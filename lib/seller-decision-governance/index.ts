// ─── DECISION STATE DEFINITIONS ───────────────────────────────────────────────
export type { SellerDecisionState, RequiredRole, DecisionStateDefinition } from "./decision-state-definitions"
export {
  SELLER_DECISION_STATES,
  getStateDefinition,
  getAllStates,
  getMilestoneStates,
  allowsOverride,
  allowsReversal,
  getOverrideRequiredRole,
  getEnabledSystemGates,
  getSLAExpectation,
  checkPrerequisites,
} from "./decision-state-definitions"

// ─── DECISION READINESS ENGINE ─────────────────────────────────────────────────
export type { DecisionReadinessInput, DecisionReadinessResult } from "./decision-readiness-engine"
export {
  evaluateDecisionReadiness,
  isDecisionReady,
  validateDecisionReversal,
} from "./decision-readiness-engine"

// ─── CMA QUALITY EVALUATOR ────────────────────────────────────────────────────
export type { CMAQualityInput, CMAQualityResult } from "./cma-quality-evaluator"
export {
  evaluateCMAQuality,
  deriveCMAQualityFromEvents,
  isCMAReady,
} from "./cma-quality-evaluator"

// ─── NET SHEET VALIDATOR ──────────────────────────────────────────────────────
export type { NetSheetValidityInput, NetSheetValidityResult } from "./net-sheet-validator"
export {
  validateNetSheetValidity,
  deriveNetSheetValidityFromEvents,
  isNetSheetValid,
  emitNetSheetExpirationWarning,
} from "./net-sheet-validator"

// ─── PRESENTATION READINESS ───────────────────────────────────────────────────
export type { PresentationReadinessInput, PresentationReadinessResult } from "./presentation-readiness"
export {
  evaluatePresentationReadiness,
  derivePresentationReadinessFromEvents,
  isPresentationReady,
} from "./presentation-readiness"

// ─── DECISION LOGGER ──────────────────────────────────────────────────────────
export type {
  DecisionTransitionEvent,
  CMAQualityEvent,
  NetSheetEvent,
  PresentationEvent,
  DecisionReversalEvent,
} from "./decision-logger"
export {
  logDecisionTransition,
  logCMAQualityVerified,
  logNetSheetEvent,
  logPresentationEvent,
  logDecisionReversal,
  batchLogEvents,
  queryDecisionHistory,
} from "./decision-logger"
