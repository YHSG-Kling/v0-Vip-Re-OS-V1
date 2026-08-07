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
// The canonical "may this caller act on this contact?" gate. It admits the
// contact THEMSELVES (linked user id or matching email) as well as same-brokerage
// staff, which is exactly the audience this file's `source: 'buyer_portal'` path
// was written for — so gating on it does not close the buyer portal, it is the
// thing the buyer portal was already supposed to be going through.
// Deliberately NOT `assertCanActOnContact` (lib/auth/contact-access.ts): that one
// is staff-only and would lock the buyer out of their own journey.
import { requireContactAccess } from '@/lib/portal/require-contact-access'

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
 *
 * GATED (was not). `"use server"` makes this a public HTTP endpoint and it had no
 * session at all: `contactId` AND the acting `userId` both came from the caller.
 * So anyone could (a) drive the assistant against any contact in any brokerage —
 * `explain_progress` reads that buyer's journey status and speaks it back,
 * including their financial-verification posture — and (b) stamp the resulting
 * `buyer.voice.interaction` activity row with **any user id they liked**, forging
 * the audit trail.
 *
 * `userId` is now ignored and taken from the session, so the interaction log
 * records who actually called.
 */
export async function handleBuyerVoiceAssistant(params: {
  contactId: string
  intent: 'explain_progress' | 'whats_next' | 'search_properties' | 'schedule_tour' | 'general_question'
  transcript: string
  /** Ignored — the actor is derived from the session. */
  userId?: string
}) {
  const { contactId, intent, transcript } = params

  if (!isValidUUID(contactId)) {
    return {
      success: false,
      spokenResponse: 'I had trouble identifying your account. Please try again.'
    }
  }

  const access = await requireContactAccess(contactId)
  if (!access.ok) {
    return {
      success: false,
      spokenResponse: 'I had trouble identifying your account. Please try again.',
      error: access.error,
    }
  }

  try {
    const request: VoiceAssistantRequest = {
      contactId,
      intent,
      transcript,
      userId: access.userId,
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
 *
 * GATED (was not) — and this one bypassed RLS. `"use server"` + no session, and
 * the helper it delegates to (`lib/buyer-execution/multi-party-updates.ts:
 * getMultiPartyUpdateHistory`) reads `activities` through
 * `createServiceClient()`, filtered on `entity_id = contactId` **alone**. Service
 * role means the database's own tenant policies were not in play, so the only
 * thing standing between a caller and any buyer's financial audit trail —
 * `buyer.financial.lender_confirmed`, `buyer.financial.gate_overridden`,
 * `buyer.lifecycle.agent_advanced`, each with actor and metadata — was knowing a
 * contact uuid. Same shape as the wave-1 `batchEvaluateLeadReadiness` finding:
 * a service-client read scoped on a caller-supplied id.
 *
 * `limit` is also clamped now; it was passed straight through to `.limit()`.
 */
export async function getBuyerUpdateHistory(params: {
  contactId: string
  limit?: number
}) {
  const { contactId } = params
  const limit = Math.min(Math.max(Math.trunc(params.limit ?? 50) || 50, 1), 200)

  if (!isValidUUID(contactId)) {
    return { success: false, error: 'Invalid contact ID' }
  }

  const access = await requireContactAccess(contactId)
  if (!access.ok) return { success: false, error: access.error }

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
 *
 * GATED (was not). This was an **unauthenticated audit-log writer**: caller chose
 * the contact, the event type (a free string), the acting `userId`, the source
 * and the metadata blob. That is log forgery against any tenant — you could
 * write `buyer.financial.gate_overridden` attributed to someone else's broker
 * into someone else's activity feed, which is the same feed
 * `getBuyerUpdateHistory` above reads back as an audit trail.
 *
 * Now: caller must be able to act on the contact, the actor is the session's user
 * (never the caller's claim), and `actionType` must be a bounded `buyer.*` event
 * name so this generic logger cannot be used to counterfeit another subsystem's
 * events.
 */
export async function logBuyerAction(params: {
  contactId: string
  actionType: string
  /** Ignored — the actor is derived from the session. */
  userId?: string
  source: 'buyer_portal' | 'voice_assistant' | 'agent_action' | 'automation'
  metadata?: Record<string, unknown>
}) {
  const { contactId, actionType, source, metadata } = params

  if (!isValidUUID(contactId)) {
    return { success: false, error: 'Invalid contact ID' }
  }

  // A generic logger that accepts any event name can counterfeit every other
  // subsystem's events. Keep it inside its own namespace and its own vocabulary.
  if (typeof actionType !== 'string' || !/^buyer\.[a-z0-9_.]{1,60}$/.test(actionType)) {
    return { success: false, error: 'actionType must be a buyer.* event name' }
  }

  const access = await requireContactAccess(contactId)
  if (!access.ok) return { success: false, error: access.error }

  try {
    return await logBuyerExecutionEvent({
      contactId,
      eventType: actionType,
      userId: access.userId,
      source,
      metadata
    })
  } catch (error) {
    console.error('[buyer-execution] Error in logBuyerAction:', error)
    return handleError(error, 'logBuyerAction')
  }
}
