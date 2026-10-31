/**
 * lib/entitlements/tenant-capabilities.ts
 *
 * "WHAT DOES **THIS TENANT** ACTUALLY HAVE?" — asked for a whole SET of features
 * at once, by a caller that holds a SERVICE client and no request.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS NOT A SECOND CAPABILITY REGISTRY (§6) ────
 *
 * The repo already answers this question twice, and NEITHER answer is reachable
 * from a cron/producer path:
 *
 *   · `lib/kernel/0.1-feature-access.ts` canAccessFeature — the real gate, but
 *     it is USER-scoped and REQUEST-scoped: it opens with the cookie-bound SSR
 *     client from `@/lib/supabase/server`, and it answers ONE feature per call.
 *     A cron-driven producer has no cookie and no user, and asking it six times
 *     would be six round trips even if it did.
 *   · `app/actions/superadmin/tenant-entitlements.ts` getTenantEntitlementsAction
 *     — tenant-scoped and service-client, which is the right SHAPE, but it is a
 *     `"use server"` export behind `requireSuperadmin()`. Every export in a
 *     "use server" file is a public HTTP endpoint (§4); importing it from a
 *     library would be importing an endpoint, and its superadmin gate would
 *     refuse a cron caller anyway.
 *
 * So the missing half is the READER, not the model (§1.2 — build the missing
 * half). NOTHING here re-decides what a feature is or who may have it:
 *
 *   · the ROWS are the same rows — `feature_flags` tier columns and
 *     brokerage-scoped `feature_access_overrides`, read with the same shape
 *     getTenantEntitlementsAction uses;
 *   · the TIER is `lib/billing/plan-tier.ts` readPlanTier — the one column with
 *     writers, with its refusal preserved;
 *   · the ORDER is `lib/entitlements/resolve.ts` resolveEntitlement — the ONE
 *     pure resolution order, unchanged and un-duplicated;
 *   · the override VOCABULARY is `lib/kernel/override-vocab.ts`.
 *
 * A second table, a second precedence order, or a second spelling of
 * "grant_trial" would be the §6 defect. There is none of that here.
 *
 * ── IT FAILS CLOSED, AND THE CALLER CAN TELL (§4) ──────────────────────────
 *
 * "This tenant does not have the feature" and "this process could not read what
 * the tenant has" must never be the same value. `ok:false` is returned for the
 * second, with the refusal text, and `allowed` is EMPTY on that path — so a
 * caller that ignores `ok` still claims nothing, rather than claiming
 * everything. That direction matters more here than in a normal gate: the first
 * consumer of this module composes ADVERTISING spoken to a consumer, where
 * "we could not check" rendering as "yes, we do all of that" is a false claim,
 * not merely a loose permission.
 */
import type { createServiceClient } from "@/lib/supabase/service"
import { readPlanTier, type PlanTier } from "@/lib/billing/plan-tier"
import { resolveEntitlement, rolloutBucket } from "@/lib/entitlements/resolve"
import { normalizeOverrideType } from "@/lib/kernel/override-vocab"

/** The `feature_flags` columns that carry per-tier access, by tier. ONE map —
 *  the same four column names `0.1-feature-access.ts` and the superadmin
 *  entitlements action select on. */
const TIER_ACCESS_COLUMN: Record<PlanTier, string> = {
  solo_agent:     "solo_agent_access",
  team:           "team_access",
  brokerage:      "brokerage_access",
  multi_location: "multi_location_access",
}

export interface TenantCapabilities {
  ok: true
  /** The tenant's billed tier (brokerages.plan_tier via readPlanTier). */
  tier: PlanTier
  /** Feature keys this tenant may actually use, out of the keys asked for. */
  allowed: ReadonlySet<string>
  /** Why each requested key that is NOT allowed was refused — for logs, never
   *  for a consumer-facing surface. */
  refusedBecause: ReadonlyMap<string, string>
}

export interface TenantCapabilitiesFailure {
  ok: false
  /** Nothing was resolvable. EMPTY, so an `ok`-blind caller still claims nothing. */
  allowed: ReadonlySet<string>
  reason: string
}

export type TenantCapabilityRead = TenantCapabilities | TenantCapabilitiesFailure

const NOTHING: ReadonlySet<string> = new Set<string>()

/**
 * Resolve, in two queries, which of `featureKeys` this BROKERAGE may use.
 *
 * Deliberately tenant-scoped and NOT user-scoped: a tier is a property of the
 * subscription, and the surfaces that need this (a producer building a claim
 * about what the brokerage delivers) are asking about the tenant, not about
 * whoever happened to trigger the cron. USER- and TEAM-scoped overrides are
 * therefore NOT consulted — the same `.is("user_id", null).is("team_id", null)`
 * filter the superadmin entitlements panel uses, for the same reason: one
 * teammate's personal trial is not a fact about the brokerage.
 *
 * Usage limits are not consulted either, and that is a deliberate reading of
 * the question rather than an omission: "is this tenant entitled to the
 * capability" is a different question from "have they used up this month's
 * allowance of it". `resolveEntitlement` is handed `tierLimit: null` so it
 * answers the first. A caller that needs the second wants canAccessFeature.
 */
