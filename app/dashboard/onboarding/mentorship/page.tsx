import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { MentorshipClient } from "./mentorship-client"
import { listMentorSessions, type MentorSessionEntry } from "@/app/actions/onboarding/mentor-session"

export const dynamic = "force-dynamic"

export default async function MentorshipPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const { data: agent } = await supabase
    .from("agents")
    .select("id, brokerage_id")
    .eq("user_id", user.id)
    .maybeSingle()

  if (!agent) redirect("/dashboard/onboarding")

  // Existing mentor assignment — the CANONICAL agent_mentor_relationships is the single source of truth
  // (the deprecated agent_onboarding_sessions mentor columns are retired). The matcher stores the match
  // reason/score/topics as JSON in the notes column.
  // `users` has NO `full_name` (verified against information_schema) — a name is
  // first_name + last_name — so PostgREST rejected this ENTIRE select and the
  // page could never show a mentor, even for a mentee who has one. The
  // mentor_agent_id hint is required: agent_mentor_relationships has TWO FKs to
  // agents (mentor_agent_id, mentee_agent_id). agents.user_id -> users.id is a
  // single FK, so `user` is an OBJECT.
  const { data: relationship, error: relationshipError } = await supabase
    .from("agent_mentor_relationships")
    .select(
      "mentor_agent_id, status, notes, agents:mentor_agent_id(id, phone_mobile, phone_office, user:users(first_name, last_name, email, phone))",
    )
    .eq("mentee_agent_id", agent.id)
    .eq("status", "active")
    .maybeSingle()

  // supabase-js RESOLVES a failed query, so `const { data }` alone rendered a
  // rejected read as "you have no mentor yet".
  if (relationshipError) {
    console.error("[MentorshipPage] mentor read refused:", relationshipError.message)
  }

  const parsedNotes = (() => {
    const n = relationship?.notes
    if (!n) return { topics: [] as string[], reason: null as string | null, score: null as number | null }
    try {
      const p = JSON.parse(n)
      if (Array.isArray(p)) return { topics: p as string[], reason: null, score: null }
      return { topics: Array.isArray(p.topics) ? p.topics : [], reason: p.reason ?? null, score: typeof p.score === "number" ? p.score : null }
    } catch { return { topics: [n], reason: null, score: null } }
  })()

  // The READ has to move with the select: `?.user?.full_name` would still be
  // undefined and mentorName would stay "Your Mentor" forever. Phone prefers the
  // mentor's own client-facing numbers on `agents`; users.phone is the fallback.
  const mentorAgent = (relationship?.agents ?? null) as Record<string, any> | null
  const mentorUser = (mentorAgent?.user ?? null) as Record<string, any> | null
  const mentorName =
    [mentorUser?.first_name, mentorUser?.last_name].filter(Boolean).join(" ") || null

  const mentorData = relationship
    ? {
        mentorId: relationship.mentor_agent_id as string,
        mentorName: mentorName ?? "Your Mentor",
        mentorEmail: mentorUser?.email ?? null,
        mentorPhone:
          mentorAgent?.phone_mobile ?? mentorAgent?.phone_office ?? mentorUser?.phone ?? null,
        suggestedTopics: parsedNotes.topics,
        matchScore: parsedNotes.score,
        matchReason: parsedNotes.reason,
      }
    : null

  // THE COACHING HISTORY. logMentorSession has written mentor_sessions since it
  // was built and NOTHING read the table: the rating a mentee gave, the action
  // item the pair agreed and the mentor's notes were all recorded and then
  // unreachable by either of them. A refusal is surfaced rather than rendered as
  // "no sessions yet" — an empty coaching history is a claim, not a default.
  const sessionsRes = await listMentorSessions(25)
  const sessions: MentorSessionEntry[] = sessionsRes.ok ? sessionsRes.entries : []
  const sessionsError = sessionsRes.ok ? null : sessionsRes.error

  return (
    <MentorshipClient
      agentId={agent.id}
      brokerageId={agent.brokerage_id}
      initialMentor={mentorData}
      sessions={sessions}
      sessionsError={sessionsError}
    />
  )
}
