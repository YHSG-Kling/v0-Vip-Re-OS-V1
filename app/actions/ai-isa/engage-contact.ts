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
import type { MessageType, Persona } from '@/lib/kernel/types'

// ── Lifecycle states where AI ISA MUST NOT engage ──────────────────────────
const BLOCKED_LIFECYCLE_STATES = new Set([
  'representation',
  'active_transaction',
  'closing',
  'closed',
  'do_not_contact',
])

// ── Channels that require explicit TCPA consent ────────────────────────────
const CONSENT_REQUIRED_CHANNELS = new Set(['phone', 'sms'])

export type ISAEngagementReason =
  | 'stale'
  | 'ghosted'
  | 'agent_enabled'
  | 'brokerage_rule'
  | 'reactivation'

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

// ── Channel authority matrix for contacts ─────────────────────────────────

function resolveContactChannel(contact: Record<string, any>): string {
  const preferred = (contact.preferred_channel ?? 'email') as string

  // Opt-out checks per channel
  if (preferred === 'phone') {
    if (contact.phone_opt_out || contact.call_stop_flag || !contact.tcpa_consent) return 'email'
    return contact.phone ? 'phone' : 'email'
  }
  if (preferred === 'sms') {
    if (contact.sms_opt_out || !contact.tcpa_consent) return 'email'
    return contact.phone ? 'sms' : 'email'
  }
  if (preferred === 'email') {
      if (contact.email_opt_out) {
      // Fall back to direct mail if a mailing address is available
      const hasAddr = !!(contact.mailing_address)
      return hasAddr ? 'direct_mail' : 'email'
    }
    return contact.email ? 'email' : 'direct_mail'
  }
  if (preferred === 'direct_mail') {
    // contacts table has no mailing_address_verified — presence of mailing_address suffices
    const hasAddr = !!(contact.mailing_address)
    return hasAddr ? 'direct_mail' : 'email'
  }
  return 'email'
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
  const messageType = channel as MessageType

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

    const smsBody = `Hi ${contact.first_name || 'there'}, this is an update from your real estate team. Reply STOP to opt out.`

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

  // Fallback — unsupported channel → email
  return await dispatchContactChannel('email', contact, brokerageId, reason, actorId, supabase)
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
