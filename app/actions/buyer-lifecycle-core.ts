/**
 * System 5.1C: Buyer Lifecycle Governance Core - Server Actions
 * 
 * Public API for buyer lifecycle governance.
 * All actions are governance-only - validate, gate, and log.
 * 
 * NO execution logic, NO UI, NO lender integrations
 */

"use server"

import { isValidUUID } from "@/lib/validations"
import {
  validateStateTransition,
  validateRollback,
  validateReactivation,
  getNextAllowedStates,
  emitLifecycleTransition,
  getLifecycleHistory,
  getCurrentBuyerState as getStateFromHistory,
  getLifecycleStatistics,
  getBuyersInState,
  isSearchAllowed,
  isTourAllowed,
  isOfferAllowed,
  getEnabledGatesForBuyer,
  isGateEnabled,
  checkFinancialVerification,
  emitFinancialVerificationEvent,
  getFinancialVerificationStatus,
  type TransitionValidationResult,
  type LifecycleHistoryEntry,
  type LifecycleStatistics,
  type GatingResult,
  type FinancialVerificationResult,
  type FinancialVerificationStatus,
  type BuyerState,
} from "@/lib/buyer-lifecycle"

/**
 * Validate a buyer lifecycle state transition
 */
export async function validateBuyerStateTransition(params: {
  contactId: string
  currentState: BuyerState | null
  targetState: BuyerState
  userRole: string
  userId: string
  isAdminOverride?: boolean
  overrideReason?: string
}): Promise<TransitionValidationResult> {
  const { contactId, currentState, targetState, userRole, userId, isAdminOverride, overrideReason } =
    params

  // Validate inputs
  if (!isValidUUID(contactId)) {
    return { allowed: false, reason: "Invalid contact ID" }
  }

  if (!userId) {
    return { allowed: false, reason: "User ID required" }
  }

  // Perform validation
  return await validateStateTransition({
    contactId,
    currentState,
    targetState,
    userRole,
    userId,
    isAdminOverride,
    overrideReason,
  })
}

/**
 * Execute a validated state transition (emits event only)
 */
export async function executeBuyerStateTransition(params: {
  contactId: string
  fromState: BuyerState | null
  toState: BuyerState
  triggeredBy: "agent" | "system" | "ai_isa" | "voice"
  authorityRole: string
  userId: string
  sourceSystem: string
  brokerageId: string
  overrideReason?: string
  metadata?: Record<string, unknown>
}): Promise<{ success: boolean; error?: string; activityId?: string }> {
  const {
    contactId,
    fromState,
    toState,
    triggeredBy,
    authorityRole,
    userId,
    sourceSystem,
    brokerageId,
    overrideReason,
    metadata,
  } = params

  // Validate inputs
  if (!isValidUUID(contactId)) {
    return { success: false, error: "Invalid contact ID" }
  }

  // Emit transition event
  return await emitLifecycleTransition({
    contactId,
    fromState,
    toState,
    triggeredBy,
    authorityRole,
    userId,
    sourceSystem,
    brokerageId,
    overrideReason,
    metadata,
  })
}

/**
 * Get buyer lifecycle history
 */
export async function getBuyerLifecycleHistory(params: {
  contactId: string
  limit?: number
  startDate?: Date
  endDate?: Date
}): Promise<LifecycleHistoryEntry[]> {
  const { contactId, limit, startDate, endDate } = params

  if (!isValidUUID(contactId)) {
    return []
  }

  return await getLifecycleHistory(contactId, { limit, startDate, endDate })
}

/**
 * Get current buyer state
 */
export async function getCurrentBuyerState(contactId: string): Promise<BuyerState | null> {
  if (!isValidUUID(contactId)) {
    return null
  }

  return await getStateFromHistory(contactId)
}

/**
 * Get next allowed states for buyer
 */
export async function getNextAllowedBuyerStates(params: {
  contactId: string
  userRole: string
}): Promise<BuyerState[]> {
  const { contactId, userRole } = params

  if (!isValidUUID(contactId)) {
    return []
  }

  const currentState = await getStateFromHistory(contactId)
  if (!currentState) {
    return []
  }

  return getNextAllowedStates(currentState, userRole)
}

/**
 * Validate rollback to ON_HOLD or DISENGAGED
 */
export async function validateBuyerRollback(params: {
  contactId: string
  targetState: "BUYER_ON_HOLD" | "BUYER_DISENGAGED"
  userRole: string
}): Promise<TransitionValidationResult> {
  const { contactId, targetState, userRole } = params

  if (!isValidUUID(contactId)) {
    return { allowed: false, reason: "Invalid contact ID" }
  }

  const currentState = await getStateFromHistory(contactId)
  if (!currentState) {
    return { allowed: false, reason: "Buyer state not found" }
  }

  return validateRollback(currentState, targetState, userRole)
}

