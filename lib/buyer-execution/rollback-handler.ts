/**
 * System 5.1 Reconciliation: Rollback Event Handler
 * 
 * Emits canonical rollback events when journey needs to move backward.
 * Does NOT modify state - state is derived from events.
 * 
 * CONSTITUTIONAL COMPLIANCE:
 * - Journey + Progress Contract (v1.0.0) - Rollback Behavior section
 * - Lifecycle Event Contract (v1.0.0) - Rollback Events section
 */

import { createServiceClient } from '@/lib/supabase/service'
import { type BuyerState } from '@/lib/buyer-lifecycle'

export interface RollbackTrigger {
  contactId: string
  fromStage: BuyerState
  toStage: BuyerState
  reason: 'offer_rejected' | 'offer_withdrawn' | 'contract_terminated' | 'financing_failed' | 'verification_expired' | 'buyer_disengaged' | 'other'
  triggerEventId?: string
  relockedEducation?: string[]
  actorId?: string
  actorRole?: 'agent' | 'broker' | 'admin' | 'system'
  metadata?: Record<string, unknown>
}

/**
 * Emit journey rollback event
 * Signals that buyer journey has moved backward
 */
export async function emitRollbackEvent(
  trigger: RollbackTrigger
): Promise<{ success: boolean; error?: string }> {
  const {
    contactId,
    fromStage,
    toStage,
    reason,
    triggerEventId,
    relockedEducation,
    actorId,
    actorRole,
    metadata
  } = trigger

  const supabase = createServiceClient()

  const { error } = await supabase.from('activities').insert({
    type: 'journey.rollback',
    entity_type: 'contact',
    entity_id: contactId,
    user_id: actorId,
    metadata: {
      journey_type: 'buyer',
      from_stage: fromStage,
      to_stage: toStage,
      reason,
      trigger_event_id: triggerEventId,
      relocked_education: relockedEducation || [],
      actor_role: actorRole || 'system',
      actor_id: actorId,
      timestamp: new Date().toISOString(),
      ...metadata
    }
  })

  if (error) {
    console.error('[rollback-handler] Error emitting rollback event:', error)
    return { success: false, error: error.message }
  }

  return { success: true }
}

/**
 * Handle offer rejection rollback
 * Buyer: OFFER_SUBMITTED → OFFER_ELIGIBLE
 */
export async function handleOfferRejection(params: {
  contactId: string
  offerId: string
  rejectionReason?: string
  actorId?: string
}): Promise<{ success: boolean; error?: string }> {
  const { contactId, offerId, rejectionReason, actorId } = params

  return await emitRollbackEvent({
    contactId,
    fromStage: 'BUYER_OFFER_SUBMITTED',
    toStage: 'BUYER_OFFER_ELIGIBLE',
    reason: 'offer_rejected',
    actorId,
    actorRole: 'system',
    relockedEducation: ['offer_strategy', 'negotiation_tactics'],
    metadata: {
      offer_id: offerId,
      rejection_reason: rejectionReason
    }
  })
}

/**
 * Handle offer withdrawal rollback
 * Buyer: OFFER_SUBMITTED → OFFER_ELIGIBLE
 */
export async function handleOfferWithdrawal(params: {
  contactId: string
  offerId: string
  withdrawalReason?: string
  actorId?: string
}): Promise<{ success: boolean; error?: string }> {
  const { contactId, offerId, withdrawalReason, actorId } = params

  return await emitRollbackEvent({
    contactId,
    fromStage: 'BUYER_OFFER_SUBMITTED',
    toStage: 'BUYER_OFFER_ELIGIBLE',
    reason: 'offer_withdrawn',
    actorId,
    actorRole: actorId ? 'agent' : 'system',
    relockedEducation: ['offer_strategy'],
    metadata: {
      offer_id: offerId,
      withdrawal_reason: withdrawalReason
    }
  })
}

/**
 * Handle contract termination rollback
 * Buyer: UNDER_CONTRACT → SEARCHING or DISENGAGED
 */
export async function handleContractTermination(params: {
  contactId: string
  transactionId: string
  terminationReason: string
  toStage: 'BUYER_SEARCHING' | 'BUYER_DISENGAGED'
  actorId?: string
}): Promise<{ success: boolean; error?: string }> {
  const { contactId, transactionId, terminationReason, toStage, actorId } = params

  return await emitRollbackEvent({
    contactId,
    fromStage: 'BUYER_UNDER_CONTRACT',
    toStage,
    reason: 'contract_terminated',
    actorId,
    actorRole: actorId ? 'agent' : 'system',
    relockedEducation: ['closing_process', 'contingencies'],
    metadata: {
      transaction_id: transactionId,
      termination_reason: terminationReason
    }
  })
}

