import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { publishManagerSignal } from "@/lib/kernel/manager-signals"

/**
 * Weekly SELLER UPDATE VIDEO cron — the Listing Concierge's heartbeat for the governed seller video.
 * It does NOT make or send the video itself; it HANDS THE WORK to the managers on the bus (mirroring
 * the buyer reels — Listing Concierge decides → Asset Manager creates → Campaign Orchestrator sends):
 *   1) SEND   — publish asset_manager → campaign_orchestrator `seller_update_ready` per brokerage so
 *               the Campaign Orchestrator delivers last week's finished reels to each seller (gated).
 *   2) CREATE — publish listing_concierge → asset_manager `seller_update_reel_handoff` per active
 *               listing so the Asset Manager commissions this week's reel.
 * The manager-signals dispatcher runs the handlers (which delegate to the proven producer). Idempotent
 * (publishManagerSignal de-dupes open signals per entity; the producers de-dupe per listing/week).
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "listing-seller-update-video",
    cron_path: "/app/api/cron/listing-seller-update-video/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let sendHandoffs = 0
  let createHandoffs = 0

  try {
    // Distinct active brokerages first (delivery is brokerage-scoped + sweeps all).
    const { data: activeListings, error } = await supabase
      .from("listings")
      .select("id, brokerage_id, lifecycle_stage")
      .in("lifecycle_stage", ["MLS_ACTIVE", "COMING_SOON_ACTIVE", "SHOWINGS_ACTIVE"])
      .limit(200)
    if (error) throw error

    const listings = (activeListings ?? []) as Array<{ id: string; brokerage_id: string }>
    const brokerages = Array.from(new Set(listings.map((l) => l.brokerage_id)))

    // Phase 1 — SEND handoff: Asset Manager → Campaign Orchestrator delivers finished reels (gated).
    for (const brokerageId of brokerages) {
      try {
        const r = await publishManagerSignal({
          brokerageId, fromManager: "asset_manager", toManager: "campaign_orchestrator",
          signalType: "seller_update_ready", entityType: "brokerage", entityId: brokerageId,
          message: "Finished seller-update reels are ready — deliver each to its seller (gated).",
        }, supabase)
        if (r.ok) sendHandoffs += 1
      } catch (e: any) {
        errors.push(`send-handoff ${brokerageId}: ${e?.message ?? String(e)}`)
      }
    }

    // Phase 2 — CREATE handoff: Listing Concierge → Asset Manager commissions this week's reel.
    for (const l of listings) {
      try {
        const r = await publishManagerSignal({
          brokerageId: l.brokerage_id, fromManager: "listing_concierge", toManager: "asset_manager",
          signalType: "seller_update_reel_handoff", entityType: "listing", entityId: l.id,
          message: "Weekly seller update due for an active listing — commission the avatar reel.",
        }, supabase)
        if (r.ok) createHandoffs += 1
      } catch (e: any) {
        errors.push(`create-handoff ${l.id}: ${e?.message ?? String(e)}`)
      }
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: sendHandoffs + createHandoffs,
      metadata: { sendHandoffs, createHandoffs, listings: listings.length, errors },
    }).catch(() => {})
    return NextResponse.json({ ok: true, sendHandoffs, createHandoffs, listings: listings.length, errors })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
