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

/**
 * THE ONE COMPETENCY VOCABULARY (wave 106, lane 106D — owner 2026-10-06: "competency model per agent:
 * Listing Presentation, Buyer Consultation, Negotiation, Pricing, Lead Conversion, Follow-Up,
 * Transaction Management, Compliance, Marketing, Recruiting, Technology"). Eleven keys, one list,
 * mirrored nowhere else: the relationship graph's `competency` node id is entityIdForKey("competency",
 * <key>) (lib/kernel/relationship-graph.ts), the learning router matches COMPETENCY_GAP_TAG against
 * learning_modules.gap_tags, the simulation library tags scenarios with these keys
 * (lib/training/objection-scenarios.ts SCENARIO_CATEGORY_COMPETENCY), the ledger and the scorecard
 * record them. No CHECK holds them (competency has no table of its own — the key IS the identity,
 * m715), so this const is the vocabulary and scripts/adaptive-development-guard.ts proves every
 * consumer reads it.
 *
 * TOMBSTONE (§6 — one vocabulary per function). The wave-103 (103A) spellings were EVIDENCE RAILS
 * named as if they were competencies; each is merged onto the owner's key below and the old
 * spelling is retired everywhere a competency is named (the freshness SkillArea keys stay — they
 * name a last-practice SIGNAL, not a competency, and SKILL_AREA_COMPETENCY says which competency
 * each signal evidences):
 *   objection_handling → negotiation            product_knowledge → technology
 *   coursework         → technology (completion is education STATE; it only ever moves technology)
 *   lead_response      → follow_up              lead_conversion   → lead_conversion
 *   closing            → transaction_management call_quality      → buyer_consultation
 *   compliance_ce      → compliance
 * The gap TAG values (the catalog vocabulary m711 stamped onto learning_modules.gap_tags) are KEPT
 * so every tagged module still matches its gap; only the competency keys changed.
 */
export const COMPETENCY_SKILLS = [
  "listing_presentation", "buyer_consultation", "negotiation", "pricing", "lead_conversion",
  "follow_up", "transaction_management", "compliance", "marketing", "recruiting", "technology",
] as const
export type CompetencySkill = (typeof COMPETENCY_SKILLS)[number]

/** Which competency each last-practice SIGNAL (freshness area) evidences — the rail → competency map. */
export const SKILL_AREA_COMPETENCY: Record<SkillArea, CompetencySkill> = {
  objection_handling: "negotiation",
  product_knowledge:  "technology",
  coursework:         "technology",
}

export const COMPETENCY_LABEL: Record<CompetencySkill, string> = {
  listing_presentation:   "Listing presentation",
  buyer_consultation:     "Buyer consultation",
  negotiation:            "Negotiation",
  pricing:                "Pricing",
  lead_conversion:        "Lead conversion",
  follow_up:              "Follow-up",
  transaction_management: "Transaction management",
  compliance:             "Compliance",
  marketing:              "Marketing",
  recruiting:             "Recruiting",
  technology:             "Technology",
}

/**
 * The learning_modules.gap_tags each competency maps onto — the curriculum assignment vocabulary.
 * Tags the router already documented (lib/learning-router/resolve-agent-learning-context.ts:40) and
 * the tags m711 stamped onto the live catalog are reused where the rail is the same; the four
 * competencies that had no rail before wave 106 carry their own key as the tag (m720 stamps them
 * onto the catalog by title/summary the way m711 did).
 */
