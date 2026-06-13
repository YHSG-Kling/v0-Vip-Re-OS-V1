import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runAgentCoaching } from "@/lib/kernel/agent-coaching"

export const runtime = "nodejs"
export const maxDuration = 300

/**
 * THE AGENT COACHING LOOP cron (weekly) — for each active agent, the Recruiting Manager
 * (who owns agent development/talent) turns the OS's own outcome data into a per-agent
 * coaching brief: what's working, where deals are leaking, and the ONE focus this week.
 * Reuses the agent scorecard + the no-show / stale / tour→offer aggregates — every line
 * earned from a REAL row. Delivered as ONE gated, manager-facing brief per agent per week
 * to the agent's broker/team-lead (audience 'agent') — never autonomously to the agent.
 * A brand-new agent with no data gets an honest minimal brief, not fabricated criticism.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "agent-coaching",
    cron_path: "/app/api/cron/agent-coaching/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let agents = 0, briefs = 0, thin = 0, withLeaks = 0

  try {
    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error
    for (const b of (rows ?? []) as Array<{ id: string }>) {
      try {
        const r = await runAgentCoaching(b.id, {}, supabase)
        agents += r.agentsConsidered; briefs += r.briefsProposed
        thin += r.thinDataBriefs; withLeaks += r.briefsWithLeaks
        if (r.errors.length) errors.push(...r.errors.slice(0, 5).map((e) => `${b.id}: ${e}`))
      } catch (e: any) { errors.push(`${b.id}: ${e?.message ?? String(e)}`) }
    }
    await recordCronSuccessAction({
      context_id: contextId, records_processed: briefs,
      metadata: { agents, briefs, thin, withLeaks, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, agents, briefs, thin, withLeaks })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
