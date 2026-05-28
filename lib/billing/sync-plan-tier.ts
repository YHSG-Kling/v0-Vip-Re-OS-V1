/**
 * lib/billing/sync-plan-tier.ts
 *
 * Keeps brokerages.plan_tier (the cap-enforcement column read by
 * lib/usage/check-cap.ts) in sync with the brokerage's active subscription
 * tier. The commercial source of truth is subscriptions.tier_id →
 * subscription_tiers.tier_name; brokerages.plan_tier is the runtime cache
 * the cap-checker reads on every request.
 *
 * Call this whenever the subscription state changes:
 *   - Stripe webhook customer.subscription.updated  → sync to new tier
 *   - Stripe webhook customer.subscription.deleted  → revert to solo_agent
 *   - Superadmin manualTierOverride                  → sync immediately
 *
 * Defaults to 'solo_agent' when no active subscription exists (matches the
 * brokerages.plan_tier default).
 */

import { createServiceClient } from "@/lib/supabase/service"

export type CanonicalPlanTier = "solo_agent" | "team" | "brokerage" | "multi_location"

/**
 * Resolve the brokerage's active subscription tier and write it to
 * brokerages.plan_tier. Idempotent — safe to call repeatedly.
 *
 * Returns the tier that was written (or already in place), or null on error.
 * Never throws — billing webhooks should not fail because of this sync.
 */
export async function syncBrokeragePlanTier(
  brokerageId: string,
): Promise<CanonicalPlanTier | null> {
  if (!brokerageId) return null

  const supabase = createServiceClient()

  // Find the active subscription for this brokerage. There should be only one
  // active at a time (Stripe enforces this); if multiple exist for any reason
  // we take the most recently updated.
  const { data: subscription } = await supabase
    .from("subscriptions")
    .select("tier_id, status, updated_at, subscription_tiers:tier_id(tier_name)")
    .eq("brokerage_id", brokerageId)
    .in("status", ["active", "trialing"])
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  const tierName = (subscription as any)?.subscription_tiers?.tier_name as string | undefined
  // No active subscription, or tier wasn't joinable → default to solo_agent.
  const resolved: CanonicalPlanTier = isCanonicalTier(tierName) ? tierName : "solo_agent"

  const { error } = await supabase
    .from("brokerages")
    .update({ plan_tier: resolved })
    .eq("id", brokerageId)

  if (error) {
    console.error("[sync-plan-tier] failed to update brokerages.plan_tier:", error)
    return null
  }

  return resolved
}

function isCanonicalTier(t: unknown): t is CanonicalPlanTier {
  return t === "solo_agent" || t === "team" || t === "brokerage" || t === "multi_location"
}
