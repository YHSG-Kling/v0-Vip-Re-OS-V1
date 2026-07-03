"use server"

import { createServiceClient } from "@/lib/supabase/service"
import {
  phaseForDay, journeyProgress, buildDailyActionPlan, fallBehindRisk,
  type JourneyStep, type DailyActionPlan, type JourneyProgress, type FallBehindRisk,
} from "@/lib/kernel/onboarding-journey"

export interface AgentJourney {
  active: boolean
  progress: JourneyProgress | null
  plan: DailyActionPlan | null
  risk: FallBehindRisk
  phaseFocus: string
}

/** Load an agent's 90-day journey: phase progress + today's action plan + fall-behind risk. Read-only. */
export async function getAgentDailyActionPlan(agentId: string): Promise<AgentJourney> {
  const empty: AgentJourney = { active: false, progress: null, plan: null, risk: "none", phaseFocus: "" }
  if (!agentId) return empty
  const svc = createServiceClient()

  const { data: ob } = await svc.from("agent_onboarding").select("agent_id, brokerage_id, current_day, completion_percentage, status, start_date").eq("agent_id", agentId).maybeSingle()
  if (!ob) return empty
  const o = ob as any
  if (o.status && ["completed", "graduated"].includes(String(o.status))) return { ...empty, active: false }

  // Program day: prefer current_day, else derive from start_date.
  const day = o.current_day ?? (o.start_date ? Math.max(1, Math.floor((Date.now() - Date.parse(o.start_date)) / 86_400_000) + 1) : 1)

  const [stepsRes, doneRes, pipelineRes, leadsRes, agentRes] = await Promise.all([
    svc.from("onboarding_steps").select("id, step_name, day_number, required, estimated_minutes, instructions, target_role").or(`brokerage_id.eq.${o.brokerage_id},brokerage_id.is.null`).limit(200),
    svc.from("agent_step_completions").select("step_id").eq("agent_id", agentId).limit(500),
    svc.from("transactions").select("id", { count: "exact", head: true }).eq("agent_id", agentId).in("stage", ["UNDER_CONTRACT", "INSPECTION", "APPRAISAL", "FINANCING_PENDING", "CLOSING_PREP"]),
    svc.from("leads").select("id", { count: "exact", head: true }).eq("agent_id", agentId).eq("is_active", true),
    svc.from("agents").select("users(first_name)").eq("id", agentId).maybeSingle(),
  ])

  const steps: JourneyStep[] = ((stepsRes.data ?? []) as any[])
    .filter((s) => !s.target_role || s.target_role === "agent")
    .map((s) => ({ id: s.id, name: s.step_name ?? "Onboarding step", dayNumber: s.day_number ?? 1, required: !!s.required, estimatedMinutes: s.estimated_minutes, instructions: s.instructions }))
  const completed = new Set(((doneRes.data ?? []) as any[]).map((r) => r.step_id))
  const progress = journeyProgress(day, steps, completed)
  const pendingSteps = steps.filter((s) => !completed.has(s.id))
  const agentName = (agentRes.data as any)?.users?.first_name ?? null

  const plan = buildDailyActionPlan({
    agentName, dayInProgram: day, phase: progress.phase, pendingSteps,
    openLeads: (leadsRes as any)?.count ?? 0, activePipeline: (pipelineRes as any)?.count ?? 0,
  })

  return { active: true, progress, plan, risk: fallBehindRisk(day, progress.overallPct), phaseFocus: phaseForDay(day).focus }
}
