'use server'

import { generateText } from 'ai'
import { createServiceClient } from '@/lib/supabase/service'
import { shouldStopAutoResponding } from '@/lib/ai-isa/conversation-handler'
import { evaluateLeadQualification, persistQualificationSignals } from '@/lib/ai-isa'
import { dispatchEmail } from '@/lib/providers/dispatch'
import { evaluateOutbound } from '@/lib/kernel'
import { checkMaxTouches } from '@/lib/ai-isa/isa-outreach-logger'

export async function processInboundEmail(params: {
  leadId: string
  fromEmail: string
  subject: string
  body: string
  conversationId?: string
}) {
  const supabase = createServiceClient()

  // Check if we should still auto-respond (max exchanges, qualified, agent assigned)
  const stopResponding = await shouldStopAutoResponding(params.leadId)
  if (stopResponding) {
    return { success: true, responded: false, reason: 'Lead qualified or max exchanges reached' }
  }

  // Fetch lead record for context and compliance
  const { data: lead } = await supabase
    .from('leads')
    .select('id, first_name, last_name, email, brokerage_id, motivation_type, property_interest, budget_min, budget_max, timeline, lead_score, lifecycle_state')
    .eq('id', params.leadId)
    .single()

  if (!lead) {
    return { success: false, responded: false, error: 'Lead not found' }
  }

  // Compliance gate — respect kernel outbound rules
  const compliance = await evaluateOutbound({
    brokerageId: lead.brokerage_id,
    entityType: 'lead',
    entityId: params.leadId,
    channel: 'email',
  })
  if (!compliance.allowed) {
    return { success: false, responded: false, reason: `compliance:${compliance.reason ?? 'blocked'}` }
  }

  // Max touches gate
  const canContinue = await checkMaxTouches(params.leadId, 'lead', lead.brokerage_id)
  if (!canContinue) {
    return { success: false, responded: false, reason: 'max_touches_reached' }
  }

  // Fetch last 10 messages for conversation history
  const { data: history } = await supabase
    .from('messages')
    .select('direction, body, created_at')
    .eq('contact_id', params.leadId)
    .order('created_at', { ascending: true })
    .limit(10)

  const conversationMessages = (history ?? []).map((m) => ({
    role: (m.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
    content: m.body ?? '',
  }))

  // Generate AI reply using AI SDK
  const { text: replyBody } = await generateText({
    model: 'openai/gpt-4o-mini',
    system: [
      'You are an AI Inside Sales Agent (ISA) for a real estate brokerage.',
      'Your job is to qualify leads with genuine warmth — not pushy sales tactics.',
      'Keep replies concise (3–5 sentences max), conversational, and always end with a single qualifying question.',
      'Never reveal you are an AI unless directly asked.',
      'If the lead seems highly motivated or mentions a specific timeline, reflect urgency back.',
      'Do not make up property details or pricing.',
    ].join(' '),
    messages: [
      // Background context injected as the first user turn
      {
        role: 'user',
        content: [
          `Lead name: ${lead.first_name ?? 'there'} ${lead.last_name ?? ''}`.trim(),
          lead.motivation_type ? `Motivation: ${lead.motivation_type}` : '',
          lead.property_interest ? `Interest: ${lead.property_interest}` : '',
          lead.budget_min || lead.budget_max
            ? `Budget: $${lead.budget_min?.toLocaleString() ?? '?'} – $${lead.budget_max?.toLocaleString() ?? '?'}`
            : '',
          lead.timeline ? `Timeline: ${lead.timeline}` : '',
          `Lead score: ${lead.lead_score ?? 0}/100`,
        ].filter(Boolean).join('\n'),
      },
      // Real conversation history
      ...conversationMessages,
      // The new inbound message
      {
        role: 'user',
        content: `Subject: ${params.subject}\n\n${params.body}`,
      },
    ],
  })

  // Persist inbound message
  await supabase.from('messages').insert({
    contact_id: params.leadId,
    conversation_id: params.conversationId ?? null,
    type: 'email',
    direction: 'inbound',
    subject: params.subject,
    body: params.body,
    status: 'received',
    created_at: new Date().toISOString(),
  })

  // Send AI-generated reply via kernel dispatch
  const sendResult = await dispatchEmail({
    brokerageId: lead.brokerage_id,
    to: lead.email,
    from: '',
    subject: params.subject.startsWith('Re:') ? params.subject : `Re: ${params.subject}`,
    html: `<p>${replyBody.replace(/\n/g, '<br>')}</p>`,
    text: replyBody,
    metadata: { leadId: params.leadId, source: 'ai_isa_reply' },
  })

  if (!sendResult.success) {
    return { success: false, responded: false, error: `Dispatch failed: ${sendResult.error}` }
  }

  // Persist outbound message
  await supabase.from('messages').insert({
    contact_id: params.leadId,
    conversation_id: params.conversationId ?? null,
    type: 'email',
    direction: 'outbound',
    subject: params.subject.startsWith('Re:') ? params.subject : `Re: ${params.subject}`,
    body: replyBody,
    status: 'sent',
    created_at: new Date().toISOString(),
  })

  // Log activity
  await supabase.from('activities').insert({
    contact_id: params.leadId,
    brokerage_id: lead.brokerage_id,
    activity_type: 'ai_isa_conversation',
    description: `AI ISA replied to inbound email. Subject: ${params.subject}`,
    metadata: { provider_key: sendResult.providerKey, source: 'ai_isa_reply' },
    created_at: new Date().toISOString(),
  })

  // Evaluate and persist qualification signals
  const qualificationSignals = await evaluateLeadQualification(params.leadId).catch(() => null)
  if (qualificationSignals) {
    await persistQualificationSignals(params.leadId, qualificationSignals).catch(() => null)
  }

  return {
    success: true,
    responded: true,
    providerKey: sendResult.providerKey,
    qualificationSignals,
    responsePreview: replyBody.slice(0, 200),
  }
}
