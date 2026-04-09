'use server'

import { createClient } from '@/lib/supabase/server'
import { createPortalInviteForContact } from './portal-invites'
import { syncContactToCRM } from '@/lib/crm/sync'

export async function listUnassignedLeads(params: {
  brokerageId: string
  limit?: number
  leadStage?: string
  motivationType?: string
}) {
  const supabase = await createClient()
  const { brokerageId, limit = 50, leadStage, motivationType } = params

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

  const { data: contact, error: createError } = await supabase
    .from('contacts')
    .insert({
      brokerage_id: brokerageId,
      agent_id: agentId,
      first_name: lead.first_name,
      last_name: lead.last_name,
      email: lead.email,
      phone: lead.phone,
      phone_secondary: lead.phone_secondary,
      contact_type: lead.lead_type === 'motivated_seller' ? 'seller' : 'buyer',
      contact_persona: determineContactPersona(lead),
      source: lead.source,
      created_at: new Date().toISOString()
    })
    .select('id')
    .single()

  if (createError || !contact) {
    throw new Error(`Failed to create contact: ${createError?.message}`)
  }

  const { error: updateError } = await supabase
    .from('leads')
    .update({
      is_active: false,
      updated_at: new Date().toISOString()
    })
    .eq('id', leadId)

  if (updateError) {
    throw new Error(`Failed to update lead: ${updateError.message}`)
  }

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

function determineContactPersona(lead: any): string {
  if (lead.motivation_type === 'probate') return 'probate'
  if (lead.motivation_type === 'divorce') return 'divorce'
  if (lead.motivation_type === 'foreclosure' || lead.motivation_type === 'pre_foreclosure') return 'motivated_seller'
  if (lead.motivation_type === 'fsbo') return 'fsbo'
  
  return 'other'
}
