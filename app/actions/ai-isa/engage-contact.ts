'use server'

/**
 * app/actions/ai-isa/engage-contact.ts
 *
 * AI ISA contact-side engagement engine.
 *
 * Invoked when:
 *   - A contact is detected as stale / ghosted by the stale-contact-detector cron
 *   - An agent manually enables AI ISA on a contact record
 *   - A brokerage automation rule triggers re-engagement
 *
 * Distinct from initiate-engagement.ts (lead-side) because:
 *   - Contact is the canonical relationship record
 *   - Full channel matrix applies (all channels permitted with correct consent)
 *   - All history writes go to contact-facing tables only
 *   - Protected lifecycle states (representation, active_transaction, closing) block engagement
 *   - Outcomes drive future automation suppression / resume logic
 */

import { createServiceClient } from '@/lib/supabase/service'
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
import { evaluateOutbound } from '@/lib/kernel'
import { dispatchEmail, dispatchSms } from '@/lib/providers/dispatch'
import { loadBrandVoicePrompt } from '@/lib/ai-isa/brand-voice-prompt'
import { emitLifecycleEvent } from '@/lib/kernel/helpers'
import { buildPersonalizationFacts, buildDeterministicCopy } from '@/lib/ai-isa/personalize-outreach'
import { resolveContactChannel } from '@/lib/ai-isa/contact-channel-policy'
import type { MessageType, Persona } from '@/lib/kernel/types'

// ── Lifecycle states where AI ISA MUST NOT engage ──────────────────────────
const BLOCKED_LIFECYCLE_STATES = new Set([
  'representation',
  'active_transaction',
  'closing',
  'closed',
  'do_not_contact',
])

// ── Channels that require explicit TCPA consent (voicedrop is regulated as a call) ──
const CONSENT_REQUIRED_CHANNELS = new Set(['phone', 'sms', 'voicedrop'])

export type ISAEngagementReason =
  | 'stale'
  | 'ghosted'
  | 'agent_enabled'
  | 'brokerage_rule'
  | 'reactivation'
  | 'speed_to_lead'

export interface EngageContactParams {
  contactId: string
  brokerageId: string
  /** Why engagement is being triggered */
  reason: ISAEngagementReason
  /** Override channel — must still pass consent check */
  forceChannel?: string
  /** User who initiated (for audit trail) */
  actorId?: string
}

export interface EngageContactResult {
  success: boolean
  channel?: string
  reason?: string
  error?: string
}

