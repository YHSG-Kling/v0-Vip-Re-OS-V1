/**
 * System 5.1: Multi-Party Update Handlers
 * 
 * Allows updates from:
 * - Agent (assist, guide, update preferences)
 * - Lender (update financial readiness, confirm verification)
 * - Admin/Broker (override gates, expedite process)
 * 
 * All updates are logged with actor role for audit trail
 */

import { createServiceClient } from '@/lib/supabase/service'
import { emitFinancialVerificationEvent } from '@/lib/buyer-lifecycle/financial-verification'
import { logBuyerExecutionEvent } from './buyer-execution-engine'

export type ActorRole = 'agent' | 'lender' | 'admin' | 'broker'

export interface MultiPartyUpdateContext {
  contactId: string
  userId: string
  actorRole: ActorRole
  reason?: string
}

/**
 * Lender confirms financial verification
 * Only lenders can call this
 */
export async function lenderConfirmFinancialVerification(params: {
  contactId: string
  lenderId: string
  verificationType: 'pre_approval' | 'proof_of_funds' | 'lender_intro'
  expiresAt?: Date
  metadata?: {
    approvedAmount?: number
    loanType?: string
    interestRate?: number
    lenderName?: string
    notes?: string
  }
}): Promise<{ success: boolean; error?: string }> {
  const { contactId, lenderId, verificationType, expiresAt, metadata } = params
  
  // Verify lender role
  const supabase = createServiceClient()
  const { data: user } = await supabase
    .from('users')
    .select('role')
    .eq('id', lenderId)
    .single()
  
  if (!user || user.role !== 'lender') {
    return {
      success: false,
      error: 'Only lenders can confirm financial verification'
    }
  }
  
  // Emit verification event
  const result = await emitFinancialVerificationEvent({
    contactId,
    verificationType,
    userId: lenderId,
    expiresAt,
    metadata: {
      ...metadata,
      confirmed_by_lender: true,
      lender_id: lenderId,
    }
  })
  
  if (!result.success) {
    return result
  }
  
  // Log multi-party update
  await logBuyerExecutionEvent({
    contactId,
    eventType: 'buyer.financial.lender_confirmed',
    userId: lenderId,
    source: 'lender_update',
    metadata: {
      verification_type: verificationType,
      actor_role: 'lender',
      ...metadata,
    }
  })
  
  return { success: true }
}

/**
 * Agent assists buyer with search configuration
 * Logs agent involvement without bypassing gates
 */
export async function agentAssistSearchConfiguration(params: {
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
}): Promise<{ success: boolean; error?: string }> {
  const { contactId, agentId, searchPreferences, notes } = params
  
  const supabase = createServiceClient()
  
  // Verify agent role
  const { data: user } = await supabase
    .from('users')
    .select('role')
    .eq('id', agentId)
    .single()
  
  if (!user || !['agent', 'team_leader', 'broker', 'admin'].includes(user.role)) {
    return {
      success: false,
      error: 'Invalid agent role'
    }
  }
  
  // Log agent assistance
  await logBuyerExecutionEvent({
    contactId,
    eventType: 'buyer.search.agent_configured',
    userId: agentId,
    source: 'agent_action',
    metadata: {
      search_preferences: searchPreferences,
      notes,
      actor_role: user.role,
    }
  })
  
  // Optionally append to contact notes
  if (notes) {
    const { data: contact } = await supabase
      .from('contacts')
      .select('notes')
      .eq('id', contactId)
      .single()
    
    let existingNotes: any = {}
    if (contact?.notes) {
      try {
        existingNotes = JSON.parse(contact.notes)
      } catch {
        existingNotes = { raw: contact.notes }
      }
    }
    
    existingNotes.search_preferences = {
      ...existingNotes.search_preferences,
      ...searchPreferences,
      configured_by: agentId,
      configured_at: new Date().toISOString(),
      agent_notes: notes,
    }
    
    await supabase
      .from('contacts')
      .update({ notes: JSON.stringify(existingNotes) })
      .eq('id', contactId)
  }
  
  return { success: true }
}

