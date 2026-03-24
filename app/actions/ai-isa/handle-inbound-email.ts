'use server'

/**
 * app/actions/ai-isa/handle-inbound-email.ts
 *
 * Handles an inbound email reply from a lead:
 *   1. Stop-response guards (shouldStopAutoResponding, max touches)
 *   2. Kernel compliance gate — correct EvaluateOutboundParams shape
 *   3. Brand voice injection into AI SDK system prompt
 *   4. AI SDK generateText reply generation
 *   5. Dispatch via preferred channel (email or fallback)
 *   6. Persist inbound + outbound messages in unified inbox (messages table)
 *   7. Qualification signal evaluation
 */

import { generateTextRouted as generateText } from '@/lib/ai/models'
import { createServiceClient } from '@/lib/supabase/service'
import { shouldStopAutoResponding } from '@/lib/ai-isa/conversation-handler'
import { evaluateLeadQualification, persistQualificationSignals } from '@/lib/ai-isa'
import { dispatchEmail } from '@/lib/providers/dispatch'
import { assembleEmail } from '@/lib/kernel/communications/assemble-email'
import { evaluateOutbound } from '@/lib/kernel'
import { checkMaxTouches } from '@/lib/ai-isa/isa-outreach-logger'
import { loadBrandVoicePrompt } from '@/lib/ai-isa/brand-voice-prompt'
import type { MessageType, Persona } from '@/lib/kernel/types'

