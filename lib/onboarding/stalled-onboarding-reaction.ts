/**
 * lib/onboarding/stalled-onboarding-reaction.ts — THE reaction to `onboarding.stalled`
 * (wave 89, lane 89E — census round 34, event-flow known gap → handler BUILT).
 *
 * THE DEFECT. app/api/cron/onboarding-progress-tracker wrote an `onboarding.stalled`
 * lifecycle_events row straight into the table (an audit echo, dispatched to nobody),
 * then stamped `additional_data.last_nudge_sent_at` and counted `agent_nudged++` —
 * and NO NUDGE WAS EVER SENT. "Nudge sent" was a timestamp with no bell behind it,
 * and the stamp overwrote the whole `additional_data` jsonb with that one key.
 *
 * THE FIX. The cron now EMITS the event (emitEventFromCron → orchestrateEvent →
 * EVENT_TYPES.ONBOARDING_STALLED → this core, the same rail every routed event
 * uses), and this is the nudge: an in-app bell to the stalled person, and — on a
 * REPEAT stall (the cron already nudged once ≥ 7 days ago and the row is still in
 * progress) — a second bell to the brokerage's admins so a human can step in
 * (owner, wave 89: "brokerages need agent fatigue signals so they can give the
 * support that they are lacking before they decide to leave").
 *
 * SHAPE (template lib/portal/journey-event-handlers.ts): server-only, service
 * client, tenant = the EVENT row's brokerage_id, every write's `{ error }` read
 * and returned — never logged-and-dropped (CLAUDE.md §3).
 *
 * notifications vocabulary (scripts/check-vocabularies.ts): priority
 * low|medium|high|critical; channel email|in_app|sms. `type` has no CHECK.
 */
import "server-only"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"

export interface StalledOnboardingPayload {
  onboarding_id?: string | null
  /** users.id of the stalled person (agent_onboarding.user_id). */
  user_id?: string | null
  current_day?: number | null
  completion_pct?: number | null
  /** true when the cron had already nudged this row once (≥ 7 days earlier). */
  repeat?: boolean | null
}

export interface StalledOnboardingOutcome { success: boolean; written: number; error?: string }

/** PURE: the copy of the nudge — specific to the stall, one next step, never a scold. */
export function stalledOnboardingCopy(p: { currentDay: number | null; completionPct: number | null; repeat: boolean }): { title: string; body: string } {
  const pct = typeof p.completionPct === "number" ? Math.max(0, Math.min(100, Math.round(p.completionPct))) : null
  const day = typeof p.currentDay === "number" && p.currentDay > 0 ? p.currentDay : null
  const where = [day ? `day ${day}` : null, pct !== null ? `${pct}% complete` : null].filter(Boolean).join(", ")
  return {
    title: p.repeat ? "Still stuck on onboarding? Let's get you unblocked" : "Pick up your onboarding where you left off",
    body:
      `${where ? `You're at ${where}. ` : ""}The next step is waiting on your Onboarding page — most people finish a step in under ten minutes.` +
      (p.repeat ? " If something is in the way, reply here and your broker will help." : ""),
  }
}

/** onboarding.stalled — the bell to the stalled person; admins too on a repeat stall. */
export async function reactToOnboardingStalled(
  svc: any,
  brokerageId: string,
  payload: StalledOnboardingPayload,
): Promise<StalledOnboardingOutcome> {
  if (!brokerageId) return { success: false, written: 0, error: "No brokerageId — an onboarding nudge is never sent untenanted" }
  const userId = payload?.user_id ?? null
  if (!userId) return { success: false, written: 0, error: "No user_id on the onboarding.stalled event — nobody to nudge" }
  const repeat = payload?.repeat === true
  const copy = stalledOnboardingCopy({ currentDay: payload?.current_day ?? null, completionPct: payload?.completion_pct ?? null, repeat })

  let written = 0
  const { error: bellErr } = await svc.from("notifications").insert({
    brokerage_id: brokerageId,
    user_id: userId,
    type: "onboarding_stalled",
    entity_type: "agent_onboarding",
    entity_id: payload?.onboarding_id ?? null,
    title: copy.title,
    body: copy.body,
    priority: repeat ? "high" : "medium",
    channel: "in_app",
    is_read: false,
  })
  if (bellErr) return { success: false, written, error: `stalled-onboarding bell refused for user ${userId}: ${bellErr.message}` }
  written++

  if (!repeat) return { success: true, written }

  // Repeat stall → the brokerage's admins (CLAUDE.md §4 roster: TENANT_ADMIN_USER_TYPES,
  // spread never restated), inside the tenant. Two bells at most.
  const { data: admins, error: adminErr } = await svc
    .from("users")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .in("user_type", [...TENANT_ADMIN_USER_TYPES])
    .neq("id", userId)
    .limit(2)
  if (adminErr) return { success: false, written, error: `admin roster read refused: ${adminErr.message}` }
  for (const a of ((admins ?? []) as Array<{ id: string }>)) {
    const { error } = await svc.from("notifications").insert({
      brokerage_id: brokerageId,
      user_id: a.id,
      type: "onboarding_stalled_escalation",
      entity_type: "agent_onboarding",
      entity_id: payload?.onboarding_id ?? null,
      title: "An onboarding is stalled for a second week",
      body: `A team member's onboarding has been nudged twice and is still in progress${typeof payload?.completion_pct === "number" ? ` (${Math.round(payload.completion_pct)}% complete)` : ""}. A ten-minute check-in usually gets them moving.`,
      priority: "medium",
      channel: "in_app",
      is_read: false,
    })
    if (error) return { success: false, written, error: `stalled-onboarding escalation bell refused for admin ${a.id}: ${error.message}` }
    written++
  }
  return { success: true, written }
}
