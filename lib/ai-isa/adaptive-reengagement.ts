// lib/ai-isa/adaptive-reengagement.ts
// ─────────────────────────────────────────────────────────────────────────────
// "Reach them mentally" — the AI-ISA's adaptive, THEM-FIRST re-engagement for a
// non-responding lead. Two pure dimensions layered on top of the existing facts copy:
//
//   1. ANGLE-BY-ATTEMPT — instead of re-sending the SAME message forever, the angle
//      rotates each touch (life-context → market-timing → expertise → soft close) so a
//      ghost gets a FRESH reason to respond, not the identical note again.
//   2. GENERATIONAL TONE — the SAME canonical cohort vocabulary the portal education
//      uses (generationalCohortFromAge) selects an age-appropriate STYLE (terse vs
//      warm vs ROI-framed). This is TONE ONLY — never demographic targeting.
//
// FAIR HOUSING SAFE BY CONSTRUCTION: the hooks adapt HOW we say it (pace, warmth,
// value framing), never WHO based on a protected class. They never reference race,
// religion, sex, national origin, disability, familial status, or age itself — the
// adaptive-reengagement simulator asserts this. Brand voice + the evaluateOutbound
// compliance gate still apply downstream; this only shapes the opening angle.

import { generationalCohortFromAge, type GenerationalCohort } from "@/lib/kernel/education"

export type ReengagementAngle = "life_context" | "market_timing" | "expertise" | "soft_close"

/** PURE. The angle for a given re-engagement attempt (1-based). A non-responder gets a
 *  DIFFERENT approach each touch, escalating from a gentle personal hook toward a soft
 *  close that preps the human hand-off — never the same message repeated. */
export function reengagementAngleForAttempt(attempt: number): ReengagementAngle {
  if (attempt <= 2) return "life_context"
  if (attempt <= 4) return "market_timing"
  if (attempt <= 6) return "expertise"
  return "soft_close"
}

/** PURE. Resolve the lead's generational cohort from whatever age signal enrichment
 *  produced (a numeric age, or an "35-44"-style range → its midpoint). Never fabricates:
 *  no usable signal ⇒ "unknown" (neutral tone). */
export function cohortFromEnrichment(
  enrichment: { age?: number | null; age_range?: string | null } | null | undefined,
): GenerationalCohort {
  if (!enrichment) return "unknown"
  if (typeof enrichment.age === "number") return generationalCohortFromAge(enrichment.age)
  const range = enrichment.age_range
  if (typeof range === "string") {
    const nums = range.match(/\d+/g)?.map(Number) ?? []
    if (nums.length >= 2) return generationalCohortFromAge(Math.round((nums[0] + nums[1]) / 2))
    if (nums.length === 1) return generationalCohortFromAge(nums[0])
  }
  return "unknown"
}

// Per-cohort STYLE wrapper — pace + warmth only. No protected-class language.
const COHORT_STYLE: Record<GenerationalCohort, { lead: string; close: string }> = {
  gen_z:      { lead: "Quick one —", close: "A one-tap reply works." },
  millennial: { lead: "Hi again —", close: "Happy to make this easy whenever you're ready." },
  gen_x:      { lead: "Following up —", close: "Worth a quick look when it's convenient." },
  boomer:     { lead: "Hello again,", close: "I'd be glad to help whenever the timing feels right." },
  silent:     { lead: "Hello,", close: "Please reach out at your convenience — no rush at all." },
  unknown:    { lead: "Hi —", close: "Reply anytime and I'll take it from there." },
}

// Per-angle CORE message — the reason to respond. Generic + compliant; the deterministic
// facts copy (occupation/city/etc.) still personalizes the body downstream.
const ANGLE_CORE: Record<ReengagementAngle, string> = {
  life_context: "now might be a good moment to explore your options, with no obligation",
  market_timing: "there's been some movement in your area worth a quick look",
  expertise: "this is exactly the kind of move our team handles every day",
  soft_close: "even a quick yes/no tells me how best to help — or whether to step back",
}

/**
 * buildAdaptiveReengagementHook — PURE. A them-first opening hook combining the
 * attempt's angle with the cohort's style. Style + angle only; safe for Fair Housing.
 */
export function buildAdaptiveReengagementHook(cohort: GenerationalCohort, angle: ReengagementAngle): string {
  const style = COHORT_STYLE[cohort] ?? COHORT_STYLE.unknown
  return `${style.lead} ${ANGLE_CORE[angle]}. ${style.close}`
}

/** Convenience: resolve cohort + angle and build the hook in one call. */
export function adaptiveReengagementHook(params: {
  attempt: number
  enrichment: { age?: number | null; age_range?: string | null } | null | undefined
}): { cohort: GenerationalCohort; angle: ReengagementAngle; hook: string } {
  const cohort = cohortFromEnrichment(params.enrichment)
  const angle = reengagementAngleForAttempt(params.attempt)
  return { cohort, angle, hook: buildAdaptiveReengagementHook(cohort, angle) }
}
