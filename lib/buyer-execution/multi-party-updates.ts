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
import { emitFinancialVerificationEvent } from '@/lib/buyer-lifecycle'
import { logBuyerExecutionEvent } from './buyer-execution-engine'
import { assertVendorAssignedToContact } from '@/lib/vendor/assignment-access'
import type { SupabaseClient } from '@supabase/supabase-js'

export type ActorRole = 'agent' | 'lender' | 'admin' | 'broker'

// ─────────────────────────────────────────────────────────────────────────────
// ACTOR ROLE RESOLUTION — read `user_type`, not the retired `role` column.
//
// lib/auth/resolve-user-role.ts states the rule: "`user_type` is the single source of
// truth. The legacy `role` column is being retired; new code MUST NOT read or write
// it." `lenderConfirmFinancialVerification` below was migrated in an earlier wave, with
// a note that the old `role === 'lender'` test "silently rejected genuine lenders".
// The other three guards in this file were missed, and the live database shows what
// that cost (project hrvaqgvukzxfskkcrwbt, wave-3 probe):
//
//     select count(*) total, count(role) role_set, count(user_type) user_type_set
//     from users;   ->   total 23, role_set 4, user_type_set 23
//
// 19 of 23 users have role = NULL, and the four that are set are title-cased
// ('Admin', 'Lender') which no lowercase includes() list matches. So:
//
//   * adminOverrideFinancialGate refused EVERY user in the database — the sole
//     user_type='broker' user has role NULL, both user_type='admin' users are NULL
//     or 'Admin'. The emergency financial-gate override could never succeed.
//   * agentAdvanceBuyerStage (the "Advance stage" button on the CRM contact page)
//     and agentAssistSearchConfiguration refused 22 of 23.
//
// It failed CLOSED, so nothing was exposed — but the capability had never once run.
// These now read user_type with the legacy role column as a case-insensitive fallback
// only, matching the shape lenderConfirmFinancialVerification already uses.
// ─────────────────────────────────────────────────────────────────────────────

/** Staff types permitted to record agent-side buyer updates. */
const AGENT_LEVEL_TYPES = new Set(['agent', 'team_lead', 'isa', 'tc', 'broker', 'broker_owner', 'admin', 'superadmin'])
/** Staff types permitted to override a financial gate. Deliberately narrower. */
const OVERRIDE_LEVEL_TYPES = new Set(['admin', 'broker', 'broker_owner', 'superadmin'])

/**
 * Resolve an actor's canonical role from `users.user_type`.
 * Returns null when there is no such user OR the read was refused — supabase-js
 * RESOLVES a failed query, so the error is destructured explicitly and treated as a
 * refusal rather than as "no row", and every caller fails closed on null.
 */
async function resolveActorType(
  supabase: SupabaseClient<any, any, any>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('users')
    .select('user_type, role')
    .eq('id', userId)
    .maybeSingle()

  if (error || !data) return null
  const row = data as { user_type?: string | null; role?: string | null }
  const resolved = row.user_type ?? row.role ?? ''
  return String(resolved).toLowerCase() || null
}

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
  verificationType: 'preapproval' | 'proof_of_funds' | 'lender_intro'
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

  // Verify lender identity. A lender is a vendor-user role — key on user_type
  // (the canonical column: real lender users carry user_type 'lender'|'vendor'
  // and a null/inconsistent legacy `role`, so the old `role === 'lender'` check
  // silently rejected genuine lenders). role is kept only as a legacy fallback.
  const supabase = createServiceClient()
  const { data: user } = await supabase
    .from('users')
    .select('user_type, role')
    .eq('id', lenderId)
    .single()

  const userType = String((user as { user_type?: string; role?: string } | null)?.user_type
    ?? (user as { role?: string } | null)?.role ?? '').toLowerCase()
  if (!user || (userType !== 'lender' && userType !== 'vendor')) {
    return {
      success: false,
      error: 'Only lender / vendor accounts can confirm financial verification'
    }
  }

  // ASSIGNMENT-AWARE GATE (l-vendor): a lender may confirm financials ONLY for a
  // contact the brokerage has assigned to them, with 'financial' scope. Ports the
  // vendor_contact_assignments model — "if the lender is assigned to the contact
  // they can see the transaction, etc." Without this, ANY lender user could flip
  // ANY contact's financing gate across the brokerage boundary. Fails closed.
  const access = await assertVendorAssignedToContact(supabase, {
    vendorUserId: lenderId,
    contactId,
    requiredScopes: ['financial'],
  })
  if (!access.ok) {
    return { success: false, error: access.error ?? 'You are not assigned to this contact.' }
  }

  // Emit verification event
  const result = await emitFinancialVerificationEvent({
    contactId,
    verificationType,
    status: 'verified',
    verifiedBy: 'lender',
    source: 'lender_intro',
    userId: lenderId,
    expiresAt,
    lenderName: metadata?.lenderName,
    preApprovalAmount: metadata?.approvedAmount,
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

  // Verify agent role — see ACTOR ROLE RESOLUTION at the top of this file.
  const actorType = await resolveActorType(supabase, agentId)
  if (!actorType || !AGENT_LEVEL_TYPES.has(actorType)) {
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
      actor_role: actorType,
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

  // Verify admin/broker role — see ACTOR ROLE RESOLUTION at the top of this file.
  // This is the LAST gate in front of a financial-gate override, so it stays here even
  // though the calling server action now derives the admin from the session and checks
  // the same thing: defence in depth, and the lib function is reachable from lanes
  // (the ElevenLabs webhook) that have no cookie session at all.
  const actorType = await resolveActorType(supabase, adminId)
  if (!actorType || !OVERRIDE_LEVEL_TYPES.has(actorType)) {
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
    status: 'verified',
    verifiedBy: 'admin',
    source: 'manual',
    userId: adminId,
    expiresAt,
  })
  
  // Log override (high severity)
  await logBuyerExecutionEvent({
    contactId,
    eventType: 'buyer.financial.gate_overridden',
    userId: adminId,
    source: 'agent_action',
    metadata: {
      override_reason: reason,
      actor_role: actorType,
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

  // Verify agent role — see ACTOR ROLE RESOLUTION at the top of this file.
  const actorType = await resolveActorType(supabase, agentId)
  if (!actorType || !AGENT_LEVEL_TYPES.has(actorType)) {
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
      actor_role: actorType,
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
    .select('activity_type, agent_user_id, created_at, metadata')
    .eq('entity_type', 'contact')
    .eq('entity_id', contactId)
    .in('activity_type', [
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
    eventType: event.activity_type,
    actorId: event.agent_user_id || 'system',
    actorRole: (event.metadata as any)?.actor_role || 'unknown',
    timestamp: new Date(event.created_at),
    metadata: event.metadata as Record<string, unknown>,
  })) || []
  
  return {
    success: true,
    updates
  }
}
