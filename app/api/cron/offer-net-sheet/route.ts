import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runOfferNetSheets } from "@/lib/kernel/offer-net-sheet"

/**
 * OFFER NET SHEET cron (frequent — offers are time-sensitive). For each brokerage's
 * in-house listings with open offer(s), the Listing Concierge computes the per-offer
 * NET PROCEEDS comparison (offer price − payoff/taxes/HOA/commission/credit), ranks by
 * net (surfacing which offer nets the seller MOST, not just the highest price), proposes
 * ONE gated agent summary into the approval gate, and PUSHES a read-only value card to
 * the seller's portal. Idempotent: one comparison per listing per offer-set per 24h.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "offer-net-sheet",
    cron_path: "/app/api/cron/offer-net-sheet/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let listingsScanned = 0, comparisonsProposed = 0, portalCardsPushed = 0

  try {
    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error
    for (const b of (rows ?? []) as Array<{ id: string }>) {
      try {
        const r = await runOfferNetSheets(b.id, {}, supabase)
        listingsScanned += r.listingsScanned
        comparisonsProposed += r.comparisonsProposed
        portalCardsPushed += r.portalCardsPushed
      } catch (e: any) { errors.push(`${b.id}: ${e?.message ?? String(e)}`) }
    }
    await recordCronSuccessAction({
      context_id: contextId, records_processed: comparisonsProposed,
      metadata: { listingsScanned, comparisonsProposed, portalCardsPushed, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, listingsScanned, comparisonsProposed, portalCardsPushed })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
