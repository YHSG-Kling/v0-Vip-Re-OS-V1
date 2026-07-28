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
 * transaction_health_factors.factor_type is stored lower_snake_case; the weight map
 * is UPPER. One normaliser so the UI never has to guess.
 */
export function weightForFactorType(factorType: string | null | undefined): number {
  if (!factorType) return 0
  return CATEGORY_WEIGHTS[String(factorType).toUpperCase() as HealthCategory] ?? 0
}
