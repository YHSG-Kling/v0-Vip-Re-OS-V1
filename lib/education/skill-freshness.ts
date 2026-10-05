// lib/education/skill-freshness.ts
//
// CONTINUING-COMPETENCY / SKILL-FRESHNESS — closes the education loop. The app already tracks when an
// agent last DEMONSTRATED a skill (an objection-handling drill in objection_training_sessions, a passed
// quiz in agent_quiz_attempts, a completed module in learning_assignments) — but competency was treated as a
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

// ═════════════════════════════════════════════════════════════════════════════
// THE ONE COMPETENCY MODEL (wave 103, lane 103A — layer 5 of the owner's 7-layer target).
//
// Freshness above answers "when did the agent last PROVE this skill". Competency answers "how GOOD is
// the agent at it, on the evidence" — per skill, from the rows the OS already keeps: outcomes
// (closings, tour→offer, no-shows, lead claim speed), the voice coach's call insights
// (call_coaching_insights), the objection simulator's scores (objection_training_sessions), CE /
// license readiness (agents.* via evaluateLicenseReadiness — the compliance survivor), certifications
// and Academy completions (learning_assignments). Deterministic, no LLM: every score is a documented
// function of counts; every skill with too little evidence is NULL (honest "unproven"), never a
// fabricated number. This file is the survivor because it already scored competence (freshness) and
// every freshness area is one of the competency skills — one vocabulary (CLAUDE.md §6), one place.
// The live evidence gatherer is loadAgentCompetency in skill-freshness-radar.ts, beside the freshness
// gatherer it reuses; the consumers are the learning router (gap tags → module picks), the coaching
// brief (cites the gap), the team-lead brief, and the command-center board.
// ═════════════════════════════════════════════════════════════════════════════

/** Competency skills: the three freshness areas PLUS the outcome- and compliance-backed skills. */
export type CompetencySkill =
  | SkillArea
  | "lead_response"
  | "lead_conversion"
  | "closing"
  | "call_quality"
  | "compliance_ce"

export const COMPETENCY_SKILLS: readonly CompetencySkill[] = [
  "objection_handling", "product_knowledge", "coursework",
  "lead_response", "lead_conversion", "closing", "call_quality", "compliance_ce",
]

export const COMPETENCY_LABEL: Record<CompetencySkill, string> = {
  ...SKILL_LABEL,
  lead_response:   "Lead response speed",
  lead_conversion: "Appointment & tour conversion",
  closing:         "Closing execution",
  call_quality:    "Call quality",
  compliance_ce:   "License, CE & ethics readiness",
}

/**
 * The learning_modules.gap_tags each skill maps onto — the curriculum assignment vocabulary.
 * Canonical tags already in the router's documented set (lib/learning-router/
 * resolve-agent-learning-context.ts:40) are reused where one fits; the rest are this model's
 * own tags, which the curriculum author / module editor may tag modules with.
 */
export const COMPETENCY_GAP_TAG: Record<CompetencySkill, string> = {
  objection_handling: "objection_handling",
  product_knowledge:  "product_knowledge",
  coursework:         "coursework_incomplete",
  lead_response:      "slow_lead_response",
  lead_conversion:    "low_close_rate",
  closing:            "low_close_rate",
  call_quality:       "call_quality",
  compliance_ce:      "compliance_ce",
}

/** A skill scoring at or below this is a COMPETENCY GAP — what curriculum + coaching act on. */
export const COMPETENCY_GAP_SCORE = 60
/** Sample gates: below MIN_EVIDENCE events a skill is "low" confidence; below 1 it is unproven (null). */
export const COMPETENCY_MIN_EVIDENCE = 3
/** A drill scenario at or below this average (with ≥2 runs) names its own curriculum tag. */
export const WEAK_SCENARIO_SCORE = 70

export interface CompetencyEvidence {
  /** Freshness signals (the three areas) — the last-practice rail, reused as-is. */
  freshness: SkillSignal[]
  /** Objection simulator: completed sessions in the window, avg total_score, per-scenario breakdown. */
  objection: { sessions: number; avgScore: number | null; byScenario: Array<{ key: string; sessions: number; avgScore: number }> }
  /** Voice coach insights in the window (call_coaching_insights): strengths vs the improvement kinds. */
  coaching: { strengths: number; improvements: number }
  /** Outcomes in the window. closings = status 'closed' deals; activeDeals + avgHealth from the scorecard rail. */
  outcomes: {
    closings: number; activeDeals: number; avgHealthScore: number | null
    tours: number; offers: number; appointments: number; noShows: number
    /** assignment_log: leads routed to the agent, how many were claimed, median minutes to claim. */
    leadsAssigned: number; leadsClaimed: number; medianClaimMinutes: number | null
  }
  /** Compliance survivor's verdict (evaluateLicenseReadiness) + CE progress + active certifications. */
  compliance: { ready: boolean; blockers: number; warnings: number; cePct: number | null; activeCertifications: number }
  /** Academy completions on the canonical rail. */
  modules: { assigned: number; completed: number; avgQuizScore: number | null }
}

