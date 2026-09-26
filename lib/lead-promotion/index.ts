// ─── ELIGIBILITY EVALUATOR ────────────────────────────────────────────────────
export { evaluatePromotionEligibility } from './eligibility-evaluator'   // gated public door
export { evaluatePromotionEligibilityCore } from './eligibility-core'    // ungated, internal/server callers only

// ─── INITIAL SCORER ───────────────────────────────────────────────────────────
export { triggerInitialScoring } from './initial-scorer'

// ─── LEAD PROMOTER ────────────────────────────────────────────────────────────
export { promoteRawRecordToLead } from './lead-promoter'