/**
 * Validate reactivation from ON_HOLD or DISENGAGED
 */
export async function validateBuyerReactivation(params: {
  contactId: string
  targetState: BuyerState
  userRole: string
}): Promise<TransitionValidationResult> {
  const { contactId, targetState, userRole } = params

  if (!isValidUUID(contactId)) {
    return { allowed: false, reason: "Invalid contact ID" }
  }

  const currentState = await getStateFromHistory(contactId)
  if (!currentState || (currentState !== "BUYER_ON_HOLD" && currentState !== "BUYER_DISENGAGED")) {
    return { allowed: false, reason: "Buyer is not in ON_HOLD or DISENGAGED state" }
  }

  return await validateReactivation(currentState, targetState, contactId, userRole)
}

/**
 * GATING HELPERS
 */

/**
 * Check if buyer can search properties
 */
export async function canBuyerSearchProperties(contactId: string): Promise<GatingResult> {
  if (!isValidUUID(contactId)) {
    return { allowed: false, reason: "Invalid contact ID" }
  }

  return await isSearchAllowed(contactId)
}

/**
 * Check if buyer can schedule tours
 */
export async function canBuyerScheduleTours(contactId: string): Promise<GatingResult> {
  if (!isValidUUID(contactId)) {
    return { allowed: false, reason: "Invalid contact ID" }
  }

  return await isTourAllowed(contactId)
}

/**
 * Check if buyer can submit offers
 */
export async function canBuyerSubmitOffers(contactId: string): Promise<GatingResult> {
  if (!isValidUUID(contactId)) {
    return { allowed: false, reason: "Invalid contact ID" }
  }

  return await isOfferAllowed(contactId)
}

/**
 * Get all enabled gates for buyer
 */
export async function getBuyerEnabledGates(contactId: string): Promise<string[]> {
  if (!isValidUUID(contactId)) {
    return []
  }

  return await getEnabledGatesForBuyer(contactId)
}

/**
 * Check if specific gate is enabled for buyer
 */
export async function isBuyerGateEnabled(params: {
  contactId: string
  gateName: string
}): Promise<boolean> {
  const { contactId, gateName } = params

  if (!isValidUUID(contactId)) {
    return false
  }

  return await isGateEnabled(contactId, gateName)
}

/**
 * FINANCIAL VERIFICATION
 */

/**
 * Check buyer financial verification status
 */
export async function checkBuyerFinancialVerification(
  contactId: string
): Promise<FinancialVerificationResult> {
  if (!isValidUUID(contactId)) {
    return { isVerified: false, signals: [] }
  }

  return await checkFinancialVerification({ contactId })
}

/**
 * Get financial verification status summary
 */
export async function getBuyerFinancialStatus(
  contactId: string
): Promise<FinancialVerificationStatus> {
  if (!isValidUUID(contactId)) {
    return { status: "not_verified" } as unknown as FinancialVerificationStatus
  }

  return (await getFinancialVerificationStatus(contactId)) as unknown as FinancialVerificationStatus
}

/**
 * Emit financial verification event
 */
export async function recordBuyerFinancialVerification(params: {
  contactId: string
  verificationType: "preapproval" | "proof_of_funds" | "lender_intro" | "agent_confirmation"
  userId: string
  expiresAt?: Date
  metadata?: Record<string, unknown>
}): Promise<{ success: boolean; error?: string }> {
  const { contactId, verificationType, userId, expiresAt, metadata } = params

  if (!isValidUUID(contactId)) {
    return { success: false, error: "Invalid contact ID" }
  }

  if (!userId) {
    return { success: false, error: "User ID required" }
  }

  return await emitFinancialVerificationEvent({
    contactId,
    verificationType,
    userId,
    expiresAt,
    status: "verified",
    verifiedBy: "agent",
    source: "manual",
  })
}

/**
 * STATISTICS & REPORTING
 */

/**
 * Get lifecycle statistics for brokerage
 */
export async function getBuyerLifecycleStatistics(params: {
  brokerageId: string
  startDate?: Date
  endDate?: Date
}): Promise<LifecycleStatistics> {
  const { brokerageId, startDate, endDate } = params

  if (!isValidUUID(brokerageId)) {
    return {
      totalBuyers: 0,
      byState: {} as Record<BuyerState, number>,
    }
  }

  return await getLifecycleStatistics(brokerageId, { startDate, endDate })
}

/**
 * Get buyers in specific state
 */
export async function getBuyersInSpecificState(params: {
  brokerageId: string
  state: BuyerState
  limit?: number
}): Promise<string[]> {
  const { brokerageId, state, limit } = params

  if (!isValidUUID(brokerageId)) {
    return []
  }

  return await getBuyersInState(brokerageId, state, { limit })
}