export async function engageContact(
  params: EngageContactParams,
): Promise<EngageContactResult> {
  const { contactId, brokerageId, reason, forceChannel, actorId } = params
  const supabase = createServiceClient()

  try {
    // ── 1. Fetch contact ──────────────────────────────────────────────────
    const { data: contact, error: fetchError } = await supabase
      .from('contacts')
      .select(
        `id, first_name, last_name, email, phone,
         contact_type, contact_persona, buyer_stage, status,
         dnc_status, call_stop_flag, tcpa_consent, tcpa_consent_date,
         email_opt_out, sms_opt_out, phone_opt_out, direct_mail_opt_out,
         isa_reengage_allowed, ai_outreach_paused,
         preferred_channel, social_handles,
         brokerage_id, team_id, agent_id,
         mailing_address, mailing_city:city, mailing_state:state, mailing_zip:zip_code,
         last_contacted_at`
      )
      .eq('id', contactId)
      .eq('brokerage_id', brokerageId)
      .maybeSingle()

    if (fetchError || !contact) {
      return { success: false, reason: 'contact_not_found' }
    }

    // ── 2. Hard stops ─────────────────────────────────────────────────────
    if (contact.dnc_status) {
      return { success: false, reason: 'stop:dnc' }
    }
    if (contact.ai_outreach_paused) {
      return { success: false, reason: 'stop:paused' }
    }
    if (contact.isa_reengage_allowed === false) {
      return { success: false, reason: 'stop:reengage_blocked' }
    }

    // Check lifecycle state via related records
    const { data: activeTransaction } = await supabase
      .from('transactions')
      .select('id, status')
      .eq('contact_id', contactId)
      .in('status', ['active', 'under_contract', 'closing', 'pending'])
      .limit(1)
      .maybeSingle()

    if (activeTransaction?.id) {
      return { success: false, reason: 'stop:active_transaction' }
    }

    // ── 3. Under-contract pause ────────────────────────────────────────────
    const paused = await checkUnderContractPause(brokerageId, contactId, 'contact', contactId)
    if (paused) {
      return { success: false, reason: 'paused:under_contract' }
    }

    // ── 4. Max touches ─────────────────────────────────────────────────────
    const canContinue = await checkMaxTouches(contactId, 'contact', brokerageId)
    if (!canContinue) {
      return { success: false, reason: 'stop:max_touches' }
    }

    // ── 5. Resolve channel ────────────────────────────────────────────────
    const resolvedChannel = resolveContactChannel(contact)
    const channel = forceChannel ?? resolvedChannel

    // Consent guard for phone/SMS
    if (CONSENT_REQUIRED_CHANNELS.has(channel) && !contact.tcpa_consent) {
      // Fall back to email rather than block entirely
      return await dispatchContactChannel('email', contact, brokerageId, reason, actorId, supabase)
    }

    return await dispatchContactChannel(channel, contact, brokerageId, reason, actorId, supabase)
  } catch (error: any) {
    console.error('[engageContact] Error:', error)
    await supabase.from('automation_errors').insert({
      workflow_name: 'ai_isa_contact_engagement',
      error_message: error.message,
      context_json: JSON.stringify({ contactId, brokerageId, reason }),
      severity: 'high',
      status: 'new',
      created_at: new Date().toISOString(),
    })
    return { success: false, error: error.message }
  }
}

// ── Dispatch ───────────────────────────────────────────────────────────────

