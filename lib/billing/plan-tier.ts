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

/** The brokerage's tier. Reads plan_tier — the column with writers — and nothing else. */
export async function resolvePlanTier(
  supabase: ReturnType<typeof createServiceClient>,
  brokerageId: string,
): Promise<PlanTier> {
  const { data } = await supabase
    .from("brokerages")
    .select("plan_tier")
    .eq("id", brokerageId)
    .maybeSingle()
  return toPlanTier((data as { plan_tier?: string | null } | null)?.plan_tier)
}