export type CompetencyConfidence = "none" | "low" | "high"

export interface CompetencyScore {
  skill: CompetencySkill
  label: string
  /** 0-100, or null when there is no evidence (unproven — never fabricated). */
  score: number | null
  confidence: CompetencyConfidence
  /** The numbers behind the score, human-readable. */
  evidence: string[]
  gapTag: string
}

export interface CompetencyProfile {
  skills: CompetencyScore[]
  /** Mean of the scored skills; null when nothing is scored. */
  overall: number | null
  /** Scored skills at or below COMPETENCY_GAP_SCORE, lowest first — what curriculum + coaching target. */
  gaps: Array<CompetencyScore & { score: number }>
  /** learning_modules.gap_tags to match: the gap skills' tags + weak drill scenarios ("objection:<key>"). Deduped. */
  gapTags: string[]
  /** Skills with no evidence at all. */
  unproven: CompetencySkill[]
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)))
const conf = (n: number): CompetencyConfidence => (n <= 0 ? "none" : n < COMPETENCY_MIN_EVIDENCE ? "low" : "high")

/** PURE: median minutes to claim → 0-100. 15 min or better is 100; an hour 75; four hours 45; a day 15.
 *  @proofSeam the piecewise speed curve is asserted at its four knees by scripts/competency-guard.ts; its
 *  only product caller is scoreCompetency in this file. */
export function claimSpeedScore(medianMinutes: number): number {
  if (medianMinutes <= 15) return 100
  if (medianMinutes <= 60) return clamp(100 - ((medianMinutes - 15) / 45) * 25)
  if (medianMinutes <= 240) return clamp(75 - ((medianMinutes - 60) / 180) * 30)
  if (medianMinutes <= 1440) return clamp(45 - ((medianMinutes - 240) / 1200) * 30)
  return 10
}

/**
 * PURE + deterministic: the agent's competency per skill from EVIDENCE. Every rule is a documented
 * function of counts with a sample gate; a skill with no evidence is null. Stale freshness subtracts
 * from a scored skill (a skill proven long ago is worth less than one proven last week).
 */
