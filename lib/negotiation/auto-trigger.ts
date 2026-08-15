/**
 * Sprint 8 — Auto-trigger + outcome recording for Negotiation Co-Pilot.
 *
 * The offer kernel emits OFFER_OS_SUBMITTED, OFFER_OS_COUNTERED, OFFER_OS_*
 * lifecycle events for every state change. Sprint 8 hooks those events to
 * (a) generate a strategy automatically, and (b) close the learning loop
 * by recording the outcome when an offer is accepted / rejected /
 * withdrawn.
 *
 * Why a separate file (not inline in offer commands):
 *   - The AI call in generateAndPersistNegotiationStrategyAction takes
 *     5-30s. We do NOT want to block the offer command's response.
 *   - The cron generator (/app/api/cron/negotiation-strategy-generator)
 *     is the canonical trigger path so retries / backoff / errors are
 *     centralized.
 *   - For outcome recording (a single UPDATE), inline fire-and-forget
 *     from the offer command IS appropriate — it's fast and idempotent.
 */

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { createServiceClient } from "@/lib/supabase/service"

/**
 * Record the outcome on any open or accepted-by-agent strategy for this
 * offer. Idempotent — calling twice is harmless. Catches all errors so
 * it never breaks the parent flow.
 */
export async function recordOutcomeForOfferSafe(
  offerId: string,
  outcome: "accepted" | "countered" | "rejected" | "withdrawn" | "closed" | "lost",
): Promise<void> {
  try {
    const supabase = createServiceClient()
    await supabase
      .from("negotiation_strategies")
      .update({
        status:              "outcome_recorded",
        outcome,
        outcome_recorded_at: new Date().toISOString(),
        updated_at:          new Date().toISOString(),
      })
      .eq("offer_id", offerId)
      .in("status", ["open", "accepted_by_agent"])
  } catch (err) {
    console.error("[negotiation-auto] recordOutcomeForOffer failed:", err)
  }
}

/**
 * Returns the offer rows surfaced by recent lifecycle_events that should
 * have a negotiation_strategy. Used by the cron generator to scan recent
 * activity. Filters out events that already have a corresponding open
 * or accepted strategy for the inferred side (idempotency).
 *
 * lookback default: 90 minutes (the cron runs every minute, generous overlap).
 */
export async function findOffersNeedingStrategy(
  svc:       SupabaseClient,
  lookbackMinutes: number = 90,
): Promise<Array<{ offerId: string; side: "buyer" | "seller"; brokerageId: string; eventId: string }>> {
  const since = new Date(Date.now() - lookbackMinutes * 60_000).toISOString()

  // OFFER_OS_SUBMITTED → seller needs strategy (whose listing got the offer)
  // OFFER_OS_COUNTERED → buyer needs strategy (the seller countered back)
  const { data: events } = await svc
    .from("lifecycle_events")
    .select("id, event_type, entity_id, brokerage_id, created_at")
    .in("event_type", ["offer_os_submitted", "offer_os_countered"])
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(200)

  const candidates: Array<{ offerId: string; side: "buyer" | "seller"; brokerageId: string; eventId: string }> = []
  for (const ev of (events ?? []) as Array<{ id: string; event_type: string; entity_id: string; brokerage_id: string }>) {
    const side: "buyer" | "seller" = ev.event_type === "offer_os_countered" ? "buyer" : "seller"

    // Skip if an open/accepted strategy already exists for this (offer, side)
    const { data: existing } = await svc
      .from("negotiation_strategies")
      .select("id")
      .eq("offer_id", ev.entity_id)
      .eq("side", side)
      .in("status", ["open", "accepted_by_agent"])
      .maybeSingle()
    if (existing) continue

    candidates.push({
      offerId:     ev.entity_id,
      side,
      brokerageId: ev.brokerage_id,
      eventId:     ev.id,
    })
  }
  return candidates
}
