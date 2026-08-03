'use server'

/**
 * SYSTEM 5.1 - BUYER CORE EXECUTION ENGINE
 * Server actions for buyer journey execution
 * 
 * Powers:
 * - Buyer journey status and progress bars
 * - Financial gate enforcement
 * - Voice assistant integration
 * - Multi-party updates (agent, lender, admin)
 * - Journey transparency and education
 */

import { isValidUUID } from '@/lib/validations'
import { handleError } from '@/lib/errors'
import {
  getBuyerJourneyStatus,
  enforceFinancialGate,
  getBuyerFriendlyMessage,
  logBuyerExecutionEvent,
  handleBuyerVoiceRequest,
  lenderConfirmFinancialVerification,
  agentAssistSearchConfiguration,
  adminOverrideFinancialGate,
  agentAdvanceBuyerStage,
  getMultiPartyUpdateHistory,
  type BuyerExecutionContext,
  type VoiceAssistantRequest,
} from '@/lib/buyer-execution'

/**
 * Get buyer's complete journey status
 * Powers buyer portal, progress bars, and agent dashboards
 */
export async function getBuyerJourney(params: {
  contactId: string
  userId?: string
  source?: 'buyer_portal' | 'agent_action' | 'voice_assistant'
}) {
  const { contactId, userId, source = 'buyer_portal' } = params

  if (!isValidUUID(contactId)) {
    return { success: false, error: 'Invalid contact ID' }
  }

  try {
    const context: BuyerExecutionContext = {
      contactId,
      userId,
      source
    }

    const result = await getBuyerJourneyStatus(context)

    if (!result.success || !result.status) {
      return { success: false, error: result.error || 'Failed to get journey status' }
    }

    const friendlyMessage = getBuyerFriendlyMessage(result.status)

    return {
      success: true,
      journey: result.status,
      message: friendlyMessage
    }
  } catch (error) {
    console.error('[buyer-execution] Error in getBuyerJourney:', error)
    return handleError(error, 'getBuyerJourney')
  }
}

/**
 * Check if buyer can perform a specific action
 * Called before search, tour, or offer actions
 */
export async function checkBuyerCanPerformAction(params: {
  contactId: string
  action: 'search' | 'tour' | 'offer'
  userId?: string
}) {
  const { contactId, action, userId } = params

  if (!isValidUUID(contactId)) {
    return { success: false, error: 'Invalid contact ID' }
  }

  try {
    const context: BuyerExecutionContext = {
      contactId,
      userId,
      source: 'buyer_portal'
    }

    const gateCheck = await enforceFinancialGate(context, action)

    if (!gateCheck.allowed) {
      // Log blocked attempt
      await logBuyerExecutionEvent({
        contactId,
        eventType: `buyer.${action}.blocked`,
        userId,
        source: 'buyer_portal',
        metadata: {
          reason: gateCheck.reason,
          verification_status: gateCheck.verification?.isVerified || false
        }
      })
    }

    return {
      success: true,
      allowed: gateCheck.allowed,
      reason: gateCheck.reason,
      verification: gateCheck.verification
    }
  } catch (error) {
    console.error('[buyer-execution] Error in checkBuyerCanPerformAction:', error)
    return handleError(error, 'checkBuyerCanPerformAction')
  }
}

/**
 * Voice assistant endpoint
 * Handles all buyer voice interactions
 */
