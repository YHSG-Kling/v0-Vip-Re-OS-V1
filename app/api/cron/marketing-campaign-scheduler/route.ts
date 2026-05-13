import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  findCampaignsReadyToLaunch,
  publishMarketingCampaignSafe,
} from "@/lib/marketing/campaign-publisher"
import { syncCampaignMetricsSafe } from "@/lib/marketing/campaign-measurer"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"

export const dynamic = "force-dynamic"

/**
 * Marketing Campaign Scheduler — Sprint 9.
 *
 * Two responsibilities per run:
 *   1. LAUNCH — find marketing_campaigns where scheduled_start_at is now
 *      or past and status ∈ {draft, scheduled}, publish each.
 *   2. MEASURE — refresh metrics rollup on any campaigns launched in the
 *      last 90 days (cap to 30 per run to bound cron cost).
 *
 * Idempotent + tenant-isolated by virtue of service-role queries scoped to
 * brokerage_id columns on every row read.
 */

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const ctx = await createCronRunContextAction({
    cron_name: "marketing-campaign-scheduler",
    cron_path: "/app/api/cron/marketing-campaign-scheduler/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  const svc = createServiceClient()
  const launchResults: Array<{ campaignId: string; ok: boolean; audienceSize?: number; error?: string }> = []
  const measureResults: Array<{ campaignId: string; impressions: number; engagements: number; conversions: number }> = []

  try {
    // 1. LAUNCH
    const ready = await findCampaignsReadyToLaunch(svc, 90)
    for (const r of ready) {
      const result = await publishMarketingCampaignSafe(r.campaignId)
      launchResults.push({
        campaignId:    r.campaignId,
        ok:            result.ok,
        audienceSize:  result.audienceSize,
        error:         result.error,
      })
    }

    // 2. MEASURE — refresh metrics on recently-launched campaigns
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString()
    const { data: launched } = await svc
      .from("marketing_campaigns")
      .select("id")
      .in("status", ["live", "ended"])
      .gte("launched_at", since)
      .order("launched_at", { ascending: false })
      .limit(30)
    for (const m of (launched ?? []) as Array<{ id: string }>) {
      const metrics = await syncCampaignMetricsSafe(m.id)
      if (metrics) measureResults.push(metrics)
    }

    const summary = {
      candidates_for_launch: ready.length,
      launches_succeeded:    launchResults.filter(r => r.ok).length,
      launches_failed:       launchResults.filter(r => !r.ok).length,
      campaigns_measured:    measureResults.length,
    }

    await recordCronSuccessAction({
      context_id:        contextId,
      records_processed: summary.launches_succeeded + summary.campaigns_measured,
      metadata:          { ...summary, launchResults, measureResults },
    })

    return NextResponse.json({ message: "Scheduler complete", summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Scheduler failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}
