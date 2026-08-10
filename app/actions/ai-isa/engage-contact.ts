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
import { resolveWriteContext } from '@/lib/kernel/identity'
import { collectError } from '@/lib/errors/collect-error'
import {
  generatePersonalizedEmail,
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
import { isLifetimeCustomerType } from '@/lib/contact-types'
import { resolveContactChannel } from '@/lib/ai-isa/contact-channel-policy'
import type { MessageType, Persona } from '@/lib/kernel/types'
import { TRANSACTION_STATUSES_OPEN } from "@/lib/transactions/transaction-status"
import { VIDEO_FINISHED_STATUSES } from "@/lib/video/video-status"

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
         mailing_address, city, mailing_state:state, mailing_zip:zip_code,
         budget_min, budget_max, timeline, motivation_type, enrichment_profile, age_range,
         occupation, household_income, home_owner_status, life_events, marital_status,
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
      .in('status', [...TRANSACTION_STATUSES_OPEN])
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

    // ── MANAGERS DELEGATING — the ISA hands a TRULY SITUATIONAL reel to the Asset Manager
    //    (the video director), instead of making videos itself. The handler picks the reel
    //    KIND for the persona (buyer/seller/both/lifetime) + fronts it with the assigned
    //    agent's avatar/voice. Deduped per open signal (won't stack across touches); visible
    //    on the "managers talking" feed. Re-engagement reasons only (not speed-to-lead). ──
    if (reason === 'stale' || reason === 'ghosted' || reason === 'reactivation') {
      try {
        const { publishManagerSignal } = await import('@/lib/kernel/manager-signals')
        await publishManagerSignal({
          brokerageId, fromManager: 'ai_isa', toManager: 'asset_manager',
          signalType: 'contact_reel_handoff',
          message: `Re-engaging ${contact.first_name ?? 'a contact'} — build the situational reel fronted by their agent.`,
          entityType: 'contact', entityId: contactId, contactId,
        }, supabase)
      } catch { /* best-effort — the touch still goes out */ }
    }

    // ── PORTAL (them-first NLP, in-app) — the highest-attention, zero-cost touch. On
    //    re-engagement, leave a personal, SITUATIONAL note in the contact's portal (by
    //    persona: buyer/seller/both/lifetime) so a logged-in contact is met in-app, not just
    //    by email. Requires an assigned agent (client_portal_messages.agent_id NOT NULL);
    //    deduped to one situational note per week; the contact's hard stops already cleared above. ──
    if ((reason === 'stale' || reason === 'ghosted' || reason === 'reactivation') && contact.agent_id) {
      try {
        const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString()
        const { data: recent } = await supabase.from('client_portal_messages')
          .select('id').eq('contact_id', contact.id).eq('direction', 'agent_to_client')
          .contains('metadata', { source: 'ai_isa_situational' }).gte('created_at', weekAgo).limit(1).maybeSingle()
        if (!recent) {
          const { buildSituationalPortalMessage } = await import('@/lib/ai-isa/situational-portal-message')
          const portalPersona = contact.contact_type === 'seller' ? 'seller'
            : contact.contact_type === 'both' ? 'both'
            : isLifetimeCustomerType(contact.contact_type) ? 'lifetime' : 'buyer'
          const portalStage = (contact.buyer_stage as string | null) ?? (contact.motivation_type as string | null) ?? null
          const portalFallback = buildSituationalPortalMessage({
            firstName: contact.first_name || 'there', persona: portalPersona, stage: portalStage,
          })
          // AI-GENERATED them-first portal note (the gateway writes it for this person);
          // the deterministic builder is the FALLBACK only.
          let portalBody = portalFallback
          try {
            const { generatePersonaCopy, realCopyGenerator } = await import('@/lib/kernel/ai-copy')
            const drafted = await generatePersonaCopy(
              { goal: `a short, warm, them-first IN-APP PORTAL note for a real-estate ${portalPersona} client — reference where they are, ~60–80 words, end with "reply here". No protected-class or age language.`,
                facts: portalStage ? [`Stage/intent: ${portalStage}`] : [], channel: 'portal',
                persona: { name: contact.first_name ?? undefined, audience: portalPersona, situation: portalStage }, words: 75 },
              { body: portalFallback }, { generator: realCopyGenerator },
            )
            if (drafted.body?.trim()) portalBody = drafted.body.trim()
          } catch { /* gateway down → the deterministic them-first fallback stands */ }
          await supabase.from('client_portal_messages').insert({
            brokerage_id: brokerageId, contact_id: contact.id, agent_id: contact.agent_id,
            direction: "agent_to_client", channel: 'portal', body: portalBody,
            metadata: { source: 'ai_isa_situational', persona: portalPersona, reason },
          })
        }
      } catch (e) { console.error('[engageContact] portal touch failed:', e) }
    }

    // ── 5. AUTONOMOUS NEXT-BEST CHANNEL — the manager DECIDES which channel this contact's
    //    next touch uses (not just the static stored preference): the channel they actually
    //    REPLY to, then their AGE-GROUP psychology (gen-z text/video-first, boomers answer the
    //    phone, …), ROTATED off the last channel used — all within consent. resolveContactChannel
    //    remains the floor when consent permits nothing the manager would choose. ──
    let resolvedChannel = resolveContactChannel(contact)
    try {
      const { permittedContactChannels, decideNextChannel } = await import('@/lib/ai-isa/next-best-touch')
      const { cohortFromEnrichment } = await import('@/lib/ai-isa/adaptive-reengagement')
      const cohort = cohortFromEnrichment({
        age: (contact.enrichment_profile as { age?: number | null } | null)?.age ?? null,
        age_range: (contact.age_range as string | null) ?? null,
      })
      const { data: logRows } = await supabase.from('isa_outreach_log')
        .select('channel, replied_at').eq('contact_id', contact.id).order('sent_at', { ascending: false }).limit(60)
      const lastChannel = (logRows as Array<{ channel: string | null }> | null)?.[0]?.channel ?? null
      const byCh = new Map<string, { sent: number; replies: number }>()
      for (const r of (logRows ?? []) as Array<{ channel: string | null; replied_at: string | null }>) {
        if (!r.channel) continue
        const e = byCh.get(r.channel) ?? { sent: 0, replies: 0 }
        e.sent++; if (r.replied_at) e.replies++; byCh.set(r.channel, e)
      }
      const { rankChannelsByReplyRate } = await import('@/lib/campaign-sequences/channel-order')
      const ranked = rankChannelsByReplyRate([...byCh.entries()].map(([channel, v]) => ({ channel, sent: v.sent, replies: v.replies })))
      const nba = decideNextChannel({
        permitted: permittedContactChannels(contact), cohort,
        learnedRanked: ranked.ranked.map((x) => x.channel), lastChannel,
      })
      if (nba.channel !== 'no_channel') resolvedChannel = nba.channel
    } catch (e) { console.error('[engageContact] next-best-channel failed; using preference:', e) }
    const channel = forceChannel ?? resolvedChannel

    // ── NEWSLETTER = the nurture downshift → HAND OFF to the Campaign Orchestrator (its owner).
    //    The manager decided the next best touch is the passive, value-first newsletter (not
    //    another 1:1 ask) — so the ISA hands the relationship to the newsletter channel instead
    //    of dispatching a 1:1. Managers working together; enrollment is idempotent. ──
    if (channel === 'newsletter') {
      try {
        const { publishManagerSignal } = await import('@/lib/kernel/manager-signals')
        await publishManagerSignal({
          brokerageId, fromManager: 'ai_isa', toManager: 'campaign_orchestrator',
          signalType: 'newsletter_touch_handoff',
          message: `${contact.first_name || 'A contact'}'s next-best touch is the newsletter — handing them to the content channel for low-pressure nurture.`,
          entityType: 'contact', entityId: contact.id, contactId: contact.id,
          payload: { audience: 'contact', reason },
        }, supabase)
        return { success: true, channel: 'newsletter' }
      } catch (e) {
        console.error('[engageContact] newsletter handoff failed; falling back to email:', e)
        return await dispatchContactChannel('email', contact, brokerageId, reason, actorId, supabase)
      }
    }

    // Consent guard for phone/SMS
    if (CONSENT_REQUIRED_CHANNELS.has(channel) && !contact.tcpa_consent) {
      // Fall back to email rather than block entirely
      return await dispatchContactChannel('email', contact, brokerageId, reason, actorId, supabase)
    }

    return await dispatchContactChannel(channel, contact, brokerageId, reason, actorId, supabase)
  } catch (error: any) {
    console.error('[engageContact] Error:', error)
    await collectError({
      workflowName: 'ai_isa_contact_engagement',
      errorMessage: error.message,
      stack: error.stack,
      severity: 'high',
      brokerageId,
      context: { contactId, reason },
      client: supabase,
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

  // Brand voice — extend the AI's knowledge to cover THIS contact.
  const brandVoice = await loadBrandVoicePrompt({ brokerageId, agentId: contact.agent_id ?? null, contactId: contact.id })

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

    // THEM-FIRST, SITUATION-AWARE — address the contact by where they actually are
    // (motivation / budget / timeline / generational cohort), not a generic template. Same
    // enrichment the SMS path uses, so no channel speaks past the relationship.
    const { cohortFromEnrichment } = await import('@/lib/ai-isa/adaptive-reengagement')
    const enrichForCohort = {
      age: (contact.enrichment_profile as any)?.age ?? null,
      age_range: (contact.age_range as string | null) ?? (contact.enrichment_profile as any)?.age_range ?? null,
    }
    const emailCtx = {
      leadId: contact.id,
      firstName: contact.first_name || 'there',
      lastName: contact.last_name || '',
      email: contact.email,
      motivation_type: (contact.motivation_type as string | null) ?? contact.buyer_stage ?? undefined,
      property_interest: undefined,
      budget_min: (contact.budget_min as number | null) ?? undefined,
      budget_max: (contact.budget_max as number | null) ?? undefined,
      timeline: (contact.timeline as string | null) ?? undefined,
      lead_score: (contact.engagement_score as number | null) ?? undefined,
      enrichment_context: (contact.enrichment_profile as Record<string, any> | null) ?? undefined,
      brandVoiceBlock: brandVoice.systemBlock,
      brandTagline: brandVoice.tagline ?? null,
      cohort: cohortFromEnrichment(enrichForCohort),
    }

    const { subject, body, fromName } = await generatePersonalizedEmail(emailCtx)

    // SITUATIONAL VIDEO, never a throwaway: instead of synthesizing a generic D-ID avatar on
    // EVERY email (wasteful + non-situational + an unplayable placeholder), surface the
    // contact's most recent FINISHED (completed or published), broker-APPROVED situational reel — the anniversary-
    // equity / buyer-match / market reels the dedicated situation triggers render over the
    // relationship. As new situational reels render, the email shows the latest: videos
    // RECUR and stay relevant, never "once" and never a per-touch generic clip.
    const { data: latestReel } = await supabase
      .from('ai_video_projects')
      .select('video_url, thumbnail_url, completed_at')
      .eq('contact_id', contact.id)
      .eq('brokerage_id', brokerageId)
      .in('status', [...VIDEO_FINISHED_STATUSES])
      .eq('approval_status', 'approved')
      .not('video_url', 'is', null)
      .gte('completed_at', new Date(Date.now() - 120 * 86_400_000).toISOString())
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const reel = latestReel as { video_url?: string | null; thumbnail_url?: string | null } | null
    const embeddedBody = await embedVideoInEmail(body, reel?.video_url ?? null, reel?.thumbnail_url ?? null)
    // EVERY TOUCH DRIVES BACK TO THE PORTAL — append a CTA so the relationship compounds in
    // OUR portal (matches, journey, value, videos in one place), not a competitor's.
    const { portalCtaHtml } = await import('@/lib/ai-isa/portal-link')
    const finalBody = `${embeddedBody}\n${portalCtaHtml(contact.id)}`

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

    // Write to unified inbox messages table — messages.conversation_id is
    // NOT NULL (live schema): resolve the thread via the ONE canonical helper
    // first. Without it this insert failed silently (same dead-write class
    // pass 2 killed on the lead side).
    try {
      const { ensureConversationForContact, touchConversation } = await import('@/lib/kernel/conversation-thread')
      const conversationId = await ensureConversationForContact(supabase, {
        contactId: contact.id, brokerageId, agentId: contact.agent_id ?? null,
      })
      if (conversationId) {
        await supabase.from('messages').insert({
          conversation_id: conversationId,
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
        await touchConversation(supabase, conversationId, { inbound: false })
      }
    } catch { /* inbox mirror is best-effort; isa_outreach_log + activities are the record */ }

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
      activity_type: 'email', // CHECK vocabulary (drifted synonym was silently rejected)
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
    // PORTAL-BACK — every touch (SMS included) pulls the client into OUR portal (matches,
    // journey, value in one place), not a competitor's. SMS is the SMS-first cohorts' channel.
    const { portalSmsLine } = await import('@/lib/ai-isa/portal-link')
    const smsBody = `${smsCopy.body}\n${portalSmsLine(contact.id)}`

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
      activity_type: 'text', // CHECK vocabulary (drifted synonym was silently rejected)
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
      activity_type: 'direct_mail', // CHECK vocabulary (drifted synonym was silently rejected)
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
  //    still lands. The TCPA gate is the explicit guard on the next line — consent,
  //    opt-out and stop-flag are checked HERE, in this repo, before any dial. (This note
  //    used to credit the retired vendor's own gate for that, which would have been a
  //    dangerous thing to believe once the vendor was gone: it named a safeguard that no
  //    longer existed for the one channel where consent is a federal matter.) ──
  if (channel === 'phone') {
    if (!contact.phone || !contact.tcpa_consent || contact.phone_opt_out || contact.call_stop_flag) {
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
    // ENGINE: Twilio-native (the single voice lane). placeOutboundAiCall runs
    // the TCPA + budget gates and writes its own voice_calls ledger row; on any
    // block/failure it returns { ok: false }, so the escalation ladder (voice
    // drop → email) still lands the touch.
    const { placeOutboundAiCall } = await import('@/lib/voice/twilio-outbound')
    const placed = await placeOutboundAiCall(supabase, {
      toNumber: contact.phone, contactId: contact.id, brokerageId,
      agentUserId: contact.agent_id ?? null, initiatedBy: contact.agent_id ?? null,
      objective: `AI ISA re-engagement (trigger: ${reason}): reconnect, understand where the contact is now, and offer to book time with the agent.`,
      contactName: contact.first_name ?? null,
      firstMessage: callContext.firstMessage ?? null,
      systemPrompt: callContext.systemPrompt ?? null,
      // ARMS THE AUTONOMY GATE — unattended re-engagement dial. 'ghost_recovery'
      // and 'ai_isa' both map to the ai_isa manager; the trigger reason decides
      // which, so the ledger records why the contact was called.
      //
      // `reason` is 'stale' | 'ghosted' | 'reactivation' — there is no
      // 'ghost_recovery' reason. This mirrors the callPurpose mapping ~20 lines
      // above, which is the convention this file already uses.
      systemSource: reason === "ghosted" ? "ghost_recovery" : "ai_isa",
    })
    if (!placed.ok) {
      // Call couldn't be placed (TCPA block / provider) — drop a voicemail, else email.
      return (await tryVoiceDrop(contact, brokerageId, reason, supabase))
        ?? await dispatchContactChannel('email', contact, brokerageId, reason, actorId, supabase)
    }

    await supabase.from('ai_isa_calls').insert({
      voice_call_id: placed.voiceCallId, brokerage_id: brokerageId, contact_id: contact.id,
      lead_id: null, isa_campaign_id: null, script_used: 'isa_reengagement', appointment_set: false,
    }).then(() => {}, () => {})
    await logISAOutreach({
      brokerageId, entity: { entityType: 'contact', contactId: contact.id },
      channel: 'phone', subject: 'AI ISA call', bodySnippet: `AI-ISA outbound call initiated (Twilio). Call SID: ${placed.callSid}`,
    })
    await supabase.from('ai_isa_activities').insert({
      contact_id: contact.id, brokerage_id: brokerageId, channel: 'phone',
      activity_type: 'call', outcome: 'initiated', summary: `AI ISA call (trigger: ${reason})`,
    }).then(() => {}, () => {})
    await supabase.from('contacts').update({ last_contacted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', contact.id)
    await emitLifecycleEvent({
      eventType: 'AI_ISA_CONTACT_CALL_INITIATED', entityType: 'contact', entityId: contact.id,
      actorId: actorId ?? brokerageId, brokerageId, metadata: { reason, channel: 'phone', call_sid: placed.callSid },
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
    // SITUATIONAL + AI-GENERATED — the voice drop is WRITTEN by the gateway for this person
    // (them-first NLP grounded in their real facts), NOT a hardwired template. The deterministic
    // builder is only the FALLBACK when the gateway is unavailable. Spoken in the agent's voice,
    // so no agent-name placeholder is needed.
    const { buildSituationalVoicemailScript } = await import('@/lib/ai-isa/situational-voicemail')
    const side = contact.contact_type === 'seller' ? 'seller'
      : contact.contact_type === 'both' ? 'both'
      : isLifetimeCustomerType(contact.contact_type) ? 'past_client' : 'buyer'
    const stageHint = (contact.buyer_stage as string | null) ?? (contact.motivation_type as string | null) ?? null
    const fallbackVm = buildSituationalVoicemailScript({
      firstName: contact.first_name || 'there', side, stage: stageHint,
      hasFreshHook: reason === 'reactivation' || reason === 'stale' || reason === 'ghosted',
    })
    let scriptOverride = fallbackVm
    try {
      const { generatePersonaCopy, realCopyGenerator } = await import('@/lib/kernel/ai-copy')
      const vmFacts: string[] = []
      if (stageHint) vmFacts.push(`Stage/intent: ${stageHint}`)
      if (contact.timeline) vmFacts.push(`Timeline: ${contact.timeline}`)
      if (typeof contact.budget_min === 'number' && typeof contact.budget_max === 'number') vmFacts.push(`Budget: $${Number(contact.budget_min).toLocaleString()}–$${Number(contact.budget_max).toLocaleString()}`)
      const drafted = await generatePersonaCopy(
        { goal: `a warm, them-first ringless VOICEMAIL for a real-estate ${side} client — reference where they actually are, ≤25 seconds spoken (~50 words), natural and personal, end with a soft "call me back when you get a sec". No protected-class or age language.`,
          facts: vmFacts, channel: 'voicedrop',
          persona: { name: contact.first_name ?? undefined, audience: side, situation: stageHint }, words: 50 },
        { body: fallbackVm }, { generator: realCopyGenerator },
      )
      if (drafted.body?.trim()) scriptOverride = drafted.body.trim()
    } catch { /* gateway down → the deterministic them-first fallback stands */ }
    // IDENTITY: a contact's voicemail speaks in the ASSIGNED AGENT's cloned voice. Resolve
    // the agent's user_id (agents.id → users.id) so synthVoicemail uses the agent's voice,
    // not the preset default. Null (unassigned) → the brokerage default ISA voice.
    let agentUserId: string | null = null
    if (contact.agent_id) {
      const { data: a } = await supabase.from('agents').select('user_id').eq('id', contact.agent_id).maybeSingle()
      agentUserId = (a as { user_id: string | null } | null)?.user_id ?? null
    }
    const { orchestrateVoicedropSend } = await import('@/lib/voicedrop/orchestrate-voicedrop-send')
    const r = await orchestrateVoicedropSend({
      brokerageId, presetId: (preset as { id: string }).id, contactId: contact.id,
      toPhone: contact.phone, recipientFirstName: contact.first_name ?? null,
      teamId: contact.team_id ?? null, agentUserId, systemSource: 'ai_isa_contact', scriptOverride,
    })
    if (!r.success) return null
    await logISAOutreach({
      brokerageId, entity: { entityType: 'contact', contactId: contact.id },
      channel: 'phone', subject: 'AI ISA voicemail', bodySnippet: 'AI ISA ringless voicemail dropped (voicedrop)',
    })
    await supabase.from('ai_isa_activities').insert({
      contact_id: contact.id, brokerage_id: brokerageId, channel: 'voicedrop',
      activity_type: 'voicedrop', outcome: 'sent', summary: `AI ISA voice drop (trigger: ${reason})`,
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
 *
 * THIS IS AN OUTBOUND-AUTOMATION SWITCH, so who may flip it matters as much as
 * what it writes. It is exported from a `"use server"` module, i.e. it is a
 * reachable HTTP endpoint, and it previously had **no authentication at all**:
 * it opened a service-role client (RLS bypassed) and then took `brokerageId`
 * AND `actorId` straight from the caller. Three separate problems:
 *
 *   · Any anonymous caller holding a contactId + brokerageId pair could set
 *     `ai_outreach_paused = false` and `isa_reengage_allowed = true` —
 *     RE-ARMING automated email/SMS outreach on a contact an agent had
 *     deliberately paused. That is the wrong direction on a suppression-
 *     adjacent flag.
 *   · `isa_reengage_marked_by` is an accountability column and `actorId` is
 *     also stamped on the emitted lifecycle event. Both were whatever the
 *     caller said, so the audit trail could be forged to name any user.
 *   · RLS was no defence here. The `contacts` UPDATE policies are properly
 *     restrictive (agent-owns / broker-in-brokerage / platform-admin, verified
 *     live) but `createServiceClient()` bypasses all of them.
 *
 * Both identity inputs now come from the session and the caller's copies are
 * ignored — the same convention the rest of this repo uses for `agent_id?`.
 * The tenant scope on the UPDATE is therefore session-derived, which is what
 * makes it a real boundary rather than a caller-chosen one.
 */
export async function toggleContactAIISA(params: {
  contactId: string
  /** ignored — the tenant is the authenticated caller's */
  brokerageId?: string
  enabled: boolean
  /** ignored — the actor is the authenticated caller */
  actorId?: string
}): Promise<{ success: boolean; error?: string }> {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId || !ctx.userId) {
    return { success: false, error: 'Unauthorized' }
  }
  const brokerageId = ctx.brokerageId
  const actorId = ctx.userId

  const supabase = createServiceClient()
  const { contactId, enabled } = params

  // .select('id') so a no-op update is distinguishable from a successful one:
  // without it, targeting a contact in ANOTHER brokerage matches zero rows and
  // still returns error === null, which would report success for a write that
  // never happened.
  const { data: updated, error } = await supabase
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
    .select('id')

  if (error) return { success: false, error: error.message }
  if (!updated || updated.length === 0) {
    return { success: false, error: 'Contact not found in your brokerage' }
  }

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
