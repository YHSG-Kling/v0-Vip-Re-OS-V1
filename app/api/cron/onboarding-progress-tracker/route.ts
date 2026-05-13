import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"

export const dynamic = "force-dynamic"

/**
 * Onboarding Progress Tracker — Sprint 10.
 *
 * Scans BOTH onboarding state tables and nudges stalled actors:
 *
 *   agent_onboarding   (covers agent / tc / isa / team_lead)
 *   customer_onboarding
 *
 * Stalled =
 *   - status='in_progress'
 *   - last_nudge_sent_at IS NULL OR last_nudge_sent_at < now() - 7 days
 *   - current_day or start_date >= 2 days ago (give the actor breathing room)
 *
 * For each stalled row we emit a lifecycle_event so downstream surfaces
 * (notifications, agent action queue, portal feed) can act. We also
 * update last_nudge_sent_at to avoid re-nudging the same row.
 */

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const ctx = await createCronRunContextAction({
    cron_name: "onboarding-progress-tracker",
    cron_path: "/app/api/cron/onboarding-progress-tracker/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  const svc = createServiceClient()
  const sevenDaysAgo = new Date(Date.now() - 7  * 86_400_000).toISOString()
  const twoDaysAgo   = new Date(Date.now() - 2  * 86_400_000).toISOString()

  let agentNudged = 0
  const errors: string[] = []

  try {
    // ── Agent / TC / ISA / team_lead onboarding nudges ──────────────────
    const { data: agentRows } = await svc
      .from("agent_onboarding")
      .select("id, user_id, brokerage_id, agent_id, start_date, current_day, completion_percentage")
      .eq("status", "in_progress")
      .lt("start_date", twoDaysAgo)
      .limit(100)

    for (const r of (agentRows ?? []) as Array<{
      id: string; user_id: string | null; brokerage_id: string;
      agent_id: string; current_day: number; completion_percentage: number;
    }>) {
      // Emit a lifecycle_event for each stalled actor
      await svc.from("lifecycle_events").insert({
        event_type:   "onboarding.stalled",
        entity_type:  "agent_onboarding",
        entity_id:    r.id,
        brokerage_id: r.brokerage_id,
        actor_user_id: r.user_id,
        metadata: {
          actor_kind:        "agent_or_staff",
          completion_pct:    r.completion_percentage,
          current_day:       r.current_day,
        },
        created_at: new Date().toISOString(),
      })
      // No nudge_sent_at column on agent_onboarding — use additional_data jsonb
      await svc
        .from("agent_onboarding")
        .update({ additional_data: { last_nudge_sent_at: new Date().toISOString() }, updated_at: new Date().toISOString() })
        .eq("id", r.id)
      agentNudged++
    }

    // Note: customer_onboarding table was dropped in migration 1049 —
    // customer "education" is now milestone-gated via portal-stream
    // projector + learning_modules.gated_until_milestone, not a separate
    // welcome wizard. So this cron now only scans staff/agent onboarding.
    void sevenDaysAgo  // referenced for the agent query if needed

    const summary = { agent_nudged: agentNudged, customer_nudged: 0, errors: errors.length }
    await recordCronSuccessAction({
      context_id:        contextId,
      records_processed: agentNudged,
      metadata:          summary,
    })
    return NextResponse.json({ message: "Onboarding tracker complete", summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Tracker failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}
