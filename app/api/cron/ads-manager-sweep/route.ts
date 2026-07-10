import { NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { createServiceClient } from "@/lib/supabase/service"
import { proposeAdOptimizations } from "@/lib/ads/ad-manager"
import { proposeCompetitorInspiredCreative } from "@/lib/ads/ad-creative-engine"
import { publishLaunchingCampaigns } from "@/lib/ads/launch-assembler"

/**
 * app/api/cron/ads-manager-sweep/route.ts
 *
 * The Ads Manager's loop, two passes each tick:
 *   1. OPTIMIZE — for brokerages with a LIVE campaign, roll up performance and
 *      propose spend actions (scale winner / pause loser), judged ONLY by real
 *      outcomes (cost-per-lead, leads). Nothing moves money without human approval
 *      + the spend cap.
 *   2. CREATE — for brokerages with competitor-ad intelligence, auto-generate NEW
 *      ad creatives inspired by high-performing competitor ads (fresh copy + an
 *      Asset-Manager video) into the ad_creative approval queue.
 * Auth: CRON_SECRET.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(request: Request) {
  const authError = verifyCronAuth(request)
  if (authError) return authError
  try {
    const svc = createServiceClient()
    const { data: live } = await svc.from("ad_campaigns").select("brokerage_id").in("status", ["live", "launching"])
    const { data: competitors } = await svc.from("competitor_ads").select("brokerage_id").limit(2000)
    const optimizeIds = Array.from(new Set((live ?? []).map((r: { brokerage_id: string }) => r.brokerage_id)))
    const createIds = Array.from(new Set((competitors ?? []).map((r: { brokerage_id: string }) => r.brokerage_id)))

    let scanned = 0, proposed = 0, creativesProposed = 0, published = 0
    for (const bid of optimizeIds) {
      const res = await proposeAdOptimizations(bid, svc)
      scanned += res.scanned; proposed += res.proposed
      // Publish approved+validated 'launching' campaigns to the platform (real create).
      const pub = await publishLaunchingCampaigns(bid, svc)
      published += pub.published
    }
    for (const bid of createIds) {
      const res = await proposeCompetitorInspiredCreative(bid, svc)
      creativesProposed += res.proposed
    }

    // THE OUTCOME LOOP — distribution intelligence: budget follows CPL via
    // GATED rebalance proposals on the manager bus (a human approves before
    // money moves). Feedback-conditioned generation runs inside the
    // listing-ad producer at creative time.
    let rebalancesProposed = 0
    try {
      const { runAdOutcomeLoop } = await import("@/lib/ads/ad-outcome-loop")
      const loop = await runAdOutcomeLoop(svc)
      rebalancesProposed = loop.rebalancesProposed
    } catch { /* loop retries next sweep */ }

    return NextResponse.json({ ok: true, optimize_brokerages: optimizeIds.length, create_brokerages: createIds.length, scanned, proposed, creativesProposed, published, rebalancesProposed })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
