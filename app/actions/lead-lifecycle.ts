'use server'

import { createClient } from '@/lib/supabase/server'
import { isPlatformStaff } from '@/lib/auth/resolve-user-role'
import { createPortalInviteForContact } from './portal-invites'
import { syncContactToCRM } from '@/lib/crm/sync'
import { convertLeadToContact as kernelConvertLeadToContact } from '@/lib/kernel'

// ACCESS POLICY (owner): LEADS = BROKERAGE + PLATFORM ONLY. The lifecycle verbs
// in this file (list unassigned / claim-assign / convert-to-contact) are lead-desk
// verbs: brokerage-LEVEL roles (broker / broker_owner / broker_admin / admin) +
// platform staff only. Agents, team leads, TCs and compliance officers never work
// lead rows — agents receive their work as CONTACTS (post-promotion). Previously
// these actions had NO role gate and trusted a caller-supplied brokerageId.
const LEAD_DESK_ROLES = new Set(['admin', 'broker', 'broker_owner', 'broker_admin', 'superadmin'])

async function requireLeadDesk(targetBrokerageId: string): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Unauthenticated')

  const { data: profile } = await supabase
    .from('users')
    .select('user_type, platform_role, brokerage_id')
    .eq('id', user.id)
    .maybeSingle()

  const role = profile?.user_type ?? 'agent'
  // Platform staff may act across brokerages (support/repair paths).
  if (role === 'superadmin' || isPlatformStaff(profile?.platform_role)) return

  if (!LEAD_DESK_ROLES.has(role)) {
    throw new Error('Forbidden — leads are managed at the brokerage level')
  }
  // Tenant brokers act only inside their own brokerage — the caller-supplied
  // brokerageId is verified against the session, never trusted.
  if (!profile?.brokerage_id || profile.brokerage_id !== targetBrokerageId) {
    throw new Error('Forbidden — brokerage mismatch')
  }
}

export async function listUnassignedLeads(params: {
  brokerageId: string
  limit?: number
  leadStage?: string
  motivationType?: string
}) {
  const supabase = await createClient()
  const { brokerageId, limit = 50, leadStage, motivationType } = params
  await requireLeadDesk(brokerageId)

  let query = supabase
    .from('leads')
    .select(`
      id,
      first_name,
      last_name,
      email,
      phone,
      source,
      lead_type,
      motivation_type,
      motivation_confidence,
      property_interest,
      lead_stage,
      enrichment_status,
      enrichment_confidence,
      created_at
    `)
    .eq('brokerage_id', brokerageId)
    .is('agent_id', null)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (leadStage) {
    query = query.eq('lead_stage', leadStage)
  }

  if (motivationType) {
    query = query.eq('motivation_type', motivationType)
  }

  const { data: leads, error } = await query

  if (error) {
    throw new Error(`Failed to list leads: ${error.message}`)
  }

  return {
    success: true,
    leads: leads || [],
    total: leads?.length || 0,
    count: leads?.length || 0
  }
}

export async function claimLead(params: {
  leadId: string
  agentId: string
  brokerageId: string
}) {
  const supabase = await createClient()
  const { leadId, agentId, brokerageId } = params
  await requireLeadDesk(brokerageId)

  const { data: lead, error: fetchError } = await supabase
    .from('leads')
    .select('id, agent_id, brokerage_id, is_active')
    .eq('id', leadId)
    .single()

  if (fetchError || !lead) {
    throw new Error('Lead not found')
  }

  if (lead.brokerage_id !== brokerageId) {
    throw new Error('Lead does not belong to this brokerage')
  }

  if (lead.agent_id) {
    throw new Error('Lead already assigned')
  }

  if (!lead.is_active) {
    throw new Error('Lead is inactive')
  }

  const { error: updateError } = await supabase
    .from('leads')
    .update({
      agent_id: agentId,
      lead_stage: 'claimed',
      updated_at: new Date().toISOString()
    })
    .eq('id', leadId)

  if (updateError) {
    throw new Error(`Failed to claim lead: ${updateError.message}`)
  }

  return {
    success: true,
    message: 'Lead claimed successfully'
  }
}

export async function convertLeadToContact(params: {
  leadId: string
  agentId: string
  brokerageId: string
}) {
  const supabase = await createClient()
  const { leadId, agentId, brokerageId } = params
  await requireLeadDesk(brokerageId)

  const { data: lead, error: fetchError } = await supabase
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .single()

  if (fetchError || !lead) {
    throw new Error('Lead not found')
  }

  if (lead.brokerage_id !== brokerageId) {
    throw new Error('Lead does not belong to this brokerage')
  }

  if (!lead.agent_id) {
    throw new Error('Lead must be assigned before conversion')
  }

  // Core conversion via the single canonical kernel command: dedup +
  // contact creation (valid contact_type/persona) + leads.contact_id link +
  // lifecycle_state='assigned' + CONTACT_LEAD_CONVERTED event. The prior inline
  // insert here skipped the link/state/event and had no dedup (drift).
  // QUALIFICATION GATE (owner, round 37): the kernel command REFUSES leads the
  // AI ISA has not marked lead_stage='qualified' — a broker may convert an
  // already-qualified lead, never an unqualified one. The refusal is RETURNED
  // (not thrown) so the UI can show the real reason — production masks thrown
  // server-action messages.
  const result = await kernelConvertLeadToContact({
    leadId,
    brokerageId,
    agentId,                       // agents.id
    tcpaConsent: true,             // manual agent-initiated conversion asserts consent
    consentSource: 'manual_lead_conversion',
  })
  if (!result.success || !result.contactId) {
    return {
      success: false as const,
      contactId: undefined,
      portalInviteCreated: false,
      message: result.error ?? 'Failed to convert lead to contact',
    }
  }
  const contact = { id: result.contactId }

  // Also flip is_active off (the kernel sets lifecycle_state='assigned'/contact_id).
  await supabase.from('leads').update({ is_active: false, updated_at: new Date().toISOString() }).eq('id', leadId)

  // Non-blocking CRM sync — do not fail the conversion if CRM is not configured
  void syncContactToCRM({
    firstName: lead.first_name,
    lastName: lead.last_name,
    email: lead.email ?? undefined,
    phone: lead.phone ?? undefined,
    tags: [lead.lead_type, lead.motivation_type, lead.source].filter(Boolean) as string[],
    source: lead.source ?? "lead_conversion",
    brokerageId,
    agentId,
  })

  // Resolve users.id from agents.id for the invite (non-blocking)
  let portalInviteCreated = false
  try {
    const { data: agentRow } = await supabase
      .from('agents')
      .select('user_id')
      .eq('id', agentId)
      .maybeSingle()

    if (agentRow?.user_id) {
      const inviteResult = await createPortalInviteForContact({
        contactId: contact.id,
        brokerageId,
        invitedByUserId: agentRow.user_id,
        sendMagicLink: false,
      })
      portalInviteCreated = inviteResult.success
    }
  } catch {
    // Non-blocking — do not fail the conversion if the invite fails
  }

  return {
    success: true,
    contactId: contact.id,
    portalInviteCreated,
    message: 'Lead converted to contact successfully'
  }
}

