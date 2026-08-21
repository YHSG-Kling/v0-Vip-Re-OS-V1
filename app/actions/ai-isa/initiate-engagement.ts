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
import { collectError } from '@/lib/errors/collect-error'
import { getAgentContext } from '@/lib/identity/get-agent-context'
import {
  generatePersonalizedEmail,
  logEmailActivity,
  embedVideoInEmail,
  shouldTriggerDirectMail,
  triggerDirectMailCampaign,
} from '@/lib/ai-isa'
import { publishManagerSignal } from '@/lib/kernel/manager-signals'
import { buildPersonalizationFacts, buildDeterministicCopy } from '@/lib/ai-isa/personalize-outreach'
import { pickLeadOutreachChannel } from '@/lib/ai-isa/lead-channel-policy'
import { cohortFromEnrichment } from '@/lib/ai-isa/adaptive-reengagement'
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
  // Hoisted so the catch can anchor the error row to a tenant. Every console that
  // reads automation_errors filters on brokerage_id — an unanchored row is written
  // and then invisible, which is the same outcome as not writing it.
  let brokerageId: string | null = null

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
    brokerageId = (lead.brokerage_id as string) ?? null

    // ── CONVERSION FINALITY — the FIRST stop, and a RE-ROUTE, not a drop ─────
    //
    // This function SELECTED `contact_id` (see the select above) and then never
    // refused on it. Every other stop it has — agent_id, 'representation',
    // is_active===false — passes cleanly for a lead converted through
    // lib/kernel/crm.ts:convertLeadToContact, which stamped `contact_id` and left
    // the lead ACTIVE. So the canonical ISA first-touch door was still
    // dispatching email / SMS / phone / direct mail at people who had already
    // become clients.
    //
    // The ruling is "only contacts get the actions" — NOT "the action
    // disappears". A contact-side twin of this exact entry point already exists,
    // so the engagement is HANDED to it rather than dropped. An unreadable lead
    // never reaches here (the read above throws into the catch, which files an
    // automation_errors row), and a converted lead with no resolvable contact
    // REFUSES rather than falling through — the reason travels back to the
    // caller either way, so a skip is never silent.
    //
    // CALLER NOTE: `opts.forceChannel` does not survive the re-route — the
    // contact lane picks the channel from the CONTACT's own stored preferences
    // and opt-out state, which is the correct authority for a converted person.
    // The one caller that force-channels a converted lead
    // (app/api/contacts/send-isa-email/route.ts, which looks up
    // `leads WHERE contact_id = <contact>` and is therefore ALWAYS aiming at a
    // converted lead) is owned by another lane and is reported, not edited.
    {
      const { conversionVerdictForRow, describeConversionRefusal } =
        await import('@/lib/contact-promotion/conversion-finality')
      const verdict = conversionVerdictForRow(lead as { id?: string; contact_id?: string | null }, leadId)
      if (!verdict.allowed) {
        if (verdict.contactId) {
          const { initiateAIISAContactEngagement } =
            await import('@/app/actions/ai-isa/initiate-contact-engagement')
          const rerouted = await initiateAIISAContactEngagement(verdict.contactId, 'reactivation')
          return {
            ...rerouted,
            rerouted_to_contact: verdict.contactId,
            reason: rerouted.reason ?? describeConversionRefusal(verdict, 'lead engagement'),
          } as any
        }
        return { success: false, reason: `stop:conversion_check`, error: verdict.reason }
      }
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
    // PARKED platform lead (owner, round 39): a platform-origin lead whose zip has no
    // subscriber yet is born with brokerage_id NULL and stays that way until the Engine 1
    // distribution sweep assigns one. Nobody works a parked lead — the AI ISA must not
    // engage it (there is no tenant to engage FOR: brand voice, compliance actor, and
    // dispatch identity are all brokerage-scoped). The per-brokerage sweeps never select
    // brokerage-less leads; this is the belt-and-suspenders refusal for direct callers.
    if (!lead.brokerage_id) {
      return { success: false, reason: 'stop:parked_awaiting_distribution' }
    }

    // ── Contact-level stops ─────────────────────────────────────────────────
    // Past the conversion guard above, `lead.contact_id` is always null, so this
    // block and the phone/SMS branches it feeds no longer fire on THIS path —
    // which is the ruling working as intended (a lead is email / direct-mail
    // only; a converted person is engaged as a CONTACT, through
    // initiateAIISAContactEngagement). Kept as the defence-in-depth read rather
    // than deleted: it is what makes a contact-linked lead fail safely instead of
    // being treated as consented.
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
      // Canonical lead-channel rule (the single source of truth — leads are STRICTLY
      // email / direct_mail; SMS / phone / social are never permitted for an unconsented
      // lead). pickLeadOutreachChannel is pure + guarded by the lead-channel simulator.
      return pickLeadOutreachChannel({ requestedChannel: requested, emailUsable, mailingVerified: hasVerifiedAddr })
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
    await collectError({
      workflowName: 'ai_isa_engagement',
      errorMessage: error.message,
      stack: error.stack,
      severity: 'high',
      brokerageId: brokerageId ?? undefined,
      leadId,
      context: { leadId },
      client: supabase,
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
      // Brand voice + them-first tone now actually shape the copy: the brokerage tagline
      // carries the brand, and the lead's generational cohort (from enrichment age) tones
      // the opener. Fair-Housing safe (style only); compliance gate still runs below.
      brandTagline: brandVoice.tagline ?? null,
      cohort: cohortFromEnrichment(lead.enrichment_profile as { age?: number | null; age_range?: string | null } | null),
    }

    const { subject, body, fromName } = await generatePersonalizedEmail(emailContext)

    // MULTI-MANAGER PLAY — instead of the ISA rendering a solo, throwaway D-ID avatar
    // inline, it DELEGATES the persona-matched intro reel to the Asset Manager (the team's
    // video director) on the bus. The Asset Manager commissions it through the full Director
    // (format → book-a-consult QR → compliance gate → a GATED ai_video_projects row); on
    // completion the Campaign Orchestrator proposes the gated 1:1 follow-up email embedding
    // it. Every hop shows on the "managers talking" feed — the differentiator. The reel is a
    // coordinated FOLLOW-UP, so the first-touch email's "being prepared, sent shortly" note
    // (embedVideoInEmail below) is accurate.
    const reelDelegation = await publishManagerSignal({
      brokerageId: lead.brokerage_id,
      fromManager: 'ai_isa',
      toManager: 'asset_manager',
      signalType: 'lead_creative_handoff',
      message: `Qualified ${lead.first_name || 'a lead'} — build the persona-matched 1:1 intro reel for the email follow-up.`,
      entityType: 'lead',
      entityId: lead.id,
      payload: { first_name: lead.first_name ?? null, property_interest: lead.property_interest ?? null },
    }, supabase)
    // The reel arrives as the coordinated follow-up — pass null so the email shows the
    // honest "intro is being prepared and will be sent shortly" note.
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
    // DEAD-WRITE REMOVED (pass 2): the old unified-inbox messages insert could never
    // succeed — messages.conversation_id is NOT NULL and was never provided, and
    // messages.contact_id FKs contacts (leads are not contacts). The ISA record of
    // truth is isa_outreach_log (+ the activities entry) — keep-one, no dead writes.

    await logEmailActivity(leadId, lead.brokerage_id, true)

    if (lead.lifecycle_state === 'unconsented') {
      await handleISAQualificationStarted({ leadId, brokerageId: lead.brokerage_id })
    }

    const shouldSendMail = await shouldTriggerDirectMail(leadId)
    if (shouldSendMail) {
      // Welcome kit = the long-form intro LETTER. The POSTCARD is no longer a static
      // Lob-template piece here — it's the BRAND-VOICED persona postcard the Asset
      // Manager stages (gated) off the lead_creative_handoff above, so the team play
      // owns the postcard creative and we never send two postcards for one lead.
      await triggerDirectMailCampaign({
        leadId: lead.id,
        brokerageId: lead.brokerage_id,
        firstName: lead.first_name || '',
        lastName: lead.last_name || '',
        motivation_type: lead.motivation_type,
        property_interest: lead.property_interest,
        pieceTypes: ['letter'],
      })
    }

    return {
      success: true,
      emailSent: true,
      reelDelegated: reelDelegation.ok,
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

    // ── ENGINE: Twilio-native (the single voice lane). The per-call ISA persona
    // (buildCallContext systemPrompt/firstMessage) rides the serverless turn
    // engine; TCPA + budget gates run inside placeOutboundAiCall, which writes
    // its own voice_calls ledger row. Honest failure → fall back to email.
    const { placeOutboundAiCall } = await import('@/lib/voice/twilio-outbound')
    const { createServiceClient } = await import('@/lib/supabase/service')
    const placed = await placeOutboundAiCall(createServiceClient(), {
      toNumber:     phone,
      contactId:    contactRow.id,
      brokerageId:  lead.brokerage_id,
      agentUserId:  lead.agent_id ?? null,
      initiatedBy:  lead.agent_id ?? null,
      objective:    'ISA qualification outreach: reconnect, understand where this lead is in their journey (timeline, motivation), and offer to book time with the agent.',
      contactName:  lead.first_name ?? contactRow.first_name ?? null,
      firstMessage: callContext.firstMessage ?? null,
      systemPrompt: callContext.systemPrompt ?? null,
      // ARMS THE AUTONOMY GATE — unattended qualification dial on a raw lead.
      // `leadId` is passed too so the suppression and de-conflict gates can key
      // on the LEAD as well as the contact row minted for it: this path calls
      // people who exist as a lead first, and suppression recorded against the
      // lead must still bind.
      systemSource: "ai_isa",
      leadId:       lead.id ?? null,
    })
    if (!placed.ok) {
      console.error('[AI-ISA] Twilio call failed, falling back to email:', placed.error)
      return await dispatchToChannel('email', lead, contactRow, leadId, supabase)
    }

    // ai_isa_calls — placeOutboundAiCall already wrote the voice_calls ledger row.
    await supabase.from('ai_isa_calls').insert({
      voice_call_id:   placed.voiceCallId,
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
      bodySnippet: `AI-ISA outbound call initiated (Twilio). Call SID: ${placed.callSid}`,
    })

    return {
      success:       true,
      callInitiated: true,
      vendorCallId:  placed.callSid,
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

    // Micro-personalized SMS from enrichment_profile — never a hardcoded fixed string
    const smsFactsLead = buildPersonalizationFacts({
      first_name:        lead.first_name,
      city:              lead.city,
      motivation_type:   lead.motivation_type,
      property_interest: lead.property_interest,
      budget_min:        lead.budget_min,
      budget_max:        lead.budget_max,
      timeline:          lead.timeline,
      enrichment_profile: lead.enrichment_profile as any ?? null,
      occupation:        lead.occupation,
      household_income:  lead.household_income,
      home_owner_status: lead.home_owner_status,
      life_events:       lead.life_events as any ?? null,
      marital_status:    lead.marital_status,
    })
    const smsCopyLead = buildDeterministicCopy(smsFactsLead, 'sms', lead.first_name ?? undefined)
    const smsBody = smsCopyLead.body

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
    // DEAD-WRITE REMOVED (pass 2): messages.conversation_id is NOT NULL and was
    // never provided — this insert always failed. isa_outreach_log is the record.

    return { success: true, smsSent: true, channel: 'sms' }
  }

  // ── DIRECT MAIL ────────────────────────────────────────────────────────
  if (channel === 'direct_mail') {
    const mailAddress =
      contactRow?.mailing_address ?? lead.mailing_address ?? null
    if (!mailAddress) {
      return { success: false, reason: 'no_mailing_address', channel }
    }

    // MULTI-MANAGER PLAY (direct-mail-only lead) — instead of auto-sending a static
    // Lob-template postcard, the ISA DELEGATES the persona creative to the Asset Manager
    // on the bus. With no usable email the Asset Manager skips the reel and stages the
    // BRAND-VOICED, them-first persona POSTCARD (gated, approval_status='pending') — a
    // human approves before any Lob send. Same handoff, same gated governance as email.
    const reelDelegation = await publishManagerSignal({
      brokerageId: lead.brokerage_id,
      fromManager: 'ai_isa',
      toManager: 'asset_manager',
      signalType: 'lead_creative_handoff',
      message: `Qualified ${lead.first_name || 'a lead'} (direct-mail) — build the persona postcard for the verified mailing address.`,
      entityType: 'lead',
      entityId: lead.id,
      payload: { first_name: lead.first_name ?? null, property_interest: lead.property_interest ?? null, channel: 'direct_mail' },
    }, supabase)

    await logISAOutreach({
      brokerageId: lead.brokerage_id,
      entity: { entityType: 'lead', leadId },
      channel: 'direct_mail',
      bodySnippet: `Persona postcard delegated to the Asset Manager (gated) for ${lead.first_name ?? ''} ${lead.last_name ?? ''}`.trim(),
    })
    // DEAD-WRITE REMOVED (pass 2): messages.conversation_id is NOT NULL and was
    // never provided — this insert always failed. isa_outreach_log is the record.

    return { success: true, reelDelegated: reelDelegation.ok, channel: 'direct_mail' }
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
    // DEAD-WRITE REMOVED (pass 2): messages.conversation_id is NOT NULL and was
    // never provided — this insert always failed. isa_outreach_log is the record.

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

/**
 * What the ISA has actually done to a lead, and where the lead stands.
 *
 * THREE THINGS WERE WRONG HERE and all three are fixed below, because this is
 * now reachable from the ISA console and a status panel that lies is worse than
 * no status panel.
 *
 * 1. THE ACTIVITY READ COULD NEVER RETURN A ROW. It filtered
 *    `activities.contact_id = <a LEADS id>`. `activities.contact_id` FKs
 *    `contacts(id)` (verified live in pg_constraint), and the WRITER of these
 *    very rows — lib/ai-isa/email-generator.ts:77 — sets `contact_id: null`
 *    explicitly, with the comment "leads are NOT contacts", and files the lead
 *    under `entity_type: 'lead' / entity_id: leadId`. So the reader was matching
 *    a column the writer deliberately leaves NULL: the activity list was
 *    ALWAYS EMPTY, for every lead, forever, and would have rendered as "the ISA
 *    has never touched this lead". Reads on (entity_type, entity_id) now, which
 *    is where the rows are.
 *
 * 2. NO AUTH AND NO TENANT. This is a `"use server"` export — a public HTTP
 *    endpoint — running on the SERVICE client, which bypasses RLS. Anyone who
 *    could guess a uuid could read any brokerage's lead stage, lead score and
 *    full ISA activity history. The lead must now be in the caller's own
 *    brokerage before anything is returned.
 *
 * 3. REFUSALS WERE INVISIBLE. Every read was undestructured, so a blocked query
 *    returned `null` and this function reported stage 'new', score 0 and no
 *    activity — a confident, wrong answer. Failures are now reported.
 */
export async function getAIISAEngagementStatus(leadId: string) {
  const { getAgentContext } = await import('@/lib/identity/get-agent-context')
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false as const, error: 'Unauthorized' }
  }

  const supabase = createServiceClient()

  // TENANT FIRST. The service client bypasses RLS, so the brokerage predicate is
  // this function's only tenancy — and it is checked before anything else is read.
  const { data: lead, error: leadError } = await supabase
    .from('leads')
    .select('lead_stage, lead_score, agent_id')
    .eq('id', leadId)
    .eq('brokerage_id', ctx.brokerageId)
    .maybeSingle()

  if (leadError) {
    console.error('[getAIISAEngagementStatus] lead read failed:', leadError.message)
    return { success: false as const, error: 'Could not load that lead.' }
  }
  if (!lead) return { success: false as const, error: 'Lead not found' }

  const { data: activities, error: activitiesError } = await supabase
    .from('activities')
    .select('id, activity_type, title, description, status, outcome, channel, created_at')
    // The identity class the WRITER uses. See note 1 above.
    .eq('entity_type', 'lead')
    .eq('entity_id', leadId)
    .eq('brokerage_id', ctx.brokerageId)
    .in('activity_type', [
      'ai_isa_email',
      'ai_isa_conversation',
      'ai_isa_qualification',
      'ai_isa_direct_mail',
    ])
    .order('created_at', { ascending: false })

  if (activitiesError) {
    console.error('[getAIISAEngagementStatus] activity read failed:', activitiesError.message)
    return { success: false as const, error: 'Could not load this lead’s ISA history.' }
  }

  // PASS-2 FIX: the old read filtered messages.contact_id (FKs contacts) by a
  // LEAD id — always empty. The ISA record of truth is isa_outreach_log;
  // inbound threads only exist once a lead becomes a contact (honest zero).
  const { count: outreachCount, error: outreachError } = await supabase
    .from('isa_outreach_log')
    .select('id', { count: 'exact', head: true })
    .eq('lead_id', leadId)
    .eq('brokerage_id', ctx.brokerageId)

  if (outreachError) {
    console.error('[getAIISAEngagementStatus] outreach count failed:', outreachError.message)
    return { success: false as const, error: 'Could not count this lead’s ISA outreach.' }
  }

  const inboundCount = 0
  const outboundCount = outreachCount ?? 0

  return {
    success: true as const,
    activities: activities ?? [],
    conversationStats: {
      inboundMessages: inboundCount,
      outboundMessages: outboundCount,
      totalExchanges: Math.max(inboundCount, outboundCount),
      /* Inbound is a structural zero, not a measurement: a lead has no message
       * thread until it converts to a contact. Surfaces must not render it as
       * "this person never replied". */
      inboundTracked: false as const,
    },
    currentStage: lead.lead_stage ?? 'new',
    leadScore: lead.lead_score ?? 0,
    assignedToAgent: !!lead.agent_id,
  }
}