export const COMPETENCY_GAP_TAG: Record<CompetencySkill, string> = {
  listing_presentation:   "listing_presentation",
  buyer_consultation:     "call_quality",
  negotiation:            "objection_handling",
  pricing:                "pricing",
  lead_conversion:        "low_close_rate",
  follow_up:              "slow_lead_response",
  transaction_management: "low_close_rate",
  compliance:             "compliance_ce",
  marketing:              "marketing",
  recruiting:             "recruiting",
  technology:             "product_knowledge",
}
/** A second tag a competency gap emits under a named condition (technology: assigned modules unfinished). */
export const COMPETENCY_SECONDARY_GAP_TAG: Partial<Record<CompetencySkill, string>> = {
  technology: "coursework_incomplete",
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
  /** Wave 106 (106D) rails for the competencies that had none. Each is OPTIONAL so an older caller
   *  (or a refused rail) reads as "no evidence" → unproven, never a fabricated zero. */
  /** listing_presentations in the window: held = presented | converted | abandoned; taken = converted. */
  listing?: { appointments: number; taken: number }
  /** listings sold in the window with both prices: sold_price / list_price averaged. */
  pricing?: { sold: number; avgSoldToList: number | null }
  /** social_posts published in the window by the agent. */
  marketing?: { postsPublished: number }
  /** recruits the agent sourced (recruits.recruiter_agent_id) and how many were provisioned. */
  recruiting?: { recruits: number; provisioned: number }
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

  // Listing presentation — listing appointments held → listings taken (60% taken = the bar).
  const li = ev.listing
  if (li && li.appointments >= COMPETENCY_MIN_EVIDENCE) {
    add("listing_presentation", Math.min(100, (li.taken / li.appointments / 0.6) * 100), conf(li.appointments),
      [`${li.taken} of ${li.appointments} listing appointments became listings (${Math.round((li.taken / li.appointments) * 100)}%)`])
  } else add("listing_presentation", null, "none", ["Fewer than 3 listing appointments in the window."])

  // Buyer consultation — the voice coach's strengths vs improvement insights on coached calls.
  const c = ev.coaching
  const insights = c.strengths + c.improvements
  if (insights > 0) {
    add("buyer_consultation", 40 + 60 * (c.strengths / insights), conf(insights),
      [`${c.strengths} strength${c.strengths === 1 ? "" : "s"} vs ${c.improvements} improvement note${c.improvements === 1 ? "" : "s"} from coached calls`])
  } else add("buyer_consultation", null, "none", ["No coached calls yet."])

  // Negotiation — the simulator's objection-drill scores, decayed by freshness.
  if (ev.objection.sessions > 0 && ev.objection.avgScore != null) {
    add("negotiation", ev.objection.avgScore - stalePenalty("objection_handling"), conf(ev.objection.sessions),
      [`${ev.objection.sessions} drill${ev.objection.sessions === 1 ? "" : "s"} averaging ${Math.round(ev.objection.avgScore)}/100`, fresh.get("objection_handling")?.reason ?? ""].filter(Boolean))
  } else add("negotiation", null, "none", ["No completed objection drills."])

  // Pricing — sold-to-list ratio on the agent's sold listings: 98%+ → 100, 95% → 70, 90% → 20.
  const pr = ev.pricing
  if (pr && pr.sold > 0 && pr.avgSoldToList != null) {
    add("pricing", 100 - Math.max(0, 0.98 - pr.avgSoldToList) * 1000, conf(pr.sold),
      [`${pr.sold} sold listing${pr.sold === 1 ? "" : "s"} at ${Math.round(pr.avgSoldToList * 100)}% of list price`])
  } else add("pricing", null, "none", ["No sold listings with both prices in the window."])

  // Lead conversion — tour→offer conversion, minus a no-show penalty.
  const o = ev.outcomes
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

  // Follow-up — claim rate × claim speed on the leads routed to the agent.
  if (o.leadsAssigned > 0) {
    const claimRate = o.leadsClaimed / o.leadsAssigned
    const speed = o.medianClaimMinutes != null ? claimSpeedScore(o.medianClaimMinutes) : 0
    add("follow_up", claimRate * 100 * 0.5 + speed * 0.5, conf(o.leadsAssigned),
      [`${o.leadsClaimed} of ${o.leadsAssigned} routed leads claimed${o.medianClaimMinutes != null ? `, median ${Math.round(o.medianClaimMinutes)} min to claim` : ""}`])
  } else add("follow_up", null, "none", ["No leads routed in the window."])

  // Transaction management — closings in the window, blended with active-deal health.
  if (o.closings > 0 || o.activeDeals > 0) {
    const closeScore = o.closings >= 6 ? 95 : o.closings >= 3 ? 80 : o.closings >= 1 ? 65 : 40
    const score = o.avgHealthScore != null ? closeScore * 0.7 + o.avgHealthScore * 0.3 : closeScore
    add("transaction_management", score, conf(o.closings + o.activeDeals),
      [`${o.closings} closing${o.closings === 1 ? "" : "s"} in the window${o.activeDeals > 0 ? `, ${o.activeDeals} active deal${o.activeDeals === 1 ? "" : "s"}${o.avgHealthScore != null ? ` at health ${Math.round(o.avgHealthScore)}/100` : ""}` : ""}`])
  } else add("transaction_management", null, "none", ["No closed or active deals."])

  // Compliance — the license-readiness verdict is the rule; CE progress and certs add precision.
  const cp = ev.compliance
  {
    let score: number
    if (cp.blockers > 0) score = 10
    else if (cp.warnings > 0) score = Math.min(70, 50 + (cp.cePct ?? 0) * 0.2)
    else score = cp.cePct == null ? 85 : 70 + cp.cePct * 0.3
    score = Math.min(100, score + Math.min(cp.activeCertifications, 2) * 2.5)
    add("compliance", score, "high", [
      cp.blockers > 0 ? `${cp.blockers} readiness blocker${cp.blockers === 1 ? "" : "s"} (cannot legally transact)` : cp.warnings > 0 ? `${cp.warnings} readiness warning${cp.warnings === 1 ? "" : "s"}` : "License, CE and ethics clear",
      cp.cePct != null ? `CE ${cp.cePct}% of the cycle requirement` : "",
      cp.activeCertifications > 0 ? `${cp.activeCertifications} active certification${cp.activeCertifications === 1 ? "" : "s"}` : "",
    ].filter(Boolean))
  }

  // Marketing — social posts published in the window (12 in 90 days = the bar).
  const mk = ev.marketing
  if (mk && mk.postsPublished > 0) {
    add("marketing", Math.min(100, (mk.postsPublished / 12) * 100), conf(mk.postsPublished), [`${mk.postsPublished} social post${mk.postsPublished === 1 ? "" : "s"} published in the window`])
  } else add("marketing", null, "none", ["No published social posts in the window."])

  // Recruiting — recruits sourced (5 = full marks on volume) × how many were provisioned.
  const rc = ev.recruiting
  if (rc && rc.recruits > 0) {
    add("recruiting", (rc.provisioned / rc.recruits) * 60 + Math.min(rc.recruits, 5) / 5 * 40, conf(rc.recruits),
      [`${rc.recruits} recruit${rc.recruits === 1 ? "" : "s"} sourced, ${rc.provisioned} provisioned`])
  } else add("recruiting", null, "none", ["No recruits sourced in the window."])

  // Technology — the Academy's knowledge check (the quiz; freshness carries it) is the ONLY score
  // evidence. Module completion NEVER enters a score: it is education state, not competency (owner:
  // "much more powerful than training completion"), so completing modules cannot earn an improvement;
  // it rides the evidence text and keeps the catalog's coursework tag live while modules stand open.
  const pk = ev.freshness.find((s) => s.area === "product_knowledge")
  const quiz = pk && pk.lastPracticedDays != null && pk.lastScore != null ? pk.lastScore - stalePenalty("product_knowledge") : null
  const completionPct = ev.modules.assigned > 0 ? (ev.modules.completed / ev.modules.assigned) * 100 : null
  if (quiz != null) {
    add("technology", quiz, "low", [
      `Last knowledge check ${pk!.lastScore}/100, ${pk!.lastPracticedDays} days ago`,
      completionPct != null ? `${ev.modules.completed} of ${ev.modules.assigned} assigned modules completed${ev.modules.avgQuizScore != null ? `, quizzes averaging ${Math.round(ev.modules.avgQuizScore)}/100` : ""}` : "",
    ].filter(Boolean))
  } else add("technology", null, "none", [completionPct != null ? `${ev.modules.completed} of ${ev.modules.assigned} modules completed but no knowledge check on file — completion alone proves nothing.` : "No knowledge check on file."])

  const scored = skills.filter((s) => s.score != null) as Array<CompetencyScore & { score: number }>
  const overall = scored.length ? Math.round(scored.reduce((a, s) => a + s.score, 0) / scored.length) : null
  const gaps = scored.filter((s) => s.score <= COMPETENCY_GAP_SCORE).sort((a, b) => a.score - b.score || a.skill.localeCompare(b.skill))
  const gapTags = new Set<string>(gaps.map((g) => g.gapTag))
  // Unfinished assigned modules keep the catalog's coursework tag live while technology is a gap or unproven.
  if ((quiz == null || gaps.some((g) => g.skill === "technology")) && completionPct != null && completionPct < 100) gapTags.add(COMPETENCY_SECONDARY_GAP_TAG.technology as string)
  for (const sc of ev.objection.byScenario) {
    if (sc.sessions >= 2 && sc.avgScore <= WEAK_SCENARIO_SCORE) gapTags.add(`objection:${sc.key}`)
  }
  return { skills, overall, gaps, gapTags: [...gapTags], unproven: skills.filter((s) => s.score == null).map((s) => s.skill) }
}

