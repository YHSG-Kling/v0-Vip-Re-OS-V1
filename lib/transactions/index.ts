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
  // canActAsExternalParty removed — see the tombstone at
  // lib/transactions/role-guard.ts:112. The external-party gate is
  // lib/kernel/portal-auth.ts:61 requireLenderVendorActor / :111 requireTitleActor.
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
// CDA workflow: ONE rail — app/actions/cda-portal.ts. cda-workflow.ts was a second
// implementation over the same table with weaker gates and a broken create path; its
// unique capabilities (the final document-compliance gate, the kernel lifecycle events,
// the discrepancy activity) were folded into the portal rail and the file deleted.

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

// ─── STAGE AUTO TASKS ─────────────────────────────────────────────────────────
export { seedStageAutoTasks } from './stage-auto-tasks'

// ─── MILESTONE AUTO TRIGGER ───────────────────────────────────────────────────
export { triggerMilestoneFromDocument } from './milestone-auto-trigger'

// ─── COMPLIANCE CHECKS SEEDER ─────────────────────────────────────────────────
export { seedTransactionComplianceChecks } from './compliance-checks-seeder'

// ─── CLASSES ──────────────────────────────────────────────────────────────────
export { TransactionOrchestrator } from './transaction-orchestrator'
export { NotificationService } from './notification-service'
export { ActivityFactory } from './activity-factory'
export type { TransactionOrchestratorParams } from './transaction-orchestrator'
