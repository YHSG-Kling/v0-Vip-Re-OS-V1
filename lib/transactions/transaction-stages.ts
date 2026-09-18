/**
 * Phase 3A: Transaction Orchestration System - Stage Constants
 * 
 * Strict state machine definitions for post-contract transaction lifecycle.
 * Every stage transition must validate requirements and log events.
 */

import type { TransactionStatus } from "./transaction-status"

// Stage definitions (post-contract only)
export const TRANSACTION_STAGES = {
  UNDER_CONTRACT: 'UNDER_CONTRACT',
  INSPECTION: 'INSPECTION',
  APPRAISAL: 'APPRAISAL',
  FINANCING_PENDING: 'FINANCING_PENDING',
  CLOSING_PREP: 'CLOSING_PREP',
  CLOSED: 'CLOSED',
  LOST: 'LOST',
} as const

export type TransactionStage = typeof TRANSACTION_STAGES[keyof typeof TRANSACTION_STAGES]

// Status mapping (for transactions.status column).
//
// SECOND SPELLING, SECOND SILENT REFUSAL. The first defect wrote the UPPERCASE
// stage straight into `status`; the fix that replaced it invented `closing`,
// which `transactions_status_check` does not admit EITHER — so FINANCING_PENDING
// and CLOSING_PREP still lost the WHOLE row (23514, both writers below), and no
// deal ever persisted an advance past APPRAISAL. `closing` is precisely the
// value m291 removed from the column: see the "WHAT WAS THERE" note in
// lib/transactions/transaction-status.ts:24 — the ONE transactions.status
// vocabulary, which this map is now typed against so `tsc` refuses a third
// spelling. Values are the survivor's ladder
// (under_contract → pending → clear_to_close → closed), lib/transactions/transaction-status.ts:36.
//   FINANCING_PENDING → `pending`        inspection/appraisal contingencies cleared, lender still working
//   CLOSING_PREP      → `clear_to_close` the lender has issued CTC — docs to title
export const STAGE_TO_STATUS_MAP: Record<TransactionStage, TransactionStatus> = {
  UNDER_CONTRACT: 'under_contract',
  INSPECTION: 'under_contract',
  APPRAISAL: 'under_contract',
  FINANCING_PENDING: 'pending',
  CLOSING_PREP: 'clear_to_close',
  CLOSED: 'closed',
  LOST: 'lost',
}

// Allowed stage transitions
export const ALLOWED_TRANSITIONS: Record<TransactionStage, TransactionStage[]> = {
  UNDER_CONTRACT: ['INSPECTION', 'LOST'],
  INSPECTION: ['APPRAISAL', 'UNDER_CONTRACT', 'LOST'],
  APPRAISAL: ['FINANCING_PENDING', 'INSPECTION', 'LOST'],
  FINANCING_PENDING: ['CLOSING_PREP', 'APPRAISAL', 'LOST'],
  CLOSING_PREP: ['CLOSED', 'FINANCING_PENDING', 'LOST'],
  CLOSED: [], // Terminal state
  LOST: [], // Terminal state
}

// Alias for compatibility
export const STAGE_TRANSITIONS = ALLOWED_TRANSITIONS

// Critical milestones that block stage advancement if overdue
export const CRITICAL_MILESTONES: Record<TransactionStage, string[]> = {
  UNDER_CONTRACT: [],
  INSPECTION: ['inspection_deadline'],
  APPRAISAL: ['appraisal_deadline'],
  FINANCING_PENDING: ['financing_deadline'],
  CLOSING_PREP: ['cda_delivered'],
  CLOSED: [],
  LOST: []
}

// Milestone names (supported by transaction_milestones table)
export const MILESTONE_NAMES = {
  EARNEST_MONEY_DUE: 'earnest_money_due',
  INSPECTION_DEADLINE: 'inspection_deadline',
  INSPECTION_COMPLETED: 'inspection_completed',
  APPRAISAL_ORDERED: 'appraisal_ordered',
  APPRAISAL_DEADLINE: 'appraisal_deadline',
  APPRAISAL_COMPLETED: 'appraisal_completed',
  FINANCING_DEADLINE: 'financing_deadline',
  CLEAR_TO_CLOSE_RECEIVED: 'clear_to_close_received',
  FINAL_WALKTHROUGH_SCHEDULED: 'final_walkthrough_scheduled',
  CDA_DELIVERED: 'cda_delivered',
  CD_UPLOADED: 'cd_uploaded',
  FUNDING_CONFIRMED: 'funding_confirmed',
  CLOSING_DATE: 'closing_date',
  // Addendum milestones
  INSPECTOR_APPROVED: 'inspector_approved',
  INSURANCE_QUOTE_APPROVED: 'insurance_quote_approved',
  GIFT_ORDERED: 'gift_ordered',
} as const

