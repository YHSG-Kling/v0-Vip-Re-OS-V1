'use server'

/**
 * app/actions/ai-isa/initiate-engagement.ts
 *
 * AI ISA first-touch engagement entry point.
 *
 * Dispatch routing:
 *   1. Reads lead.preferred_channel (set by agent/contact on contact record)
 *   2. Checks call_stop_flag before any phone channel dispatch
 *   3. Runs kernel compliance gate with full EvaluateOutboundParams shape
 *   4. Injects brand voice into AI generation prompts
 *   5. Routes to: email | sms | phone | direct_mail | social
 *   6. Logs outreach to isa_outreach_log + messages (unified inbox row)
 *
 * Social channels (facebook, instagram, linkedin) are dispatched via
 * dispatchSocial which writes to messages table and logs to GHL via the
 * provider cascade. A human agent is notified to manually send if no
 * social API is connected.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { getAgentContext } from '@/lib/identity/get-agent-context'
import {
  generatePersonalizedEmail,
  logEmailActivity,
  generateAvatarVideo,
  embedVideoInEmail,
  shouldTriggerDirectMail,
  triggerDirectMailCampaign,
} from '@/lib/ai-isa'
import {
  logISAOutreach,
  checkMaxTouches,
  checkUnderContractPause,
} from '@/lib/ai-isa/isa-outreach-logger'
import { handleISAQualificationStarted } from '@/lib/kernel/lead-acquisition-handlers'
import { evaluateOutbound } from '@/lib/kernel'
import { dispatchEmail, dispatchSms } from '@/lib/providers/dispatch'
import { hasReachablePhone } from '@/lib/communication/phone-reachability'
import { loadBrandVoicePrompt } from '@/lib/ai-isa/brand-voice-prompt'
import type { MessageType, Persona } from '@/lib/kernel/types'

// Channels that require a phone number and respect call_stop_flag
const PHONE_CHANNELS = new Set(['phone', 'sms'])
// Channels logged to the social table pending agent action if no API
const SOCIAL_CHANNELS = new Set(['facebook', 'instagram', 'linkedin', 'twitter'])

export async function initiateAIISAEngagement(
  leadId: string,
  opts?: { forceChannel?: 'email' | 'sms' | 'phone' | 'direct_mail' }
) {
  const supabase = createServiceClient()

  try {
    // ── AUTH GATE ────────────────────────────────────────────────────────
    // Permitted callers:
    //   1. Session-authenticated server actions (UI) — verify ctx.brokerageId
    //      matches the lead row's brokerage_id.
    //   2. Internal trusted callers (cron, internal server-action chain like
    //      app/actions/leads.ts post-create). CRON_SECRET must be set so an
    //      unconfigured deploy does not silently become an open endpoint.
    const ctx = await getAgentContext()
    const hasSession = ctx.isAuthenticated && !!ctx.brokerageId
    const isTrustedInternal = !hasSession && !!process.env.CRON_SECRET
    if (!hasSession && !isTrustedInternal) {
      return { success: false, reason: 'Unauthorized' }
    }

    // ── Fetch lead with channel fields ──────────────────────────────────────
    let leadQuery = supabase
      .from('leads')
      .select(
        `*, preferred_channel, call_stop_flag, contact_id`
      )
      .eq('id', leadId)
    if (hasSession && ctx.brokerageId) {
      leadQuery = leadQuery.eq('brokerage_id', ctx.brokerageId)
    }
    const { data: lead, error: leadError } = await leadQuery.maybeSingle()

    if (leadError || !lead) {
      throw new Error(`Lead not found: ${leadId}`)
    }

    if (hasSession && ctx.brokerageId && lead.brokerage_id !== ctx.brokerageId) {
      return { success: false, reason: 'Forbidden' }
    }

    if (lead.agent_id) {
      return { success: false, reason: 'Lead already assigned to agent' }
    }

    // ── Hard lifecycle stops ────────────────────────────────────────────────
    if (lead.lifecycle_state === 'representation') {
      return { success: false, reason: 'stop:representation' }
    }
    if (lead.is_active === false) {
      return { success: false, reason: 'stop:inactive' }
    }

    // ── Contact-level stops ─────────────────────────────────────────────────
    let contactRow: Record<string, any> | null = null
    if (lead.contact_id) {
      const { data } = await supabase
        .from('contacts')
        .select(
          `id, first_name, last_name, email, phone,
           contact_type, persona:contact_persona, buyer_stage,
           lifecycle_state, status, tcpa_consent, tcpa_consent_date,
           isa_reengage_allowed, dnc_status, brokerage_id, team_id, agent_id,
           preferred_channel, social_handles, call_stop_flag,
           phone_opt_out, phone_status, sms_unsubscribed, email_opt_out,
           mailing_address, mailing_city, mailing_state,
           phone_secondary, phone_secondary_dnc_status, phone_secondary_opt_out, phone_secondary_status`
        )
        .eq('id', lead.contact_id)
        .maybeSingle()
      contactRow = data
    }

    if (contactRow?.dnc_status) {
      return { success: false, reason: 'stop:dnc' }
    }
    if (contactRow?.isa_reengage_allowed === false) {
      return { success: false, reason: 'stop:reengage_blocked' }
    }

    // Under-contract pause
    if (lead.contact_id) {
      const paused = await checkUnderContractPause(
        lead.brokerage_id,
        lead.contact_id,
        'lead',
        leadId
      )
      if (paused) {
        return { success: false, reason: 'paused:under_contract' }
      }
    }

    // Max touches
    const canContinue = await checkMaxTouches(leadId, 'lead', lead.brokerage_id)
    if (!canContinue) {
      return { success: false, reason: 'stop:max_touches' }
    }

    // ── forceChannel override (operator-initiated send from ISA console) ─────
    // Email and direct_mail are safe to force — no TCPA consent required.
    // Phone and SMS still require explicit TCPA validation; block them here.
    const FORCE_ALLOWED_CHANNELS = new Set(['email', 'direct_mail'])
    if (opts?.forceChannel && !FORCE_ALLOWED_CHANNELS.has(opts.forceChannel)) {
      throw new Error('Only email and direct_mail can be force-dispatched from the ISA console. Phone/SMS require TCPA compliance checks.')
    }

    // ── Channels permitted for unconsented leads (no TCPA) ─────────────────
    const LEAD_ALLOWED_CHANNELS = new Set(['email', 'direct_mail'])

    /**
     * resolveKernelOutreachChannel — single channel source-of-truth for
     * all lead/contact routing decisions in Kernel OS.
     *
     * Rules:
     *   - Unconsented lead: ONLY email or verified direct_mail
     *   - Post-conversion contact: follow stored preferences + opt-out state
     *   - call_stop_flag / sms_unsubscribed / email_opt_out handled here
     *
     * Any future phone/SMS path added to Kernel OS MUST route through this
     * resolver before reaching a dispatch or compliance gate.
     */
    function resolveKernelOutreachChannel(
      lead: Record<string, any>,
      contactRow: Record<string, any> | null
    ): string {
      // Post-conversion contact: follow stored preferences + opt-out state
      if (contactRow?.id) {
        const ch = (contactRow.preferred_channel ?? 'email') as string
        // Voice is a per-NUMBER permission: if the primary line is blocked but a clean secondary
        // line exists, keep the phone channel (the dialer uses pickReachablePhone to select it).
        // Only downgrade to email when NEITHER line is voice-reachable. (SMS stays person-level.)
        if (ch === 'phone' && !hasReachablePhone(contactRow)) return 'email'
        if (contactRow.sms_unsubscribed && ch === 'sms') return 'email'
        if (contactRow.email_opt_out && ch === 'email') {
          const hasAddr = !!(
            contactRow.mailing_address ||
            (contactRow.mailing_city && contactRow.mailing_state)
          )
          return hasAddr ? 'direct_mail' : 'email'
        }
        return ch
      }
      // Lead only (unconsented): ONLY email (when verified) or verified direct_mail. Per the
      // canonical rule, an unconsented lead may only be reached by EMAIL when the email is verified.
      // When neither channel is permitted, return the explicit sentinel 'no_outreach' so the caller
      // can short-circuit BEFORE dispatchToChannel ever sends — avoiding CAN-SPAM / canonical-rule
      // violations on an unverified address.
      const requested = (lead.preferred_channel ?? 'email') as string
      const hasVerifiedAddr = !!(lead.mailing_address && lead.mailing_address_verified === true)
      const emailUsable = !!(lead.email && lead.email_verified === true)
      const pick = (): string => {
        if (!LEAD_ALLOWED_CHANNELS.has(requested)) return emailUsable ? 'email' : (hasVerifiedAddr ? 'direct_mail' : 'no_outreach')
        if (requested === 'direct_mail')           return hasVerifiedAddr ? 'direct_mail' : (emailUsable ? 'email' : 'no_outreach')
        return emailUsable ? 'email' : (hasVerifiedAddr ? 'direct_mail' : 'no_outreach')
      }
      return pick()
    }

    const resolvedChannel = resolveKernelOutreachChannel(lead, contactRow)
    // forceChannel='email' overrides the resolved channel (operator-initiated send)
    const preferredChannel = opts?.forceChannel ?? resolvedChannel

    // Honor the resolver's explicit no-permitted-channel sentinel — unconsented lead with no
    // verified email AND no verified mailing address: skip outreach entirely. Without this, the
    // dispatcher would have sent to an unverified email address, violating the canonical rule.
    if (preferredChannel === 'no_outreach') {
      return {
        success: false,
        error: 'No permitted outreach channel: email is not verified and mailing address is not verified.',
        skipped_reason: 'no_outreach',
      } as any
    }

    return await dispatchToChannel(
      preferredChannel,
      lead,
      contactRow,
      leadId,
      supabase
    )
  } catch (error: any) {
    console.error('[AIISAEngagement] Error:', error)
    await supabase.from('automation_errors').insert({
      workflow_name: 'ai_isa_engagement',
      error_message: error.message,
      context_json: JSON.stringify({ leadId }),
      severity: 'high',
      status: 'new',
      created_at: new Date().toISOString(),
    })
    return { success: false, error: error.message }
  }
}

