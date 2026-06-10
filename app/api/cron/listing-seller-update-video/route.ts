import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { requestSellerUpdateReel, deliverSellerUpdateReels } from "@/lib/agents/seller-update-reel-producer"

/**
 * Weekly SELLER UPDATE VIDEO cron — the Listing Concierge's governed video deliverable.
 * Two phases per run:
 *   1) DELIVER — sweep last week's finished seller-update avatar renders and propose
 *      each to its seller through the client-message gate (audience='seller').
 *   2) REQUEST — enqueue this week's seller-update avatar render for every active
 *      listing (the D-ID poll cron renders it; next week's run delivers it).
 * Both phases are idempotent, so re-running the cron is safe.
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
  let proposed = 0
  let queued = 0

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

    // Phase 1 — deliver finished renders into the gate.
    for (const brokerageId of brokerages) {
      try {
        const r = await deliverSellerUpdateReels(brokerageId, supabase)
        proposed += r.proposed
      } catch (e: any) {
        errors.push(`deliver ${brokerageId}: ${e?.message ?? String(e)}`)
      }
    }

    // Phase 2 — enqueue this week's renders.
    for (const l of listings) {
      try {
        const r = await requestSellerUpdateReel(l.brokerage_id, l.id, supabase)
        if (r.queued) queued += 1
      } catch (e: any) {
        errors.push(`request ${l.id}: ${e?.message ?? String(e)}`)
      }
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: proposed + queued,
      metadata: { proposed, queued, listings: listings.length, errors },
    }).catch(() => {})
    return NextResponse.json({ ok: true, proposed, queued, listings: listings.length, errors })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