/**
 * Admin/Broker override financial gate
 * Emergency use only - fully logged
 */
export async function adminOverrideFinancialGate(params: {
  contactId: string
  adminId: string
  reason: string
  expiresAt?: Date
}): Promise<{ success: boolean; error?: string }> {
  const { contactId, adminId, reason, expiresAt } = params
  
  const supabase = createServiceClient()
  
  // Verify admin/broker role
  const { data: user } = await supabase
    .from('users')
    .select('role')
    .eq('id', adminId)
    .single()
  
  if (!user || !['admin', 'broker'].includes(user.role)) {
    return {
      success: false,
      error: 'Only admins or brokers can override financial gates'
    }
  }
  
  if (!reason || reason.length < 10) {
    return {
      success: false,
      error: 'Detailed reason required for override'
    }
  }
  
  // Emit override verification event
  await emitFinancialVerificationEvent({
    contactId,
    verificationType: 'agent_confirmation',
    userId: adminId,
    expiresAt,
    metadata: {
      override: true,
      override_reason: reason,
      override_by_role: user.role,
    }
  })
  
  // Log override (high severity)
  await logBuyerExecutionEvent({
    contactId,
    eventType: 'buyer.financial.gate_overridden',
    userId: adminId,
    source: 'agent_action',
    metadata: {
      override_reason: reason,
      actor_role: user.role,
      severity: 'high',
    }
  })
  
  return { success: true }
}

/**
 * Agent manually advances buyer to next stage
 * Only allowed if gates are satisfied
 */
export async function agentAdvanceBuyerStage(params: {
  contactId: string
  agentId: string
  targetState: string
  reason?: string
}): Promise<{ success: boolean; error?: string }> {
  const { contactId, agentId, targetState, reason } = params
  
  const supabase = createServiceClient()
  
  // Verify agent role
  const { data: user } = await supabase
    .from('users')
    .select('role')
    .eq('id', agentId)
    .single()
  
  if (!user || !['agent', 'team_leader', 'broker', 'admin'].includes(user.role)) {
    return {
      success: false,
      error: 'Invalid agent role'
    }
  }
  
  // Log stage advancement
  await logBuyerExecutionEvent({
    contactId,
    eventType: 'buyer.lifecycle.agent_advanced',
    userId: agentId,
    source: 'agent_action',
    metadata: {
      target_state: targetState,
      reason,
      actor_role: user.role,
    }
  })
  
  return { success: true }
}

/**
 * Get multi-party update history for audit
 */
export async function getMultiPartyUpdateHistory(params: {
  contactId: string
  limit?: number
}): Promise<{
  success: boolean
  updates?: Array<{
    eventType: string
    actorId: string
    actorRole: string
    timestamp: Date
    metadata: Record<string, unknown>
  }>
  error?: string
}> {
  const { contactId, limit = 50 } = params
  
  const supabase = createServiceClient()
  
  const { data: events, error } = await supabase
    .from('activities')
    .select('type, user_id, created_at, metadata')
    .eq('entity_type', 'contact')
    .eq('entity_id', contactId)
    .in('type', [
      'buyer.financial.lender_confirmed',
      'buyer.search.agent_configured',
      'buyer.financial.gate_overridden',
      'buyer.lifecycle.agent_advanced',
    ])
    .order('created_at', { ascending: false })
    .limit(limit)
  
  if (error) {
    return {
      success: false,
      error: 'Failed to fetch update history'
    }
  }
  
  const updates = events?.map(event => ({
    eventType: event.type,
    actorId: event.user_id || 'system',
    actorRole: (event.metadata as any)?.actor_role || 'unknown',
    timestamp: new Date(event.created_at),
    metadata: event.metadata as Record<string, unknown>,
  })) || []
  
  return {
    success: true,
    updates
  }
}
