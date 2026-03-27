import { createServiceClient } from '@/lib/supabase/service'

export interface InboundEmailContext {
  leadId: string
  fromEmail: string
  subject: string
  body: string
  conversationId?: string
}

export async function handleInboundEmailReply(context: InboundEmailContext) {
  console.log('[AI ISA] Handling inbound email from lead:', context.leadId)
  
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
  
  // Log activity — Agent task (correct location, no changes) — activity_type: ai_isa_conversation
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

// Keywords that indicate negative intent — stop all AI outreach immediately
const NEGATIVE_INTENT_PHRASES = [
  'not interested',
  'no thanks',
  'stop',
  'unsubscribe',
  'remove me',
  'take me off',
  'do not contact',
  'don\'t contact',
  'leave me alone',
  'stop emailing',
  'stop contacting',
  'opt out',
  'opt-out',
  'cancel',
  'go away',
]

export function detectNegativeIntent(body: string): boolean {
  const lower = body.toLowerCase().trim()
  return NEGATIVE_INTENT_PHRASES.some((phrase) => lower.includes(phrase))
}

export async function haltEngagementForNegativeReply(params: {
  leadId: string
  body: string
  brokerageId: string
}): Promise<boolean> {
  if (!detectNegativeIntent(params.body)) return false

  const supabase = createServiceClient()

  // Set call_stop_flag and dnc on the lead — prevents any future AI outreach
  await supabase
    .from('leads')
    .update({
      call_stop_flag: true,
      ai_isa_owner: false,
      lifecycle_state: 'do_not_contact',
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.leadId)

  // If a contact record is linked, set dnc_status too
  const { data: lead } = await supabase
    .from('leads')
    .select('contact_id')
    .eq('id', params.leadId)
    .maybeSingle()

  if (lead?.contact_id) {
    await supabase
      .from('contacts')
      .update({
        dnc_status: true,
        isa_reengage_allowed: false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', lead.contact_id)
  }

  // Log an activity so the agent sees this clearly in the timeline
  await supabase.from('activities').insert({
    contact_id: params.leadId,
    brokerage_id: params.brokerageId,
    activity_type: 'lead_opted_out',
    title: 'Lead requested no further contact',
    description: 'AI ISA detected negative reply. All automated outreach halted. DNC flag set.',
    status: 'completed',
    created_at: new Date().toISOString(),
  })

  // Notify the agent
  await supabase.from('notifications').insert({
    brokerage_id: params.brokerageId,
    type: 'lead_opted_out',
    title: 'Lead requested to be removed',
    message: 'A lead replied with an opt-out signal. They have been marked Do Not Contact.',
    entity_type: 'lead',
    entity_id: params.leadId,
    is_read: false,
  }).catch(() => {})

  return true
}

export async function shouldStopAutoResponding(leadId: string): Promise<boolean> {
  const supabase = createServiceClient()

  const { data: lead } = await supabase
    .from('leads')
    .select('lead_stage, lead_score, call_stop_flag, lifecycle_state')
    .eq('id', leadId)
    .single()

  if (!lead) return true

  // Stop immediately if DNC, call_stop_flag, or already qualified/handed off
  if (
    lead.call_stop_flag ||
    lead.lifecycle_state === 'do_not_contact' ||
    lead.lifecycle_state === 'qualified' ||
    lead.lifecycle_state === 'consented' ||
    lead.lead_stage === 'qualified' ||
    lead.lead_score > 75
  ) {
    return true
  }

  // Stop after 5 back-and-forth exchanges (10 total messages = 5 each side)
  const { count } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('contact_id', leadId)
    .eq('type', 'email')

  if ((count ?? 0) >= 10) return true

  return false
}
