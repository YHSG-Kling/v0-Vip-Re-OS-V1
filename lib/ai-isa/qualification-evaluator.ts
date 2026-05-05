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

  // Step 2: Transition lifecycle via the OFFICIAL handler chain.
  //         lead-acquisition-handlers.ts is the SOLE writer of lifecycle_state.
  //         handleConsentReceived: isa_qualifying → consented (valid transition)
  //         This also stamps stage_entered_at and fires CONSENT_RECEIVED event.
  const { handleConsentReceived } = await import('@/lib/kernel/lead-acquisition-handlers')
  await handleConsentReceived({
    leadId,
    brokerageId: lead.brokerage_id,
    consentSource: 'reply',
  })

  // Step 3: Mark the lead as qualified — this satisfies Engine 2's gate
  //         (lead_stage = 'qualified' AND lifecycle_state = 'consented').
  //         Engine 2 (assignment-engine.evaluateAndAssignLead) is the SOLE
  //         agent-assignment path going forward — governLead is now scoring-only.
  await supabase
    .from('leads')
    .update({
      lead_stage: 'qualified',
      ai_isa_owner: false,
      updated_at: new Date().toISOString(),
    })
    .eq('id', leadId)

  // Step 4: Score the lead (governLead in scoring-only mode keeps the score
  //         current for Engine 2's rule conditions like min_score).
  const { governLead } = await import('@/app/actions/lead-governance/govern-lead')
  const govResult = await governLead(leadId, lead.brokerage_id)

  // Step 5: Engine 2 — Qualification-Triggered Assignment
  //         Reads brokerage assignment_rules and selects an agent.
  const { evaluateAndAssignLead } = await import('@/lib/lead-assignment/assignment-engine')
  const assignResult = await evaluateAndAssignLead({
    leadId,
    brokerageId: lead.brokerage_id,
  })

  // Step 6: Update qualification record with the outcome
  if (qualRecord?.id) {
    await supabase
      .from('ai_isa_qualifications')
      .update({
        assigned_to_agent_id: assignResult.agentId ?? null,
        assigned_at: assignResult.assigned ? new Date().toISOString() : null,
        qualified_at: new Date().toISOString(),
        qualification_result: 'qualified',
      })
      .eq('id', qualRecord.id)
  }

  // Step 7: If Engine 2 couldn't find an agent, log for manual assignment.
  //         handleLeadAssigned (called inside Engine 2) already handles
  //         lifecycle transition + contact creation + notification on success.
  if (!assignResult.assigned) {
    await supabase.from('lifecycle_events').insert({
      entity_type: 'lead',
      entity_id: leadId,
      event_type: KernelEvent.LEAD_READY_FOR_ASSIGNMENT,
      brokerage_id: lead.brokerage_id,
      metadata: {
        source: 'ai_isa_qualification',
        score: qualificationScore,
        gov_score: govResult?.score,
        assign_reason: assignResult.reason,
      },
      created_at: new Date().toISOString(),
    })
  }
}
