'use server'

import { createServiceClient } from '@/lib/supabase/service'

export interface InboundEmailContext {
  leadId: string
  fromEmail: string
  subject: string
  body: string
  conversationId?: string
}

export async function handleInboundEmailReply(context: InboundEmailContext) {
  console.log('[v0] Handling inbound email from lead:', context.leadId)
  
  const supabase = createServiceClient()
  
  // Get lead context
  const { data: lead } = await supabase
    .from('leads')
    .select('*')
    .eq('id', context.leadId)
    .single()
  
  if (!lead) {
    throw new Error(`Lead not found: ${context.leadId}`)
  }
  
  // Get conversation history
  const { data: messages } = await supabase
    .from('messages')
    .select('*')
    .eq('contact_id', context.leadId)
    .order('created_at', { ascending: true })
    .limit(10)
  
  const conversationHistory = messages?.map(m => ({
    role: m.direction === 'inbound' ? 'user' : 'assistant',
    content: m.body
  })) || []
  
  // Generate AI response using conversation context
  const aiResponse = await generateAIResponse({
    lead,
    inboundMessage: context.body,
    conversationHistory
  })
  
  // Store inbound message
  await supabase.from('messages').insert({
    contact_id: context.leadId,
    conversation_id: context.conversationId || null,
    type: 'email',
    direction: 'inbound',
    subject: context.subject,
    body: context.body,
    status: 'received',
    created_at: new Date().toISOString()
  })
  
  // Store AI response
  await supabase.from('messages').insert({
    contact_id: context.leadId,
    conversation_id: context.conversationId || null,
    type: 'email',
    direction: 'outbound',
    subject: `Re: ${context.subject}`,
    body: aiResponse.body,
    status: 'sent',
    created_at: new Date().toISOString()
  })
  
  // Log activity
  await supabase.from('activities').insert({
    contact_id: context.leadId,
    brokerage_id: lead.brokerage_id,
    activity_type: 'ai_isa_conversation',
    title: 'AI ISA Email Reply',
    description: 'AI ISA responded to lead inquiry',
    status: 'completed',
    created_at: new Date().toISOString()
  })
  
  return aiResponse
}

async function generateAIResponse(context: {
  lead: any
  inboundMessage: string
  conversationHistory: Array<{ role: string; content: string }>
}) {
  // Use AI SDK or OpenAI to generate response
  // For now, return a template-based response
  
  const isQualifyingQuestion = 
    /when|timeline|budget|ready|interested|looking|schedule|meet|call/i.test(context.inboundMessage)
  
  if (isQualifyingQuestion) {
    return {
      body: `Thanks for your response! To make sure I can provide the most relevant information, could you share a bit more about your timeline and what you're looking for?

For example:
- Are you actively looking now, or just exploring options?
- Do you have a specific area or property type in mind?
- What's most important to you in this process?

No pressure—just want to make sure I'm pointing you in the right direction!`,
      qualificationSignal: 'engaged'
    }
  }
  
  return {
    body: `Thanks for reaching out! I'm here to help answer any questions you have.

${context.lead.property_interest ? `I see you're interested in ${context.lead.property_interest}.` : ''} Feel free to share what's on your mind, and I'll do my best to provide useful information.`,
    qualificationSignal: null
  }
}

export async function shouldStopAutoResponding(leadId: string): Promise<boolean> {
  const supabase = createServiceClient()
  
  // Check if lead has been qualified
  const { data: lead } = await supabase
    .from('leads')
    .select('lead_stage, lead_score')
    .eq('id', leadId)
    .single()
  
  if (!lead) return true
  
  // Stop if lead is qualified or scored high enough
  if (lead.lead_stage === 'qualified' || lead.lead_score > 75) {
    console.log('[v0] Stopping auto-response - lead is qualified')
    return true
  }
  
  // Check message count
  const { data: messages, error } = await supabase
    .from('messages')
    .select('id')
    .eq('contact_id', leadId)
    .eq('type', 'email')
  
  if (error) {
    console.error('[v0] Error checking message count:', error)
    return false
  }
  
  // Stop after 5 back-and-forth exchanges
  if (messages && messages.length >= 10) {
    console.log('[v0] Stopping auto-response - max messages reached')
    return true
  }
  
  return false
}
