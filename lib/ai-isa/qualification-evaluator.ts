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
  
  console.log('[AI ISA] Persisting qualification signals for lead:', leadId, signals)
  
  // Update lead stage if ready for agent
  if (signals.readinessForAgent) {
    const { handleConsentReceived } = await import('@/lib/kernel/lead-acquisition-handlers')
    const { data: lead } = await supabase
      .from('leads')
      .select('brokerage_id')
      .eq('id', leadId)
      .single()
    if (lead) {
      await handleConsentReceived({
        leadId,
        brokerageId: lead.brokerage_id,
        consentSource: 'reply'
      })
    }
  }
}
