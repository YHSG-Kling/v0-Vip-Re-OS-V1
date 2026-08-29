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

  // Award to both parties through the ONE atomic award path (m484's
  // public.award_agent_points). A raw ledger insert stood here, which advanced the
  // ledger and left agents.gamification_points untouched — so a mentor could hold
  // ten sessions, earn 750 points on the board, and see no change to their tier.
  if (brokerageId) {
    const { awardAgentPoints, POINT_VALUES } = await import("@/lib/gamification/award-points")
    for (const agentId of [input.mentorAgentId, input.menteeAgentId]) {
      const awarded = await awardAgentPoints(svc, {
        agentId,
        points: POINT_VALUES.MENTOR_SESSION_HELD,
        reason: "MENTOR_SESSION_HELD",
        referenceType: "mentor_session",
        referenceId: (row as any).id,
      })
      if (!awarded.ok) console.error(`[logMentorSession] ${awarded.error}`)
    }
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

/** One logged coaching session, as the mentorship page shows it. */
export interface MentorSessionEntry {
  id: string
  loggedAt: string | null
  /** check_in / deal_review / skill_building / crisis_support. */
  sessionType: string | null
  durationMinutes: number | null
  topics: string[]
  menteeRating: number | null
  actionItem: string | null
  mentorNotes: string | null
  /** True when the viewing agent was the MENTOR on this session. */
  viewerWasMentor: boolean
  /** The other party's display name, resolved through agents.user_id -> users. */
  counterpartName: string | null
  /** Whether this session hangs off the active agent_mentor_relationships row. */
  onCurrentRelationship: boolean
  /** Who pressed "log session" — the accountability half of the record. */
  loggedByName: string | null
}

/**
 * THE COACHING HISTORY — the reader half of logMentorSession.
 *
 * mentor_sessions was written on every logged session and read by NOTHING: the
 * mentorship page had the form and no history, so a mentee's rating, the agreed
 * ACTION ITEM and the mentor's notes were recorded and then unreachable by
 * either party. `getMentorLift` (below) answers a different question entirely —
 * it is a brokerage-level cohort KPI computed from agents/relationships/
 * retention scores and never touches this table — so this is not a second
 * reader of an answered question, it is the missing first one.
 *
 * SCOPE. The rows are the viewer's OWN sessions, on either side of the pairing:
 * `.or(mentor_agent_id.eq.X, mentee_agent_id.eq.X)` plus the agent's brokerage,
 * so a session is visible to the two people who held it and to nobody else.
 * The caller's agent row is resolved from the SESSION (§4), never passed in.
 *
 * §3: `error` is destructured and reported. An RLS refusal rendered as "you
 * have had no sessions" would tell a mentee their coaching history is empty.
 *
 * IDENTITY (§3 trap): `mentor_agent_id`/`mentee_agent_id` are agents.id and
 * `logged_by` is users.id — DISJOINT id spaces. The two lookups are therefore
 * separate, crossing via agents.user_id, never by matching the two directly.
 */
export async function listMentorSessions(
  limit = 25,
): Promise<{ ok: true; entries: MentorSessionEntry[] } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not authenticated" }

  const svc = createServiceClient()
  const { data: me, error: meErr } = await svc
    .from("agents")
    .select("id, brokerage_id")
    .eq("user_id", user.id)
    .maybeSingle()
  if (meErr) return { ok: false, error: `Could not resolve your agent profile: ${meErr.message}` }
  if (!me?.id) return { ok: false, error: "No agent profile" }
  const myAgentId = me.id as string

  const { data: rows, error } = await svc
    .from("mentor_sessions")
    .select(
      "id, created_at, relationship_id, mentor_agent_id, mentee_agent_id, session_type, duration_minutes, topics, mentee_rating, action_item, mentor_notes, logged_by",
    )
    .eq("brokerage_id", me.brokerage_id)
    .or(`mentor_agent_id.eq.${myAgentId},mentee_agent_id.eq.${myAgentId}`)
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(limit, 100)))
  if (error) return { ok: false, error: error.message }

  const list = (rows ?? []) as any[]
  if (list.length === 0) return { ok: true, entries: [] }

  // The relationship that is CURRENT, so a session logged under a retired
  // pairing is not shown as if it belonged to today's mentor.
  const { data: activeRel } = await svc
    .from("agent_mentor_relationships")
    .select("id")
    .eq("brokerage_id", me.brokerage_id)
    .eq("status", "active")
    .or(`mentor_agent_id.eq.${myAgentId},mentee_agent_id.eq.${myAgentId}`)
    .limit(10)
  const activeRelIds = new Set(((activeRel ?? []) as any[]).map((r) => r.id as string))

  // AGENTS class → users, via agents.user_id (agents.id and users.id are disjoint).
  const counterpartAgentIds = [
    ...new Set(
      list
        .map((r) => (r.mentor_agent_id === myAgentId ? r.mentee_agent_id : r.mentor_agent_id))
        .filter(Boolean) as string[],
    ),
  ]
  const nameByAgentId = new Map<string, string>()
  if (counterpartAgentIds.length > 0) {
    const { data: agentRows } = await svc
      .from("agents")
      .select("id, user_id")
      .in("id", counterpartAgentIds)
      .eq("brokerage_id", me.brokerage_id)
    const agentUserIds = ((agentRows ?? []) as any[]).map((a) => a.user_id).filter(Boolean) as string[]
    if (agentUserIds.length > 0) {
      const { data: agentUsers } = await svc
        .from("users")
        .select("id, first_name, last_name, email")
        .in("id", agentUserIds)
      const labelByUserId = new Map<string, string>()
      for (const u of (agentUsers ?? []) as any[]) {
        const label = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email
        if (label) labelByUserId.set(u.id as string, label as string)
      }
      for (const a of (agentRows ?? []) as any[]) {
        const label = a.user_id ? labelByUserId.get(a.user_id as string) : undefined
        if (label) nameByAgentId.set(a.id as string, label)
      }
    }
  }

  // USERS class — logged_by is a users.id written from auth.getUser().
  const loggerIds = [...new Set(list.map((r) => r.logged_by).filter(Boolean) as string[])]
  const nameByUserId = new Map<string, string>()
  if (loggerIds.length > 0) {
    const { data: loggers } = await svc
      .from("users")
      .select("id, first_name, last_name, email")
      .in("id", loggerIds)
    for (const u of (loggers ?? []) as any[]) {
      const label = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email
      if (label) nameByUserId.set(u.id as string, label as string)
    }
  }

  return {
    ok: true,
    entries: list.map((r) => {
      const viewerWasMentor = r.mentor_agent_id === myAgentId
      const counterpartId = viewerWasMentor ? r.mentee_agent_id : r.mentor_agent_id
      return {
        id: r.id as string,
        loggedAt: (r.created_at as string) ?? null,
        sessionType: (r.session_type as string) ?? null,
        durationMinutes: r.duration_minutes == null ? null : Number(r.duration_minutes),
        topics: Array.isArray(r.topics) ? (r.topics as string[]) : [],
        menteeRating: r.mentee_rating == null ? null : Number(r.mentee_rating),
        actionItem: (r.action_item as string) ?? null,
        mentorNotes: (r.mentor_notes as string) ?? null,
        viewerWasMentor,
        counterpartName: counterpartId ? nameByAgentId.get(counterpartId as string) ?? null : null,
        onCurrentRelationship: !!r.relationship_id && activeRelIds.has(r.relationship_id as string),
        loggedByName: r.logged_by ? nameByUserId.get(r.logged_by as string) ?? null : null,
      }
    }),
  }
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
