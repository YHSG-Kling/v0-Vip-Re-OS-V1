'use server'

import { createServiceClient } from '@/lib/supabase/service'

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
  
  console.log('[v0] Persisting qualification signals for lead:', leadId, signals)
  
  // Update lead stage if ready for agent
  if (signals.readinessForAgent) {
    await supabase
      .from('leads')
      .update({
        lead_stage: 'qualified',
        updated_at: new Date().toISOString()
      })
      .eq('id', leadId)
    
    // Log qualification activity
    const { data: lead } = await supabase
      .from('leads')
      .select('brokerage_id, agent_id')
      .eq('id', leadId)
      .single()
    
    if (lead) {
      await supabase.from('activities').insert({
        contact_id: leadId,
        agent_id: lead.agent_id,
        brokerage_id: lead.brokerage_id,
        activity_type: 'ai_isa_qualification',
        title: 'Lead Qualified by AI ISA',
        description: `Lead qualified with ${signals.urgency} urgency and ${signals.engagementLevel} engagement`,
        status: 'completed',
        created_at: new Date().toISOString()
      })
    }
  }
}