// ═════════════════════════════════════════════════════════════════════════════
// THE ADAPTIVE DEVELOPMENT LOOP — pure half (wave 106, lane 106D). Owner: "observed weakness →
// education recommendation → AI coaching/simulation → assessment → real-world activity → actual
// outcome → competency update — much more powerful than training completion". The live half
// (reads, ledger, events, graph, gamification) is runAdaptiveDevelopmentCycle in
// skill-freshness-radar.ts; everything that decides is here, deterministic, no LLM.
// ═════════════════════════════════════════════════════════════════════════════

/** A scored weakness with the evidence it stands on. */
export interface ObservedWeakness { skill: CompetencySkill; label: string; score: number; confidence: CompetencyConfidence; evidence: string[]; gapTag: string }

/**
 * PURE — the weakest competencies WITH evidence (a null skill is unproven, not weak), lowest first.
 * Fatigue is a signal in, not a score: an agent under strain (lib/gamification/strain.ts
 * isUnderStrain — the retention radar's own cut) is handed ONE focus, never a list, and the
 * reason rides the weakness's evidence so the ledger says why the loop held back.
 * @proofSeam scripts/adaptive-development-guard.ts asserts ordering, the null rule and the strain cap.
 */
export function observeWeakness(profile: CompetencyProfile, opts: { limit?: number; underStrain?: boolean } = {}): ObservedWeakness[] {
  const limit = opts.underStrain ? 1 : Math.max(1, opts.limit ?? 2)
  return profile.gaps.slice(0, limit).map((g) => ({
    skill: g.skill, label: g.label, score: g.score, confidence: g.confidence, gapTag: g.gapTag,
    evidence: opts.underStrain ? [...g.evidence, "Agent under strain (retention radar): one development focus only."] : g.evidence,
  }))
}

