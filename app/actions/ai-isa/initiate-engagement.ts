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
import {
  generatePersonalizedEmail,
  logEmailActivity,
  generateHeyGenVideo,
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
import { loadBrandVoicePrompt } from '@/lib/ai-isa/brand-voice-prompt'
import type { MessageType, Persona } from '@/lib/kernel/types'

// Channels that require a phone number and respect call_stop_flag
const PHONE_CHANNELS = new Set(['phone', 'sms'])
// Channels logged to the social table pending agent action if no API
const SOCIAL_CHANNELS = new Set(['facebook', 'instagram', 'linkedin', 'twitter'])

export async function initiateAIISAEngagement(leadId: string) {
  const supabase = createServiceClient()

  try {
    // ── Fetch lead with channel fields ──────────────────────────────────────
    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select(
        `*, preferred_channel, call_stop_flag, contact_id`
      )
      .eq('id', leadId)
      .single()

    if (leadError || !lead) {
      throw new Error(`Lead not found: ${leadId}`)
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
           contact_type, persona, buyer_stage, seller_stage,
           lifecycle_state, status, tcpa_consent, tcpa_consent_date,
           isa_reengage_allowed, dnc_status, brokerage_id, team_id, agent_id,
           preferred_channel, social_handles, call_stop_flag`
        )
        .eq('id', lead.contact_id)
        .single()
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

    // ── Resolve preferred channel ───────────────────────────────────────────
    // Contact preference overrides lead field; lead field overrides default (email)
    const preferredChannel: string =
      (contactRow?.preferred_channel ?? lead.preferred_channel ?? 'email') as string

    // ── Call stop flag: block all phone-channel attempts ───────────────────
    const callStopped: boolean =
      !!(contactRow?.call_stop_flag ?? lead.call_stop_flag ?? false)

    if (callStopped && PHONE_CHANNELS.has(preferredChannel)) {
      // Fall back to email if phone/sms is blocked
      return await dispatchToChannel(
        'email',
        lead,
        contactRow,
        leadId,
        supabase
      )
    }

    return await dispatchToChannel(
      preferredChannel,
      lead,
      contactRow,
      leadId,
      supabase
    )
  } catch (error: any) {
    console.error('[v0] AI ISA engagement error:', error)
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

// ─── CHANNEL DISPATCHER ────────────────────────────────────────────────────────

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

    const videoResult = await generateHeyGenVideo({
      leadId: lead.id,
      firstName: lead.first_name || 'there',
      motivation_type: lead.motivation_type,
      property_interest: lead.property_interest,
      timeline: lead.timeline,
    })
    const finalEmailBody = await embedVideoInEmail(body, videoResult.videoUrl)

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

    await dispatchEmail({
      brokerageId: lead.brokerage_id,
      from: fromName,
      to: lead.email,
      subject,
      html: finalEmailBody,
      text: finalEmailBody.replace(/<[^>]+>/g, ''),
      metadata: { leadId, source: 'ai_isa', channel: 'email' },
    })

    await logISAOutreach({
      brokerageId: lead.brokerage_id,
      entity: { entityType: 'lead', leadId },
      channel: 'email',
      subject,
      bodySnippet: finalEmailBody.substring(0, 500),
    })

    // Unified inbox row
    await supabase.from('messages').insert({
      contact_id: leadId,
      type: 'email',
      channel: 'email',
      direction: 'outbound',
      subject,
      body: finalEmailBody.replace(/<[^>]+>/g, '').substring(0, 1000),
      status: 'sent',
      brokerage_id: lead.brokerage_id,
      created_at: new Date().toISOString(),
    })

    await logEmailActivity(leadId, lead.brokerage_id, true)

    if (lead.lifecycle_state === 'unconsented') {
      await handleISAQualificationStarted({ leadId, brokerageId: lead.brokerage_id })
    }

    const shouldSendMail = await shouldTriggerDirectMail(leadId)
    if (shouldSendMail) {
      await triggerDirectMailCampaign({
        leadId: lead.id,
        firstName: lead.first_name || '',
        lastName: lead.last_name || '',
        motivation_type: lead.motivation_type,
        property_interest: lead.property_interest,
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

  // ── SMS ────────────────────────────────────────────────────────────────
  if (channel === 'sms') {
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
      type: 'sms',
      channel: 'sms',
      direction: 'outbound',
      body: smsBody,
      status: 'sent',
      brokerage_id: lead.brokerage_id,
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
      type: 'direct_mail',
      channel: 'direct_mail',
      direction: 'outbound',
      body: `Direct mail campaign initiated`,
      status: 'queued',
      brokerage_id: lead.brokerage_id,
      created_at: new Date().toISOString(),
    })

    return { success: true, directMailTriggered: true, channel: 'direct_mail' }
  }

  // ── SOCIAL (Facebook / Instagram / LinkedIn / Twitter) ─────────────────
  if (SOCIAL_CHANNELS.has(channel)) {
    const socialHandle =
      contactRow?.social_handles?.[channel] ?? null

    // Log to messages as "queued" — agent notified to send manually if no API
    await supabase.from('messages').insert({
      contact_id: leadId,
      type: 'social',
      channel,
      direction: 'outbound',
      body: [
        `Hi ${lead.first_name ?? 'there'}!`,
        brandVoice.tagline ? brandVoice.tagline : '',
        lead.motivation_type
          ? `I see you may be interested in ${lead.motivation_type.replace(/_/g, ' ')}.`
          : '',
        'Would love to connect about your real estate goals.',
      ]
        .filter(Boolean)
        .join(' ')
        .slice(0, 500),
      status: socialHandle ? 'queued' : 'pending_manual',
      metadata: { social_handle: socialHandle, platform: channel },
      brokerage_id: lead.brokerage_id,
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
        entity_type: 'lead',
        entity_id: leadId,
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
    .single()

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
