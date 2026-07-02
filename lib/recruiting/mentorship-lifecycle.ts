// lib/recruiting/mentorship-lifecycle.ts
//
// MENTORSHIP LIFECYCLE (recruiting_manager) — agent_mentor_relationships was a STATIC record: created
// once at onboarding (the AI matcher pairs a new agent with a tenured mentor), then never touched. It
// never checked in and never ended — a mentorship sat 'active' forever with zero touchpoints. This gives
// it a life: while a pairing is active it proposes GATED periodic "check in with your mentee" nudges to
// the mentor, and when the mentee COMPLETES onboarding it GRADUATES the pairing (status completed +
// end_date) so it doesn't linger. Reuses the gated proposal rail (nothing auto-sends); the matcher is
// untouched. Pure cadence/graduation logic is unit-tested; the runner does the I/O.

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

/** Default cadence between mentor check-in nudges (days). */
export const MENTORSHIP_CHECKIN_DAYS = 14

function daysBetween(a: number, b: number): number {
  return Math.floor((a - b) / 86_400_000)
}

/**
 * PURE: is a mentor check-in due? Due when the pairing has had no nudge within the cadence window
 * (measured from the last nudge, or the start date if none yet). Undated pairings never nudge (honest).
 */
export function mentorshipCheckInDue(
  startDate: string | null, lastNudgeAt: string | null, now: Date, cadenceDays: number = MENTORSHIP_CHECKIN_DAYS,
): boolean {
  const nowMs = now.getTime()
  const anchor = lastNudgeAt ?? startDate
  if (!anchor) return false
  const anchorMs = Date.parse(anchor)
  if (Number.isNaN(anchorMs)) return false
  return daysBetween(nowMs, anchorMs) >= cadenceDays
}

/** PURE: should an active pairing graduate? Yes once the mentee has completed onboarding certification. */
export function shouldGraduate(status: string | null, menteeCertificationAchieved: boolean | null): boolean {
  return status === "active" && menteeCertificationAchieved === true
}

/** The period bucket for a pairing's check-in (one nudge per window) — the idempotency key suffix. */
export function checkInPeriod(startDate: string | null, now: Date, cadenceDays: number = MENTORSHIP_CHECKIN_DAYS): number {
  if (!startDate) return 0
  const startMs = Date.parse(startDate)
  if (Number.isNaN(startMs)) return 0
  return Math.max(0, Math.floor(daysBetween(now.getTime(), startMs) / cadenceDays))
}

export interface MentorshipLifecycleResult { scanned: number; graduated: number; nudged: number }

/**
 * Advance every active mentorship in a brokerage: graduate the ones whose mentee finished onboarding,
 * and propose a gated mentor check-in for the ones that are due. Idempotent (graduation is terminal; one
 * nudge per (pairing, period)). Best-effort; never throws into the caller.
 */
export async function runMentorshipLifecycle(
  svc: Svc, params: { brokerageId: string; now?: Date; cadenceDays?: number },
): Promise<MentorshipLifecycleResult> {
  const out: MentorshipLifecycleResult = { scanned: 0, graduated: 0, nudged: 0 }
  const now = params.now ?? new Date()
  const cadence = params.cadenceDays ?? MENTORSHIP_CHECKIN_DAYS

  const { data: rels } = await svc
    .from("agent_mentor_relationships")
    .select("id, mentor_agent_id, mentee_agent_id, status, start_date")
    .eq("brokerage_id", params.brokerageId).eq("status", "active").limit(500)

  for (const r of (rels ?? []) as any[]) {
    out.scanned++

    // GRADUATION — mentee completed onboarding certification → end the pairing.
    const { data: ob } = await svc.from("agent_onboarding").select("certification_achieved").eq("agent_id", r.mentee_agent_id).maybeSingle()
    if (shouldGraduate(r.status, (ob as any)?.certification_achieved ?? null)) {
      await svc.from("agent_mentor_relationships").update({ status: "completed", end_date: now.toISOString() }).eq("id", r.id)
      out.graduated++
      continue
    }

    // CHECK-IN NUDGE — gated mentor reminder, one per (pairing, period).
    const period = checkInPeriod(r.start_date, now, cadence)
    const dedupeTag = `MENTORSHIP CHECK-IN — rel:${r.id} — period:${period}`
    const { data: prior } = await svc
      .from("agent_client_messages")
      .select("id")
      .eq("brokerage_id", params.brokerageId).eq("entity_type", "mentorship").eq("entity_id", r.id)
      .eq("agent_kind", "recruiting_manager").ilike("rationale", `${dedupeTag}%`)
      .limit(1).maybeSingle()
    if (prior) continue

    // Only nudge once the cadence window has elapsed since the last touch/start.
    const { data: lastNudge } = await svc
      .from("agent_client_messages")
      .select("created_at")
      .eq("brokerage_id", params.brokerageId).eq("entity_type", "mentorship").eq("entity_id", r.id)
      .eq("agent_kind", "recruiting_manager").order("created_at", { ascending: false }).limit(1).maybeSingle()
    if (!mentorshipCheckInDue(r.start_date, (lastNudge as any)?.created_at ?? null, now, cadence)) continue

    const menteeName = await agentName(svc, r.mentee_agent_id)
    try {
      const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
      const res = await proposeClientMessage({
        brokerageId: params.brokerageId, agentKind: "recruiting_manager", entityType: "mentorship", entityId: r.id,
        recipientContactId: null, audience: "agent",
        subject: `Time to check in with ${menteeName}`,
        body: [
          `Your mentee ${menteeName} is still ramping. A quick check-in goes a long way — see how their first deals and pipeline are shaping up and where you can unblock them.`,
          `Reply here with a note after you connect, and I'll keep the cadence going.`,
        ].join("\n\n"),
        rationale: `${dedupeTag} — mentor check-in for ${menteeName}; review before it goes out.`,
        channel: "portal",
      }, svc)
      if (res.ok) out.nudged++
    } catch { /* best-effort */ }
  }
  return out
}

async function agentName(svc: Svc, agentId: string | null): Promise<string> {
  if (!agentId) return "your mentee"
  const { data: a } = await svc.from("agents").select("user_id").eq("id", agentId).maybeSingle()
  const uid = (a as { user_id?: string | null } | null)?.user_id ?? null
  if (!uid) return "your mentee"
  const { data: u } = await svc.from("users").select("first_name, last_name").eq("id", uid).maybeSingle()
  return [(u as any)?.first_name, (u as any)?.last_name].filter(Boolean).join(" ").trim() || "your mentee"
}

/** Autonomous: advance mentorships across every brokerage (rides the daily onboarding cron). */
export async function runMentorshipLifecycleAll(svc: Svc, now?: Date): Promise<{ brokerages: number; graduated: number; nudged: number }> {
  const out = { brokerages: 0, graduated: 0, nudged: 0 }
  const { data: rows } = await svc.from("brokerages").select("id").limit(1000)
  for (const b of (rows ?? []) as Array<{ id: string }>) {
    out.brokerages++
    try { const r = await runMentorshipLifecycle(svc, { brokerageId: b.id, now }); out.graduated += r.graduated; out.nudged += r.nudged } catch { /* keep going */ }
  }
  return out
}