export async function resolveTenantCapabilities(
  supabase: ReturnType<typeof createServiceClient>,
  brokerageId: string,
  featureKeys: readonly string[],
): Promise<TenantCapabilityRead> {
  const keys = [...new Set(featureKeys.filter((k) => !!k?.trim()))]
  if (!brokerageId) return { ok: false, allowed: NOTHING, reason: "No brokerage to resolve capabilities for" }
  if (keys.length === 0) return { ok: true, tier: "solo_agent", allowed: NOTHING, refusedBecause: new Map() }

  // 1. THE BILLED TIER, with the refusal still visible. `resolvePlanTier` would
  //    hand back the floor for an unreadable tenant, which is exactly the
  //    "nobody checked" → "checked and fine" collapse §4 forbids.
  const tierRead = await readPlanTier(supabase, brokerageId)
  if (!tierRead.ok) return { ok: false, allowed: NOTHING, reason: tierRead.reason }
  const tier = tierRead.tier
  const accessColumn = TIER_ACCESS_COLUMN[tier]

  // 2. The flags and the tenant's own overrides. §3 — supabase-js RESOLVES a
  //    refusal, so both errors are destructured and read.
  const [flagsRes, overridesRes] = await Promise.all([
    supabase
      .from("feature_flags")
      .select(
        "feature_key, enabled, superadmin_only, deprecated, sunset_date, rollout_percentage, "
        + "solo_agent_access, team_access, brokerage_access, multi_location_access",
      )
      .in("feature_key", keys),
    supabase
      .from("feature_access_overrides")
      .select("feature_key, override_type, trial_ends_at, disabled_reason")
      .eq("brokerage_id", brokerageId)
      .is("user_id", null)
      .is("team_id", null)
      .in("feature_key", keys),
  ])

  if (flagsRes.error) {
    return { ok: false, allowed: NOTHING, reason: `Could not read feature flags: ${flagsRes.error.message}` }
  }
  // An override read that REFUSED is not "no overrides". A tenant whose
  // `disable` row we failed to see would be handed a capability staff took
  // away — so this refuses too rather than resolving against a partial picture.
  if (overridesRes.error) {
    return { ok: false, allowed: NOTHING, reason: `Could not read feature overrides: ${overridesRes.error.message}` }
  }

  type FlagRow = Record<string, unknown> & { feature_key: string }
  const flagByKey = new Map<string, FlagRow>()
  for (const row of (flagsRes.data ?? []) as unknown as FlagRow[]) flagByKey.set(row.feature_key, row)

  const overrideByKey = new Map<string, { type: string | null; trialEndsAt: string | null; disabledReason: string | null }>()
  for (const o of (overridesRes.data ?? []) as Array<Record<string, any>>) {
    overrideByKey.set(o.feature_key, {
      // Canonical spelling only (§6) — the table has carried both historically.
      type:           normalizeOverrideType(o.override_type),
      trialEndsAt:    o.trial_ends_at ?? null,
      disabledReason: o.disabled_reason ?? null,
    })
  }

  const allowed = new Set<string>()
  const refusedBecause = new Map<string, string>()

  for (const key of keys) {
    const flag = flagByKey.get(key) ?? null
    const decision = resolveEntitlement({
      flag: flag
        ? {
            enabled:        !!flag.enabled,
            deprecated:     !!flag.deprecated,
            sunsetDate:     (flag.sunset_date as string | null) ?? null,
            superadminOnly: !!flag.superadmin_only,
            tierHasAccess:  !!flag[accessColumn],
            // Entitlement, not allowance — see the header.
            tierLimit:      null,
            rolloutPercentage: (flag.rollout_percentage as number | null) ?? null,
          }
        : null,
      // A tenant is never a superadmin. The god-switch is a PLATFORM read that
      // canAccessFeature performs behind a fail-open try; it is deliberately not
      // re-spelled here, and its absence can only make this answer TIGHTER.
      isSuperadmin: false,
      // The bucket keys on the TENANT, which is what this reader has — the same
      // key canAccessFeature prefers (a whole office flips together).
      rolloutBucket: rolloutBucket(key, brokerageId),
      override: overrideByKey.get(key) ?? null,
      tier,
    })
    if (decision.allowed) allowed.add(key)
    else refusedBecause.set(key, decision.reason ?? decision.disabled_reason ?? "Not available on this account")
  }

  return { ok: true, tier, allowed, refusedBecause }
}
