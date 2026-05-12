import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { mineAllPatterns } from "@/lib/brokerage-intelligence/miners"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"

export const dynamic = "force-dynamic"

/**
 * Brokerage Intelligence Mine — weekly cron.
 *
 * Per brokerage: run the 4 pattern miners, write each fresh insight to
 * brokerage_intelligence_insights, supersede any previous open insight
 * for the same pattern_key so brokers always see the latest snapshot.
 *
 * GET = scheduled. POST = admin on-demand single-brokerage rerun.
 */

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const ctx = await createCronRunContextAction({
    cron_name: "brokerage-intelligence-mine",
    cron_path: "/app/api/cron/brokerage-intelligence-mine/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  const svc = createServiceClient()
  const summary = { brokerages_processed: 0, insights_written: 0, errors: 0 }

  try {
    const { data: brokerages } = await svc
      .from("brokerages").select("id").is("deleted_at", null)

    for (const b of (brokerages ?? []) as Array<{ id: string }>) {
      summary.brokerages_processed++
      try {
        const written = await runMiningForBrokerage(b.id)
        summary.insights_written += written
      } catch (e) {
        console.error(`[brokerage-intelligence-mine] ${b.id}:`, e)
        summary.errors++
      }
    }

    await recordCronSuccessAction({
      context_id:        contextId,
      records_processed: summary.insights_written,
      metadata:          summary,
    })
    return NextResponse.json({ message: "Mining complete", summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Mining failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  try {
    const { brokerage_id } = await request.json() as { brokerage_id: string }
    if (!brokerage_id) return NextResponse.json({ error: "brokerage_id required" }, { status: 400 })
    const written = await runMiningForBrokerage(brokerage_id)
    return NextResponse.json({ success: true, insights_written: written })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Mining failed" }, { status: 500 })
  }
}

async function runMiningForBrokerage(brokerageId: string): Promise<number> {
  const svc = createServiceClient()
  const miningRunId = crypto.randomUUID()
  const insights = await mineAllPatterns({ brokerageId })
  if (insights.length === 0) return 0

  // Supersede previous open insights for the patterns we're about to write.
  const patternKeys = Array.from(new Set(insights.map((i) => i.patternKey)))
  await svc
    .from("brokerage_intelligence_insights")
    .update({ status: "superseded" })
    .eq("brokerage_id", brokerageId)
    .eq("status", "open")
    .in("pattern_key", patternKeys)

  // Insert new
  await svc.from("brokerage_intelligence_insights").insert(insights.map((i) => ({
    brokerage_id:            i.brokerageId,
    mining_run_id:           miningRunId,
    pattern_key:             i.patternKey,
    headline:                i.headline,
    metric_label:            i.metricLabel,
    top_quartile_value:      i.topQuartileValue,
    median_value:            i.medianValue,
    bottom_quartile_value:   i.bottomQuartileValue,
    outcome_label:           i.outcomeLabel,
    top_quartile_outcome:    i.topQuartileOutcome,
    median_outcome:          i.medianOutcome,
    bottom_quartile_outcome: i.bottomQuartileOutcome,
    lift_pct:                i.liftPct,
    sample_size:             i.sampleSize,
    supporting_agent_count:  i.supportingAgents.length,
    playbook:                i.playbook,
    playbook_actions:        i.playbookActions,
    supporting_agents:       i.supportingAgents,
    severity:                i.severity,
  })))

  return insights.length
}