// ─── CHANNEL DISPATCHER ─────────────────────────────────────���──────────────────

async function dispatchToChannel(
  channel: string,
  lead: Record<string, any>,
  contactRow: Record<string, any> | null,
  leadId: string,
  supabase: ReturnType<typeof createServiceClient>
) {
  const journeyType = (lead.lead_type === 'seller' ? 'seller' : 'buyer') as 'buyer' | 'seller'
  const persona: Persona = (lead.motivation_type as Persona) ?? 'other'

  // ── Build KernelContact for compliance gate ─────────────────────────────
  const kernelContact = contactRow
    ? {
        id: contactRow.id,
        first_name: contactRow.first_name ?? '',
        last_name: contactRow.last_name ?? '',
        email: contactRow.email ?? undefined,
        phone: contactRow.phone ?? undefined,
        contact_type: (contactRow.contact_type ?? 'buyer') as any,
        persona: (contactRow.persona ?? persona) as Persona,
        lifecycle_state: contactRow.lifecycle_state,
        status: contactRow.status,
        tcpa_consent: contactRow.tcpa_consent ?? false,
        isa_reengage_allowed: contactRow.isa_reengage_allowed ?? true,
        dnc_status: contactRow.dnc_status ?? false,
        brokerage_id: contactRow.brokerage_id,
        team_id: contactRow.team_id,
        agent_id: contactRow.agent_id,
      }
    : {
        id: leadId,
        first_name: lead.first_name ?? '',
        last_name: lead.last_name ?? '',
        email: lead.email ?? undefined,
        contact_type: 'buyer' as const,
        tcpa_consent: false,
        isa_reengage_allowed: true,
        dnc_status: false,
      }

  // Derive messageType for compliance gate
  const messageType: MessageType =
    channel === 'sms' ? 'sms'
    : channel === 'phone' ? 'phone'
    : channel === 'direct_mail' ? 'direct_mail'
    : SOCIAL_CHANNELS.has(channel) ? 'social'
    : 'email'

  // ── Brand voice ────────────────────────────────────────────────────────
  const brandVoice = await loadBrandVoicePrompt({
    brokerageId: lead.brokerage_id,
    agentId: lead.agent_id ?? null,
  })

  // Minimal content for compliance pre-check on channels without pre-generated copy
  const preflightContent = `AI ISA outreach to ${lead.first_name ?? 'lead'} via ${channel}.`

  // ── Compliance gate ────────────────────────────────────────────────────
  const compliance = await evaluateOutbound({
    actorContext: {
      userId: lead.brokerage_id,
      role: 'isa',
      brokerageId: lead.brokerage_id,
    },
    journeyType,
    persona,
    messageType,
    content: preflightContent,
    contact: kernelContact,
  })

  if (!compliance.allowed) {
    return {
      success: false,
      reason: `stop:compliance:${compliance.blockedReason ?? 'blocked'}`,
      channel,
    }
  }

  // ── EMAIL ──────────────────────────────────────────────────────────────
  if (channel === 'email') {
    if (!lead.email) {
      return { success: false, reason: 'no_email', channel }
    }

    const emailContext = {
      leadId: lead.id,
      firstName: lead.first_name || 'there',
      lastName: lead.last_name || '',
      email: lead.email,
      motivation_type: lead.motivation_type,
      property_interest: lead.property_interest,
      budget_min: lead.budget_min,
      budget_max: lead.budget_max,
      timeline: lead.timeline,
      lead_score: lead.lead_score,
      brandVoiceBlock: brandVoice.systemBlock,
    }

    const { subject, body, fromName } = await generatePersonalizedEmail(emailContext)

    const videoResult = await generateAvatarVideo({
      leadId: lead.id,
      firstName: lead.first_name || 'there',
      brokerageId: lead.brokerage_id,
      recipientEmail: lead.email ?? '',
      motivation_type: lead.motivation_type,
      property_interest: lead.property_interest,
      timeline: lead.timeline,
    })
    // HeyGen rendering is async — videoId is a provider message ID, not a playable URL.
    // Pass null so the graceful placeholder is shown; a follow-up can embed the URL once rendering completes.
    const finalEmailBody = await embedVideoInEmail(body, null)

    // Run compliance on final content
    const finalCompliance = await evaluateOutbound({
      actorContext: { userId: lead.brokerage_id, role: 'isa', brokerageId: lead.brokerage_id },
      journeyType,
      persona,
      messageType: 'email',
      content: finalEmailBody.replace(/<[^>]+>/g, ''),
      contact: kernelContact,
    })
    if (!finalCompliance.allowed) {
      return {
        success: false,
        reason: `stop:compliance:${finalCompliance.blockedReason ?? 'blocked'}`,
        channel,
      }
    }

    // assembleEmail() runs inside dispatchEmail() — do NOT pre-assemble.
    await dispatchEmail({
      brokerageId:    lead.brokerage_id,
      agentId:        lead.agent_id ?? undefined,
      from:           fromName,
      to:             lead.email,
      subject,
      html:           finalEmailBody,
      channelPurpose: 'campaign',
      systemSource:   'ai_isa',
      leadId,
      metadata: { source: 'ai_isa', channel: 'email' },
    })

    await logISAOutreach({
      brokerageId: lead.brokerage_id,
      entity: { entityType: 'lead', leadId },
      channel: 'email',
      subject,
      bodySnippet: finalEmailBody.substring(0, 500),
    })

    // Unified inbox row — stamped with brokerage for billing rollups
    await supabase.from('messages').insert({
      contact_id: leadId,
      brokerage_id: lead.brokerage_id,
      type: 'email',
      direction: 'outbound',
      subject,
      body: finalEmailBody.replace(/<[^>]+>/g, '').substring(0, 1000),
      status: 'sent',
      created_at: new Date().toISOString(),
    })

    await logEmailActivity(leadId, lead.brokerage_id, true)

    if (lead.lifecycle_state === 'unconsented') {
      await handleISAQualificationStarted({ leadId, brokerageId: lead.brokerage_id })
    }

    const shouldSendMail = await shouldTriggerDirectMail(leadId)
    if (shouldSendMail) {
      // Wave 36 — welcome kit = postcard AND letter for a brand new
      // lead with a verified address (idempotent at the trigger level:
      // skipped if any individual_lead campaign already exists for this
      // lead). Postcard for hand-time, letter for long-form intro.
      await triggerDirectMailCampaign({
        leadId: lead.id,
        brokerageId: lead.brokerage_id,
        firstName: lead.first_name || '',
        lastName: lead.last_name || '',
        motivation_type: lead.motivation_type,
        property_interest: lead.property_interest,
        pieceTypes: ['postcard', 'letter'],
      })
    }

    return {
      success: true,
      emailSent: true,
      videoGenerated: videoResult.success,
      directMailTriggered: shouldSendMail,
      channel: 'email',
    }
  }

  // ── PHONE ──────────────────────────────────────────────────────────────
  if (channel === 'phone') {
    // TCPA double-guard: phone is never permitted for unconsented leads
    if (!contactRow?.id) {
      console.error('[AI-ISA][TCPA] Phone blocked for unconsented lead', { leadId })
      return await dispatchToChannel('email', lead, contactRow, leadId, supabase)
    }

    const phone = contactRow.phone ?? lead.phone
    if (!phone) {
      return await dispatchToChannel('email', lead, contactRow, leadId, supabase)
    }

    const vapiAssistantId = process.env.VAPI_ISA_ASSISTANT_ID
    if (!vapiAssistantId) {
      console.error('[AI-ISA] VAPI_ISA_ASSISTANT_ID not set — falling back to email')
      return await dispatchToChannel('email', lead, contactRow, leadId, supabase)
    }

    const { buildCallContext } = await import('@/lib/ai-isa/build-call-context')
    const callContext = await buildCallContext({
      brokerageId:   lead.brokerage_id,
      teamId:        contactRow.team_id ?? null,
      agentId:       lead.agent_id ?? null,
      contactId:     contactRow.id,
      callPurpose:   'isa_qualification',
    })

    if (callContext.blocked) {
      console.error('[AI-ISA][TCPA] buildCallContext blocked call:', callContext.blockReason)
      return await dispatchToChannel('email', lead, contactRow, leadId, supabase)
    }

    const { initiateCall } = await import('@/lib/voice/vapi-client')
    let vapiResponse: { id: string; status: string }
    try {
      vapiResponse = await initiateCall({
        phoneNumber:  phone,
        assistantId:  vapiAssistantId,
        contactId:    contactRow.id,
        brokerageId:  lead.brokerage_id,
        initiatedBy:  lead.agent_id ?? null,
        assistantOverrides: {
          name:         callContext.assistantName,
          firstMessage: callContext.firstMessage,
          // voiceConfig shape from buildCallContext: { provider, voiceId, stability, similarityBoost }
          ...(callContext.voiceConfig?.voiceId
            ? {
                voice: {
                  provider:        (callContext.voiceConfig.provider ?? 'elevenlabs') as any,
                  voiceId:         callContext.voiceConfig.voiceId,
                  stability:       callContext.voiceConfig.stability        ?? 0.7,
                  similarityBoost: callContext.voiceConfig.similarityBoost  ?? 0.8,
                },
              }
            : {}),
          model:          { systemPrompt: callContext.systemPrompt },
          variableValues: callContext.variables ?? {},
        },
      })
    } catch (err: any) {
      console.error('[AI-ISA] VAPI call failed, falling back to email:', err.message)
      return await dispatchToChannel('email', lead, contactRow, leadId, supabase)
    }

    // voice_calls row — initiateCall confirmed the call is live
    const voiceCallRow = await supabase
      .from('voice_calls')
      .insert({
        contact_id:  contactRow.id,
        brokerage_id: lead.brokerage_id,
        agent_id:    lead.agent_id ?? null,
        vapi_call_id: vapiResponse.id,
        direction:   'outbound',
        call_type:   'ai_isa_call',
        status:      'initiated',
        started_at:  new Date().toISOString(),
      })
      .select('id')
      .single()
      .then((r) => r.data, () => null)

    // vapi_voice_calls billing row
    await supabase.from('vapi_voice_calls').insert({
      voice_call_id: voiceCallRow?.id ?? null,
      brokerage_id:  lead.brokerage_id,
      vapi_call_id:  vapiResponse.id,
      assistant_id:  vapiAssistantId,
      agent_id:      lead.agent_id ?? null,
      contact_id:    contactRow.id,
    }).then(() => {}, () => {})

    // ai_isa_calls — use callPurpose as script_used (not raw systemPrompt)
    await supabase.from('ai_isa_calls').insert({
      voice_call_id:   voiceCallRow?.id ?? null,
      brokerage_id:    lead.brokerage_id,
      contact_id:      contactRow.id,
      lead_id:         null, // contact path — lead already promoted
      isa_campaign_id: null,
      script_used:     'isa_qualification',
      appointment_set: false,
    }).then(() => {}, (err: any) => {
      console.error('[AI-ISA] ai_isa_calls insert error (phone path):', err?.message)
    })

    await logISAOutreach({
      brokerageId: lead.brokerage_id,
      entity: { entityType: 'lead', leadId },
      channel: 'phone',
      bodySnippet: `AI-ISA outbound call initiated. VAPI call ID: ${vapiResponse.id}`,
    })

    return {
      success:       true,
      callInitiated: true,
      vapiCallId:    vapiResponse.id,
      channel:       'phone',
    }
  }

  // ── SMS ────────────────────────────────────────────────────────────────
  if (channel === 'sms') {
    // TCPA double-guard: SMS is never permitted for unconsented leads
    if (!contactRow?.id) {
      console.error('[AI-ISA][TCPA] SMS blocked for unconsented lead', { leadId })
      return await dispatchToChannel('email', lead, contactRow, leadId, supabase)
    }

    const phone = contactRow?.phone ?? lead.phone
    if (!phone) {
      return { success: false, reason: 'no_phone', channel }
    }

    const smsBody = [
      `Hi ${lead.first_name ?? 'there'}, this is`,
      brandVoice.tagline ? `${brandVoice.tagline}.` : 'your real estate team.',
      lead.motivation_type
        ? `I see you're interested in ${lead.motivation_type.replace(/_/g, ' ')}.`
        : '',
      'Would you like to chat about your home search?',
    ]
      .filter(Boolean)
      .join(' ')

    await dispatchSms({
      brokerageId: lead.brokerage_id,
      to: phone,
      message: smsBody.slice(0, 320),
      metadata: { leadId, source: 'ai_isa', channel: 'sms' },
    })

    await logISAOutreach({
      brokerageId: lead.brokerage_id,
      entity: { entityType: 'lead', leadId },
      channel: 'sms',
      bodySnippet: smsBody.substring(0, 160),
    })

    await supabase.from('messages').insert({
      contact_id: leadId,
      brokerage_id: lead.brokerage_id,
      type: 'sms',
      direction: 'outbound',
      body: smsBody,
      status: 'sent',
      created_at: new Date().toISOString(),
    })

    return { success: true, smsSent: true, channel: 'sms' }
  }

  // ── DIRECT MAIL ────────────────────────────────────────────────────────
  if (channel === 'direct_mail') {
    const mailAddress =
      contactRow?.mailing_address ?? lead.mailing_address ?? null
    if (!mailAddress) {
      return { success: false, reason: 'no_mailing_address', channel }
    }

    await triggerDirectMailCampaign({
      leadId: lead.id,
      brokerageId: lead.brokerage_id,
      firstName: lead.first_name || '',
      lastName: lead.last_name || '',
      motivation_type: lead.motivation_type,
      property_interest: lead.property_interest,
    })

    await logISAOutreach({
      brokerageId: lead.brokerage_id,
      entity: { entityType: 'lead', leadId },
      channel: 'direct_mail',
      bodySnippet: `Direct mail campaign triggered for ${lead.first_name ?? ''} ${lead.last_name ?? ''}`.trim(),
    })

    await supabase.from('messages').insert({
      contact_id: leadId,
      brokerage_id: lead.brokerage_id,
      type: 'direct_mail',
      direction: 'outbound',
      body: 'Direct mail campaign initiated',
      status: 'queued',
      created_at: new Date().toISOString(),
    })

    return { success: true, directMailTriggered: true, channel: 'direct_mail' }
  }

  // ── SOCIAL (Facebook / Instagram / LinkedIn / Twitter) ─────────────────
  if (SOCIAL_CHANNELS.has(channel)) {
    const socialHandle =
      contactRow?.social_handles?.[channel] ?? null

    // Log to messages as "queued" — agent notified to send manually if no API
    const socialBody = [
      `Hi ${lead.first_name ?? 'there'}!`,
      brandVoice.tagline ? brandVoice.tagline : '',
      lead.motivation_type
        ? `I see you may be interested in ${lead.motivation_type.replace(/_/g, ' ')}.`
        : '',
      'Would love to connect about your real estate goals.',
    ]
      .filter(Boolean)
      .join(' ')
      .slice(0, 500)

    await supabase.from('messages').insert({
      contact_id: leadId,
      brokerage_id: lead.brokerage_id,
      type: 'social',
      direction: 'outbound',
      body: socialBody,
      status: socialHandle ? 'queued' : 'pending_manual',
      created_at: new Date().toISOString(),
    })

    await logISAOutreach({
      brokerageId: lead.brokerage_id,
      entity: { entityType: 'lead', leadId },
      channel: 'social',
      bodySnippet: `Social outreach queued via ${channel}. Handle: ${socialHandle ?? 'not on file'}`,
    })

    // Notify agent to send manually if handle is missing
    if (!socialHandle) {
      await supabase.from('notifications').insert({
        brokerage_id: lead.brokerage_id,
        type: 'action_required',
        title: `Social outreach needed — ${channel}`,
        body: `AI ISA cannot send ${channel} to ${lead.first_name ?? 'lead'} — no handle on file. Please send manually.`,
        created_at: new Date().toISOString(),
      })
    }

    return {
      success: true,
      socialQueued: true,
      channel,
      requiresManualSend: !socialHandle,
    }
  }

  // Fallback — channel not recognized, default to email
  return await dispatchToChannel('email', lead, contactRow, leadId, supabase)
}