export async function processInboundEmail(params: {
  leadId: string
  fromEmail: string
  subject: string
  body: string
  conversationId?: string
}) {
  const supabase = createServiceClient()

  // ── Guard 1: auto-respond check ───────────────────────────────────────────
  const stopResponding = await shouldStopAutoResponding(params.leadId)
  if (stopResponding) {
    return { success: true, responded: false, reason: 'lead_qualified_or_max_exchanges' }
  }

  // ── Fetch lead with all compliance-required fields ────────────────────────
  const { data: lead } = await supabase
    .from('leads')
    .select(
      `id, first_name, last_name, email, brokerage_id, agent_id,
       motivation_type, property_interest, budget_min, budget_max,
       timeline, lead_score, lifecycle_state, lead_type,
       contact_id, preferred_channel, call_stop_flag`
    )
    .eq('id', params.leadId)
    .single()

  if (!lead) {
    return { success: false, responded: false, error: 'Lead not found' }
  }

  // Resolve contact for compliance gate (KernelContact shape)
  const { data: contact } = lead.contact_id
    ? await supabase
        .from('contacts')
        .select(
          `id, first_name, last_name, email, phone,
           contact_type, persona, buyer_stage, seller_stage,
           lifecycle_state, status, tcpa_consent, tcpa_consent_date,
           isa_reengage_allowed, dnc_status, brokerage_id, team_id, agent_id`
        )
        .eq('id', lead.contact_id)
        .single()
    : { data: null }

  // ── Guard 2: kernel compliance gate — correct EvaluateOutboundParams ──────
  const complianceContact = contact ?? {
    id: lead.id,
    first_name: lead.first_name ?? '',
    last_name: lead.last_name ?? '',
    email: lead.email ?? undefined,
    contact_type: 'buyer' as const,
    tcpa_consent: false,
    isa_reengage_allowed: false,
    dnc_status: false,
  }

  const messageType: MessageType = 'email'
  const persona: Persona = (lead.motivation_type as Persona) ?? 'other'
  const journeyType = (lead.lead_type === 'seller' ? 'seller' : 'buyer') as 'buyer' | 'seller'

  const compliance = await evaluateOutbound({
    actorContext: {
      userId: lead.brokerage_id,
      role: 'isa',
      brokerageId: lead.brokerage_id,
    },
    journeyType,
    persona,
    messageType,
    content: params.body,
    contact: complianceContact,
  })

  if (!compliance.allowed) {
    return {
      success: false,
      responded: false,
      reason: `compliance:${compliance.blockedReason ?? 'blocked'}`,
    }
  }

  // ── Guard 3: max touches ──────────────────────────────────────────────────
  const canContinue = await checkMaxTouches(params.leadId, 'lead', lead.brokerage_id)
  if (!canContinue) {
    return { success: false, responded: false, reason: 'max_touches_reached' }
  }

  // ── Load brand voice for system prompt ────────────────────────────────────
  const brandVoice = await loadBrandVoicePrompt({
    brokerageId: lead.brokerage_id,
    agentId: lead.agent_id ?? null,
  })

  // ── Fetch last 10 messages for conversation context ───────────────────────
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

  // ── Build system prompt with brand voice ──────────────────────────────────
  const baseSystem = [
    'You are an AI Inside Sales Agent (ISA) for a real estate brokerage.',
    'Qualify leads with genuine warmth — no pushy sales tactics.',
    'Keep replies concise (3–5 sentences max), conversational, ending with one qualifying question.',
    'Never reveal you are an AI unless directly asked.',
    'If the lead seems highly motivated or mentions a specific timeline, reflect urgency back.',
    'Do not make up property details, pricing, or market data.',
    'Respect TCPA, DNC, and fair housing requirements in every message.',
  ].join(' ')

  const systemPrompt = brandVoice.systemBlock
    ? `${baseSystem} Brand voice guidance: ${brandVoice.systemBlock}`
    : baseSystem

  // ── Generate AI reply via AI SDK ──────────────────────────────────────────
  const { text: replyBody } = await generateText({
    model: 'openai/gpt-4o-mini',
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: [
          `Lead: ${lead.first_name ?? 'there'} ${lead.last_name ?? ''}`.trim(),
          lead.motivation_type ? `Motivation: ${lead.motivation_type}` : '',
          lead.property_interest ? `Interest: ${lead.property_interest}` : '',
          lead.budget_min || lead.budget_max
            ? `Budget: $${lead.budget_min?.toLocaleString() ?? '?'} – $${lead.budget_max?.toLocaleString() ?? '?'}`
            : '',
          lead.timeline ? `Timeline: ${lead.timeline}` : '',
          `Lead score: ${lead.lead_score ?? 0}/100`,
        ]
          .filter(Boolean)
          .join('\n'),
      },
      ...conversationMessages,
      {
        role: 'user',
        content: `Subject: ${params.subject}\n\n${params.body}`,
      },
    ],
  })

  // ── Persist inbound message ───────────────────────────────────────────────
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

  // ── Send reply via kernel dispatch ───────────────────────��───────���────────
  const assembled = await assembleEmail({
    bodyHtml: `<p>${replyBody.replace(/\n/g, '<br>')}</p>`,
    bodyText: replyBody,
    userId: lead.agent_id ?? '',
    brokerageId: lead.brokerage_id,
    contactId: params.leadId,
    channelPurpose: 'conversation',
  })

  const sendResult = await dispatchEmail({
    brokerageId: lead.brokerage_id,
    to: lead.email,
    from: '',
    subject: params.subject.startsWith('Re:') ? params.subject : `Re: ${params.subject}`,
    html: assembled.html,
    text: assembled.text,
    metadata: { leadId: params.leadId, source: 'ai_isa_reply' },
  })

  if (!sendResult.success) {
    return { success: false, responded: false, error: `Dispatch failed: ${sendResult.error}` }
  }

  // ── Persist outbound message (unified inbox row) ──────────────────────────
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

  // ── Activity log ─────────────────────────────────────────────────────────
  await supabase.from('activities').insert({
    contact_id: params.leadId,
    brokerage_id: lead.brokerage_id,
    activity_type: 'ai_isa_conversation',
    description: `AI ISA replied to inbound email. Subject: ${params.subject}`,
    notes: JSON.stringify({ provider_key: sendResult.providerKey, source: 'ai_isa_reply', channel: 'email' }),
    created_at: new Date().toISOString(),
  })

  // ── Qualification signals ─────────────────────────────────────────────────
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
