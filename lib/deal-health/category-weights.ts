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
 * These now cover the FULL 100. COMMUNICATION (6), DOCUMENTS (8) and
 * PARTICIPANTS (6) used to have no FACTOR_TYPE mapping and were never persisted —
 * scored in memory, dropped at write time. deal_health_factors.factor_type already
 * admitted communication_recency and party_responsiveness, so closing the gap was
 * a matter of adding three lines to the scorer's map, not a migration.
 *
 * A bucket weight is the SUM of the categories that collapse into it, so it is the
 * right weight for a bucket but the WRONG weight for a single row when two
 * categories share a bucket (EARNEST_MONEY and LENDER both persist as
 * financing_status; each row would otherwise be ranked as if it carried all 28).
 * The scorer stores the true category in `detail.category` — prefer
 * weightForCategory() when a caller can read it.
 *
 * NOTE: transaction_health_factors is a DIFFERENT table and only ever stores
 * factor_type 'comprehensive' (one aggregate row, no per-category breakdown), so it
 * cannot feed a weakest-link at all. Read deal_health_factors for that.
 */
export const PERSISTED_FACTOR_WEIGHTS: Record<string, number> = {
  financing_status:      CATEGORY_WEIGHTS.EARNEST_MONEY + CATEGORY_WEIGHTS.LENDER,      // 28
  deadline_proximity:    CATEGORY_WEIGHTS.INSPECTION + CATEGORY_WEIGHTS.DEADLINES,      // 22
  timeline_adherence:    CATEGORY_WEIGHTS.MILESTONES,                                    // 10
  document_completeness: CATEGORY_WEIGHTS.TITLE + CATEGORY_WEIGHTS.COMPLIANCE
                       + CATEGORY_WEIGHTS.DOCUMENTS,                                     // 28
  communication_recency: CATEGORY_WEIGHTS.COMMUNICATION,                                 // 6
  party_responsiveness:  CATEGORY_WEIGHTS.PARTICIPANTS,                                  // 6
}

/** Human label for a persisted factor_type — the raw value is not seller-readable. */
export const PERSISTED_FACTOR_LABEL: Record<string, string> = {
  financing_status:      "Financing",
  deadline_proximity:    "Deadlines",
  timeline_adherence:    "Timeline",
  document_completeness: "Documents & title",
  communication_recency: "Communication",
  party_responsiveness:  "Party responsiveness",
}

/**
 * EXACT weight for a single scored row, when the caller can recover the original
 * HealthCategory (the scorer writes it into detail.category). This avoids charging a
 * row the whole bucket's weight when two categories collapsed into that bucket.
 * Unknown → 0 so the caller can fall back to weightForFactorType.
 */
export function weightForCategory(category: string | null | undefined): number {
  if (!category) return 0
  return CATEGORY_WEIGHTS[String(category).toUpperCase() as HealthCategory] ?? 0
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
