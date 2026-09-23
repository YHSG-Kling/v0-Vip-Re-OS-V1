// lib/billing/seat-sync.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE RECONCILE (wave 79A): Stripe is the tenant's truth for tier + purchased
// seats; the webhook keeps the row current event-by-event, and this daily
// step catches what a missed / out-of-order delivery left behind. It rides
// the existing daily billing cron (app/api/cron/billing-dunning — the one
// billing cron registered in lib/kernel/cron-dispatch.ts) as a second step.
//
// IMPURE but INJECTABLE: the Stripe retrieval is a parameter (default:
// lib/billing/stripe-subscription-ops.ts stripeRetrieveSubscription) so the
// proof drives the whole walk with fixtures and no network. Every write is
// COUNTED (.select("id")) and every error is read (CLAUDE.md §3).

import { deriveSubscriptionSeatState, itemFactsOf, seatRowPatch, type TierSeatLink, type SeatRowFacts } from "./seat-packages"

export interface SeatSyncSummary {
  /** Live subscription rows that carry a stripe_subscription_id. */
  candidates: number
  /** Retrieved from Stripe. */
  retrieved: number
  /** Rows whose tier / seat columns were changed to match Stripe. */
  patched: number
  /** Tenants whose tier changed (brokerages.plan_tier re-synced). */
  tierChanged: number
  /** Stripe items the mapping could not place (per subscription). */
  unmatched: Array<{ subscriptionId: string; priceIds: string[] }>
  errors: Array<{ subscriptionId: string; error: string }>
  /** True when Stripe is not configured — nothing was compared, and this is reported, not passed. */
  skipped: boolean
}

export interface SeatSyncDeps {
  retrieve?: (stripeSubscriptionId: string) => Promise<{ ok: true; sub: any } | { ok: false; skipped: boolean; error?: string }>
  syncPlanTier?: (brokerageId: string) => Promise<unknown>
}

export async function reconcileSubscriptionsFromStripe(svc: any, deps: SeatSyncDeps = {}): Promise<SeatSyncSummary> {
  const out: SeatSyncSummary = { candidates: 0, retrieved: 0, patched: 0, tierChanged: 0, unmatched: [], errors: [], skipped: false }
  const retrieve = deps.retrieve ?? (await import("./stripe-subscription-ops")).stripeRetrieveSubscription
  const syncPlanTier = deps.syncPlanTier ?? (async (brokerageId: string) => (await import("./sync-plan-tier")).syncBrokeragePlanTier(brokerageId))

  const { data: tiers, error: tiersErr } = await svc
    .from("subscription_tiers")
    .select("id, tier_name, stripe_price_id, stripe_seat_price_id, seat_package_size")
  if (tiersErr) { out.errors.push({ subscriptionId: "*", error: `catalogue read refused: ${tiersErr.message}` }); return out }
  const links = (tiers ?? []) as TierSeatLink[]

  const { data: rows, error: rowsErr } = await svc
    .from("subscriptions")
    .select("id, brokerage_id, stripe_subscription_id, tier_id, seat_packages, extra_seats, stripe_seat_item_id, stripe_price_id")
    .in("status", ["active", "trialing", "past_due", "paused"])
    .not("stripe_subscription_id", "is", null)
  if (rowsErr) { out.errors.push({ subscriptionId: "*", error: `subscriptions read refused: ${rowsErr.message}` }); return out }
  const list = (rows ?? []) as Array<SeatRowFacts & { id: string; brokerage_id: string; stripe_subscription_id: string }>
  out.candidates = list.length

  for (const row of list) {
    const r = await retrieve(row.stripe_subscription_id)
    if (!r.ok) {
      if (r.skipped) { out.skipped = true; break }
      out.errors.push({ subscriptionId: row.stripe_subscription_id, error: r.error ?? "retrieve failed" })
      continue
    }
    out.retrieved += 1
    const derived = deriveSubscriptionSeatState(itemFactsOf(r.sub), links)
    if (derived.unmatchedPriceIds.length > 0) out.unmatched.push({ subscriptionId: row.stripe_subscription_id, priceIds: derived.unmatchedPriceIds })
    const patch = seatRowPatch(row, derived)
    if (!patch) continue
    const { data: written, error: wErr } = await svc
      .from("subscriptions")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .select("id")
    if (wErr) { out.errors.push({ subscriptionId: row.stripe_subscription_id, error: `row update refused: ${wErr.message}` }); continue }
    if (((written ?? []) as unknown[]).length !== 1) { out.errors.push({ subscriptionId: row.stripe_subscription_id, error: "row update matched no row" }); continue }
    out.patched += 1
    if (patch.tier_id) {
      out.tierChanged += 1
      try { await syncPlanTier(row.brokerage_id) } catch (e) { out.errors.push({ subscriptionId: row.stripe_subscription_id, error: `plan_tier sync failed: ${(e as Error)?.message}` }) }
    }
  }
  return out
}
