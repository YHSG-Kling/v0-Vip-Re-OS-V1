// ─── TRANSACTION STAGES & TYPES ───────────────────────────────────────────────
export {
  TRANSACTION_STAGES,
  STAGE_TO_STATUS_MAP,
  ALLOWED_TRANSITIONS,
  STAGE_TRANSITIONS,
  CRITICAL_MILESTONES,
  MILESTONE_NAMES,
  MILESTONE_STATUS,
  CLIENT_VISIBLE_MILESTONES,
  ROLES,
  STAGE_TRANSITION_ROLES,
  MILESTONE_OVERRIDE_ROLES,
  MILESTONE_EDIT_ROLES,
  MARK_LOST_ROLES,
} from './transaction-stages'
export type {
  TransactionStage,
  MilestoneName,
  MilestoneStatus,
  Role,
  Transaction,
  Milestone,
  StageTransitionParams,
  MilestoneCompletionParams,
  MarkLostParams,
} from './transaction-stages'

// ─── STAGE PROGRESSION ────────────────────────────────────────────────────────
export { canAdvanceStage, advanceStage } from './stage-progression'
export type { StageProgressionResult } from './stage-progression'

// ─── ROLE GUARD ───────────────────────────────────────────────────────────────
export {
  canTransitionStage,
  canOverrideMilestone,
  canEditMilestoneDate,
  canViewFinancials,
  canActAsExternalParty,
  assertUserHasRole,
} from './role-guard'
export type { UserRole, RoleContext } from './role-guard'

// ─── MILESTONE SERVICE ────────────────────────────────────────────────────────
export {
  ensureRequiredMilestones,
  completeMilestone,
  overrideMilestone,
  setMilestoneDate,
  getMilestones,
} from './milestone-service'
export type {
  CreateMilestoneParams,
  CompleteMilestoneParams,
  OverrideMilestoneParams,
} from './milestone-service'

// ─── CDA WORKFLOW ─────────────────────────────────────────────────────────────
export { generateCDAPreview, submitCDA, approveCDA } from './cda-workflow'

// ─── VENDOR QUOTE WORKFLOW ────────────────────────────────────────────────────
export { requestQuoteApproval, approveQuote, declineQuote } from './vendor-quote-workflow'

// ─── OFFER BRIDGE ─────────────────────────────────────────────────────────────
export { createTransactionFromOffer } from './offer-bridge'

// ─── CONTRACT GOVERNANCE ──────────────────────────────────────────────────────
export { setContractDate, assertAdjustmentsUnlocked } from './contract-governance'

// ─── DEADLINE MONITOR ─────────────────────────────────────────────────────────
export { checkTransactionDeadlines } from './deadline-monitor'

// ─── GIFT ORDER TRIGGER ───────────────────────────────────────────────────────
export { checkAndTriggerGiftOrder } from './gift-order-trigger'

// ─── CLASSES ──────────────────────────────────────────────────────────────────
export { TransactionOrchestrator } from './transaction-orchestrator'
export { TransparencyService } from './transparency-service'
export { NotificationService } from './notification-service'
export { ActivityFactory } from './activity-factory'
export type { TransactionOrchestratorParams } from './transaction-orchestrator'
