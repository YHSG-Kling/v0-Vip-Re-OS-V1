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
// agents.id -> users.id. Taken from the CLIENT-AGNOSTIC kernel module, not from
// lib/kernel/agent-identity-resolver.ts: that one is `server-only` and pulling it
// into this graph would break any plain guard/page that reaches this module.
import { resolveUserIdForAgentRecord } from '@/lib/kernel/agent-identity'
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

// ─────────────────────────────────────────────────────────────────────────────
// FINANCING-GATE OVERRIDE AUTHORITY
//
// Owner ruling: "admin or agent can override the finiancing gate".
//
// Expressed as an EXPLICIT ALLOW-LIST of staff user_types, and never as "not a
// contact" or any other negation. A negation admits every user_type that is added
// to the vocabulary later — which is exactly how this class of hole gets reopened.
//
// The vocabulary was verified against the LIVE CHECK constraint rather than
// assumed (project hrvaqgvukzxfskkcrwbt, `users_user_type_check`, convalidated):
//
//   admin, agent, broker, broker_owner, compliance_officer, contact, isa,
//   lender, superadmin, support, system, tc, team_lead, vendor
//
// Deliberately absent: team_lead, isa, tc, compliance_officer, support, lender,
// vendor, system — the ruling names admin and agent, and widening past it is not
// ours to invent. (`broker_admin` / `super_admin`, which lib/auth/resolve-user-role
// still tolerates as legacy spellings, are NOT admissible values in the constraint,
// so they are absent here too.)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Override authority over ANY contact in the caller's tenant. The admin/broker
 * family, unchanged from before the ruling.
 */
const OVERRIDE_BROKERAGE_WIDE_TYPES = new Set([
  'admin',
  'broker',
  'broker_owner',
  'superadmin',
])

/**
 * Override authority ONLY over a contact this caller is the AGENT OF RECORD for.
 *
 * "agent" is scoped to the agent ON THAT CONTACT, not to any agent in the
 * brokerage. Tenancy alone is not a relationship: `requireContactAccess` admits
 * every agent in the brokerage, so reading the ruling the loose way would let any
 * of a brokerage's agents lift the financing gate of a buyer they have never met.
 * The voice lane already draws the line in the same place
 * (validate-authority.ts:validateContactAccess restricts a plain agent to their own
 * contacts while admin/broker get brokerage-wide reach), so this keeps the two
 * lanes saying the same thing.
 */
const OVERRIDE_ASSIGNED_AGENT_TYPES = new Set(['agent'])

export type OverrideAuthorityDecision =
  | { allowed: true; scope: 'brokerage_wide' | 'assigned_agent' }
  | { allowed: false; error: string }

/**
 * THE ONE PLACE the financing-gate override authority rule is written down.
 *
 * Both enforcement points call this — the server action (with the user_type
 * requireContactAccess already resolved) and adminOverrideFinancialGate below
 * (with a user_type it re-reads from the database itself). Sharing the DECISION
 * while keeping the two user_type READS independent is what keeps the layers in
 * agreement without giving up defence in depth.
 *
 * Fails CLOSED on every uncertainty: unknown user_type, refused query, missing
 * contact, missing agents row.
 */
