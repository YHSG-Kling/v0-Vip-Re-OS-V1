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

// ─── EXTENSIONS: SLA METADATA ─────────────────────────────────────────────────
export type {
  SLAType,
  SLASeverity,
  SLAExpectation,
  SLABreachCheck,
  SLABreachEvent,
} from "./extensions/sla-metadata"
export {
  BUYER_SLA_EXPECTATIONS,
  getSLAExpectation,
  getSLAExpectationsForState,
  emitSLAExpectationMetadata,
  checkSLABreach,
  emitSLABreachSignal,
  querySLABreaches,
  getBuyersWithSLABreaches,
  emitSLAWarningSignal,
} from "./extensions/sla-metadata"

// ─── EXTENSIONS: RECOVERY PATHS ───────────────────────────────────────────────
export type {
  RecoveryPath,
  RecoveryTrigger,
  RecoveryValidation,
  RecoveryHistoryEntry,
} from "./extensions/recovery-paths"
export {
  validateOnHoldRecovery,
  validateDisengagedReengagement,
  emitRecoveryEvent,
  emitReengagementEvent,
  getRecoveryHistory,
  getBuyersEligibleForRecovery,
} from "./extensions/recovery-paths"

// ─── EXTENSIONS: MULTI-OFFER GUARDS ───────────────────────────────────────────
export type {
  OfferStatus,
  OfferLifecycleEvent,
  OfferSubmissionValidation,
  ContractTransitionEvaluation,
  OfferStatistics,
} from "./extensions/multi-offer-guards"
export {
  emitOfferLifecycleEvent,
  queryBuyerOffers,
  hasAcceptedOffer,
  getActiveOffers,
  validateOfferSubmission,
  evaluateContractTransition,
  emitOfferTerminalEvent,
  getBuyerOfferStatistics,
  batchValidateOfferSubmissions,
} from "./extensions/multi-offer-guards"

// ─── EXTENSIONS: FINANCIAL VERIFICATION SCHEMA ────────────────────────────────
export type {
  FinancialVerificationStatus,
  FinancialVerificationType,
  FinancialVerificationSource,
  VerifiedBy,
  FinancialVerificationEventMetadata,
  FinancialVerificationEvent,
  EnhancedVerificationStatus,
} from "./extensions/financial-verification-schema"
export {
  emitFinancialVerificationEvent,
  queryFinancialVerificationEvents,
  getMostRecentVerification,
  isVerificationExpired,
  getDaysUntilExpiration,
  getEnhancedVerificationStatus,
  batchGetVerificationStatus,
} from "./extensions/financial-verification-schema"

// ─── EXTENSIONS: EXPIRATION HANDLER ───────────────────────────────────────────
export type {
  ExpirationCheckResult,
  ExpirationGateResult,
} from "./extensions/expiration-handler"
export {
  checkVerificationExpiration,
  emitExpirationTransitionSignal,
  emitSLAEscalation,
  evaluateSystemGateWithExpiration,
  batchCheckExpirations,
  getBuyersWithExpiringVerifications,
  emitRenewalReminderSignal,
} from "./extensions/expiration-handler"

// ─── EXTENSIONS: CONTACT LIFECYCLE SYNC ───────────────────────────────────────
export type {
  ContactSyncTrigger,
  ContactSyncEvent,
  SyncCheckResult,
} from "./extensions/contact-lifecycle-sync"
export {
  CONTACT_SYNC_STATES,
  mapBuyerStateToContactStage,
  shouldTriggerContactSync,
  emitContactLifecycleSync,
  emitBuyerEngagementSignal,
  emitBuyerUnderContractSignal,
  emitBuyerLifetimeSignal,
  getContactSyncHistory,
  getMostRecentContactSync,
  checkContactSyncStatus,
  batchEmitContactSyncs,
} from "./extensions/contact-lifecycle-sync"