// ─── STATUS QUERY ─────────────────────────────────────────────────────────────

export async function getAIISAEngagementStatus(leadId: string) {
  const supabase = createServiceClient()

  const { data: activities } = await supabase
    .from('activities')
    .select('*')
    .eq('contact_id', leadId)
    .in('activity_type', [
      'ai_isa_email',
      'ai_isa_conversation',
      'ai_isa_qualification',
      'ai_isa_direct_mail',
    ])
    .order('created_at', { ascending: false })

  const { data: messages } = await supabase
    .from('messages')
    .select('id, direction, channel')
    .eq('contact_id', leadId)

  const inboundCount =
    messages?.filter((m) => m.direction === 'inbound').length ?? 0
  const outboundCount =
    messages?.filter((m) => m.direction === 'outbound').length ?? 0

  const { data: lead } = await supabase
    .from('leads')
    .select('lead_stage, lead_score, agent_id')
    .eq('id', leadId)
    .maybeSingle()

  return {
    activities: activities ?? [],
    conversationStats: {
      inboundMessages: inboundCount,
      outboundMessages: outboundCount,
      totalExchanges: Math.max(inboundCount, outboundCount),
    },
    currentStage: lead?.lead_stage ?? 'new',
    leadScore: lead?.lead_score ?? 0,
    assignedToAgent: !!lead?.agent_id,
  }
}