export function scoreCompetency(ev: CompetencyEvidence): CompetencyProfile {
  const fresh = new Map<SkillArea, SkillFreshness>(ev.freshness.map((s) => [s.area, scoreSkill(s)]))
  const stalePenalty = (area: SkillArea) => (fresh.get(area)?.status === "stale" ? 15 : fresh.get(area)?.status === "aging" ? 5 : 0)
  const skills: CompetencyScore[] = []
  const add = (skill: CompetencySkill, score: number | null, confidence: CompetencyConfidence, evidence: string[]) =>
    skills.push({ skill, label: COMPETENCY_LABEL[skill], score: score == null ? null : clamp(score), confidence, evidence, gapTag: COMPETENCY_GAP_TAG[skill] })

  // Objection handling — the simulator's scores, decayed by freshness.
  if (ev.objection.sessions > 0 && ev.objection.avgScore != null) {
    add("objection_handling", ev.objection.avgScore - stalePenalty("objection_handling"), conf(ev.objection.sessions),
      [`${ev.objection.sessions} drill${ev.objection.sessions === 1 ? "" : "s"} averaging ${Math.round(ev.objection.avgScore)}/100`, fresh.get("objection_handling")?.reason ?? ""].filter(Boolean))
  } else add("objection_handling", null, "none", ["No completed objection drills."])

  // Product knowledge — the last quiz score (freshness carries it), decayed.
  const pk = ev.freshness.find((s) => s.area === "product_knowledge")
  if (pk && pk.lastPracticedDays != null && pk.lastScore != null) {
    add("product_knowledge", pk.lastScore - stalePenalty("product_knowledge"), "low", [`Last knowledge check ${pk.lastScore}/100, ${pk.lastPracticedDays} days ago`])
  } else add("product_knowledge", null, "none", ["No knowledge check on file."])

  // Coursework — completion of assigned Academy modules, blended with quiz scores when present.
  if (ev.modules.assigned > 0) {
    const completionPct = (ev.modules.completed / ev.modules.assigned) * 100
    const score = ev.modules.avgQuizScore != null ? completionPct * 0.6 + ev.modules.avgQuizScore * 0.4 : completionPct
    add("coursework", score - stalePenalty("coursework"), conf(ev.modules.assigned),
      [`${ev.modules.completed} of ${ev.modules.assigned} assigned modules completed${ev.modules.avgQuizScore != null ? `, quizzes averaging ${Math.round(ev.modules.avgQuizScore)}/100` : ""}`])
  } else add("coursework", null, "none", ["No modules assigned yet."])

  // Lead response — claim rate × claim speed on the leads routed to the agent.
  const o = ev.outcomes
  if (o.leadsAssigned > 0) {
    const claimRate = o.leadsClaimed / o.leadsAssigned
    const speed = o.medianClaimMinutes != null ? claimSpeedScore(o.medianClaimMinutes) : 0
    add("lead_response", claimRate * 100 * 0.5 + speed * 0.5, conf(o.leadsAssigned),
      [`${o.leadsClaimed} of ${o.leadsAssigned} routed leads claimed${o.medianClaimMinutes != null ? `, median ${Math.round(o.medianClaimMinutes)} min to claim` : ""}`])
  } else add("lead_response", null, "none", ["No leads routed in the window."])

  // Lead conversion — tour→offer conversion, minus a no-show penalty.
  if (o.tours >= COMPETENCY_MIN_EVIDENCE || o.appointments >= COMPETENCY_MIN_EVIDENCE) {
    const parts: string[] = []
    let score: number | null = null
    if (o.tours >= COMPETENCY_MIN_EVIDENCE) {
      const convRate = o.offers / o.tours
      score = Math.min(100, (convRate / 0.5) * 100) // 50% tour→offer = the strength bar in agent-coaching
      parts.push(`${o.offers} offers from ${o.tours} tours (${Math.round(convRate * 100)}%)`)
    }
    if (o.appointments >= COMPETENCY_MIN_EVIDENCE) {
      const noShowRate = o.noShows / o.appointments
      const apptScore = clamp(100 - noShowRate * 200) // 25% no-shows (the coaching leak bar) = 50
      score = score == null ? apptScore : score * 0.6 + apptScore * 0.4
      parts.push(`${o.noShows} no-shows across ${o.appointments} appointments`)
    }
    add("lead_conversion", score, "high", parts)
  } else add("lead_conversion", null, "none", ["Fewer than 3 tours or appointments in the window."])

  // Closing — closings in the window, blended with active-deal health.
  if (o.closings > 0 || o.activeDeals > 0) {
    const closeScore = o.closings >= 6 ? 95 : o.closings >= 3 ? 80 : o.closings >= 1 ? 65 : 40
    const score = o.avgHealthScore != null ? closeScore * 0.7 + o.avgHealthScore * 0.3 : closeScore
    add("closing", score, conf(o.closings + o.activeDeals),
      [`${o.closings} closing${o.closings === 1 ? "" : "s"} in the window${o.activeDeals > 0 ? `, ${o.activeDeals} active deal${o.activeDeals === 1 ? "" : "s"}${o.avgHealthScore != null ? ` at health ${Math.round(o.avgHealthScore)}/100` : ""}` : ""}`])
  } else add("closing", null, "none", ["No closed or active deals."])

  // Call quality — the voice coach's strengths vs improvement insights.
  const c = ev.coaching
  const insights = c.strengths + c.improvements
  if (insights > 0) {
    add("call_quality", 40 + 60 * (c.strengths / insights), conf(insights),
      [`${c.strengths} strength${c.strengths === 1 ? "" : "s"} vs ${c.improvements} improvement note${c.improvements === 1 ? "" : "s"} from coached calls`])
  } else add("call_quality", null, "none", ["No coached calls yet."])

  // Compliance / CE — the license-readiness verdict is the rule; CE progress and certs add precision.
  const cp = ev.compliance
  {
    let score: number
    if (cp.blockers > 0) score = 10
    else if (cp.warnings > 0) score = Math.min(70, 50 + (cp.cePct ?? 0) * 0.2)
    else score = cp.cePct == null ? 85 : 70 + cp.cePct * 0.3
    score = Math.min(100, score + Math.min(cp.activeCertifications, 2) * 2.5)
    add("compliance_ce", score, "high", [
      cp.blockers > 0 ? `${cp.blockers} readiness blocker${cp.blockers === 1 ? "" : "s"} (cannot legally transact)` : cp.warnings > 0 ? `${cp.warnings} readiness warning${cp.warnings === 1 ? "" : "s"}` : "License, CE and ethics clear",
      cp.cePct != null ? `CE ${cp.cePct}% of the cycle requirement` : "",
      cp.activeCertifications > 0 ? `${cp.activeCertifications} active certification${cp.activeCertifications === 1 ? "" : "s"}` : "",
    ].filter(Boolean))
  }

  const scored = skills.filter((s) => s.score != null) as Array<CompetencyScore & { score: number }>
  const overall = scored.length ? Math.round(scored.reduce((a, s) => a + s.score, 0) / scored.length) : null
  const gaps = scored.filter((s) => s.score <= COMPETENCY_GAP_SCORE).sort((a, b) => a.score - b.score || a.skill.localeCompare(b.skill))
  const gapTags = new Set<string>(gaps.map((g) => g.gapTag))
  for (const sc of ev.objection.byScenario) {
    if (sc.sessions >= 2 && sc.avgScore <= WEAK_SCENARIO_SCORE) gapTags.add(`objection:${sc.key}`)
  }
  return { skills, overall, gaps, gapTags: [...gapTags], unproven: skills.filter((s) => s.score == null).map((s) => s.skill) }
}
