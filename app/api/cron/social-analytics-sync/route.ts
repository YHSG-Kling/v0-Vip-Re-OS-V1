import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { syncSocialAnalytics } from "@/lib/social/analytics-sync"

export const dynamic = "force-dynamic"
export const maxDuration = 300

// Daily social-analytics sync (round 30) — THE writer for
// social_media_analytics. Pulls REAL platform metrics for posts the OS
// actually published in the last 30 days, through the same connector gateway
// + stored tenant credentials the publisher posted with. The
// bundle-attribution rollup reads this table for SOCIAL_POST scans — before
// this cron existed, that lane could only ever see the dead fake-success
// stub's zeros. Registered in CRON_REGISTRY; campaign_orchestrator-owned (m618:
// survivor of the retired marketing_agent seat; same lane as publish-social-posts).
export async function GET(request: NextRequest) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "social-analytics-sync",
    cron_path: "/app/api/cron/social-analytics-sync/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  try {
    const svc = createServiceClient()
    const result = await syncSocialAnalytics(svc, { sinceDays: 30, limit: 100 })

    // THE WINNER PASS (2026-09-07): with fresh numbers in, judge every measured
    // brokerage's recent posts against its own 28-day baseline and publish
    // `content_winner` to the Ads Manager — the signal the registry declared and
    // the handler consumed, which nothing had ever emitted.
    let winners = { brokerages: 0, winners: 0, signalled: 0 }
    try {
      const { detectContentWinnersAll } = await import("@/lib/marketing/content-winner")
      winners = await detectContentWinnersAll(svc)
    } catch (e) { console.error("[social-analytics-sync] winner pass failed:", (e as Error).message) }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: result.synced,
      metadata: { ...result, winners },
    }).catch(() => {})
    return NextResponse.json({ ok: true, ...result, winners })
  } catch (err: any) {
    await recordCronFailureAction({
      context_id: contextId,
      error: String(err?.message ?? err).slice(0, 500),
    }).catch(() => {})
    return NextResponse.json({ ok: false, error: String(err?.message ?? err) }, { status: 500 })
  }
}