export async function resolveFinancialGateOverrideAuthority(
  supabase: SupabaseClient<any, any, any>,
  params: { userId: string; userType: string | null; contactId: string },
): Promise<OverrideAuthorityDecision> {
  const { userId, userType, contactId } = params
  const refusal = {
    allowed: false as const,
    error: 'Only admins, brokers, or the assigned agent can override financial gates',
  }

  if (!userId || !userType) return refusal

  const type = userType.toLowerCase()
  const brokerageWide = OVERRIDE_BROKERAGE_WIDE_TYPES.has(type)
  const assignedAgentOnly = OVERRIDE_ASSIGNED_AGENT_TYPES.has(type)

  // Not on either allow-list — refuse before touching the database.
  if (!brokerageWide && !assignedAgentOnly) return refusal

  // `contacts.agent_id` is an agents.id (FK contacts_agent_id_fkey -> agents(id)),
  // NOT a users.id — verified against the live schema. `contact_user_id` IS a
  // users.id. Never compare across those spaces.
  const { data: contact, error: contactErr } = await supabase
    .from('contacts')
    .select('agent_id, contact_user_id')
    .eq('id', contactId)
    .maybeSingle()

  // supabase-js RESOLVES a refused query, so `error` is destructured explicitly;
  // a gate that cannot read its own inputs must refuse, not proceed.
  if (contactErr || !contact) return refusal

  const row = contact as { agent_id: string | null; contact_user_id: string | null }

  // NOBODY overrides their own financing gate, whatever their user_type says.
  // The gate exists to stop a buyer transacting before their finances are verified;
  // a staff member who is also the contact of record is still the buyer here.
  if (row.contact_user_id && row.contact_user_id === userId) {
    return { allowed: false, error: 'You cannot override your own financial gate' }
  }

  if (brokerageWide) return { allowed: true, scope: 'brokerage_wide' }

  // assignedAgentOnly: bridge users.id -> agents.id through the contact's assigned
  // agents row. Resolving the agents row's user_id (rather than guessing which of a
  // multi-tenant user's agents rows to use) makes this exact.
  if (!row.agent_id) return refusal
  // `as any` on the client matches the existing call convention for the kernel
  // agent-identity helpers elsewhere in the app (they are typed against the default
  // SupabaseClient schema generic, this module against <any, any, any>).
  const assignedUserId = await resolveUserIdForAgentRecord(supabase as any, row.agent_id)
  if (!assignedUserId || assignedUserId !== userId) return refusal

  return { allowed: true, scope: 'assigned_agent' }
}

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

  // Verify override authority — see FINANCING-GATE OVERRIDE AUTHORITY at the top of
  // this file. This is the LAST gate in front of a financial-gate override, so it stays
  // here even though the calling server action checks the same rule: defence in depth.
  // The user_type is re-read from the database here (resolveActorType) rather than
  // trusted from the caller, so the two layers agree on the RULE while reading the
  // FACT independently.
  const actorType = await resolveActorType(supabase, adminId)
  const authority = await resolveFinancialGateOverrideAuthority(supabase, {
    userId: adminId,
    userType: actorType,
    contactId,
  })
  if (!authority.allowed) {
    return { success: false, error: authority.error }
  }

  if (!reason || reason.length < 10) {
    return {
      success: false,
      error: 'Detailed reason required for override'
    }
  }
  
  // Emit override verification event. `verifiedBy` is derived from the authority that
  // was actually granted, not hard-coded to 'admin' — now that an assigned agent can
  // override, recording every override as an admin one would misattribute the actor in
  // the very record that exists to reconstruct who lifted the gate.
  const verifiedBy = authority.scope === 'assigned_agent' ? 'agent' : 'admin'

  const emitted = await emitFinancialVerificationEvent({
    contactId,
    verificationType: 'agent_confirmation',
    status: 'verified',
    verifiedBy,
    source: 'manual',
    userId: adminId,
    expiresAt,
    // The reason belongs on the verification event too, not only on the separate audit
    // row: this is the event `checkFinancialVerification` reads back, so it is the one
    // that survives as the explanation for why the gate is open.
    verificationNotes: reason,
  })

  // This is the write that actually lifts the gate. Dropping its result reported
  // success while nothing had been written — the sibling lender path above already
  // propagates the failure, and so must this one.
  if (!emitted.success) {
    return { success: false, error: emitted.error ?? 'Failed to record financial gate override' }
  }

  // Log override (high severity)
  await logBuyerExecutionEvent({
    contactId,
    eventType: 'buyer.financial.gate_overridden',
    userId: adminId,
    source: 'agent_action',
    metadata: {
      override_reason: reason,
      actor_role: actorType,
      // Which allow-list admitted this actor — 'brokerage_wide' (admin family) or
      // 'assigned_agent' (the agent of record on this contact).
      override_scope: authority.scope,
      expires_at: expiresAt?.toISOString() ?? null,
      severity: 'high',
    }
  })

  // ── THE OVERRIDE HAS TO LIFT BOTH STORES, OR IT DOES NOT LIFT THE GATE ─────
  //
  // Owner ruling: "admin or agent can override the financing gate." Until now
  // this lane honoured half of it. There are TWO stores of "financially
  // verified" and they are read by DIFFERENT gates:
  //
  //   · the ACTIVITY trail, which emitFinancialVerificationEvent above writes
  //     and lib/buyer-lifecycle/financial-verification.ts:checkFinancialVerification
  //     reads back — this is what isOfferAllowed consults; and
  //   · the buyer_financial_profiles.verified COLUMN, which the Financial
  //     Verification panel's own bypass (buyer-financial.ts:markFinanciallyVerified)
  //     sets and which app/actions/buyer-offers.ts:createOffer checks directly.
  //
  // So an override granted through THIS emergency lane opened the lifecycle gate
  // and was then stopped dead at the offer action by a column it never touched —
  // the agent was told the buyer "is not financially verified" moments after an
  // authorised override said otherwise, with nothing on screen explaining the
  // contradiction. That is the ruling being defeated, not enforced.
  //
  // The fix completes the OVERRIDE rather than weakening the GATE: the stricter
  // column check at createOffer stays exactly as strict for everyone who has not
  // been granted an override. Authority was established above (resolveFinancial-
  // GateOverrideAuthority) and re-read from the database, so this write is
  // downstream of the same decision, not a second, looser one.
  //
  // UPDATE, not upsert: a profile row is created when the buyer's financial
  // details are captured, and inventing one here would fabricate a financial
  // profile for a buyer who has never had one. If no row exists there is nothing
  // to verify and the caller is told, rather than the override reporting a
  // success the offer action will contradict.
  const { data: liftedRows, error: columnError } = await supabase
    .from('buyer_financial_profiles')
    .update({
      verified: true,
      verified_by: adminId,
      verified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('contact_id', contactId)
    .select('id')

  if (columnError) {
    return {
      success: false,
      error:
        `The override was recorded but the buyer's financial profile could not be updated (${columnError.message}), ` +
        'so submitting an offer would still be refused. Nothing was half-applied silently — retry the override.',
    }
  }
  if (!liftedRows || liftedRows.length === 0) {
    return {
      success: false,
      error:
        'This buyer has no financial profile yet, so there is nothing to override. ' +
        'Capture their financing details (cash or pre-approval) first, then override if it is still needed.',
    }
  }

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
