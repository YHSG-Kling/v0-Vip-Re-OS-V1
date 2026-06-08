import { NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { createServiceClient } from "@/lib/supabase/service"
import { proposeAdOptimizations } from "@/lib/ads/ad-manager"

/**
 * app/api/cron/ads-manager-sweep/route.ts
 *
 * The Ads Manager's optimization loop. Each tick, for every brokerage with a
 * LIVE campaign, roll up the latest ad performance and PROPOSE spend actions
 * (scale a winner / pause a loser) into the Command Center — judged ONLY by real
 * outcomes (cost-per-lead, leads), never vanity metrics. Nothing moves money; a
 * human approves each proposal and the executor enforces the spend cap.
 * Auth: CRON_SECRET.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(request: Request) {
  const authError = verifyCronAuth(request)
  if (authError) return authError
  try {
    const svc = createServiceClient()
    const { data: live } = await svc
      .from("ad_campaigns")
      .select("brokerage_id")
      .in("status", ["live", "launching"])
    const brokerageIds = Array.from(new Set((live ?? []).map((r: { brokerage_id: string }) => r.brokerage_id)))

    let scanned = 0, proposed = 0
    for (const bid of brokerageIds) {
      const res = await proposeAdOptimizations(bid, svc)
      scanned += res.scanned
      proposed += res.proposed
    }
    return NextResponse.json({ ok: true, brokerages: brokerageIds.length, scanned, proposed })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
