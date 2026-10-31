import {
NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

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
 *   - additional_data.last_nudge_sent_at IS NULL OR < now() - 7 days
 *   - start_date >= 2 days ago (give the actor breathing room)
 *
 * For each stalled row the cron EMITS `onboarding.stalled` through the
 * orchestrator (emitEventFromCron); the reaction — the bell to the stalled
 * person, and to the brokerage's admins on a repeat stall — lives in
 * lib/onboarding/stalled-onboarding-reaction.ts (wave 89, lane 89E: until then
 * the row was an audit echo nobody handled and "nudged" meant a timestamp).
 * additional_data.last_nudge_sent_at is MERGED in afterwards so the same row is
 * not re-nudged inside a week.
 */

export async function GET(request: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

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
    // Wave 89 (lane 89E — census round 34). Three defects in this loop, all fixed
    // in place:
    //   1. the header promised "last_nudge_sent_at IS NULL OR < now() - 7 days"
    //      but the query never read it — every in-progress row older than two
    //      days was "nudged" on EVERY run;
    //   2. "nudged" was a lifecycle_events row inserted straight into the table
    //      (an audit echo dispatched to nobody) plus a timestamp — NO NUDGE WAS
    //      SENT. The event is now EMITTED (emitEventFromCron → orchestrator →
    //      EVENT_TYPES.ONBOARDING_STALLED → lib/onboarding/stalled-onboarding-
    //      reaction.ts), and the reaction is the bell;
    //   3. the stamp overwrote the WHOLE additional_data jsonb with one key.
    const { data: agentRows, error: agentRowsErr } = await svc
      .from("agent_onboarding")
      .select("id, user_id, brokerage_id, agent_id, start_date, current_day, completion_percentage, additional_data")
      .eq("status", "in_progress")
      .lt("start_date", twoDaysAgo)
      .limit(100)
    if (agentRowsErr) errors.push(`agent_onboarding read refused: ${agentRowsErr.message}`)

    const { emitEventFromCron } = await import("@/lib/orchestrator/internal")
    for (const r of (agentRows ?? []) as Array<{
      id: string; user_id: string | null; brokerage_id: string;
      agent_id: string; current_day: number; completion_percentage: number;
      additional_data: Record<string, unknown> | null;
    }>) {
      const extra = (r.additional_data && typeof r.additional_data === "object") ? r.additional_data : {}
      const lastNudge = typeof extra.last_nudge_sent_at === "string" ? extra.last_nudge_sent_at : null
      if (lastNudge && lastNudge >= sevenDaysAgo) continue // nudged this week already
      if (!r.user_id) { errors.push(`agent_onboarding ${r.id}: no user_id — nobody to nudge`); continue }

      const emitted = await emitEventFromCron({
        brokerage_id: r.brokerage_id,
        user_id:      r.user_id,
        event_type:   "onboarding.stalled",
        source:       "cron",
        entity_type:  "agent_onboarding",
        entity_id:    r.id,
        // One nudge per row per week; the reaction is idempotent on this key.
        dedupe_key:   `onboarding.stalled:${r.id}:${new Date().toISOString().slice(0, 10)}`,
        payload: {
          onboarding_id:  r.id,
          user_id:        r.user_id,
          actor_kind:     "agent_or_staff",
          completion_pct: r.completion_percentage,
          current_day:    r.current_day,
          repeat:         !!lastNudge,
        },
      })
      if (!emitted.eventId) { errors.push(`agent_onboarding ${r.id}: onboarding.stalled not recorded${emitted.error ? ` — ${emitted.error}` : ""}`); continue }
      // No nudge_sent_at column on agent_onboarding — the stamp lives in additional_data,
      // MERGED (the old write replaced the whole jsonb with this one key).
      const { error: stampErr } = await svc
        .from("agent_onboarding")
        .update({ additional_data: { ...extra, last_nudge_sent_at: new Date().toISOString() }, updated_at: new Date().toISOString() })
        .eq("id", r.id)
        .eq("brokerage_id", r.brokerage_id)
      if (stampErr) errors.push(`agent_onboarding ${r.id}: nudge stamp refused — ${stampErr.message} (the row will be nudged again next run)`)
      agentNudged++
    }

    // Note: customer_onboarding table was dropped in migration 1049 —
    // customer "education" is now milestone-gated via portal-stream
    // projector + learning_modules.gated_until_milestone, not a separate
    // welcome wizard. So this cron now only scans staff/agent onboarding.

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
