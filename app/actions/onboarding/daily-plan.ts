"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveTenantAdmin } from "@/lib/auth/resolve-user-role"
import {
  PHASES, phaseForDay, journeyProgress, buildDailyActionPlan, fallBehindRisk, isPhaseUnlocked,
  type JourneyStep, type DailyActionPlan, type JourneyProgress, type FallBehindRisk,
} from "@/lib/kernel/onboarding-journey"

export interface AgentJourney {
  active: boolean
  progress: JourneyProgress | null
  plan: DailyActionPlan | null
  risk: FallBehindRisk
  phaseFocus: string
  /** Phases still LOCKED by the anti-skip rule (a required step of an earlier
   *  phase is not done) — empty when the agent may work any phase. */
  lockedPhases: number[]
}

/**
 * Session → identity. The same `requireCaller()` shape app/actions/video-generation.ts:57
 * carries (one copy per "use server" file — there is no shared lib helper yet).
 * Reads `{ data, error }` (§3).
 */
async function requireCaller(): Promise<
  | { ok: true; supabase: Awaited<ReturnType<typeof createClient>>; userId: string; brokerageId: string; userType: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not authenticated" }
  const { data: u, error } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (error) return { ok: false, error: `Could not resolve your profile: ${error.message}` }
  if (!u?.brokerage_id) return { ok: false, error: "Your account is not linked to a brokerage" }
  return { ok: true, supabase, userId: user.id, brokerageId: u.brokerage_id as string, userType: String(u.user_type ?? "") }
}

/**
 * Load an agent's 90-day journey: phase progress + today's action plan + fall-behind risk. Read-only.
 *
 * GATED ON THE SESSION (§4) — the same rule as app/actions/career-tier.ts:getAgentCareerProgress.
 * This ran on the SERVICE client with `agentId` straight from the parameter and no auth: any
 * caller could read any agent's onboarding state, contact count and pipeline across every
 * tenant. `agentId` is kept (the card passes the agent's own id; an admin may look at a
 * teammate) but is AUTHORISED, not trusted: the caller's OWN agent row (agents.user_id =
 * session user — disjoint id spaces, §3), OR same-brokerage AND a tenant admin
 * (resolveTenantAdmin — the ONE roster). Anything unverifiable returns the empty journey,
 * which is what the card renders as nothing.
 */
export async function getAgentDailyActionPlan(agentId: string): Promise<AgentJourney> {
  const empty: AgentJourney = { active: false, progress: null, plan: null, risk: "none", phaseFocus: "", lockedPhases: [] }
  if (!agentId) return empty
  const caller = await requireCaller()
  if (!caller.ok) return empty
  const svc = createServiceClient()

  const { data: agentIdentity, error: agentErr } = await svc
    .from("agents")
    .select("id, brokerage_id, user_id")
    .eq("id", agentId)
    .maybeSingle()
  if (agentErr) {
    console.error("[daily-plan] agent read refused:", agentErr.message)
    return empty
  }
  if (!agentIdentity) return empty
  const isOwn = (agentIdentity as any).user_id === caller.userId
  if (!isOwn) {
    if ((agentIdentity as any).brokerage_id !== caller.brokerageId) return empty
    const admin = await resolveTenantAdmin(caller.supabase, caller.userId, {
      user_type: caller.userType,
      brokerage_id: caller.brokerageId,
    })
    if (!admin.ok || !admin.isTenantAdmin) return empty
  }

  const { data: ob, error: obErr } = await svc.from("agent_onboarding").select("agent_id, brokerage_id, current_day, completion_percentage, status, start_date").eq("agent_id", agentId).maybeSingle()
  if (obErr) {
    console.error("[daily-plan] onboarding read refused:", obErr.message)
    return empty
  }
  if (!ob) return empty
  const o = ob as any
  if (o.status && ["completed", "graduated"].includes(String(o.status))) return { ...empty, active: false }

  // Program day: prefer current_day, else derive from start_date.
  const day = o.current_day ?? (o.start_date ? Math.max(1, Math.floor((Date.now() - Date.parse(o.start_date)) / 86_400_000) + 1) : 1)

  const [stepsRes, doneRes, pipelineRes, contactsRes, agentRes] = await Promise.all([
    svc.from("onboarding_steps").select("id, step_name, day_number, required, estimated_minutes, instructions, target_role").or(`brokerage_id.eq.${o.brokerage_id},brokerage_id.is.null`).limit(200),
    svc.from("agent_step_completions").select("step_id").eq("agent_id", agentId).limit(500),
    svc.from("transactions").select("id", { count: "exact", head: true }).eq("agent_id", agentId).in("stage", ["UNDER_CONTRACT", "INSPECTION", "APPRAISAL", "FINANCING_PENDING", "CLOSING_PREP"]),
    // CONTACTS the agent manages — NOT the raw lead queue (unqualified leads stay AI-ISA-owned).
    svc.from("contacts").select("id", { count: "exact", head: true }).eq("agent_id", agentId),
    svc.from("agents").select("users(first_name)").eq("id", agentId).maybeSingle(),
  ])

  const steps: JourneyStep[] = ((stepsRes.data ?? []) as any[])
    .filter((s) => !s.target_role || s.target_role === "agent")
    .map((s) => ({ id: s.id, name: s.step_name ?? "Onboarding step", dayNumber: s.day_number ?? 1, required: !!s.required, estimatedMinutes: s.estimated_minutes, instructions: s.instructions }))
  const completed = new Set(((doneRes.data ?? []) as any[]).map((r) => r.step_id))
  const progress = journeyProgress(day, steps, completed)
  // THE ANTI-SKIP RULE, applied. isPhaseUnlocked was written for exactly this
  // plan and never called: every pending step, whatever its phase, was eligible
  // for today's three priorities, so a day-3 agent could be told to write their
  // first offer (phase 3) while a required phase-1 setup step sat undone. A
  // step is offered only when its phase is unlocked — every REQUIRED step of
  // every earlier phase is complete.
  const unlockedPhase = new Map<number, boolean>(
    PHASES.map((p) => [p.phase, isPhaseUnlocked(p.phase, steps, completed)]),
  )
  const lockedPhases = PHASES.filter((p) => !unlockedPhase.get(p.phase)).map((p) => p.phase)
  const pendingSteps = steps.filter(
    (s) => !completed.has(s.id) && (unlockedPhase.get(phaseForDay(s.dayNumber).phase) ?? false),
  )
  const agentName = (agentRes.data as any)?.users?.first_name ?? null

  const plan = buildDailyActionPlan({
    agentName, dayInProgram: day, phase: progress.phase, pendingSteps,
    contactsToFollow: (contactsRes as any)?.count ?? 0, activePipeline: (pipelineRes as any)?.count ?? 0,
  })

  return { active: true, progress, plan, risk: fallBehindRisk(day, progress.overallPct), phaseFocus: phaseForDay(day).focus, lockedPhases }
}
