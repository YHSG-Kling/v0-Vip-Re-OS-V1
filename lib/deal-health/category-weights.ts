// lib/deal-health/category-weights.ts
//
// The deal-health category vocabulary + weights, split out CLIENT-SAFE.
//
// health-scorer.ts imports createServiceClient, so a client component cannot pull
// the weights from it — and a second hardcoded copy in the UI is exactly the drift
// this codebase keeps paying for. Same split lib/offers/net-sheet-calc made from
// lib/kernel/offer-net-sheet for the same reason.
//
// Weights sum to 100. distillDealConfidence uses them to rank the WEIGHTED
// shortfall ((100 − score) × weight) and name the single biggest drag on a close.

export type HealthCategory =
  | "EARNEST_MONEY"
  | "INSPECTION"
  | "LENDER"
  | "TITLE"
  | "MILESTONES"
  | "DEADLINES"
  | "COMPLIANCE"
  | "COMMUNICATION"
  | "DOCUMENTS"
  | "PARTICIPANTS"

export const CATEGORY_WEIGHTS: Record<HealthCategory, number> = {
  EARNEST_MONEY:   14,
  INSPECTION:      12,
  LENDER:          14,
  TITLE:           10,
  MILESTONES:      10,
  DEADLINES:       10,
  COMPLIANCE:      10,
  COMMUNICATION:    6,
  DOCUMENTS:        8,
  PARTICIPANTS:     6,
}

/**
 * PERSISTED factor vocabulary — deliberately NARROWER than HealthCategory.
 *
 * health-scorer.ts collapses its ten categories into four before writing them to
 * deal_health_factors (its FACTOR_TYPE map), so the stored values are
 * financing_status / deadline_proximity / timeline_adherence / document_completeness —
 * NOT the HealthCategory keys. Weighting a stored row therefore means SUMMING the
 * categories that collapsed into it.
 *
 * The four cover 80 of the 100 weight: COMMUNICATION (6), DOCUMENTS (8) and
 * PARTICIPANTS (6) have no FACTOR_TYPE mapping and are never persisted. The
 * weakest-link ranking is still correct — it compares what was actually scored —
 * but it cannot see those three.
 *
 * NOTE: transaction_health_factors is a DIFFERENT table and only ever stores
 * factor_type 'comprehensive' (one aggregate row, no per-category breakdown), so it
 * cannot feed a weakest-link at all. Read deal_health_factors for that.
 */
export const PERSISTED_FACTOR_WEIGHTS: Record<string, number> = {
  financing_status:      CATEGORY_WEIGHTS.EARNEST_MONEY + CATEGORY_WEIGHTS.LENDER,      // 28
  deadline_proximity:    CATEGORY_WEIGHTS.INSPECTION + CATEGORY_WEIGHTS.DEADLINES,      // 22
  timeline_adherence:    CATEGORY_WEIGHTS.MILESTONES,                                    // 10
  document_completeness: CATEGORY_WEIGHTS.TITLE + CATEGORY_WEIGHTS.COMPLIANCE,          // 20
}

/** Human label for a persisted factor_type — the raw value is not seller-readable. */
export const PERSISTED_FACTOR_LABEL: Record<string, string> = {
  financing_status:      "Financing",
  deadline_proximity:    "Deadlines",
  timeline_adherence:    "Timeline",
  document_completeness: "Documents & title",
}

/**
 * Weight for a row as PERSISTED. Accepts the narrow stored vocabulary first, then
 * falls back to a direct HealthCategory match for any caller holding live component
 * scores rather than persisted rows. Unknown → 0 (the caller filters those out).
 */
export function weightForFactorType(factorType: string | null | undefined): number {
  if (!factorType) return 0
  const raw = String(factorType)
  return (
    PERSISTED_FACTOR_WEIGHTS[raw.toLowerCase()] ??
    CATEGORY_WEIGHTS[raw.toUpperCase() as HealthCategory] ??
    0
  )
}
