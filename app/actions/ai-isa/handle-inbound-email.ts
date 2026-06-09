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
import { resolveModel } from '@/lib/ai/resolve-model'
import { createServiceClient } from '@/lib/supabase/service'
import { shouldStopAutoResponding, haltEngagementForNegativeReply } from '@/lib/ai-isa/conversation-handler'
import { evaluateLeadQualification, persistQualificationSignals } from '@/lib/ai-isa'
import { dispatchEmail } from '@/lib/providers/dispatch'
import { evaluateOutbound } from '@/lib/kernel'
import { checkMaxTouches } from '@/lib/ai-isa/isa-outreach-logger'
import { loadBrandVoicePrompt } from '@/lib/ai-isa/brand-voice-prompt'
import { buildISATools } from '@/lib/ai-isa/tools'
import type { MessageType, Persona } from '@/lib/kernel/types'
import { getAgentContext } from '@/lib/identity/get-agent-context'

/**
 * processInboundEmail
 *
 * AUTH MODEL: This entry point has no in-tree caller — it is intended to be
 * invoked either from an authenticated session (e.g. an "agent replies as
 * AI" tool) or from a trusted server-to-server caller (an inbound-email
 * webhook route that has already verified the provider signature, or an
 * internal cron). Because no inbound-email webhook currently exists for
 * this path, we require ONE of:
 *
 *   1. A valid authenticated session whose brokerage matches the lead.
 *   2. A trusted internal call: process.env.CRON_SECRET is configured AND
 *      the caller passes `internalSecret` matching it. Any future
 *      webhook ingress should verify the provider signature at the route
 *      layer and forward CRON_SECRET in `internalSecret`.
 *
 * In both modes we still load the lead row WITH a brokerage_id filter so a
 * forged leadId cannot reach another tenant.
 */
