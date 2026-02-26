/**
 * System 5.1 Reconciliation: Governance Guards
 * 
 * Consolidated governance enforcement checks for ALL buyer actions.
 * Ensures NO execution path bypasses constitutional rules.
 * 
 * CONSTITUTIONAL COMPLIANCE:
 * - Journey + Progress Contract (v1.0.0)
 * - Lifecycle Event Contract (v1.0.0)
 */

import { createServiceClient } from '@/lib/supabase/service'
import {
  checkFinancialVerification,
  isVerificationExpired,
  type FinancialVerificationResult,
  type BuyerState,
} from '@/lib/buyer-lifecycle'
import { getCurrentState } from '@/lib/buyer-lifecycle/transition-validator'

export interface GovernanceCheckResult {
  allowed: boolean
  blockerType?: 'financial_gate' | 'lifecycle_gate' | 'frozen_state' | 'verification_expired'
  reason?: string
  currentState?: BuyerState
  verification?: FinancialVerificationResult
  requiresRollback?: boolean
  rollbackTarget?: BuyerState
}

/**
 * MASTER GOVERNANCE CHECK
 * Called before ANY buyer action (search, tour, offer)
 * Enforces ALL constitutional rules in order
 */
export async function checkBuyerGovernance(params: {
  contactId: string
  action: 'search' | 'tour' | 'offer'
  userId?: string
}): Promise<GovernanceCheckResult> {
  const { contactId, action } = params

  // 1. Check frozen state (highest priority)
  const frozenCheck = await checkFrozenState(contactId)
  if (!frozenCheck.allowed) {
    return frozenCheck
  }

  // 2. Check financial verification
  const financialCheck = await checkFinancialVerification({ contactId })
  
  // 2a. Check expiration
  if (financialCheck.isVerified && isVerificationExpired(financialCheck)) {
    return {
      allowed: false,
      blockerType: 'verification_expired',
      reason: 'Financial verification has expired and requires renewal',
      verification: financialCheck,
      requiresRollback: true,
      rollbackTarget: 'BUYER_FINANCIAL_VERIFICATION_REQUIRED'
    }
  }

  // 2b. Check verification exists
  if (!financialCheck.isVerified) {
    return {
      allowed: false,
      blockerType: 'financial_gate',
      reason: `Financial verification required before ${action}`,
      verification: financialCheck
    }
  }

  // 3. Check lifecycle eligibility
  const lifecycleCheck = await checkLifecycleEligibility(contactId, action)
  if (!lifecycleCheck.allowed) {
    return lifecycleCheck
  }

  // ALL CHECKS PASSED
  return {
    allowed: true,
    currentState: lifecycleCheck.currentState,
    verification: financialCheck
  }
}

/**
 * Check if buyer is in frozen state (BUYER_UNDER_CONTRACT)
 * Frozen states CANNOT execute search/tour/offer actions
 */
async function checkFrozenState(contactId: string): Promise<GovernanceCheckResult> {
  const stateResult = await getCurrentState(contactId)
  
  if (!stateResult.success || !stateResult.currentState) {
    return {
      allowed: false,
      blockerType: 'lifecycle_gate',
      reason: 'Unable to determine buyer state'
    }
  }

  const currentState = stateResult.currentState

  // Check if state is frozen
  const frozenStates: BuyerState[] = [
    'BUYER_UNDER_CONTRACT',
    'BUYER_CLOSED',
    'BUYER_LIFETIME'
  ]

  if (frozenStates.includes(currentState)) {
    return {
      allowed: false,
      blockerType: 'frozen_state',
      reason: `Journey is frozen at ${currentState}. No search/tour/offer actions allowed.`,
      currentState
    }
  }

  return {
    allowed: true,
    currentState
  }
}

/**
 * Check lifecycle eligibility for specific action
 */
async function checkLifecycleEligibility(
  contactId: string,
  action: 'search' | 'tour' | 'offer'
): Promise<GovernanceCheckResult> {
  const stateResult = await getCurrentState(contactId)
  
  if (!stateResult.success || !stateResult.currentState) {
    return {
      allowed: false,
      blockerType: 'lifecycle_gate',
      reason: 'Unable to determine buyer state'
    }
  }

  const currentState = stateResult.currentState

  // Define allowed states for each action
  const allowedStates: Record<string, BuyerState[]> = {
    search: [
      'BUYER_FINANCIALLY_VERIFIED',
      'BUYER_SEARCH_CONFIGURED',
      'BUYER_SEARCHING',
      'BUYER_TOUR_ELIGIBLE',
      'BUYER_TOURING',
      'BUYER_OFFER_ELIGIBLE',
      'BUYER_OFFER_SUBMITTED'
    ],
    tour: [
      'BUYER_TOUR_ELIGIBLE',
      'BUYER_TOURING',
      'BUYER_OFFER_ELIGIBLE',
      'BUYER_OFFER_SUBMITTED'
    ],
    offer: [
      'BUYER_OFFER_ELIGIBLE',
      'BUYER_OFFER_SUBMITTED'
    ]
  }

  const allowed = allowedStates[action].includes(currentState)

  if (!allowed) {
    return {
      allowed: false,
      blockerType: 'lifecycle_gate',
      reason: `Current state ${currentState} does not allow ${action}`,
      currentState
    }
  }

  return {
    allowed: true,
    currentState
  }
}