export type MilestoneName = typeof MILESTONE_NAMES[keyof typeof MILESTONE_NAMES]

// Milestone status
export const MILESTONE_STATUS = {
  PENDING: 'pending',
  COMPLETED: 'completed',
  OVERDUE: 'overdue',
  CANCELLED: 'cancelled',
} as const

export type MilestoneStatus = typeof MILESTONE_STATUS[keyof typeof MILESTONE_STATUS]

// Client-visible vs internal-only milestones
export const CLIENT_VISIBLE_MILESTONES: MilestoneName[] = [
  MILESTONE_NAMES.EARNEST_MONEY_DUE,
  MILESTONE_NAMES.INSPECTION_DEADLINE,
  MILESTONE_NAMES.INSPECTION_COMPLETED,
  MILESTONE_NAMES.FINANCING_DEADLINE,
  MILESTONE_NAMES.CLEAR_TO_CLOSE_RECEIVED,
  MILESTONE_NAMES.FINAL_WALKTHROUGH_SCHEDULED,
  MILESTONE_NAMES.CLOSING_DATE,
]

// Role-based permissions
export const ROLES = {
  AGENT: 'agent',
  TC: 'tc',
  COMPLIANCE_OFFICER: 'compliance_officer',
  BROKER: 'broker',
  ADMIN: 'admin',
  LENDER: 'lender',
  TITLE_AGENT: 'title_agent',
  /** @deprecated Use TITLE_AGENT. Kept for backward compatibility. */
  TITLE: 'title_agent',
  /** @deprecated Use TC. Kept for backward compatibility. */
  TRANSACTION_COORDINATOR: 'tc',
  CLIENT: 'contact',
} as const

export type Role = typeof ROLES[keyof typeof ROLES]

// Roles that can transition stages
export const STAGE_TRANSITION_ROLES: Role[] = [
  ROLES.AGENT,
  ROLES.TC,
  ROLES.BROKER,
  ROLES.ADMIN,
]

// Roles that can override critical milestones
export const MILESTONE_OVERRIDE_ROLES: Role[] = [
  ROLES.BROKER,
  ROLES.ADMIN,
]

// Roles that can edit milestone dates
export const MILESTONE_EDIT_ROLES: Role[] = [
  ROLES.AGENT,
  ROLES.TC,
  ROLES.BROKER,
  ROLES.ADMIN,
]

// Roles that can mark lost
export const MARK_LOST_ROLES: Role[] = [
  ROLES.AGENT,
  ROLES.TC,
  ROLES.BROKER,
  ROLES.ADMIN,
]

// Transaction type
export interface Transaction {
  id: string
  brokerage_id: string
  agent_id: string
  contact_id: string
  property_address: string
  purchase_price: number
  status: string
  stage: string | null
  contract_date: string | null
  close_date: string | null
  compliance_passed_at: string | null
  deal_type: string | null
  commission_percentage: number | null
  created_at: string
  updated_at: string
}

// Milestone type
export interface Milestone {
  id: string
  transaction_id: string
  milestone_name: string
  target_date: string | null
  status: string
  notes: string | null
  created_at: string
}

// Stage transition parameters
export interface StageTransitionParams {
  transactionId: string
  brokerageId: string
  targetStage: TransactionStage
  actorUserId: string
  role: Role
  overrideReason?: string
}

// Milestone completion parameters
export interface MilestoneCompletionParams {
  milestoneId: string
  transactionId: string
  brokerageId: string
  actorUserId: string
  role: Role
  notes?: string
}

// Lost transaction parameters
export interface MarkLostParams {
  transactionId: string
  brokerageId: string
  actorUserId: string
  role: Role
  lostReason: string
  category: string
  earnestMoneyOutcome: 'returned' | 'forfeited'
  fromStage: TransactionStage
}
