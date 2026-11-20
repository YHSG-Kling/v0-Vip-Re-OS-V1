"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { rankMentorMatches, DEFAULT_MENTOR_CAPACITY, type MentorProfile, type MenteeProfile, type MentorMatch } from "@/lib/recruiting/mentor-match"

/**
 * Canonical mentor matcher — deterministic weighted score (replaces the retired LLM-freeform matcher).
 * Surfaces the top-3 eligible mentors and pairs the mentee with the #1 by creating an
 * agent_mentor_relationships row (the ONE canonical mentor table; the deprecated agent_onboarding_sessions
 * path is gone). Idempotent: one active mentor per mentee.
 */
export async function matchMentor(agentId: string): Promise<{ success: boolean; error?: string; mentorId?: string; matchScore?: number; matches?: MentorMatch[] }> {
  // WAVE 155 (lane 155S1, P0) — GATE FIRST, THEN THE SERVICE CLIENT (CLAUDE.md §4). Any signed-in user could create an
  // agent_mentor_relationships row for ANY agentId of ANY brokerage (the mentee's own brokerage_id was taken off the
  // argument's row). Now the caller is the SESSION (requireCaller): the mentee is read PINNED to the session's tenant, so
  // another tenant's agent answers "Agent not found" with nothing written; and an ordinary seat may only match ITSELF —
  // the one caller (app/dashboard/onboarding/mentorship/mentorship-client.tsx) passes the viewer's own agents.id — while a
  // tenant admin (TENANT_ADMIN_USER_TYPES, lib/auth/resolve-user-role.ts — never a retyped list) may pair any agent of the
  // tenant. agents.id and users.id are disjoint (§3): "itself" is crossed through agents.user_id.
  if (typeof agentId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId)) return { success: false, error: "Agent not found" }
  const { requireCaller } = await import("@/lib/auth/require-caller")
  const caller = await requireCaller()
  if (!caller.ok) return { success: false, error: caller.reason === "unauthenticated" ? "Not authenticated" : caller.error }
  const user = { id: caller.userId }
  type MatchResult = { success: boolean; error?: string; mentorId?: string; matchScore?: number; matches?: MentorMatch[] }
  const gateSvc = createServiceClient()
  const { data: menteeRow, error: menteeErr } = await gateSvc.from("agents").select("id, user_id, brokerage_id, location_id, specializations, years_experience").eq("id", agentId).eq("brokerage_id", caller.brokerageId).maybeSingle()
  if (menteeErr) return { success: false, error: "The agent could not be read. Try again in a moment." }
  if (!menteeRow) return { success: false, error: "Agent not found" }
  const { TENANT_ADMIN_USER_TYPES } = await import("@/lib/auth/resolve-user-role")
  const isTenantAdmin = TENANT_ADMIN_USER_TYPES.has(String(caller.userType ?? "").toLowerCase())
  if (!isTenantAdmin && (menteeRow as { user_id?: string | null }).user_id !== caller.userId) return { success: false, error: "Agent not found" }
  const run = async (): Promise<MatchResult> => {

  const svc = gateSvc
  const me = menteeRow as any

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
    const { error: mentorMatchErr } = await svc.from("agent_mentor_relationships").insert({
      brokerage_id: me.brokerage_id, mentee_agent_id: agentId, mentor_agent_id: best.mentorId, status: "active",
      start_date: new Date().toISOString(),
      notes: JSON.stringify({ reason: best.reason, score: best.score, topics: ["First-30-days plan", "Your first showing", "Pricing conversations"] }),
    })
    if (mentorMatchErr) console.error(`[mentorship] mentor relationship NOT created: ${mentorMatchErr.message}`)
  }
  return { success: true, mentorId: best.mentorId, matchScore: best.score, matches }
  }
  // Receipt against the SESSION user's tenant (requireCaller above refuses a seat with no tenant).
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  return ledgerSessionAction<MatchResult>({ brokerageId: caller.brokerageId, action: "onboarding.mentor.match", actor: { type: "user", userId: user.id }, subject: { type: "agent", id: agentId }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED" }, run)
}
