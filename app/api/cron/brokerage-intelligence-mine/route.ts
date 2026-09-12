import {
NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { mineAllPatterns } from "@/lib/brokerage-intelligence/miners"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

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
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

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
  const summary = { brokerages_processed: 0, insights_written: 0, followups_recorded: 0, errors: 0 }

  try {
    const { data: brokerages } = await svc
      .from("brokerages").select("id").is("deleted_at", null)

    for (const b of (brokerages ?? []) as Array<{ id: string }>) {
      summary.brokerages_processed++
      try {
        const { written, followupsRecorded } = await runMiningForBrokerage(b.id)
        summary.insights_written += written
        summary.followups_recorded += followupsRecorded
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
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth
  try {
    const { brokerage_id } = await request.json() as { brokerage_id: string }
    if (!brokerage_id) return NextResponse.json({ error: "brokerage_id required" }, { status: 400 })
    const { written, followupsRecorded } = await runMiningForBrokerage(brokerage_id)
    return NextResponse.json({ success: true, insights_written: written, followups_recorded: followupsRecorded })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Mining failed" }, { status: 500 })
  }
}

async function runMiningForBrokerage(brokerageId: string): Promise<{ written: number; followupsRecorded: number }> {
  const svc = createServiceClient()
  const miningRunId = crypto.randomUUID()
  const insights = await mineAllPatterns({ brokerageId })
  if (insights.length === 0) return { written: 0, followupsRecorded: 0 }

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

  const followupsRecorded = await recordAdoptionFollowups(svc, brokerageId, insights)
  return { written: insights.length, followupsRecorded }
}

/**
 * +30d OUTCOME CHECK for pattern_adoptions (orphan tranche X4, 2026-09-01).
 *
 * pattern_adoptions.{baseline_metric, followup_metric, observed_lift_pct,
 * followup_at} were designed for exactly this pass (1037-brokerage-intelligence-
 * mesh.sql: "populated by a follow-up cron at +30d") and no cron ever ran it —
 * the mesh page rendered a Baseline/Follow-up/Lift table that could only ever
 * show "—" and "pending". This closes the loop by EXTENDING the existing weekly
 * mine (not a new surface): every fresh mining run re-measures the same
 * per-pattern outcome metric, so for each adoption ≥30 days old whose pattern
 * was re-mined this run, followup_metric is that pattern's fresh median_outcome
 * and observed_lift_pct is DERIVED from (followup − baseline) / baseline (§2 —
 * never a stored constant). baseline_metric is stamped at adoption time from the
 * adopted insight's median_outcome (app/actions/brokerage-intelligence.ts).
 * Legacy adoptions with no baseline still get followup_metric + followup_at, and
 * lift stays NULL — the mesh page renders that as "n/a", not "pending".
 * The measurement is the brokerage-median movement of the metric, since the
 * miners publish cohort medians, not per-agent series — the honest number
 * available without re-deriving each miner per agent.
 */
const FOLLOWUP_DAYS = 30

async function recordAdoptionFollowups(
  svc: ReturnType<typeof createServiceClient>,
  brokerageId: string,
  freshInsights: Awaited<ReturnType<typeof mineAllPatterns>>,
): Promise<number> {
  const freshByPattern = new Map<string, number>()
  for (const i of freshInsights) freshByPattern.set(i.patternKey, i.medianOutcome)

  const cutoff = new Date(Date.now() - FOLLOWUP_DAYS * 86_400_000).toISOString()
  const { data: due, error } = await svc
    .from("pattern_adoptions")
    .select("id, baseline_metric, insight:brokerage_intelligence_insights(pattern_key)")
    .eq("brokerage_id", brokerageId)
    .is("followup_at", null)
    .lte("created_at", cutoff)
    .limit(200)
  if (error) {
    console.error(`[brokerage-intelligence-mine] follow-up read failed for ${brokerageId}:`, error.message)
    return 0
  }

  let recorded = 0
  type DueRow = { id: string; baseline_metric: number | string | null; insight: { pattern_key: string | null } | Array<{ pattern_key: string | null }> | null }
  for (const row of (due ?? []) as unknown as DueRow[]) {
    // supabase-js types a to-one embed as an array even though PostgREST returns
    // an object for a single-FK parent — tolerate both shapes.
    const insight = Array.isArray(row.insight) ? row.insight[0] ?? null : row.insight
    const patternKey = insight?.pattern_key
    if (!patternKey) continue
    const followup = freshByPattern.get(patternKey)
    // Pattern not re-measured this run (below the miner's publish floor) — the
    // adoption stays due; a later run that re-measures it will record then.
    if (followup == null || !Number.isFinite(followup)) continue

    const baseline = row.baseline_metric == null ? null : Number(row.baseline_metric)
    const lift = baseline != null && Number.isFinite(baseline) && baseline > 0
      ? Math.round(((followup - baseline) / baseline) * 1000) / 10
      : null

    // COUNTED update (§3): .select() the write — a refusal or a vanished row is
    // visible instead of resolving as byte-identical success.
    const { data: updated, error: updErr } = await svc
      .from("pattern_adoptions")
      .update({
        followup_metric:   followup,
        observed_lift_pct: lift,
        followup_at:       new Date().toISOString(),
      })
      .eq("id", row.id)
      .is("followup_at", null)
      .select("id")
    if (updErr) {
      console.error(`[brokerage-intelligence-mine] follow-up write refused for adoption ${row.id}:`, updErr.message)
      continue
    }
    recorded += (updated ?? []).length
  }
  return recorded
}
