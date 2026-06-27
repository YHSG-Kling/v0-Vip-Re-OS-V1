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
  let brokerages = 0, healthPlays = 0, buyerStall = 0, stuckStage = 0, listingStall = 0, cancelFollowups = 0, errors = 0

  const [
    { predictAndPublishBuyerStall },
    { detectAndPublishStuckStage },
    { predictAndPublishStall },
    { runHealthLifecyclePlays },
    { runShowingCancellationFollowups },
  ] = await Promise.all([
    import("@/lib/intelligence/buyer-stall-predictor-runner"),
    import("@/lib/intelligence/stuck-stage-detector-runner"),
    import("@/lib/intelligence/listing-stall-predictor-runner"),
    import("@/lib/intelligence/health-lifecycle-runner"),
    import("@/lib/ai-isa/showing-cancellation-followup"),
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
  }

  return NextResponse.json({ ran_at: ranAt, brokerages, healthPlays, buyerStall, stuckStage, listingStall, cancelFollowups, errors })
}
