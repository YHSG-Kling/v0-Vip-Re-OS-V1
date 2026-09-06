// lib/billing/plan-tier.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE brokerage tier. A tenant cannot be two tiers at once.
//
// `brokerages` carried TWO tier columns and different modules preferred
// different ones:
//
//   plan_tier          WRITTEN. lib/billing/sync-plan-tier.ts resolves it from
//                      the tenant's Stripe subscription → subscription_tiers
//                      .tier_name, and its own header calls it "the runtime
//                      cache". signup, staff-create, onboarding provisioning and
//                      the superadmin tier-change all write it.
//   subscription_tier  NOT WRITTEN BY ANYTHING. Verified exhaustively across
//                      .ts/.tsx/.sql: every other `subscription_tier` hit is a
//                      DIFFERENT table (subscription_tiers, ai_subscription_tier,
//                      vendor_marketplace_profiles). The only writer in the repo
//                      was a test fixture.
//
// Four production readers preferred the unwritten one — brokerage-context (as
// `subscription_tier ?? plan_tier`), asset-manager, composition-library and
// billing — so they read a value nothing maintains. This was not theoretical: a
// live tenant had plan_tier='solo_agent' and subscription_tier='brokerage', which
// made it a SOLO tenant to the lead router and a BROKERAGE tenant to the asset
// manager, the composition library and its own billing page, at the same time.
//
// plan_tier wins because it is the one with writers. m306 drops the twin so it
// cannot be re-adopted.

import type { createServiceClient } from "@/lib/supabase/service"

/** The subscription tiers a brokerage can be on. */
export const CANONICAL_TIERS = ["solo_agent", "team", "brokerage", "multi_location"] as const
export type PlanTier = (typeof CANONICAL_TIERS)[number]

/** The safest assumption when a tier is missing or unrecognised: the SMALLEST.
 *  Failing to the tightest tier means a mis-tagged tenant is never handed a free
 *  upgrade — the same fail-safe direction lib/billing/phone-plan.ts documents. */
export const FALLBACK_TIER: PlanTier = "solo_agent"

export function isPlanTier(v: string | null | undefined): v is PlanTier {
  return !!v && (CANONICAL_TIERS as readonly string[]).includes(v)
}

/** PURE — normalise a stored tier, falling to the tightest rather than guessing. */
export function toPlanTier(raw: string | null | undefined): PlanTier {
  return isPlanTier(raw) ? raw : FALLBACK_TIER
}

/**
 * The brokerage's tier. `brokerages.plan_tier` is the answer — the column with
 * writers, CHECK-constrained (brokerages_plan_tier_check, VALIDATED) to exactly
 * CANONICAL_TIERS, and defaulted to 'solo_agent'.
 *
 * ── THE SUBSCRIPTION IS THE SOURCE, plan_tier IS THE ANSWER ─────────────────
 *
 * `subscriptions.tier_id → subscription_tiers.tier_name` carries the same four
 * names, and lib/billing/sync-plan-tier.ts is what copies it down into
 * `plan_tier`. So plan_tier is not a guess about the subscription — it is the
 * subscription, cached where every reader can reach it in one query.
 *
 * WHAT HAPPENS WITH NO SUBSCRIPTION ROW, which is the live state: `subscriptions`
 * holds ZERO rows on this database while `brokerages` holds two, both carrying
 * plan_tier='solo_agent'. A resolver that read the subscription FIRST would
 * therefore resolve nothing for every tenant that exists, and the tier-aware
 * lead router would fall back on every single lead. plan_tier is read first for
 * exactly that reason.
 *
 * The subscription is consulted only to fill a NULL plan_tier — the one case
 * where the cache has nothing and the source might. `plan_tier` is nullable, so
 * a row inserted with an explicit NULL bypasses the column default; when that
 * happens the ACTIVE subscription's tier is a better answer than the floor.
 *
 * The floor is `solo_agent`, the TIGHTEST tier: a mis-tagged tenant is never
 * handed a wider agent pool or a bigger feature set than it pays for. That is
 * the same fail-safe direction lib/billing/phone-plan.ts documents, and it is
 * what the lead router relies on — a solo tenant's leads all go to one person,
 * which is never a leak.
 */