export async function processInboundEmail(params: {
  leadId: string
  fromEmail: string
  subject: string
  body: string
  conversationId?: string
  /** Set by trusted internal callers (webhook route after sig verify, cron). */
  internalSecret?: string
}) {
  const supabase = createServiceClient()

  // ── AUTH GATE ──────────────────────────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET
  const isTrustedInternal =
    !!cronSecret &&
    !!params.internalSecret &&
    params.internalSecret === cronSecret

  let callerBrokerageId: string | null = null
  if (!isTrustedInternal) {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, responded: false, error: 'Unauthorized' }
    }
    callerBrokerageId = ctx.brokerageId
  }

  // ── Guard 0: negative reply / opt-out detection ───────────────────────────
  // Must run FIRST before any DB fetch or AI call. If the lead says stop,
  // halt all engagement immediately, set DNC, and notify the agent.
  let leadForDncQuery = supabase
    .from('leads')
    .select('brokerage_id')
    .eq('id', params.leadId)
  if (callerBrokerageId) {
    leadForDncQuery = leadForDncQuery.eq('brokerage_id', callerBrokerageId)
  }
  const { data: leadForDnc } = await leadForDncQuery.maybeSingle()

  if (!leadForDnc) {
    return { success: false, responded: false, error: 'Lead not found' }
  }

  if (leadForDnc?.brokerage_id) {
    const halted = await haltEngagementForNegativeReply({
      leadId: params.leadId,
      body: params.body,
      brokerageId: leadForDnc.brokerage_id,
    })
    if (halted) {
      return { success: true, responded: false, reason: 'negative_reply_dnc_set' }
    }
  }

  // ── Guard 1: auto-respond check ───────────────────────────────────────────
  const stopResponding = await shouldStopAutoResponding(params.leadId)
  if (stopResponding) {
    return { success: true, responded: false, reason: 'lead_qualified_or_max_exchanges' }
  }

  // ── Fetch lead with all compliance-required fields ────────────────────────
  // Re-scope by caller brokerage when session-authed (defense in depth on
  // top of Guard 0 lookup above).
  let leadQuery = supabase
    .from('leads')
    .select(
      `id, first_name, last_name, email, brokerage_id, agent_id,
       motivation_type, property_interest, budget_min, budget_max,
       timeline, lead_score, lifecycle_state, lead_type,
       contact_id, preferred_channel, call_stop_flag`
    )
    .eq('id', params.leadId)
  if (callerBrokerageId) {
    leadQuery = leadQuery.eq('brokerage_id', callerBrokerageId)
  }
  const { data: lead } = await leadQuery.maybeSingle()

  if (!lead) {
    return { success: false, responded: false, error: 'Lead not found' }
  }

  // Resolve contact for compliance gate (KernelContact shape)
  const { data: contact } = lead.contact_id
    ? await supabase
        .from('contacts')
        .select(
          `id, first_name, last_name, email, phone,
           contact_type, persona:contact_persona, buyer_stage,
           lifecycle_state, status, tcpa_consent, tcpa_consent_date,
           isa_reengage_allowed, dnc_status, brokerage_id, team_id, agent_id`
        )
        .eq('id', lead.contact_id)
        .maybeSingle()
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
    '',
    'You can take real CRM actions via tools:',
    '- escalate_to_agent: when the lead asks for a human or needs urgent attention',
    '- mark_qualification: when the lead reveals stronger or weaker buying signals',
    '- request_appointment: when the lead asks to meet, call, or tour',
    '- mark_do_not_contact: when the lead clearly opts out (TCPA — irreversible)',
    'Call tools BEFORE generating your reply text. The reply should reflect any actions you took (e.g., "I just looped in your agent — they\'ll reach out shortly").',
  ].join('\n')

  const systemPrompt = brandVoice.systemBlock
    ? `${baseSystem}\n\nBrand voice guidance: ${brandVoice.systemBlock}`
    : baseSystem

  // ── Generate AI reply via AI SDK with kernel-validated tools ──────────────
  // Tools share a single context bound to (lead, brokerage, agent). Each
  // tool re-checks brokerage_id; mark_do_not_contact reuses the existing
  // TCPA halt path so the same notifications + sequence stops fire.
  const isaTools = buildISATools({
    leadId: lead.id,
    brokerageId: lead.brokerage_id,
    agentId: lead.agent_id ?? null,
    inboundExcerpt: params.body.slice(0, 280),
  })

  const { text: replyBody } = await generateText({
    feature: 'ai_isa_response',
    system: systemPrompt,
    tools: isaTools,
    maxSteps: 5,
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

  // ── Persist inbound message — stamped with brokerage for billing rollups ─
  await supabase.from('messages').insert({
    contact_id: params.leadId,
    conversation_id: params.conversationId ?? null,
    brokerage_id: lead.brokerage_id,
    type: 'email',
    direction: 'inbound',
    subject: params.subject,
    body: params.body,
    status: 'received',
    created_at: new Date().toISOString(),
  })

  // ── Send reply via kernel dispatch ───────────────────────��───────�����────────
  // assembleEmail() runs inside dispatchEmail() — do NOT pre-assemble.
  const sendResult = await dispatchEmail({
    brokerageId:    lead.brokerage_id,
    agentId:        lead.agent_id ?? undefined,
    to:             lead.email,
    from:           '',
    subject:        params.subject.startsWith('Re:') ? params.subject : `Re: ${params.subject}`,
    html:           `<p>${replyBody.replace(/\n/g, '<br>')}</p>`,
    text:           replyBody,
    channelPurpose: 'conversation',
    systemSource:   'ai_isa',
    leadId:         params.leadId,
    metadata:       { source: 'ai_isa_reply' },
  })

  if (!sendResult.success) {
    return { success: false, responded: false, error: `Dispatch failed: ${sendResult.error}` }
  }

  // ── Persist outbound message (unified inbox row) — stamped with brokerage ─
  await supabase.from('messages').insert({
    contact_id: params.leadId,
    conversation_id: params.conversationId ?? null,
    brokerage_id: lead.brokerage_id,
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