/**
 * Emit governance block event to activities table
 * Creates full audit trail of all blocks
 */
export async function emitGovernanceBlockEvent(params: {
  contactId: string
  action: 'search' | 'tour' | 'offer'
  blockResult: GovernanceCheckResult
  userId?: string
  source: string
}): Promise<{ success: boolean; error?: string }> {
  const { contactId, action, blockResult, userId, source } = params
  const supabase = createServiceClient()

  const eventType = blockResult.blockerType === 'financial_gate'
    ? 'buyer.financial_verification_required'
    : blockResult.blockerType === 'verification_expired'
    ? 'financial.verification_expired'
    : blockResult.blockerType === 'frozen_state'
    ? 'buyer.action.blocked.frozen_state'
    : 'buyer.action.blocked.lifecycle_gate'

  const { error } = await supabase.from('activities').insert({
    type: eventType,
    entity_type: 'contact',
    entity_id: contactId,
    user_id: userId,
    metadata: {
      action_attempted: action,
      blocker_type: blockResult.blockerType,
      reason: blockResult.reason,
      current_state: blockResult.currentState,
      verification_status: blockResult.verification?.isVerified || false,
      requires_rollback: blockResult.requiresRollback || false,
      rollback_target: blockResult.rollbackTarget,
      source,
      timestamp: new Date().toISOString()
    }
  })

  if (error) {
    console.error('[governance-guards] Error emitting block event:', error)
    return { success: false, error: error.message }
  }

  return { success: true }
}

/**
 * Emit lifecycle eligibility check event (audit trail)
 */
export async function emitEligibilityCheckEvent(params: {
  contactId: string
  action: 'search' | 'tour' | 'offer'
  checkResult: GovernanceCheckResult
  userId?: string
  source: string
}): Promise<{ success: boolean; error?: string }> {
  const { contactId, action, checkResult, userId, source } = params
  const supabase = createServiceClient()

  const { error } = await supabase.from('activities').insert({
    type: 'buyer.lifecycle.eligibility_checked',
    entity_type: 'contact',
    entity_id: contactId,
    user_id: userId,
    metadata: {
      action: action,
      allowed: checkResult.allowed,
      current_state: checkResult.currentState,
      blocker_type: checkResult.blockerType,
      reason: checkResult.reason,
      source,
      timestamp: new Date().toISOString()
    }
  })

  if (error) {
    console.error('[governance-guards] Error emitting eligibility check event:', error)
    return { success: false, error: error.message }
  }

  return { success: true }
}

/**
 * Check if admin override is allowed and valid
 */
export async function checkAdminOverride(params: {
  contactId: string
  userId: string
  reason: string
}): Promise<{ allowed: boolean; error?: string }> {
  const { userId, reason } = params
  const supabase = createServiceClient()

  // Verify admin/broker role
  const { data: user, error: userError } = await supabase
    .from('users')
    .select('role')
    .eq('id', userId)
    .single()

  if (userError || !user) {
    return { allowed: false, error: 'User not found' }
  }

  if (!['admin', 'broker'].includes(user.role)) {
    return { allowed: false, error: 'Only admins or brokers can override governance' }
  }

  if (!reason || reason.length < 10) {
    return { allowed: false, error: 'Detailed reason required for override (minimum 10 characters)' }
  }

  return { allowed: true }
}

/**
 * Get all governance blocks for buyer (diagnostic)
 */
export async function getDiagnosticGovernanceStatus(contactId: string): Promise<{
  success: boolean
  diagnostic?: {
    currentState: BuyerState | null
    isFrozen: boolean
    isFinanciallyVerified: boolean
    isVerificationExpired: boolean
    canSearch: boolean
    canTour: boolean
    canOffer: boolean
    blockers: string[]
  }
  error?: string
}> {
  try {
    const stateResult = await getCurrentState(contactId)
    const verification = await checkFinancialVerification({ contactId })
    
    const currentState = stateResult.currentState || null
    const isFrozen = currentState ? ['BUYER_UNDER_CONTRACT', 'BUYER_CLOSED', 'BUYER_LIFETIME'].includes(currentState) : false
    const isFinanciallyVerified = verification.isVerified
    const isVerificationExpired = isFinanciallyVerified && isVerificationExpired(verification)

    const searchCheck = await checkBuyerGovernance({ contactId, action: 'search' })
    const tourCheck = await checkBuyerGovernance({ contactId, action: 'tour' })
    const offerCheck = await checkBuyerGovernance({ contactId, action: 'offer' })

    const blockers: string[] = []
    if (!searchCheck.allowed && searchCheck.reason) blockers.push(`Search: ${searchCheck.reason}`)
    if (!tourCheck.allowed && tourCheck.reason) blockers.push(`Tour: ${tourCheck.reason}`)
    if (!offerCheck.allowed && offerCheck.reason) blockers.push(`Offer: ${offerCheck.reason}`)

    return {
      success: true,
      diagnostic: {
        currentState,
        isFrozen,
        isFinanciallyVerified,
        isVerificationExpired,
        canSearch: searchCheck.allowed,
        canTour: tourCheck.allowed,
        canOffer: offerCheck.allowed,
        blockers
      }
    }
  } catch (error) {
    console.error('[governance-guards] Error getting diagnostic status:', error)
    return {
      success: false,
      error: 'Failed to get governance diagnostic'
    }
  }
}
