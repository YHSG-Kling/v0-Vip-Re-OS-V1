/**
 * app/api/cron/buyer-market-watch/route.ts
 *
 * Wave 62/63 — SCHEDULED buyer market watch. For each active buyer (one property_preferences
 * row = a buyer with criteria) it matches their criteria against:
 *   • OUR active listings → durable property_matches (deterministic, idempotent), and
 *   • the external market (RentCast/IDX via the buyer-search connector) → COMPLIANT
 *     display-only references (no stored photos, TTL-purged) + property_matches.
 * When a buyer gets NEW matches, it enqueues the deliverable-gated property-match reel.
 *
 * System-context: CRON_SECRET auth, service client, batched + sequential per item (one
 * failing buyer never aborts the run). External search is connector-gated — no-ops when
 * no RentCast/IDX is configured.
 */
import { NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { createServiceClient } from "@/lib/supabase/service"
import { runMarketWatchForBuyer } from "@/lib/buyer-search/market-watch"
import { runExternalMarketWatchForBuyer, purgeStaleExternalReferences } from "@/lib/buyer-search/external-match"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const BATCH = 150

export async function GET(request: Request) {
  const unauthorized = verifyCronAuth(request)
  if (unauthorized) return unauthorized

  const svc = createServiceClient()
  const ranAt = new Date().toISOString()
  let buyersProcessed = 0, buyersMatched = 0, buyersWithNew = 0, reelsQueued = 0, externalMatched = 0, errors = 0, offerReadyFired = 0

  // Compliance: purge stale external (RentCast/IDX) references first — they must be short-lived.
  let purged = 0
  try { purged = (await purgeStaleExternalReferences(svc)).purged } catch { /* best-effort */ }

  try {
    // One property_preferences row per buyer = the "has criteria to match" signal (avoids
    // buyer_stage vocabulary drift). Oldest-calculated first so load spreads across runs.
    const { data: prefs } = await svc.from("property_preferences")
      .select("contact_id, brokerage_id")
      .not("contact_id", "is", null).not("brokerage_id", "is", null)
      .order("last_calculated_at", { ascending: true, nullsFirst: true })
      .limit(BATCH)
    const rows = (prefs ?? []) as Array<{ contact_id: string; brokerage_id: string }>

    for (const p of rows) {
      buyersProcessed++
      try {
        const r = await runMarketWatchForBuyer(svc, p.brokerage_id, p.contact_id)
        // External (RentCast/IDX) market — compliant, connector-gated; no-ops without a source.
        let extNew = 0
        try {
          const ext = await runExternalMarketWatchForBuyer(svc, p.brokerage_id, p.contact_id)
          externalMatched += ext.external
          extNew = ext.external
        } catch { /* external is best-effort */ }

        if (r.matched > 0) buyersMatched++
        if (r.newMatches > 0 || extNew > 0) {
          buyersWithNew++
          // Deliverable-gated touch: enqueue the personalized property-match reel
          // (cooldown-idempotent — at most one reel per buyer per week).
          try {
            const { produceBuyerMatchReel } = await import("@/lib/agents/buyer-match-reel-producer")
            const reel = await produceBuyerMatchReel(p.brokerage_id, p.contact_id, svc)
            if (reel.queued) reelsQueued++
          } catch { /* reel is best-effort */ }
        }

        // AUTONOMOUS OFFER TRIGGER — a pre-approved buyer with a fresh saved target and no offer
        // yet is at the offer moment. Fire the gated Offer Accelerator (real comps-grounded plan
        // + the offer-confidence reel handoff) instead of waiting for an agent to move the stage.
        try {
          const { runOfferReadyCheck } = await import("@/lib/agents/offer-ready-detector")
          const ready = await runOfferReadyCheck(svc, p.brokerage_id, p.contact_id)
          if (ready.fired) offerReadyFired++
        } catch { /* offer-ready check is best-effort */ }
      } catch (e) {
        errors++
        console.error("[buyer-market-watch] buyer failed:", p.contact_id, (e as Error).message)
      }
    }
  } catch (e) {
    return NextResponse.json({ ran_at: ranAt, error: (e as Error).message, buyersProcessed }, { status: 500 })
  }

  return NextResponse.json({ ran_at: ranAt, buyersProcessed, buyersMatched, buyersWithNew, reelsQueued, externalMatched, offerReadyFired, purged, errors })
}
