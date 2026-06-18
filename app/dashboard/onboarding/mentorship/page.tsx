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

  // Check existing mentor assignment
  const [{ data: session }, { data: relationship }] = await Promise.all([
    supabase
      .from("agent_onboarding_sessions")
      .select("assigned_mentor_id, mentor_match_score, mentor_match_reason")
      .eq("agent_id", agent.id)
      .maybeSingle(),
    supabase
      .from("agent_mentor_relationships")
      // live columns: mentee_agent_id/mentor_agent_id (not mentee_id/mentor_id);
      // suggested topics are stored in the notes text column by the onboarding writer.
      .select("mentor_agent_id, status, notes, agents:mentor_agent_id(id, user:users(full_name, email, phone))")
      .eq("mentee_agent_id", agent.id)
      .eq("status", "active")
      .maybeSingle(),
  ])

  const mentorData = relationship
    ? {
        mentorId: relationship.mentor_agent_id as string,
        mentorName: (relationship.agents as any)?.user?.full_name ?? "Your Mentor",
        mentorEmail: (relationship.agents as any)?.user?.email ?? null,
        mentorPhone: (relationship.agents as any)?.user?.phone ?? null,
        suggestedTopics: (() => {
          const n = relationship.notes
          if (!n) return [] as string[]
          try { const p = JSON.parse(n); return Array.isArray(p) ? p : [n] } catch { return [n] }
        })(),
        matchScore: session?.mentor_match_score ?? null,
        matchReason: session?.mentor_match_reason ?? null,
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
