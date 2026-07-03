// lib/kernel/onboarding-journey.ts
//
// 90-DAY ONBOARDING JOURNEY (recruiting_manager) — the phased structure + daily action plan that answers
// the biggest first-year-attrition driver (no structured guidance). Built ON the kept kernel onboarding
// path (onboarding_steps template + agent_onboarding + agent_step_completions) — NOT a new parallel system.
// Phases are DERIVED from the existing day_number (no schema change): Foundation (1-14), First Activity
// (15-28), Transaction Path (29-60), Career Foundation (61-90). Each phase gates on its own steps being
// done. Every morning a deterministic action plan gives the agent 3 priority tasks + 1 learning tip drawn
// from their REAL state — no LLM, so it's testable and free to run.
//
// Pure + unit-tested; the loaders/UI/runner sit in app/actions/onboarding + lib/kernel/onboarding-fallbehind.

export interface Phase { phase: number; label: string; startDay: number; endDay: number; focus: string }

export const PHASES: Phase[] = [
  { phase: 1, label: "Foundation", startDay: 1, endDay: 14, focus: "Get set up: profile, MLS, compliance, first contacts." },
  { phase: 2, label: "First Activity", startDay: 15, endDay: 28, focus: "First lead, first showing, meet your mentor." },
  { phase: 3, label: "Transaction Path", startDay: 29, endDay: 60, focus: "First offer, first deal in your pipeline." },
  { phase: 4, label: "Career Foundation", startDay: 61, endDay: 90, focus: "First closing, referral system, career tier." },
]

/** PURE: the phase for a given program day (clamped to 1..4). */
export function phaseForDay(day: number): Phase {
  const d = Math.max(1, Math.round(day))
  return PHASES.find((p) => d >= p.startDay && d <= p.endDay) ?? (d < 1 ? PHASES[0] : PHASES[PHASES.length - 1])
}

export interface JourneyStep { id: string; name: string; dayNumber: number; required: boolean; estimatedMinutes?: number | null; instructions?: string | null }

/**
 * PURE: is a phase unlocked? A phase unlocks only when every REQUIRED step of all EARLIER phases is done
 * (milestone gating — the spec's core anti-skip rule). Phase 1 is always unlocked.
 */
export function isPhaseUnlocked(phase: number, steps: JourneyStep[], completedStepIds: Set<string>): boolean {
  if (phase <= 1) return true
  const priorRequired = steps.filter((s) => s.required && phaseForDay(s.dayNumber).phase < phase)
  return priorRequired.every((s) => completedStepIds.has(s.id))
}

export interface JourneyProgress {
  dayInProgram: number
  phase: number
  phaseLabel: string
  /** Overall required-step completion 0..100. */
  overallPct: number
  /** Per-phase required-step completion 0..100. */
  phasePct: number
}

/** PURE: the agent's journey progress from their day + step completions. */
export function journeyProgress(dayInProgram: number, steps: JourneyStep[], completedStepIds: Set<string>): JourneyProgress {
  const day = Math.max(1, Math.round(dayInProgram))
  const ph = phaseForDay(day)
  const required = steps.filter((s) => s.required)
  const doneReq = required.filter((s) => completedStepIds.has(s.id)).length
  const phaseReq = required.filter((s) => phaseForDay(s.dayNumber).phase === ph.phase)
  const donePhase = phaseReq.filter((s) => completedStepIds.has(s.id)).length
  return {
    dayInProgram: day, phase: ph.phase, phaseLabel: ph.label,
    overallPct: required.length ? Math.round((doneReq / required.length) * 100) : 0,
    phasePct: phaseReq.length ? Math.round((donePhase / phaseReq.length) * 100) : 0,
  }
}

export type FallBehindRisk = "none" | "yellow" | "red"

/**
 * PURE: is the agent falling behind? Compares actual completion to what's expected by their program day.
 * A gentle-slope expectation (roughly linear over 90 days) — yellow at a 15-pt shortfall, red at 30.
 * Honest: a brand-new agent (day < 3) is never flagged; a finished agent is never flagged.
 */
export function fallBehindRisk(dayInProgram: number, overallPct: number): FallBehindRisk {
  const day = Math.max(0, dayInProgram)
  if (day < 3 || overallPct >= 100) return "none"
  const expected = Math.min(100, (day / 90) * 100)
  const shortfall = expected - overallPct
  if (shortfall >= 30) return "red"
  if (shortfall >= 15) return "yellow"
  return "none"
}

export interface DailyTask { title: string; detail: string; estimatedMinutes?: number | null; stepId?: string }
export interface DailyActionPlan { greeting: string; priorityTasks: DailyTask[]; learningTip: string; motivation: string }

const PHASE_TIP: Record<number, string> = {
  1: "Quick win: a complete profile + connected MLS is what makes your first lead take you seriously.",
  2: "Agents who complete their first showing in week 3 close their first deal ~40% faster.",
  3: "Your first offer is a milestone — write it in the platform even as a draft to build the muscle.",
  4: "Set a closing goal in the platform; agents who write down a goal hit it far more often.",
}
const PHASE_MOTIVATION: Record<number, string> = {
  1: "You're building the foundation — every step here pays off all year.",
  2: "This is where it gets real. First lead, first showing — you're on your way.",
  3: "You're in the transaction zone. Keep one deal moving and momentum follows.",
  4: "Home stretch of your first 90 — you're becoming the agent you set out to be.",
}

/**
 * PURE: the morning action plan — 3 priority tasks + 1 learning tip, drawn from the agent's real state.
 * Priorities = the nearest-day pending required steps; if fewer than 3, fill with pipeline/lead actions so
 * the plan is always concrete. Deterministic (no LLM).
 */
export function buildDailyActionPlan(input: {
  agentName?: string | null
  dayInProgram: number
  phase: number
  pendingSteps: JourneyStep[]
  openLeads: number
  activePipeline: number
}): DailyActionPlan {
  const name = input.agentName?.trim()
  const tasks: DailyTask[] = []
  for (const s of [...input.pendingSteps].sort((a, b) => a.dayNumber - b.dayNumber).slice(0, 3)) {
    tasks.push({ title: s.name, detail: (s.instructions?.trim() || `Complete this onboarding step — it's on your plan for day ${s.dayNumber}.`), estimatedMinutes: s.estimatedMinutes ?? null, stepId: s.id })
  }
  if (tasks.length < 3 && input.openLeads > 0) tasks.push({ title: `Follow up with your ${input.openLeads} open lead${input.openLeads === 1 ? "" : "s"}`, detail: "Go to CRM → Leads and send the next touch to your warmest lead before 10 AM.", estimatedMinutes: 10 })
  if (tasks.length < 3 && input.activePipeline === 0) tasks.push({ title: "Start your pipeline", detail: "Add contacts to your CRM and log your first buyer or seller consultation.", estimatedMinutes: 15 })
  if (tasks.length < 3) tasks.push({ title: "Sharpen one skill", detail: "Spend 10 minutes on a lesson relevant to your current stage in the learning center.", estimatedMinutes: 10 })

  return {
    greeting: `Good morning${name ? `, ${name}` : ""} — you're on day ${Math.max(1, Math.round(input.dayInProgram))} of your first 90.`,
    priorityTasks: tasks.slice(0, 3),
    learningTip: PHASE_TIP[input.phase] ?? PHASE_TIP[1],
    motivation: PHASE_MOTIVATION[input.phase] ?? PHASE_MOTIVATION[1],
  }
}