/**
 * Handle financing failure rollback
 * Buyer: UNDER_CONTRACT → FINANCIAL_VERIFICATION_REQUIRED
 */
export async function handleFinancingFailure(params: {
  contactId: string
  transactionId: string
  failureReason: string
  actorId?: string
}): Promise<{ success: boolean; error?: string }> {
  const { contactId, transactionId, failureReason, actorId } = params

  return await emitRollbackEvent({
    contactId,
    fromStage: 'BUYER_UNDER_CONTRACT',
    toStage: 'BUYER_FINANCIAL_VERIFICATION_REQUIRED',
    reason: 'financing_failed',
    actorId,
    actorRole: 'system',
    relockedEducation: ['financing_basics', 'pre_approval_process'],
    metadata: {
      transaction_id: transactionId,
      failure_reason: failureReason
    }
  })
}

/**
 * Handle verification expiration rollback
 * Buyer: ANY → FINANCIAL_VERIFICATION_REQUIRED
 */
export async function handleVerificationExpiration(params: {
  contactId: string
  currentStage: BuyerState
  documentId?: string
  expiredDate: Date
}): Promise<{ success: boolean; error?: string }> {
  const { contactId, currentStage, documentId, expiredDate } = params

  return await emitRollbackEvent({
    contactId,
    fromStage: currentStage,
    toStage: 'BUYER_FINANCIAL_VERIFICATION_REQUIRED',
    reason: 'verification_expired',
    actorRole: 'system',
    relockedEducation: ['financial_verification', 'search_setup'],
    metadata: {
      document_id: documentId,
      expired_date: expiredDate.toISOString()
    }
  })
}

/**
 * Handle buyer disengagement rollback
 * Buyer: ANY → DISENGAGED
 */
export async function handleBuyerDisengagement(params: {
  contactId: string
  currentStage: BuyerState
  reason: string
  actorId?: string
  actorRole?: 'agent' | 'broker' | 'admin'
}): Promise<{ success: boolean; error?: string }> {
  const { contactId, currentStage, reason, actorId, actorRole } = params

  return await emitRollbackEvent({
    contactId,
    fromStage: currentStage,
    toStage: 'BUYER_DISENGAGED',
    reason: 'buyer_disengaged',
    actorId,
    actorRole: actorRole || 'agent',
    metadata: {
      disengagement_reason: reason
    }
  })
}

/**
 * Get rollback history for buyer
 * Shows all journey rollbacks with reasons
 */
export async function getRollbackHistory(params: {
  contactId: string
  limit?: number
}): Promise<{
  success: boolean
  rollbacks?: Array<{
    fromStage: string
    toStage: string
    reason: string
    occurredAt: Date
    actorRole: string
    metadata: Record<string, unknown>
  }>
  error?: string
}> {
  const { contactId, limit = 20 } = params
  const supabase = createServiceClient()

  const { data: events, error } = await supabase
    .from('activities')
    .select('created_at, metadata')
    .eq('type', 'journey.rollback')
    .eq('entity_type', 'contact')
    .eq('entity_id', contactId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('[rollback-handler] Error fetching rollback history:', error)
    return { success: false, error: 'Failed to fetch rollback history' }
  }

  const rollbacks = events?.map(event => {
    const metadata = event.metadata as Record<string, unknown>
    return {
      fromStage: metadata.from_stage as string,
      toStage: metadata.to_stage as string,
      reason: metadata.reason as string,
      occurredAt: new Date(event.created_at),
      actorRole: metadata.actor_role as string,
      metadata
    }
  }) || []

  return { success: true, rollbacks }
}

/**
 * Check if buyer has experienced rollbacks recently
 * Useful for identifying struggling buyers
 */
export async function hasRecentRollbacks(params: {
  contactId: string
  windowDays?: number
}): Promise<{
  hasRollbacks: boolean
  count: number
  mostRecentReason?: string
}> {
  const { contactId, windowDays = 30 } = params
  const supabase = createServiceClient()

  const windowDate = new Date()
  windowDate.setDate(windowDate.getDate() - windowDays)

  const { data: events, error } = await supabase
    .from('activities')
    .select('created_at, metadata')
    .eq('type', 'journey.rollback')
    .eq('entity_type', 'contact')
    .eq('entity_id', contactId)
    .gte('created_at', windowDate.toISOString())
    .order('created_at', { ascending: false })

  if (error || !events) {
    return { hasRollbacks: false, count: 0 }
  }

  const mostRecentReason = events.length > 0
    ? ((events[0].metadata as Record<string, unknown>).reason as string)
    : undefined

  return {
    hasRollbacks: events.length > 0,
    count: events.length,
    mostRecentReason
  }
}
