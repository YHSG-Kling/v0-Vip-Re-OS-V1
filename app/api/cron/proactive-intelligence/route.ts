/**
 * app/api/cron/proactive-intelligence/route.ts
 *
 * ACTIVATES THE PROACTIVE INTELLIGENCE LAYER — daily sweep that fires the autonomous detectors
 * that were built but never triggered: buyer-stall, listing-stall, stuck-stage, and the
 * relationship-health lifecycle router. Each detector is PURE + GATED + IDEMPOTENT (it PROPOSES a
 * play into the gate / publishes a deduped manager signal — never auto-sends), so this turns the
 * OS from reactive to proactive without spam. Capped per brokerage so the first run never floods
 * the approval queue; the runners dedup on the signal bus across runs.
 *
 * System-context: CRON_SECRET auth, service client, best-effort per item (one failure never aborts).
 */
import { NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { createServiceClient } from "@/lib/supabase/service"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PER_BROKERAGE_CAP = 60

export async function GET(request: Request) {
  const unauthorized = verifyCronAuth(request)
  if (unauthorized) return unauthorized

  const svc = createServiceClient()
  const ranAt = new Date().toISOString()
  let brokerages = 0, healthPlays = 0, buyerStall = 0, stuckStage = 0, listingStall = 0, cancelFollowups = 0, sellerNurture = 0, metricsUpserted = 0, weeklyReports = 0, mlsReminders = 0, staleVideos = 0, errors = 0

  const [
    { predictAndPublishBuyerStall },
    { detectAndPublishStuckStage },
    { predictAndPublishStall },
    { runHealthLifecyclePlays },
    { runShowingCancellationFollowups },
    { runSellerConversionNurture },
    { rollupListingMetrics },
    { runSellerWeeklyReports },
    { runMlsNumberReminders },
    { reapStaleVideoWorkflows },
  ] = await Promise.all([
    import("@/lib/intelligence/buyer-stall-predictor-runner"),
    import("@/lib/intelligence/stuck-stage-detector-runner"),
    import("@/lib/intelligence/listing-stall-predictor-runner"),
    import("@/lib/intelligence/health-lifecycle-runner"),
    import("@/lib/ai-isa/showing-cancellation-followup"),
    import("@/lib/agents/seller-conversion-nurture"),
    import("@/lib/listings/listing-metrics-rollup"),
    import("@/lib/listings/seller-weekly-report-runner"),
    import("@/lib/listings/mls-number-reminder"),
    import("@/lib/video/video-pipeline-reaper"),
  ])

  const { data: brks } = await svc.from("brokerages").select("id")
  for (const b of (brks ?? []) as Array<{ id: string }>) {
    const brokerageId = b.id
    brokerages++

    // (1) Relationship-health lifecycle router — routes stale/at-risk relationships to the right
    //     manager (a per-brokerage sweep, gated proposals).
    try { const r = await runHealthLifecyclePlays(brokerageId, svc, { limit: PER_BROKERAGE_CAP }); healthPlays += (r as any)?.proposed ?? (r as any)?.routed ?? 0 } catch { errors++ }

    // (2) Buyer-stall + stuck-stage on active buyers (one property_preferences row per buyer).
    try {
      const { data: buyers } = await svc.from("property_preferences")
        .select("contact_id").not("contact_id", "is", null).eq("brokerage_id", brokerageId).limit(PER_BROKERAGE_CAP)
      for (const p of (buyers ?? []) as Array<{ contact_id: string }>) {
        try { const s = await predictAndPublishBuyerStall({ brokerageId, contactId: p.contact_id }, svc); if (s.published) buyerStall++ } catch { errors++ }
        try { const k = await detectAndPublishStuckStage({ brokerageId, contactId: p.contact_id }, svc); if (k.published) stuckStage++ } catch { errors++ }
      }
    } catch { errors++ }

    // (3) Listing-stall on the brokerage's active inventory.
    try {
      const { data: listings } = await svc.from("listings")
        .select("id, seller_contact_id, go_live_date, address").eq("brokerage_id", brokerageId).eq("status", "active").limit(PER_BROKERAGE_CAP)
      for (const l of (listings ?? []) as Array<{ id: string; seller_contact_id: string | null; go_live_date: string | null; address: string | null }>) {
        try {
          const s = await predictAndPublishStall({
            brokerageId, listingId: l.id, sellerContactId: l.seller_contact_id ?? null,
            goLiveAt: l.go_live_date ?? null, propertyAddress: l.address ?? null,
          }, svc)
          if (s.published) listingStall++
        } catch { errors++ }
      }
    } catch { errors++ }

    // (4) Showing-cancellation follow-ups — re-engage buyers whose tour just fell through
    //     (Shopping Agent proposes ONE gated reschedule/pivot note per cancelled showing).
    try { const r = await runShowingCancellationFollowups(brokerageId, svc, { limit: PER_BROKERAGE_CAP }); cancelFollowups += r.proposed } catch { errors++ }

    // (5) Seller-conversion nurture — don't drop the homeowner who showed seller intent but hasn't
    //     booked a listing consult. Multi-manager mirror of the buyer nurture: Listing Concierge hands
    //     off to the Asset Manager to commission a personal value reel, delivered to the seller-mode
    //     portal by the Campaign Orchestrator. One gated handoff per contact per 30-day cooldown.
    try { const r = await runSellerConversionNurture(brokerageId, svc, { limit: PER_BROKERAGE_CAP }); sellerNurture += r.handedOff } catch { errors++ }

    // (6) Listing-metrics rollup — the missing writer for listing_metrics. Aggregates the real
    //     written sources (showings/saves/inquiries/views) into one cumulative row per active listing
    //     so the seller portal's proof-of-work + DOM stop reading from a permanently-empty table.
    try { const r = await rollupListingMetrics(brokerageId, svc, { limit: PER_BROKERAGE_CAP }); metricsUpserted += r.upserted } catch { errors++ }

    // (7) Seller weekly reports — the missing writer for seller_weekly_reports. Synthesizes the week's
    //     real evidence (showings/views/saves/inquiries/feedback/reach) into a client-safe digest the
    //     seller-mode portal surfaces, so the seller stays engaged between agent touches. Idempotent
    //     per (listing, week); the current week's report refreshes daily and finalizes at week end.
    try { const r = await runSellerWeeklyReports(brokerageId, svc, { limit: PER_BROKERAGE_CAP }); weeklyReports += r.upserted } catch { errors++ }

    // (8) MLS-number entry reminder — when a listing is live but has no MLS number, nudge the agent
    //     once to add it so the seller portal's syndication status (MLS/Zillow/Realtor) shows live +
    //     honest (the marketing card grounds "live" in a real mls_number). Idempotent per listing.
    try { const r = await runMlsNumberReminders(brokerageId, svc, { limit: PER_BROKERAGE_CAP }); mlsReminders += r.reminded } catch { errors++ }

    // (9) Stale video-workflow reaper — no commissioned reel sits forever in a non-terminal state.
    //     The Asset Manager owns the stalls: marks genuinely-stuck rows failed + notifies the agent
    //     (mirrors the manager-signals reaper — stale work gets a manager, never falls through cracks).
    try { const r = await reapStaleVideoWorkflows(brokerageId, svc, { limit: PER_BROKERAGE_CAP }); staleVideos += r.escalated } catch { errors++ }
  }

  return NextResponse.json({ ran_at: ranAt, brokerages, healthPlays, buyerStall, stuckStage, listingStall, cancelFollowups, sellerNurture, metricsUpserted, weeklyReports, mlsReminders, staleVideos, errors })
}
