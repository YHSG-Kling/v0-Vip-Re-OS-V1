'use server'

/**
 * app/actions/ai-isa/classify-outcome.ts
 *
 * Standardized AI ISA outcome model.
 *
 * Outcomes drive:
 *   - Suppression of future automation
 *   - Agent notification / handoff creation
 *   - Disposition field updates on contact/lead
 *   - ai_isa_activities outcome column
 *   - isa_outreach_log updates
 *
 * Positive outcomes → agent handoff or follow-up task
 * Negative outcomes → suppress / reduce cadence / mark record
 * No-response outcomes → continue nurture per settings
 */

import { createServiceClient } from '@/lib/supabase/service'
import { emitLifecycleEvent } from '@/lib/kernel/helpers'
import { getAgentContext } from '@/lib/identity/get-agent-context'

// ── Outcome catalogue ─────────────────────────────────────────────────────────

export type ISAOutcome =
  | 'appointment_set'
  | 'follow_up_required'
  | 'agent_handoff'
  | 'nurture'
  | 'stale'
  | 'ghosted'
  | 'not_interested'
  | 'wrong_number'
  | 'bad_contact_data'
  | 'do_not_call'
  | 'do_not_contact'
  | 'direct_mail_only'
  | 'email_only'

// Outcomes that suppress all future phone/SMS engagement
const SUPPRESS_PHONE_OUTCOMES: Set<ISAOutcome> = new Set([
  'do_not_call',
  'do_not_contact',
  'wrong_number',
])

// Outcomes that pause all future AI ISA engagement
const SUPPRESS_ALL_OUTCOMES: Set<ISAOutcome> = new Set([
  'do_not_contact',
  'not_interested',
])

// Outcomes that require an agent handoff notification
const HANDOFF_OUTCOMES: Set<ISAOutcome> = new Set([
  'appointment_set',
  'agent_handoff',
  'follow_up_required',
])

// ── Params ────────────────────────────────────────────────────────────────────

export interface ClassifyOutcomeParams {
  /** 'contact' | 'lead' */
  entityType: 'contact' | 'lead'
  entityId: string
  brokerageId: string
  outcome: ISAOutcome
  channel: string
  notes?: string
  /** Source activity ID if classifying from a specific outreach row */
  outreachLogId?: string
  actorId?: string
}

export interface ClassifyOutcomeResult {
  success: boolean
  handoffCreated?: boolean
  suppressionApplied?: boolean
  error?: string
}

// ── classifyISAOutcome ────────────────────────────────────────────────────────