export async function handleBuyerVoiceAssistant(params: {
  contactId: string
  intent: 'explain_progress' | 'whats_next' | 'search_properties' | 'schedule_tour' | 'general_question'
  transcript: string
  userId?: string
}) {
  const { contactId, intent, transcript, userId } = params

  if (!isValidUUID(contactId)) {
    return { 
      success: false, 
      spokenResponse: 'I had trouble identifying your account. Please try again.' 
    }
  }

  try {
    const request: VoiceAssistantRequest = {
      contactId,
      intent,
      transcript,
      userId
    }

    return await handleBuyerVoiceRequest(request)
  } catch (error) {
    console.error('[buyer-execution] Error in handleBuyerVoiceAssistant:', error)
    return {
      success: false,
      spokenResponse: 'I encountered an error. Please contact your agent for assistance.',
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

/**
 * Lender confirms buyer financial verification
 * LENDER ROLE ONLY
 */
export async function lenderConfirmBuyerFinancials(params: {
  contactId: string
  lenderId: string
  verificationType: 'preapproval' | 'proof_of_funds' | 'lender_intro'
  approvedAmount?: number
  loanType?: string
  interestRate?: number
  lenderName?: string
  expiresAt?: Date
  notes?: string
}) {
  const { contactId, lenderId, verificationType, approvedAmount, loanType, interestRate, lenderName, expiresAt, notes } = params

  if (!isValidUUID(contactId) || !isValidUUID(lenderId)) {
    return { success: false, error: 'Invalid contact or lender ID' }
  }

  try {
    return await lenderConfirmFinancialVerification({
      contactId,
      lenderId,
      verificationType,
      expiresAt,
      metadata: {
        approvedAmount,
        loanType,
        interestRate,
        lenderName,
        notes
      }
    })
  } catch (error) {
    console.error('[buyer-execution] Error in lenderConfirmBuyerFinancials:', error)
    return handleError(error, 'lenderConfirmBuyerFinancials')
  }
}

/**
 * Agent configures buyer search preferences
 * AGENT ROLE
 */
export async function agentConfigureBuyerSearch(params: {
  contactId: string
  agentId: string
  searchPreferences: {
    minPrice?: number
    maxPrice?: number
    minBeds?: number
    maxBeds?: number
    minBaths?: number
    cities?: string[]
    propertyTypes?: string[]
    features?: string[]
  }
  notes?: string
}) {
  const { contactId, agentId, searchPreferences, notes } = params

  if (!isValidUUID(contactId) || !isValidUUID(agentId)) {
    return { success: false, error: 'Invalid contact or agent ID' }
  }

  try {
    return await agentAssistSearchConfiguration({
      contactId,
      agentId,
      searchPreferences,
      notes
    })
  } catch (error) {
    console.error('[buyer-execution] Error in agentConfigureBuyerSearch:', error)
    return handleError(error, 'agentConfigureBuyerSearch')
  }
}

/**
 * Admin/Broker override financial gate
 * ADMIN/BROKER ROLE ONLY - Emergency use
 */
export async function adminOverrideFinancialVerification(params: {
  contactId: string
  adminId: string
  reason: string
  expiresAt?: Date
}) {
  const { contactId, adminId, reason, expiresAt } = params

  if (!isValidUUID(contactId) || !isValidUUID(adminId)) {
    return { success: false, error: 'Invalid contact or admin ID' }
  }

  if (!reason || reason.length < 10) {
    return { success: false, error: 'Detailed reason required for override (minimum 10 characters)' }
  }

  try {
    return await adminOverrideFinancialGate({
      contactId,
      adminId,
      reason,
      expiresAt
    })
  } catch (error) {
    console.error('[buyer-execution] Error in adminOverrideFinancialVerification:', error)
    return handleError(error, 'adminOverrideFinancialVerification')
  }
}

/**
 * Agent advances buyer to next stage
 * AGENT ROLE
 */
export async function agentAdvanceBuyer(params: {
  contactId: string
  agentId: string
  targetState: string
  reason?: string
}) {
  const { contactId, agentId, targetState, reason } = params

  if (!isValidUUID(contactId) || !isValidUUID(agentId)) {
    return { success: false, error: 'Invalid contact or agent ID' }
  }

  try {
    return await agentAdvanceBuyerStage({
      contactId,
      agentId,
      targetState,
      reason
    })
  } catch (error) {
    console.error('[buyer-execution] Error in agentAdvanceBuyer:', error)
    return handleError(error, 'agentAdvanceBuyer')
  }
}

/**
 * Get multi-party update audit trail
 * Shows all agent, lender, and admin actions
 */
export async function getBuyerUpdateHistory(params: {
  contactId: string
  limit?: number
}) {
  const { contactId, limit = 50 } = params

  if (!isValidUUID(contactId)) {
    return { success: false, error: 'Invalid contact ID' }
  }

  try {
    return await getMultiPartyUpdateHistory({
      contactId,
      limit
    })
  } catch (error) {
    console.error('[buyer-execution] Error in getBuyerUpdateHistory:', error)
    return handleError(error, 'getBuyerUpdateHistory')
  }
}

/**
 * Log custom buyer action
 * Generic logging for buyer interactions
 */
export async function logBuyerAction(params: {
  contactId: string
  actionType: string
  userId?: string
  source: 'buyer_portal' | 'voice_assistant' | 'agent_action' | 'automation'
  metadata?: Record<string, unknown>
}) {
  const { contactId, actionType, userId, source, metadata } = params

  if (!isValidUUID(contactId)) {
    return { success: false, error: 'Invalid contact ID' }
  }

  try {
    return await logBuyerExecutionEvent({
      contactId,
      eventType: actionType,
      userId,
      source,
      metadata
    })
  } catch (error) {
    console.error('[buyer-execution] Error in logBuyerAction:', error)
    return handleError(error, 'logBuyerAction')
  }
}
