'use server'

import { createServiceClient } from '@/lib/supabase/service'
import { KernelEvent } from '@/lib/kernel/events'

export interface QualificationSignals {
  confirmedIntent: boolean
  urgency: 'high' | 'medium' | 'low'
  readinessForAgent: boolean
  conversationCount: number
  engagementLevel: 'high' | 'medium' | 'low'
}

export async function evaluateLeadQualification(leadId: string): Promise<QualificationSignals> {
  const supabase = createServiceClient()
  
  // Get lead data
  const { data: lead } = await supabase
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .single()
  
  if (!lead) {
    throw new Error(`Lead not found: ${leadId}`)
  }
  
  // Get conversation data
  const { data: messages } = await supabase
    .from('messages')
    .select('*')
    .eq('contact_id', leadId)
    .order('created_at', { ascending: false })
  
  const conversationCount = messages?.length || 0
  
  // Analyze message content for qualification signals
  const recentMessages = messages?.slice(0, 5) || []
  const messageText = recentMessages.map(m => m.body).join(' ').toLowerCase()
  
  // Detect confirmed intent
  const intentKeywords = ['ready', 'interested', 'looking', 'want to', 'need to', 'schedule', 'meet']
  const confirmedIntent = intentKeywords.some(keyword => messageText.includes(keyword))
  
  // Detect urgency
  const urgencyKeywords = ['asap', 'urgent', 'soon', 'quickly', 'immediately', 'this week', 'this month']
  const urgency = urgencyKeywords.some(keyword => messageText.includes(keyword)) 
    ? 'high' 
    : lead.timeline === 'immediate' ? 'high' : 'medium'
  
  // Engagement level based on message frequency and responsiveness
  const engagementLevel = conversationCount >= 3 ? 'high' : conversationCount >= 1 ? 'medium' : 'low'
  
  // Readiness for agent (multiple positive signals)
  const readinessForAgent = 
    confirmedIntent && 
    (urgency === 'high' || urgency === 'medium') && 
    engagementLevel !== 'low' &&
    (lead.lead_score || 0) >= 50
  
  return {
    confirmedIntent,
    urgency,
    readinessForAgent,
    conversationCount,
    engagementLevel
  }
}

export async function persistQualificationSignals(
  leadId: string,
  signals: QualificationSignals
) {
  const supabase = createServiceClient()

  // Step 1: Persist qualification record with current signals
  const { data: lead, error: leadError } = await supabase
    .from('leads')
    .select('brokerage_id, first_name, last_name, email, phone, source, lead_score, agent_id')
    .eq('id', leadId)
    .single()

  if (leadError || !lead) {
    console.error('[AI ISA] persistQualificationSignals: lead not found', leadId)
    return
  }

  const qualificationScore = signals.readinessForAgent
    ? 85
    : signals.confirmedIntent
    ? 60
    : signals.urgency === 'high'
    ? 45
    : 25

  // Insert qualification record
  const { data: qualRecord } = await supabase
    .from('ai_isa_qualifications')
    .insert({
      lead_id: leadId,
      brokerage_id: lead.brokerage_id,
      qualification_score: qualificationScore,
      stage: signals.readinessForAgent ? 'qualified' : signals.confirmedIntent ? 'in_progress' : 'initial',
      qualification_result: signals.readinessForAgent ? 'qualified' : 'pending',
      qualification_signals: signals as unknown as Record<string, unknown>,
    })
    .select('id')
    .single()

  // If NOT ready for agent, stop here — AI-ISA continues working this lead
  if (!signals.readinessForAgent) {
    return
  }

  // ── FULL HANDOFF CHAIN (readinessForAgent = true) ────────────────────────

  // Step 2: Mark lifecycle_state = 'qualified' (only lead-acquisition-handlers
  //         writes lifecycle_state normally, but qualification is the exception
  //         that causes the handoff — we write it directly here to avoid
  //         circular async import chains)
  await supabase
    .from('leads')
    .update({
      lifecycle_state: 'qualified',
      ai_isa_owner: false,
      updated_at: new Date().toISOString(),
    })
    .eq('id', leadId)

  // Step 3: Run governLead — selects agent and evaluates routing eligibility
  const { governLead } = await import('@/app/actions/lead-governance/govern-lead')
  const govResult = await governLead(leadId, lead.brokerage_id)

  if (!govResult.success) {
    console.error('[AI ISA] governLead failed for lead', leadId, govResult.message)
    return
  }

  const assignedAgentId = govResult.agentAssigned

  // Step 4: If agent is available, run full assignment + contact creation
  if (assignedAgentId) {
    const { handleLeadAssigned } = await import('@/lib/kernel/lead-acquisition-handlers')
    await handleLeadAssigned({
      leadId,
      brokerageId: lead.brokerage_id,
      agentId: assignedAgentId,
      method: 'ai_isa_qualified',
      scoreAtAssignment: govResult.score,
    })

    // Step 4a: Stamp handed_to_agent_at
    await supabase
      .from('leads')
      .update({
        handed_to_agent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', leadId)

    // Step 5: Insert notification to the assigned agent's user record
    // Look up the agent's user_id
    const { data: agentRow } = await supabase
      .from('agents')
      .select('user_id')
      .eq('id', assignedAgentId)
      .maybeSingle()

    if (agentRow?.user_id) {
      await supabase.from('notifications').insert({
        user_id: agentRow.user_id,
        brokerage_id: lead.brokerage_id,
        type: 'new_contact_assigned',
        title: `${lead.first_name ?? 'A lead'} is ready for you`,
        body: `AI-ISA confirmed intent. Review their profile and make first contact.`,
        entity_type: 'lead',
        entity_id: leadId,
        is_read: false,
        priority: 'high',
        created_at: new Date().toISOString(),
      })
    }

    // Step 6: Update qualification record with agent assignment
    if (qualRecord?.id) {
      await supabase
        .from('ai_isa_qualifications')
        .update({
          assigned_to_agent_id: assignedAgentId,
          assigned_at: new Date().toISOString(),
          qualified_at: new Date().toISOString(),
          qualification_result: 'qualified',
        })
        .eq('id', qualRecord.id)
    }

    // Emit lifecycle event for the handoff
    await supabase.from('lifecycle_events').insert({
      entity_type: 'lead',
      entity_id: leadId,
      event_type: KernelEvent.LEAD_ASSIGNED,
      brokerage_id: lead.brokerage_id,
      metadata: { assignedAgentId, source: 'ai_isa_qualification', score: qualificationScore },
      created_at: new Date().toISOString(),
    })
  } else {
    // No agent available yet — log for manual assignment
    await supabase.from('lifecycle_events').insert({
      entity_type: 'lead',
      entity_id: leadId,
      event_type: KernelEvent.LEAD_READY_FOR_ASSIGNMENT,
      brokerage_id: lead.brokerage_id,
      metadata: { source: 'ai_isa_qualification', score: qualificationScore },
      created_at: new Date().toISOString(),
    })
  }
}