export async function classifyISAOutcome(
  params: ClassifyOutcomeParams,
): Promise<ClassifyOutcomeResult> {
  const { entityType, entityId, brokerageId, outcome, channel, notes, outreachLogId, actorId } = params
  const supabase = createServiceClient()

  try {
    // ── AUTH GATE ──────────────────────────────────────────────────────────
    // Permitted callers:
    //   1. UI/server-action with session (verify ctx.brokerageId === param)
    //   2. Trusted system path (actorId === 'system' AND CRON_SECRET set —
    //      proves we're running in a real deploy not an open endpoint).
    // We ALSO re-verify the target entity row actually belongs to the given
    // brokerage before issuing any updates — so a forged brokerageId param
    // can't suppress communications on records in another tenant.
    const ctx = await getAgentContext()
    const isSystemCaller =
      (actorId === 'system' || actorId === 'ai_isa') && !!process.env.CRON_SECRET
    if (!isSystemCaller) {
      if (!ctx.isAuthenticated || !ctx.brokerageId) {
        return { success: false, error: 'Unauthorized' }
      }
      if (ctx.brokerageId !== brokerageId) {
        return { success: false, error: 'Forbidden' }
      }
    }

    // Verify entity belongs to brokerageId
    const entityTable = entityType === 'contact' ? 'contacts' : 'leads'
    const { data: entityRow } = await supabase
      .from(entityTable)
      .select('brokerage_id')
      .eq('id', entityId)
      .maybeSingle()
    if (!entityRow || entityRow.brokerage_id !== brokerageId) {
      return { success: false, error: 'Forbidden' }
    }

    const now = new Date().toISOString()

    // ── 1. Write outcome to ai_isa_activities ──────────────────────────────
    const activityInsert: Record<string, unknown> = {
      brokerage_id: brokerageId,
      channel,
      activity_type: 'outcome_classified',
      outcome,
      summary: notes ?? `Outcome: ${outcome}`,
      created_at: now,
    }
    if (entityType === 'contact') activityInsert.contact_id = entityId
    else activityInsert.lead_id = entityId

    await supabase.from('ai_isa_activities').insert(activityInsert)

    // ── 2. Update isa_outreach_log if provided ─────────────────────────────
    if (outreachLogId) {
      await supabase
        .from('isa_outreach_log')
        .update({ replied_at: now })
        .eq('id', outreachLogId)
    }

    let suppressionApplied = false
    let handoffCreated = false

    // ── 3. Apply suppression rules on the entity ───────────────────────────
    if (entityType === 'contact') {
      const contactUpdate: Record<string, unknown> = {
        updated_at: now,
      }

      if (SUPPRESS_ALL_OUTCOMES.has(outcome)) {
        contactUpdate.ai_outreach_paused    = true
        contactUpdate.isa_reengage_allowed  = false
        contactUpdate.isa_reengage_set_at   = now
        suppressionApplied = true
      }

      if (SUPPRESS_PHONE_OUTCOMES.has(outcome)) {
        contactUpdate.phone_opt_out   = true
        contactUpdate.call_stop_flag  = true
        suppressionApplied = true
      }

      if (outcome === 'direct_mail_only') {
        contactUpdate.email_opt_out = true
        contactUpdate.sms_opt_out   = true
        contactUpdate.phone_opt_out = true
        contactUpdate.call_stop_flag = true
        contactUpdate.preferred_channel = 'direct_mail'
        suppressionApplied = true
      }

      if (outcome === 'email_only') {
        contactUpdate.sms_opt_out   = true
        contactUpdate.phone_opt_out = true
        contactUpdate.call_stop_flag = true
        contactUpdate.preferred_channel = 'email'
        suppressionApplied = true
      }

      if (outcome === 'do_not_contact') {
        contactUpdate.dnc_status = true
        suppressionApplied = true
      }

      if (Object.keys(contactUpdate).length > 1) {
        await supabase
          .from('contacts')
          .update(contactUpdate)
          .eq('id', entityId)
          .eq('brokerage_id', brokerageId)
      }

      // Write to contact_suppression_list for auditable suppression records
      if (suppressionApplied) {
        const { data: contact } = await supabase
          .from('contacts')
          .select('email, phone')
          .eq('id', entityId)
          .maybeSingle()

        // Insert suppression — ignore if already suppressed on this channel
        await supabase.from('contact_suppression_list').insert({
          brokerage_id:       brokerageId,
          contact_id:         entityId,
          email:              contact?.email ?? null,
          phone:              contact?.phone ?? null,
          suppression_reason: outcome,
          channel:            SUPPRESS_PHONE_OUTCOMES.has(outcome) ? 'phone' : 'all',
          source:             'ai_isa',
          created_at:         now,
        }) // fire-and-forget: duplicate rows are acceptable
        .then(() => {}, () => {}) // silent fail on duplicate key error
      }
    } else {
      // Lead-side suppression
      const leadUpdate: Record<string, unknown> = { updated_at: now }

      if (SUPPRESS_ALL_OUTCOMES.has(outcome)) {
        leadUpdate.ai_outreach_paused = true
        suppressionApplied = true
      }
      if (SUPPRESS_PHONE_OUTCOMES.has(outcome)) {
        leadUpdate.call_stop_flag = true
        leadUpdate.phone_opt_out  = true
        suppressionApplied = true
      }
      if (outcome === 'do_not_contact') {
        leadUpdate.call_stop_flag = true
        leadUpdate.phone_opt_out  = true
        leadUpdate.sms_opt_out    = true
        leadUpdate.email_opt_out  = true
        suppressionApplied = true
      }

      if (Object.keys(leadUpdate).length > 1) {
        await supabase
          .from('leads')
          .update(leadUpdate)
          .eq('id', entityId)
          .eq('brokerage_id', brokerageId)
      }
    }

    // ── 4. Create agent handoff for positive outcomes ──────────────────────
    if (HANDOFF_OUTCOMES.has(outcome)) {
      // Resolve assigned agent for the entity
      let humanAgentId: string | null = null
      if (entityType === 'contact') {
        const { data: c } = await supabase.from('contacts').select('agent_id').eq('id', entityId).maybeSingle()
        humanAgentId = c?.agent_id ?? null
      } else {
        const { data: l } = await supabase.from('leads').select('agent_id').eq('id', entityId).maybeSingle()
        humanAgentId = l?.agent_id ?? null
      }

      await supabase.from('agent_handoffs').insert({
        brokerage_id:    brokerageId,
        entity_type:     entityType,
        entity_id:       entityId,
        from_agent_type: 'ai_isa',
        to_agent_type:   'human',
        human_agent_id:  humanAgentId,
        handoff_reason:  outcome,
        context_package: { outcome, channel, notes: notes ?? null },
        handoff_status:  'pending',
        created_at:      now,
      })
      handoffCreated = true

      // Notify via notifications table
      if (humanAgentId) {
        await supabase.from('notifications').insert({
          user_id:     humanAgentId,
          brokerage_id: brokerageId,
          type:        'ai_isa_handoff',
          title:       `AI ISA: ${outcome.replace(/_/g, ' ')}`,
          body:        `A contact needs your attention. Outcome: ${outcome}. Channel: ${channel}.`,
          entity_type: entityType,
          entity_id:   entityId,
          is_read:     false,
          priority:    outcome === 'appointment_set' ? 'high' : 'normal',
          created_at:  now,
        })
      }
    }

    // ── 5. Emit lifecycle event ────────────────────────────────────────────
    await emitLifecycleEvent({
      eventType:   `AI_ISA_OUTCOME_${outcome.toUpperCase()}`,
      entityType,
      entityId,
      actorId:     actorId ?? brokerageId,
      brokerageId,
      metadata:    { outcome, channel, notes: notes ?? null },
    })

    return { success: true, handoffCreated, suppressionApplied }
  } catch (error: any) {
    console.error('[classifyISAOutcome] Error:', error)
    return { success: false, error: error.message }
  }
}