async function dispatchContactChannel(
  channel: string,
  contact: Record<string, any>,
  brokerageId: string,
  reason: ISAEngagementReason,
  actorId: string | undefined,
  supabase: ReturnType<typeof createServiceClient>,
): Promise<EngageContactResult> {
  const persona = (contact.contact_persona ?? 'buyer') as Persona
  const journeyType = contact.contact_type === 'seller' ? 'seller' : 'buyer'
  // A voice drop (ringless voicemail) is regulated as a phone call — gate it as 'phone'.
  const messageType = (channel === 'voicedrop' ? 'phone' : channel) as MessageType

  // Build kernel contact for compliance gate
  const kernelContact = {
    id: contact.id,
    first_name: contact.first_name ?? '',
    last_name: contact.last_name ?? '',
    email: contact.email ?? undefined,
    phone: contact.phone ?? undefined,
    contact_type: (contact.contact_type ?? 'buyer') as any,
    persona,
    tcpa_consent: contact.tcpa_consent ?? false,
    isa_reengage_allowed: contact.isa_reengage_allowed ?? true,
    dnc_status: contact.dnc_status ?? false,
    brokerage_id: brokerageId,
    team_id: contact.team_id,
    agent_id: contact.agent_id,
  }

  // Brand voice
  const brandVoice = await loadBrandVoicePrompt({ brokerageId, agentId: contact.agent_id ?? null })

  // Compliance gate
  const compliance = await evaluateOutbound({
    actorContext: { userId: brokerageId, role: 'isa', brokerageId },
    journeyType,
    persona,
    messageType,
    content: `AI ISA re-engagement for ${contact.first_name ?? 'contact'} via ${channel}.`,
    contact: kernelContact,
  })

  if (!compliance.allowed) {
    return { success: false, reason: `stop:compliance:${compliance.blockedReason ?? 'blocked'}`, channel }
  }

  // ── EMAIL ────────────────────────────────────────────────────────────────
  if (channel === 'email') {
    if (!contact.email || contact.email_opt_out) {
      return { success: false, reason: 'no_email_or_opted_out', channel }
    }

    const emailCtx = {
      leadId: contact.id,
      firstName: contact.first_name || 'there',
      lastName: contact.last_name || '',
      email: contact.email,
      motivation_type: contact.buyer_stage ?? undefined,
      property_interest: undefined,
      budget_min: undefined,
      budget_max: undefined,
      timeline: undefined,
      lead_score: undefined,
      brandVoiceBlock: brandVoice.systemBlock,
    }

    const { subject, body, fromName } = await generatePersonalizedEmail(emailCtx)

    const videoResult = await generateAvatarVideo({
      leadId: contact.id,
      firstName: contact.first_name || 'there',
      brokerageId,
      recipientEmail: contact.email ?? '',
      motivation_type: contact.buyer_stage ?? undefined,
      property_interest: undefined,
      timeline: undefined,
    })
    // D-ID rendering is async — videoId is a provider job ID, not a playable URL.
    // Pass null so the graceful placeholder is shown; a follow-up can embed the URL once rendering completes.
    const finalBody = await embedVideoInEmail(body, null)

    // Final compliance pass on generated content
    const finalCompliance = await evaluateOutbound({
      actorContext: { userId: brokerageId, role: 'isa', brokerageId },
      journeyType,
      persona,
      messageType: 'email',
      content: finalBody.replace(/<[^>]+>/g, ''),
      contact: kernelContact,
    })
    if (!finalCompliance.allowed) {
      return { success: false, reason: `stop:compliance:${finalCompliance.blockedReason}`, channel }
    }

    await dispatchEmail({
      brokerageId,
      agentId: contact.agent_id ?? undefined,
      from: fromName,
      to: contact.email,
      subject,
      html: finalBody,
      channelPurpose: 'campaign',
      systemSource: 'ai_isa_contact',
      metadata: { source: 'ai_isa_contact', channel: 'email', reason },
    })

    await logISAOutreach({
      brokerageId,
      entity: { entityType: 'contact', contactId: contact.id },
      channel: 'email',
      subject,
      bodySnippet: finalBody.substring(0, 500),
    })

    // Write to unified inbox messages table — stamped with brokerage
    await supabase.from('messages').insert({
      contact_id: contact.id,
      agent_id: contact.agent_id ?? null,
      brokerage_id: brokerageId,
      type: 'email',
      direction: 'outbound',
      subject,
      body: finalBody.replace(/<[^>]+>/g, '').substring(0, 1000),
      status: 'sent',
      created_at: new Date().toISOString(),
    })

    // Write activity
    await supabase.from('activities').insert({
      activity_type: 'ai_isa_email',
      entity_type: 'contact',
      contact_id: contact.id,
      agent_id: contact.agent_id ?? null,
      brokerage_id: brokerageId,
      title: `AI ISA email sent (${reason})`,
      description: subject,
      status: 'completed',
      created_at: new Date().toISOString(),
    })

    // Emit lifecycle event
    await emitLifecycleEvent({
      eventType: 'AI_ISA_CONTACT_EMAIL_SENT',
      entityType: 'contact',
      entityId: contact.id,
      actorId: actorId ?? brokerageId,
      brokerageId,
      metadata: { reason, channel: 'email', subject },
    })

    // Also write to ai_isa_activities
    await supabase.from('ai_isa_activities').insert({
      contact_id: contact.id,
      brokerage_id: brokerageId,
      channel: 'email',
      activity_type: 'outbound_email',
      outcome: 'sent',
      summary: `AI ISA email: ${subject} (trigger: ${reason})`,
    })

    // Update contact last_contacted_at
    await supabase
      .from('contacts')
      .update({ last_contacted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', contact.id)

    // Trigger direct mail if eligible
    const shouldSendMail = await shouldTriggerDirectMail(contact.id)
    if (shouldSendMail && !contact.direct_mail_opt_out) {
      await triggerDirectMailCampaign({
        leadId: contact.id,
        brokerageId,
        firstName: contact.first_name || '',
        lastName: contact.last_name || '',
        motivation_type: contact.buyer_stage ?? undefined,
        property_interest: undefined,
      })
    }

    return { success: true, channel: 'email' }
  }

  // ── SMS ──────────────────────────────────────────────────────────────────
  if (channel === 'sms') {
    if (!contact.phone || !contact.tcpa_consent || contact.sms_opt_out) {
      return await dispatchContactChannel('email', contact, brokerageId, reason, actorId, supabase)
    }

    // Micro-personalized SMS — never a hardcoded fixed string
    const smsFacts = buildPersonalizationFacts({
      first_name:        contact.first_name,
      city:              (contact as any).city ?? (contact as any).mailing_city ?? null,
      motivation_type:   (contact as any).motivation_type ?? contact.buyer_stage ?? null,
      property_interest: (contact as any).property_interest ?? null,
      enrichment_profile: (contact as any).enrichment_profile ?? null,
      occupation:        (contact as any).occupation ?? null,
      household_income:  (contact as any).household_income ?? null,
      home_owner_status: (contact as any).home_owner_status ?? null,
      life_events:       (contact as any).life_events ?? null,
      marital_status:    (contact as any).marital_status ?? null,
    })
    const smsCopy = buildDeterministicCopy(smsFacts, 'sms', contact.first_name ?? undefined)
    const smsBody = smsCopy.body

    await dispatchSms({
      brokerageId,
      to: contact.phone,
      message: smsBody,
      agentId: contact.agent_id ?? undefined,
      metadata: { source: 'ai_isa_contact', reason },
    })

    await logISAOutreach({
      brokerageId,
      entity: { entityType: 'contact', contactId: contact.id },
      channel: 'sms',
      subject: 'AI ISA SMS',
      bodySnippet: smsBody.substring(0, 160),
    })

    await supabase.from('ai_isa_activities').insert({
      contact_id: contact.id,
      brokerage_id: brokerageId,
      channel: 'sms',
      activity_type: 'outbound_sms',
      outcome: 'sent',
      summary: `AI ISA SMS (trigger: ${reason})`,
    })

    await supabase
      .from('contacts')
      .update({ last_contacted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', contact.id)

    await emitLifecycleEvent({
      eventType: 'AI_ISA_CONTACT_SMS_SENT',
      entityType: 'contact',
      entityId: contact.id,
      actorId: actorId ?? brokerageId,
      brokerageId,
      metadata: { reason, channel: 'sms' },
    })

    return { success: true, channel: 'sms' }
  }

  // ── DIRECT MAIL ──────────────────────────────────────────────────────────
  if (channel === 'direct_mail') {
    const hasVerifiedAddr = !!(contact.mailing_address)
    if (!hasVerifiedAddr || contact.direct_mail_opt_out) {
      return await dispatchContactChannel('email', contact, brokerageId, reason, actorId, supabase)
    }

    await triggerDirectMailCampaign({
      leadId: contact.id,
      brokerageId,
      firstName: contact.first_name || '',
      lastName: contact.last_name || '',
      motivation_type: contact.buyer_stage ?? undefined,
      property_interest: undefined,
    })

    await logISAOutreach({
      brokerageId,
      entity: { entityType: 'contact', contactId: contact.id },
      channel: 'direct_mail',
      subject: 'AI ISA Direct Mail',
      bodySnippet: 'Direct mail dispatched',
    })

    await supabase.from('ai_isa_activities').insert({
      contact_id: contact.id,
      brokerage_id: brokerageId,
      channel: 'direct_mail',
      activity_type: 'outbound_direct_mail',
      outcome: 'sent',
      summary: `AI ISA direct mail (trigger: ${reason})`,
    })

    await emitLifecycleEvent({
      eventType: 'AI_ISA_CONTACT_MAIL_SENT',
      entityType: 'contact',
      entityId: contact.id,
      actorId: actorId ?? brokerageId,
      brokerageId,
      metadata: { reason, channel: 'direct_mail' },
    })

    return { success: true, channel: 'direct_mail' }
  }

  // ── PHONE (outbound AI call) — the ISA uses its full toolbox on a CONSENTED contact.
  //    Situation-aware (buildCallContext reads the contact's stage/persona). Escalation
  //    ladder on any block/failure: voice drop (ringless voicemail) → email, so the touch
  //    still lands. VAPI's initiateCall runs its own mandatory TCPA gate and throws on block. ──
  if (channel === 'phone') {
    if (!contact.phone || !contact.tcpa_consent || contact.phone_opt_out || contact.call_stop_flag) {
      return (await tryVoiceDrop(contact, brokerageId, reason, supabase))
        ?? await dispatchContactChannel('email', contact, brokerageId, reason, actorId, supabase)
    }
    const vapiAssistantId = process.env.VAPI_ISA_ASSISTANT_ID
    if (!vapiAssistantId) {
      return (await tryVoiceDrop(contact, brokerageId, reason, supabase))
        ?? await dispatchContactChannel('email', contact, brokerageId, reason, actorId, supabase)
    }
    const { buildCallContext } = await import('@/lib/ai-isa/build-call-context')
    const callContext = await buildCallContext({
      brokerageId, teamId: contact.team_id ?? null, agentId: contact.agent_id ?? null,
      contactId: contact.id, callPurpose: reason === 'ghosted' ? 'ghost_recovery' : 'isa_followup',
    })
    if (callContext.blocked) {
      return (await tryVoiceDrop(contact, brokerageId, reason, supabase))
        ?? await dispatchContactChannel('email', contact, brokerageId, reason, actorId, supabase)
    }
    const { initiateCall } = await import('@/lib/voice/vapi-client')
    let vapiResponse: { id: string; status: string }
    try {
      vapiResponse = await initiateCall({
        phoneNumber: contact.phone, assistantId: vapiAssistantId, contactId: contact.id,
        brokerageId, initiatedBy: contact.agent_id ?? null,
        assistantOverrides: {
          name: callContext.assistantName, firstMessage: callContext.firstMessage,
          ...(callContext.voiceConfig?.voiceId
            ? { voice: { provider: (callContext.voiceConfig.provider ?? 'elevenlabs') as any, voiceId: callContext.voiceConfig.voiceId, stability: callContext.voiceConfig.stability ?? 0.7, similarityBoost: callContext.voiceConfig.similarityBoost ?? 0.8 } }
            : {}),
          model: { systemPrompt: callContext.systemPrompt },
          variableValues: callContext.variables ?? {},
        },
      })
    } catch {
      // Call couldn't be placed (TCPA block / provider) — drop a voicemail, else email.
      return (await tryVoiceDrop(contact, brokerageId, reason, supabase))
        ?? await dispatchContactChannel('email', contact, brokerageId, reason, actorId, supabase)
    }

    const voiceCallRow = await supabase.from('voice_calls').insert({
      contact_id: contact.id, brokerage_id: brokerageId, agent_id: contact.agent_id ?? null,
      vapi_call_id: vapiResponse.id, direction: 'outbound', call_type: 'ai_isa_call',
      status: 'initiated', started_at: new Date().toISOString(),
    }).select('id').single().then((r) => r.data, () => null)
    await supabase.from('ai_isa_calls').insert({
      voice_call_id: (voiceCallRow as any)?.id ?? null, brokerage_id: brokerageId, contact_id: contact.id,
      lead_id: null, isa_campaign_id: null, script_used: 'isa_reengagement', appointment_set: false,
    }).then(() => {}, () => {})
    await logISAOutreach({
      brokerageId, entity: { entityType: 'contact', contactId: contact.id },
      channel: 'phone', subject: 'AI ISA call', bodySnippet: `AI-ISA outbound call initiated. VAPI call ID: ${vapiResponse.id}`,
    })
    await supabase.from('ai_isa_activities').insert({
      contact_id: contact.id, brokerage_id: brokerageId, channel: 'phone',
      activity_type: 'outbound_call', outcome: 'initiated', summary: `AI ISA call (trigger: ${reason})`,
    }).then(() => {}, () => {})
    await supabase.from('contacts').update({ last_contacted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', contact.id)
    await emitLifecycleEvent({
      eventType: 'AI_ISA_CONTACT_CALL_INITIATED', entityType: 'contact', entityId: contact.id,
      actorId: actorId ?? brokerageId, brokerageId, metadata: { reason, channel: 'phone', vapi_call_id: vapiResponse.id },
    })
    return { success: true, channel: 'phone' }
  }

  // ── VOICE DROP (ringless voicemail) — an explicit, consented soft touch that stays
  //    top of mind without interrupting. Falls back to email when no preset / not permitted. ──
  if (channel === 'voicedrop') {
    return (await tryVoiceDrop(contact, brokerageId, reason, supabase))
      ?? await dispatchContactChannel('email', contact, brokerageId, reason, actorId, supabase)
  }

  // Fallback — unsupported channel → email
  return await dispatchContactChannel('email', contact, brokerageId, reason, actorId, supabase)
}

/**
 * tryVoiceDrop — leave a ringless voicemail on a CONSENTED contact using the brokerage's
 * active ISA voicedrop preset. Returns null (so the caller falls back to email) when the
 * contact isn't voice-reachable or the brokerage has no active preset. orchestrateVoicedropSend
 * runs its own TCPA gate. NEVER throws.
 */
async function tryVoiceDrop(
  contact: Record<string, any>,
  brokerageId: string,
  reason: ISAEngagementReason,
  supabase: ReturnType<typeof createServiceClient>,
): Promise<EngageContactResult | null> {
  if (!contact.phone || !contact.tcpa_consent || contact.phone_opt_out || contact.call_stop_flag) return null
  try {
    const { data: preset } = await supabase.from('voicedrop_presets')
      .select('id').eq('brokerage_id', brokerageId).eq('is_active', true)
      .order('created_at', { ascending: true }).limit(1).maybeSingle()
    if (!preset?.id) return null
    const { orchestrateVoicedropSend } = await import('@/lib/voicedrop/orchestrate-voicedrop-send')
    const r = await orchestrateVoicedropSend({
      brokerageId, presetId: (preset as { id: string }).id, contactId: contact.id,
      toPhone: contact.phone, recipientFirstName: contact.first_name ?? null,
      teamId: contact.team_id ?? null, systemSource: 'ai_isa_contact',
    })
    if (!r.success) return null
    await logISAOutreach({
      brokerageId, entity: { entityType: 'contact', contactId: contact.id },
      channel: 'phone', subject: 'AI ISA voicemail', bodySnippet: 'AI ISA ringless voicemail dropped (voicedrop)',
    })
    await supabase.from('ai_isa_activities').insert({
      contact_id: contact.id, brokerage_id: brokerageId, channel: 'voicedrop',
      activity_type: 'outbound_voicedrop', outcome: 'sent', summary: `AI ISA voice drop (trigger: ${reason})`,
    }).then(() => {}, () => {})
    await supabase.from('contacts').update({ last_contacted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', contact.id)
    await emitLifecycleEvent({
      eventType: 'AI_ISA_CONTACT_VOICEDROP_SENT', entityType: 'contact', entityId: contact.id,
      actorId: brokerageId, brokerageId, metadata: { reason, channel: 'voicedrop' },
    })
    return { success: true, channel: 'voicedrop' }
  } catch (e) {
    console.error('[engageContact] voicedrop failed:', e)
    return null
  }
}

/**
 * toggleContactAIISA — agent toggle from contact detail view.
 * Enables or pauses AI ISA automation on a specific contact.
 */
export async function toggleContactAIISA(params: {
  contactId: string
  brokerageId: string
  enabled: boolean
  actorId: string
}): Promise<{ success: boolean; error?: string }> {
  const supabase = createServiceClient()
  const { contactId, brokerageId, enabled, actorId } = params

  const { error } = await supabase
    .from('contacts')
    .update({
      ai_outreach_paused: !enabled,
      isa_reengage_allowed: enabled,
      isa_reengage_set_at: new Date().toISOString(),
      isa_reengage_marked_by: actorId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', contactId)
    .eq('brokerage_id', brokerageId)

  if (error) return { success: false, error: error.message }

  await emitLifecycleEvent({
    eventType: enabled ? 'AI_ISA_ENABLED_ON_CONTACT' : 'AI_ISA_PAUSED_ON_CONTACT',
    entityType: 'contact',
    entityId: contactId,
    actorId,
    brokerageId,
    metadata: { enabled },
  })

  return { success: true }
}
