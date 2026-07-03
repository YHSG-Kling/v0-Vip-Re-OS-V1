import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { MentorshipClient } from "./mentorship-client"

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
  const { data: relationship } = await supabase
    .from("agent_mentor_relationships")
    .select("mentor_agent_id, status, notes, agents:mentor_agent_id(id, user:users(full_name, email, phone))")
    .eq("mentee_agent_id", agent.id)
    .eq("status", "active")
    .maybeSingle()

  const parsedNotes = (() => {
    const n = relationship?.notes
    if (!n) return { topics: [] as string[], reason: null as string | null, score: null as number | null }
    try {
      const p = JSON.parse(n)
      if (Array.isArray(p)) return { topics: p as string[], reason: null, score: null }
      return { topics: Array.isArray(p.topics) ? p.topics : [], reason: p.reason ?? null, score: typeof p.score === "number" ? p.score : null }
    } catch { return { topics: [n], reason: null, score: null } }
  })()

  const mentorData = relationship
    ? {
        mentorId: relationship.mentor_agent_id as string,
        mentorName: (relationship.agents as any)?.user?.full_name ?? "Your Mentor",
        mentorEmail: (relationship.agents as any)?.user?.email ?? null,
        mentorPhone: (relationship.agents as any)?.user?.phone ?? null,
        suggestedTopics: parsedNotes.topics,
        matchScore: parsedNotes.score,
        matchReason: parsedNotes.reason,
      }
    : null

  return (
    <MentorshipClient
      agentId={agent.id}
      brokerageId={agent.brokerage_id}
      initialMentor={mentorData}
    />
  )
}
