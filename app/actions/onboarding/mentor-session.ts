"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { computeMentorLift, type MentorLift } from "@/lib/recruiting/mentor-lift"

/**
 * Log a mentor session (mentor-side). Records it in the canonical mentor_sessions table and awards the
 * consolidated gamification ledger points (MENTOR_SESSION_HELD, 75) to BOTH mentor and mentee — reinforcing
 * the single-ledger consolidation. A low mentee rating (<=2) surfaces a mismatch flag to the broker.
 */
export async function logMentorSession(input: {
  relationshipId?: string | null
  mentorAgentId: string
  menteeAgentId: string
  sessionType?: string
  durationMinutes?: number
  topics?: string[]
  menteeRating?: number
  actionItem?: string
  notes?: string
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not authenticated" }
  const svc = createServiceClient()

  const { data: mentor } = await svc.from("agents").select("brokerage_id").eq("id", input.mentorAgentId).maybeSingle()
  const brokerageId = (mentor as any)?.brokerage_id ?? null

  const { data: row, error } = await svc.from("mentor_sessions").insert({
    brokerage_id: brokerageId, relationship_id: input.relationshipId ?? null,
    mentor_agent_id: input.mentorAgentId, mentee_agent_id: input.menteeAgentId,
    session_type: input.sessionType ?? "check_in", duration_minutes: input.durationMinutes ?? null,
    topics: input.topics ?? null, mentee_rating: input.menteeRating ?? null,
    action_item: input.actionItem ?? null, mentor_notes: input.notes ?? null, logged_by: user.id,
  }).select("id").single()
  if (error || !row) return { ok: false, error: error?.message ?? "insert failed" }

  // Award consolidated-ledger points to both parties (best-effort).
  if (brokerageId) {
    await svc.from("agent_points_log").insert([
      { agent_id: input.mentorAgentId, brokerage_id: brokerageId, points: 75, reason: "MENTOR_SESSION_HELD", reference_type: "mentor_session", reference_id: (row as any).id },
      { agent_id: input.menteeAgentId, brokerage_id: brokerageId, points: 75, reason: "MENTOR_SESSION_HELD", reference_type: "mentor_session", reference_id: (row as any).id },
    ]).then(undefined, () => {})
  }

  // Low rating → surface a possible-mismatch flag to the broker.
  if ((input.menteeRating ?? 5) <= 2 && brokerageId) {
    try {
      const { resolveOrgRecipients } = await import("@/lib/kernel/org-recipients")
      const recipients = await resolveOrgRecipients(svc, brokerageId)
      for (const uid of recipients) {
        await svc.from("notifications").insert({ user_id: uid, brokerage_id: brokerageId, type: "mentor_mismatch_review", title: "A mentee rated a session poorly", body: "Consider reviewing this mentor pairing.", entity_type: "agent", entity_id: input.menteeAgentId, priority: "medium", is_read: false }).then(undefined, () => {})
      }
    } catch { /* best-effort */ }
  }
  return { ok: true, id: (row as any).id }
}

/**
 * Broker KPI — mentored vs unmentored production/retention lift. Compares newer agents (<2 yrs) with an
 * active mentor to those without. Honest: null lifts + no verdict until each cohort has enough agents.
 */
export async function getMentorLift(brokerageId: string): Promise<MentorLift> {
  const svc = createServiceClient()
  const [{ data: agents }, { data: rels }, { data: scores }] = await Promise.all([
    svc.from("agents").select("id, years_experience, ytd_transactions").eq("brokerage_id", brokerageId).eq("is_active", true).limit(2000),
    svc.from("agent_mentor_relationships").select("mentee_agent_id").eq("brokerage_id", brokerageId).eq("status", "active").limit(2000),
    svc.from("agent_retention_scores").select("agent_id, composite_score").eq("brokerage_id", brokerageId).order("score_date", { ascending: false }).limit(5000),
  ])
  const mentored = new Set(((rels ?? []) as any[]).map((r) => r.mentee_agent_id))
  // Latest retention score per agent.
  const latestScore = new Map<string, number>()
  for (const s of (scores ?? []) as any[]) if (!latestScore.has(s.agent_id)) latestScore.set(s.agent_id, Number(s.composite_score) || 0)

  const newer = ((agents ?? []) as any[]).filter((a) => (a.years_experience ?? 0) < 2)
  const toStat = (a: any) => ({ transactions: Number(a.ytd_transactions) || 0, retention: latestScore.get(a.id) ?? 0 })
  return computeMentorLift(newer.filter((a) => mentored.has(a.id)).map(toStat), newer.filter((a) => !mentored.has(a.id)).map(toStat))
}