/** One competency's before/after across two profiles. */
export interface CompetencyDelta { skill: CompetencySkill; before: number | null; after: number | null; delta: number | null }

/** PURE — per-skill deltas between a prior score map (the last ledgered cycle) and the fresh profile. */
export function competencyDeltas(prior: Partial<Record<CompetencySkill, number | null>> | null, after: CompetencyProfile): CompetencyDelta[] {
  return after.skills.map((s) => {
    const before = prior?.[s.skill] ?? null
    return { skill: s.skill, before, after: s.score, delta: before != null && s.score != null ? s.score - before : null }
  })
}

/** An improvement must clear this many points to count (noise + decay cannot "earn" it). */
export const COMPETENCY_IMPROVEMENT_MIN_DELTA = 5

/**
 * PURE — the competencies that IMPROVED on evidence: both sides scored, after ≥ before + min delta,
 * and the fresh score is backed by at least low confidence. Completion of a module is not here —
 * it never moves a score by itself (technology caps completion-only at the gap line), so the award
 * that rides this list is for the improvement, never the completion.
 * @proofSeam the proof asserts the delta bar, the null rule and that completion alone yields none.
 */
export function improvedCompetencies(deltas: CompetencyDelta[], after: CompetencyProfile, minDelta = COMPETENCY_IMPROVEMENT_MIN_DELTA): Array<CompetencyDelta & { delta: number }> {
  const conf = new Map(after.skills.map((s) => [s.skill, s.confidence]))
  return deltas.filter((d): d is CompetencyDelta & { delta: number } => d.delta != null && d.delta >= minDelta && conf.get(d.skill) !== "none")
}

/** PURE — the score map a cycle ledgers (what the next cycle compares against). */
export function competencyScoreMap(profile: CompetencyProfile): Record<CompetencySkill, number | null> {
  const out = {} as Record<CompetencySkill, number | null>
  for (const s of profile.skills) out[s.skill] = s.score
  return out
}
