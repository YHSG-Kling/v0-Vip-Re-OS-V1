import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runListingInventoryRadar } from "@/lib/kernel/listing-inventory-radar"

/**
 * LISTING INVENTORY RADAR cron (6h sweep). For each brokerage, the Data Steward scores
 * the SELLER-INTENT candidates the scraper bench already landed in raw_scraped_leads
 * (expired/withdrawn, FSBO, absentee, high-equity/pre-foreclosure), ranks them, and routes
 * the hottest data_steward → listing_concierge over the bus. The handler proposes a GATED
 * "thinking of selling?" brief (+ a Director-commissioned reel + flagged CMA). It never
 * scrapes, never fabricates contact info, and nothing auto-sends.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "inventory-radar",
    cron_path: "/app/api/cron/inventory-radar/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let candidatesScanned = 0, scored = 0, routed = 0, contactBacked = 0

  try {
    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error
    for (const b of (rows ?? []) as Array<{ id: string }>) {
      try {
        const r = await runListingInventoryRadar(b.id, {}, supabase)
        candidatesScanned += r.candidatesScanned
        scored += r.scored
        routed += r.routed
        contactBacked += r.contactBacked
      } catch (e: any) { errors.push(`${b.id}: ${e?.message ?? String(e)}`) }
    }
    await recordCronSuccessAction({
      context_id: contextId, records_processed: routed,
      metadata: { candidatesScanned, scored, routed, contactBacked, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, candidatesScanned, scored, routed, contactBacked })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
