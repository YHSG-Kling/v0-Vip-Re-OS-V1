import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runCommissionForecaster } from "@/lib/kernel/commission-forecaster"

/**
 * COMMISSION & CAP FORECASTER cron (weekly) — for each active agent, the Deal
 * Coordinator + Campaign Orchestrator project forward off the REAL pipeline: GCI booked
 * YTD + probability-weighted in-progress deals → projected annual GCI, distance to the
 * (optional) commission cap, and the 1-2 highest-leverage deals to push this quarter.
 * One gated agent-facing brief per agent per week (audience 'agent'), with an optional
 * audio brief in the agent's configured assistant voice. Cap/goal are honored only when
 * set — never fabricated. Nothing sends; the brief is the agent's to approve.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "commission-forecaster",
    cron_path: "/app/api/cron/commission-forecaster/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let agents = 0, forecasts = 0, audio = 0, text = 0, caps = 0

  try {
    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error
    for (const b of (rows ?? []) as Array<{ id: string }>) {
      try {
        const r = await runCommissionForecaster(b.id, {}, supabase)
        agents += r.agentsConsidered; forecasts += r.forecastsProposed
        audio += r.audioBriefs; text += r.textBriefs; caps += r.capsConfigured
        if (r.errors.length) errors.push(...r.errors.slice(0, 5).map((e) => `${b.id}: ${e}`))
      } catch (e: any) { errors.push(`${b.id}: ${e?.message ?? String(e)}`) }
    }
    await recordCronSuccessAction({
      context_id: contextId, records_processed: forecasts,
      metadata: { agents, forecasts, audio, text, caps, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, agents, forecasts, audio, text, caps })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
