'use server'

import { createClient } from '@/lib/supabase/server'

export async function acceptAIISAHandoff(params: {
  leadId: string
  brokerageId: string
  actorUserId: string
}): Promise<{ success: boolean; contactId?: string; error?: string }> {
  const supabase = await createClient()

  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .select('id, brokerage_id, agent_id, contact_id, lifecycle_state')
    .eq('id', params.leadId)
    .single()

  if (leadErr || !lead) {
    return { success: false, error: 'Lead not found' }
  }

  // Already has a contact — just open it
  if (lead.contact_id) {
    return { success: true, contactId: lead.contact_id }
  }

  // Ensure agent is assigned before conversion
  let assignedAgentId: string | null = lead.agent_id ?? null

  if (!assignedAgentId) {
    const { governLead } = await import('@/app/actions/lead-governance/govern-lead')
    const governance = await governLead(lead.id, lead.brokerage_id)
    assignedAgentId = governance?.agentAssigned ?? null
  }

  if (!assignedAgentId) {
    return { success: false, error: 'No agent available for handoff. Assign an agent first.' }
  }

  // Convert lead → contact through canonical path
  let contactId: string | undefined
  try {
    const { convertLeadToContact } = await import('@/app/actions/lead-lifecycle')
    // convertLeadToContact throws on failure; we catch below
    await convertLeadToContact({
      leadId: lead.id,
      agentId: assignedAgentId,
      brokerageId: lead.brokerage_id,
    })

    // Read the contact_id back — convertLeadToContact writes it to leads
    const { data: updated } = await supabase
      .from('leads')
      .select('contact_id')
      .eq('id', lead.id)
      .single()

    contactId = updated?.contact_id ?? undefined
  } catch (err: any) {
    return { success: false, error: err?.message ?? 'Conversion failed' }
  }

  if (!contactId) {
    return { success: false, error: 'Contact was not created — check lead conversion logs' }
  }

  // Mark lifecycle state and stamp handed_to_agent_at
  await supabase
    .from('leads')
    .update({
      lifecycle_state: 'converted',
      ai_isa_owner: false,
      handed_to_agent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', lead.id)

  // Notify the actor that handoff is complete
  await supabase
    .from('notifications')
    .insert({
      brokerage_id: lead.brokerage_id,
      user_id: params.actorUserId,
      type: 'ai_handoff_completed',
      title: 'AI-ISA handoff accepted',
      body: 'Lead has been converted to a contact and is ready for follow-up.',
      entity_type: 'contact',
      entity_id: contactId,
      is_read: false,
      priority: 'high',
      created_at: new Date().toISOString(),
    })
    .catch(() => {})

  // Emit lifecycle event
  await supabase
    .from('lifecycle_events')
    .insert({
      entity_type: 'lead',
      entity_id: lead.id,
      brokerage_id: lead.brokerage_id,
      event_type: 'AI_ISA_HANDOFF_ACCEPTED',
      metadata: { actorUserId: params.actorUserId, contactId, assignedAgentId },
      created_at: new Date().toISOString(),
    })
    .catch(() => {})

  return { success: true, contactId }
}
