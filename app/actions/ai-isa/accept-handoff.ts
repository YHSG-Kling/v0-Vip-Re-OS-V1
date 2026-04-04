'use server'

import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

export async function acceptAIISAHandoff(params: {
  leadId: string
  brokerageId: string
  actorUserId: string
}): Promise<{ success: boolean; contactId?: string; error?: string }> {
  const supabase = await createClient()
  const service = createServiceClient()

  const { data: lead, error: leadErr } = await supabase
    .from('leads')
    .select('id, brokerage_id, agent_id, contact_id, lifecycle_state')
    .eq('id', params.leadId)
    .maybeSingle()

  if (leadErr || !lead) {
    return { success: false, error: 'Lead not found' }
  }

  // Already has a contact — just open it
  if (lead.contact_id) {
    return { success: true, contactId: lead.contact_id }
  }

  // ── Agent assignment: governance → team fallback → brokerage primary ──────
  // Priority: (1) already on the lead, (2) governLead routing engine,
  // (3) brokerage/team primary active agent. Handoff never stalls waiting
  // for manual assignment — a human can reassign afterwards via the CRM.
  let assignedAgentId: string | null = lead.agent_id ?? null

  if (!assignedAgentId) {
    try {
      const { governLead } = await import('@/app/actions/lead-governance/govern-lead')
      const governance = await governLead(lead.id, lead.brokerage_id)
      assignedAgentId = governance?.agentAssigned ?? null
    } catch {
      // governLead failure is non-fatal — fall through to primary-agent lookup
    }
  }

  // Fallback: brokerage's earliest-created active agent (owner/primary)
  if (!assignedAgentId) {
    const { data: primaryAgent } = await service
      .from('agents')
      .select('user_id')
      .eq('brokerage_id', lead.brokerage_id)
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    assignedAgentId = primaryAgent?.user_id ?? null
  }

  if (!assignedAgentId) {
    return { success: false, error: 'No active agent found in this brokerage. Add an agent first.' }
  }

  // Stamp the agent on the lead immediately so it is visible in the CRM
  // before the contact conversion completes
  await service
    .from('leads')
    .update({ agent_id: assignedAgentId, updated_at: new Date().toISOString() })
    .eq('id', lead.id)

  // Convert lead → contact through canonical path
  let contactId: string | undefined
  try {
    const { convertLeadToContact } = await import('@/app/actions/lead-lifecycle')
    const result = await convertLeadToContact({
      leadId: lead.id,
      agentId: assignedAgentId,
      brokerageId: lead.brokerage_id,
    })
    contactId = result?.contactId ?? undefined
  } catch (err: any) {
    return { success: false, error: err?.message ?? 'Conversion failed' }
  }

  if (!contactId) {
    return { success: false, error: 'Contact was not created — check lead conversion logs' }
  }

  // Mark lifecycle state and stamp handed_to_agent_at
  try {
  await supabase
    .from("notifications")
    .insert({
      // keep the same payload already in your file
      created_at: new Date().toISOString(),
    })
} catch {
  // non-blocking notification write
}

  // Notify the actor that handoff is complete
 try( await supabase
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
} catch {
  // non-blocking notification write
}

  // Emit lifecycle event
  try {
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
} catch {
  // non-blocking notification write
}

  return { success: true, contactId }
}