export async function resolvePlanTier(
  supabase: ReturnType<typeof createServiceClient>,
  brokerageId: string,
): Promise<PlanTier> {
  const read = await readPlanTier(supabase, brokerageId)
  return read.ok ? read.tier : FALLBACK_TIER
}

/**
 * THE SAME READ, WITH THE REFUSAL STILL VISIBLE.
 *
 * `resolvePlanTier` above is the never-throws projection: every caller that just
 * needs a tier to route with gets the floor and carries on, because a lead
 * router that throws is worse than a lead router that routes conservatively.
 *
 * But an ENTITLEMENT GATE cannot use that projection. "The tenant is on the
 * cheapest plan" and "this process could not read what the tenant pays for" are
 * the same value out of `resolvePlanTier`, and CLAUDE.md §4 forbids the second
 * rendering as the first: a gate that cannot run must REFUSE, not pass on a
 * guess. So this is the same read with the `{ data, error }` outcome preserved
 * (§3 — supabase-js RESOLVES refusals), and `lib/kernel/0.1-feature-access.ts`
 * `canAccessFeature` refuses on `ok:false`.
 *
 * `ok:false` is reserved for "the database did not answer": a refused/failed
 * query, or no such brokerage row. A row that ANSWERS with a NULL or legacy
 * plan_tier is not a failure — the subscription source is consulted and, failing
 * that, the caller may floor it, exactly as before.
 *
 * Deliberately structural in its client parameter: `canAccessFeature` holds the
 * cookie-bound SSR client from `@/lib/supabase/server`, not the service client,
 * and both must be able to ask this one question rather than growing a second
 * spelling of it (§6).
 */
export interface PlanTierRead {
  ok: true
  tier: PlanTier
  /** true when the value came from the plan_tier cache; false when it was
   *  recovered from the subscription, or floored because neither answered. */
  fromCache: boolean
}
export interface PlanTierReadFailure {
  ok: false
  /** Caller-safe sentence — never leaks ids or driver internals. */
  reason: string
}

interface TierReadClient {
  from: (table: string) => any
}

export async function readPlanTier(
  supabase: TierReadClient,
  brokerageId: string,
): Promise<PlanTierRead | PlanTierReadFailure> {
  const { data, error } = await supabase
    .from("brokerages")
    .select("plan_tier")
    .eq("id", brokerageId)
    .maybeSingle()

  // supabase-js RESOLVES a refused query, so a swallowed error would be
  // indistinguishable from "this brokerage has no tier". They are NOT the same
  // fact, and only the caller knows whether it may proceed on a guess.
  if (error) return { ok: false, reason: "Your plan could not be read — access is held until it can." }
  if (!data) return { ok: false, reason: "No subscription found for this account." }

  const raw = (data as { plan_tier?: string | null } | null)?.plan_tier
  if (isPlanTier(raw)) return { ok: true, tier: raw, fromCache: true }

  // NULL / unrecognised cache → ask the SOURCE before falling to the floor.
  const { data: sub, error: subError } = await supabase
    .from("subscriptions")
    .select("status, subscription_tiers(tier_name)")
    .eq("brokerage_id", brokerageId)
    .in("status", ["active", "trialing"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (subError || !sub) return { ok: true, tier: FALLBACK_TIER, fromCache: false }

  // The embed is an object for a to-one relation, but supabase-js types it as
  // either shape depending on how the FK is introspected — both are handled
  // rather than asserted, because guessing wrong here silently returns the floor.
  const embedded = (sub as { subscription_tiers?: unknown }).subscription_tiers
  const tierName = Array.isArray(embedded)
    ? (embedded[0] as { tier_name?: string } | undefined)?.tier_name
    : (embedded as { tier_name?: string } | null)?.tier_name

  return { ok: true, tier: toPlanTier(tierName), fromCache: false }
}
