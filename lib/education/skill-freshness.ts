// lib/education/skill-freshness.ts
//
// CONTINUING-COMPETENCY / SKILL-FRESHNESS — closes the education loop. The app already tracks when an
// agent last DEMONSTRATED a skill (an objection-handling drill in objection_training_sessions, a passed
// quiz in agent_quiz_attempts, a finished course in agent_courses) — but competency was treated as a
// one-time achievement. Real skill DECAYS: an agent who hasn't run an objection drill in two months is
// rusty even if they once aced it. This scores each skill's freshness from the real last-practice signal
// so the Recruiting/Education Manager can nudge a short refresher BEFORE the skill goes stale — keeping
// agents sharp and coming back (the engagement/retention mechanic), not just onboarded once and forgotten.
// Pure + honest: a skill NEVER practiced is "untested" (not "decayed" — nothing to decay from); missing
// data is neutral, never a fabricated failure.

export type SkillArea = "objection_handling" | "product_knowledge" | "coursework"

export const SKILL_LABEL: Record<SkillArea, string> = {
  objection_handling: "Objection handling",
  product_knowledge:  "Product & process knowledge",
  coursework:         "Coursework",
}

/** Per-area decay windows (days). Live skills like objection handling decay faster than a finished course. */
export const SKILL_WINDOWS: Record<SkillArea, { aging: number; stale: number }> = {
  objection_handling: { aging: 30,  stale: 60 },
  product_knowledge:  { aging: 90,  stale: 180 },
  coursework:         { aging: 180, stale: 365 },
}
/** A last score under this is "weak" — accelerates a skill toward needing a refresh. */
export const WEAK_SCORE = 60

export interface SkillSignal {
  area: SkillArea
  /** Days since the agent last demonstrated this skill; null = never demonstrated. */
  lastPracticedDays: number | null
  /** The last score 0-100 (drill/quiz/course), null when unknown. */
  lastScore: number | null
}

export type SkillStatus = "fresh" | "aging" | "stale" | "untested"

export interface SkillFreshness {
  area: SkillArea
  status: SkillStatus
  /** True when a refresher is warranted on the skill itself (decay). Tenure gating for the UNTESTED case
   *  is applied by the radar, not here — this is the pure skill state. */
  decayed: boolean
  reason: string
}

/** PURE: freshness of one skill from its last-practice signal. Honest: never-practiced → untested. */
export function scoreSkill(sig: SkillSignal): SkillFreshness {
  const w = SKILL_WINDOWS[sig.area]
  const label = SKILL_LABEL[sig.area]
  if (sig.lastPracticedDays == null) {
    return { area: sig.area, status: "untested", decayed: false, reason: `${label} has never been practiced.` }
  }
  const d = sig.lastPracticedDays
  const weak = sig.lastScore != null && sig.lastScore < WEAK_SCORE
  if (d > w.stale || (weak && d > w.aging)) {
    return { area: sig.area, status: "stale", decayed: true, reason: weak ? `${label} last scored ${sig.lastScore} and hasn't been refreshed in ${d} days.` : `${label} hasn't been practiced in ${d} days.` }
  }
  if (d > w.aging || weak) {
    return { area: sig.area, status: "aging", decayed: false, reason: weak ? `${label} last scored ${sig.lastScore} — worth reinforcing.` : `${label} is getting rusty (${d} days).` }
  }
  return { area: sig.area, status: "fresh", decayed: false, reason: `${label} is sharp (${d} days).` }
}

export interface SkillFreshnessReport {
  skills: SkillFreshness[]
  staleCount: number
  agingCount: number
  untestedCount: number
  /** sharp = nothing decayed/untested; needs_refresh = at least one stale; unproven = only untested skills. */
  overall: "sharp" | "needs_refresh" | "unproven"
}

/** PURE: roll per-skill freshness into an agent-level report. */
export function computeSkillFreshness(signals: SkillSignal[]): SkillFreshnessReport {
  const skills = signals.map(scoreSkill)
  const staleCount = skills.filter((s) => s.status === "stale").length
  const agingCount = skills.filter((s) => s.status === "aging").length
  const untestedCount = skills.filter((s) => s.status === "untested").length
  const anyProven = skills.some((s) => s.status !== "untested")
  const overall: SkillFreshnessReport["overall"] =
    staleCount > 0 ? "needs_refresh" : !anyProven ? "unproven" : "sharp"
  return { skills, staleCount, agingCount, untestedCount, overall }
}
