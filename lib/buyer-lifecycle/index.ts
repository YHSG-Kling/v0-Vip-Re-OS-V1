// ─── LIFECYCLE DEFINITIONS ────────────────────────────────────────────────────
export type { BuyerState, RequiredRole, StateDefinition } from "./lifecycle-definitions"
export {
  BUYER_LIFECYCLE_STATES,
  getStateDefinition,
  getAllStates,
  getStateIndex,
  isStateFrozen,
  getMilestoneStates,
  getEnabledSystemGates,
  isSystemGateEnabled,
  requiresFinancialVerification,
} from "./lifecycle-definitions"

// ─── TRANSITION VALIDATOR ─────────────────────────────────────────────────────
export type {
  TransitionValidationContext,
  TransitionValidationResult,
  BulkTransitionValidation,
  BulkTransitionResult,
} from "./transition-validator"
export {
  validateStateTransition,
  getNextAllowedStates,
  canSkipStates,
  validateRollback,
  validateReactivation,
  validateBulkTransitions,
} from "./transition-validator"

// ─── FINANCIAL VERIFICATION ───────────────────────────────────────────────────
export type {
  FinancialVerificationContext,
  FinancialVerificationResult,
  FinancialVerificationSignal,
  FinancialVerificationStatus,
} from "./financial-verification"
export {
  checkFinancialVerification,
  emitFinancialVerificationEvent,
  isVerificationExpired,
  getFinancialVerificationStatus,
  batchCheckFinancialVerification,
} from "./financial-verification"

// ─── GATING HELPERS ───────────────────────────────────────────────────────────
export type { GatingResult, BulkGatingRequest, BulkGatingResult } from "./gating-helpers"
export {
  isSearchAllowed,
  isTourAllowed,
  isOfferAllowed,
  batchCheckGating,
  getEnabledGatesForBuyer,
  isGateEnabled,
} from "./gating-helpers"

// ─── LIFECYCLE LOGGER ─────────────────────────────────────────────────────────
export type {
  LifecycleTransitionEvent,
  LifecycleHistoryEntry,
  LifecycleStatistics,
} from "./lifecycle-logger"
export {
  emitLifecycleTransition,
  getLifecycleHistory,
  getCurrentBuyerState,
  getLifecycleStatistics,
  getBuyersInState,
  batchEmitLifecycleTransitions,
} from "./lifecycle-logger"
