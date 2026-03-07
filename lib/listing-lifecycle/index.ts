// ─── LIFECYCLE DEFINITIONS ────────────────────────────────────────────────────
export type { ListingStage, ReadinessCheckType, RequiredRole, StageDefinition } from "./lifecycle-definitions"
export {
  LISTING_LIFECYCLE_STAGES,
  getStageDefinition,
  getAllStages,
  getStageIndex,
  isBeforeStage,
  getMilestoneStages,
  getEnabledSystemGates,
  isSystemGateEnabled,
} from "./lifecycle-definitions"

// ─── TRANSITION VALIDATOR ─────────────────────────────────────────────────────
export type {
  TransitionValidationContext,
  TransitionValidationResult,
  BulkTransitionValidation,
  BulkTransitionResult,
} from "./transition-validator"
export {
  validateStageTransition,
  validateBulkTransitions,
  getNextAllowedStages,
  canSkipStages,
  validateSkipStageTransition,
} from "./transition-validator"

// ─── READINESS CHECKER ────────────────────────────────────────────────────────
export type { ReadinessCheckResult, ReadinessEvaluation } from "./readiness-checker"
export { evaluateReadinessChecks } from "./readiness-checker"

// ─── READINESS EVALUATION (enhanced / event-sourced) ─────────────────────────
export {
  evaluateMediaReadinessFromEvents,
  evaluateDocumentReadinessFromEvents,
  evaluateSignatureReadinessFromEvents,
  evaluateMLSReadinessFromEvents,
  evaluateRepairReadinessFromEvents,
  evaluateShowingReadinessFromEvents,
  evaluateOfferReadinessFromEvents,
  evaluateTransactionReadinessFromEvents,
  evaluateCompositeReadiness,
  evaluateAllReadinessComposite,
} from "./readiness-evaluation-enhanced"

// ─── LIFECYCLE LOGGER ─────────────────────────────────────────────────────────
export type { LifecycleEventData } from "./lifecycle-logger"
export {
  logStageTransition,
  logFailedTransition,
  logSystemGateEnabled,
  getLifecycleHistory,
  getCurrentLifecycleStage,
  getLifecycleStatistics,
  getStageTimingMetrics,
} from "./lifecycle-logger"

// ─── ROLLBACK CASCADE ─────────────────────────────────────────────────────────
export type { AffectedDomain, RollbackCascadeParams } from "./rollback-cascade"
export {
  emitRollbackCascade,
  determineAffectedDomains,
  emitExceptionCascade,
  getRollbackHistory,
  isListingInRollback,
  getRecentRollbackDomains,
} from "./rollback-cascade"

// ─── MULTI-LISTING PRIORITY ───────────────────────────────────────────────────
export type { ListingPriority, ListingWithPriority } from "./multi-listing-priority"
export {
  resolvePrimaryListing,
  isListingPrimary,
  getListingPriority,
  canListingDriveJourneys,
  canListingTriggerMarketing,
  canListingControlCommunications,
  getContactsWithMultipleListings,
  getPriorityOverrideRecommendations,
} from "./multi-listing-priority"

// ─── EXCEPTION RECOVERY LIMITS ───────────────────────────────────────────────
export type { StageDurationLimit, SpecialStageRule } from "./exception-recovery-limits"
export {
  STAGE_DURATION_LIMITS,
  SPECIAL_STAGE_RULES,
  checkStageDurationLimit,
  emitStageDurationEscalation,
  checkAllListingDurationLimits,
  checkSpecialStageRules,
  getEscalationHistory,
} from "./exception-recovery-limits"

// ─── INTEGRATION DEDUPLICATION ────────────────────────────────────────────────
export type { IntegrationEventType, IntegrationSource } from "./integration-deduplication"
export {
  INTEGRATION_EVENT_TYPES,
  INTEGRATION_SOURCES,
  storeIntegrationEventIdempotent,
  computeMetadataHash,
  storeIntegrationEventWithMetadataHash,
  batchStoreIntegrationEvents,
  filterDuplicateEvents,
} from "./integration-deduplication"

// ─── EVENT STORAGE ────────────────────────────────────────────────────────────
export type { LifecycleEventStorageParams } from "./event-storage"
export {
  storeLifecycleEvent,
  queryEventsByEntityAndType,
  queryEventsByIntegrationSource,
  checkEventExists,
  getLatestEvent,
  countEventsByType,
} from "./event-storage"
