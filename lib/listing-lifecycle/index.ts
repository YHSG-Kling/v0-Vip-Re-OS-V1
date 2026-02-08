/**
 * System 4.1 - Listing Lifecycle Core Module
 * 
 * Entry point for all listing lifecycle functionality.
 */

// State Machine
export {
  type ListingStatus,
  type ListingStage,
  type TransitionRule,
  LISTING_TRANSITIONS,
  STAGE_PROGRESSION,
  isValidTransition,
  getTransitionRule,
  getAvailableTransitions,
  getRecommendedStatus,
  getNextStage,
  isValidStageProgression,
  getStatusLabel,
  getStageLabel,
  getStatusColor
} from './state-machine'

// Validation
export {
  type ValidationResult,
  type ListingData,
  validateStatusTransition,
  validateStageProgression,
  canArchive,
  canGoLive,
  canAcceptOffer,
  canWithdraw,
  canMarkSold,
  getListingValidationErrors,
  getListingRecommendations
} from './transition-validator'

// Event Logging
export {
  type LifecycleEvent,
  logStatusTransition,
  logStageProgression,
  logListingWentLive,
  logOfferAccepted,
  logSaleClosed,
  logListingExpired,
  logListingWithdrawn,
  logPriceChange,
  logLifecycleEvent,
  logError,
  getListingTimeline
} from './event-logger'

// Workflow Triggers
export {
  type WorkflowTrigger,
  triggerListingWentLiveWorkflow,
  triggerOfferAcceptedWorkflow,
  triggerUnderContractWorkflow,
  triggerSaleClosedWorkflow,
  triggerListingExpiredWorkflow,
  triggerListingWithdrawnWorkflow,
  triggerBackOnMarketWorkflow,
  triggerListingRenewedWorkflow,
  triggerListingRelistedWorkflow,
  triggerPriceReductionWorkflow,
  executeStatusWorkflows
} from './workflow-triggers'
