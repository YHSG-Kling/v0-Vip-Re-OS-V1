// lib/kernel/deal-confidence.ts
//
// DEAL CONFIDENCE — the agent's 2am anxiety is "is this deal going to close, and what's the ONE
// thing to fix?". A fused 0-100 deal-health score ALREADY exists (lib/deal-health/health-scorer.ts
// → transactions.health_score, 10 weighted categories). This does NOT recompute it — it DISTILLS
// the existing components into the single WEAKEST LINK (the biggest drag on the close) and the one
// PROTECTIVE ACTION to take next. Pure composition over the score the caller already ran.

export interface ConfidenceComponent {
  /** health-scorer category key, e.g. "lender", "earnest_money", "documents". */
  category: string
  /** 0–100 health for this category. */
  score: number
  /** category weight (health-scorer weights sum to 100). */
  weight: number
  issues?: string[]
}

export type DealVerdict = "on_track" | "watch" | "at_risk" | "critical"

export interface DealConfidence {
  /** Reused verbatim from the existing health score — not recomputed. */
  confidence: number
  verdict: DealVerdict
  weakestLink: { category: string; score: number; impact: number; issue: string | null } | null
  /** The single next step to protect the close (deterministic, agent-facing). */
  protectiveAction: string
}

// Deterministic next-step per category — what to do when THIS is the weakest link.
const PROTECTIVE_ACTION: Record<string, string> = {
  lender:        "Push the lender for clear-to-close — financing is the biggest risk to this close.",
  earnest_money: "Confirm earnest money is received and on file — it's the weak point.",
  inspection:    "Resolve the inspection items / get the report completed before they stall the deal.",
  appraisal:     "Chase the appraisal — order it or get the value in; it's the gap.",
  title:         "Get title commitment + clear any title issues — it's holding the close back.",
  milestones:    "Knock out the overdue milestone driving the risk.",
  deadlines:     "Address the overdue/at-risk deadline before it slips the close.",
  compliance:    "Close the open compliance item — it can block funding.",
  communication: "Re-engage — this deal has gone quiet; a check-in protects it.",
  documents:     "Collect the missing/rejected document blocking the file.",
  participants:  "Assign the missing party (lender/title) — gaps here stall everything.",
}

function verdictFromScore(score: number): DealVerdict {
  if (score >= 85) return "on_track"
  if (score >= 70) return "watch"
  if (score >= 40) return "at_risk"
  return "critical"
}

/**
 * Pure: distill an existing deal-health result into a confidence verdict + the single weakest link
 * + the one protective action. Weakest link = the component with the largest WEIGHTED shortfall
 * (impact = (100 − score) × weight) — the biggest drag on the close. No recompute, no fabrication.
 */
export function distillDealConfidence(
  overallScore: number,
  components: ConfidenceComponent[],
  riskLevel?: string,
): DealConfidence {
  const verdict = (riskLevel === "healthy" ? "on_track"
    : riskLevel === "watch" ? "watch"
    : riskLevel === "at_risk" ? "at_risk"
    : riskLevel === "critical" ? "critical"
    : verdictFromScore(overallScore))

  let weakest: DealConfidence["weakestLink"] = null
  let bestImpact = -1
  for (const c of components) {
    const impact = (100 - c.score) * c.weight
    if (impact > bestImpact && c.score < 100) {
      bestImpact = impact
      weakest = { category: c.category, score: c.score, impact, issue: c.issues?.[0] ?? null }
    }
  }

  const protectiveAction = weakest
    ? (PROTECTIVE_ACTION[weakest.category] ?? `Address ${weakest.category.replace(/_/g, " ")} — it's the biggest risk to the close.`)
    : "Nothing is dragging this deal — keep it moving to close."

  return { confidence: Math.round(overallScore), verdict, weakestLink: weakest, protectiveAction }
}
