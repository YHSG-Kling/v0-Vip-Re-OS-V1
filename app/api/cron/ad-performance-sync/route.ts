import { NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { createServiceClient } from "@/lib/supabase/service"
import { ingestAdPerformance } from "@/lib/ads/ad-performance-ingest"

/**
 * app/api/cron/ad-performance-sync/route.ts
 *
 * Pulls REAL ad performance from Meta/Google into ad_performance for every
 * brokerage with a live campaign, so the Ads Manager optimizer acts on actual
 * cost-per-lead instead of seeded data. Best-effort + credential-gated.
 * Auth: CRON_SECRET.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 120

export async function GET(request: Request) {
  const authError = verifyCronAuth(request)
  if (authError) return authError
  try {
    const svc = createServiceClient()
    const { data: live } = await svc.from("ad_campaigns").select("brokerage_id").in("status", ["live", "launching"])
    const brokerageIds = Array.from(new Set((live ?? []).map((r: { brokerage_id: string }) => r.brokerage_id)))
    let campaigns = 0, ingested = 0, skipped = 0
    for (const bid of brokerageIds) {
      const res = await ingestAdPerformance(bid, svc)
      campaigns += res.campaigns; ingested += res.ingested; skipped += res.skipped
    }
    return NextResponse.json({ ok: true, brokerages: brokerageIds.length, campaigns, ingested, skipped })
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 })
  }
}
