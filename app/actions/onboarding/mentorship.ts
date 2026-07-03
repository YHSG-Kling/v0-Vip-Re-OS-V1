"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { rankMentorMatches, DEFAULT_MENTOR_CAPACITY, type MentorProfile, type MenteeProfile, type MentorMatch } from "@/lib/recruiting/mentor-match"

/**
 * Canonical mentor matcher — deterministic weighted score (replaces the retired LLM-freeform matcher).
 * Surfaces the top-3 eligible mentors and pairs the mentee with the #1 by creating an
 * agent_mentor_relationships row (the ONE canonical mentor table; the deprecated agent_onboarding_sessions
 * path is gone). Idempotent: one active mentor per mentee.
 */
export async function matchMentor(agentId: string): Promise<{ success: boolean; error?: string; mentorId?: string; matchScore?: number; matches?: MentorMatch[] }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  const svc = createServiceClient()
  const { data: mentee } = await svc.from("agents").select("id, brokerage_id, location_id, specializations, years_experience").eq("id", agentId).maybeSingle()
  if (!mentee) return { success: false, error: "Agent not found" }
  const me = mentee as any

  // Eligible mentors: active, in the same brokerage, tenured enough (>= 6 trailing/ytd transactions ~ spec),
  // not the mentee.
  const { data: mentors } = await svc.from("agents")
    .select("id, location_id, specializations, years_experience, ytd_transactions, users(first_name, last_name)")
    .eq("brokerage_id", me.brokerage_id).eq("is_active", true).neq("id", agentId).gte("ytd_transactions", 6).limit(50)
  const mentorRows = (mentors ?? []) as any[]
  if (mentorRows.length === 0) return { success: false, error: "No eligible mentors found yet" }

  // Current mentee load per mentor (capacity dimension).
  const { data: activeRels } = await svc.from("agent_mentor_relationships").select("mentor_agent_id").eq("brokerage_id", me.brokerage_id).eq("status", "active")
  const load = new Map<string, number>()
  for (const r of (activeRels ?? []) as any[]) load.set(r.mentor_agent_id, (load.get(r.mentor_agent_id) ?? 0) + 1)

  const profiles: MentorProfile[] = mentorRows.map((m) => ({
    id: m.id,
    name: [m.users?.first_name, m.users?.last_name].filter(Boolean).join(" ").trim() || null,
    locationId: m.location_id, specializations: m.specializations ?? [], yearsExperience: m.years_experience ?? 0,
    currentMentees: load.get(m.id) ?? 0, capacity: DEFAULT_MENTOR_CAPACITY,
  }))
  const menteeProfile: MenteeProfile = { locationId: me.location_id, specializations: me.specializations ?? [], yearsExperience: me.years_experience ?? 0 }

  const matches = rankMentorMatches(menteeProfile, profiles, 3)
  const best = matches[0]
  if (!best) return { success: false, error: "No mentor match found" }

  // Idempotent: if the mentee already has an active mentor, keep it (return the ranking for review).
  const { data: existing } = await svc.from("agent_mentor_relationships").select("id").eq("mentee_agent_id", agentId).eq("status", "active").maybeSingle()
  if (!existing) {
    await svc.from("agent_mentor_relationships").insert({
      brokerage_id: me.brokerage_id, mentee_agent_id: agentId, mentor_agent_id: best.mentorId, status: "active",
      start_date: new Date().toISOString(),
      notes: JSON.stringify({ reason: best.reason, score: best.score, topics: ["First-30-days plan", "Your first showing", "Pricing conversations"] }),
    })
  }
  return { success: true, mentorId: best.mentorId, matchScore: best.score, matches }
}
