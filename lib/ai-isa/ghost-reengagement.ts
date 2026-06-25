import { createServiceClient } from '@/lib/supabase/service'
import { KernelEvent } from '@/lib/kernel/events'
import { processKernelEvent } from '@/lib/kernel'
import { logISAOutreach } from '@/lib/ai-isa/isa-outreach-logger'
import { initiateAIISAContactEngagement } from '@/app/actions/ai-isa/initiate-contact-engagement'
import { ghostReengagementStopReason, ghostReengagementPhase, shouldSendGhostOutreach } from '@/lib/ai-isa/reengagement-policy'
import { buildPersonalizationFacts, buildDeterministicCopy } from '@/lib/ai-isa/personalize-outreach'
import { adaptiveReengagementHook } from '@/lib/ai-isa/adaptive-reengagement'

// ─── detectGhostLeads ─────────────────────────────────────────────────────────

export async function detectGhostLeads(
  brokerageId: string,
  thresholdDays: number,
): Promise<string[]> {
  const supabase = createServiceClient()

  const cutoff = new Date(
    Date.now() - thresholdDays * 24 * 60 * 60 * 1000,
  ).toISOString()

  const { data, error } = await supabase
    .from('leads')
    .select('id')
    .eq('brokerage_id', brokerageId)
    .eq('lifecycle_state', 'isa_qualifying')
    .eq('is_active', true)
    .not('reengagement_status', 'in', '("completed","opted_out","handed_to_sphere")')
    .or(`last_activity_at.lt.${cutoff},and(last_activity_at.is.null,created_at.lt.${cutoff})`)

  if (error) throw new Error(`detectGhostLeads query failed: ${error.message}`)

  return (data ?? []).map((r) => r.id as string)
}

// ─── runGhostReengagement ─────────────────────────────────────────────────────

export async function runGhostReengagement(
  brokerageId: string,
  thresholdDays: number,
): Promise<{
  processed: number
  sent: number
  paused: number
  stopped: number
  skipped: number
}> {
  const supabase = createServiceClient()
  const today = new Date()

  const ghostIds = await detectGhostLeads(brokerageId, thresholdDays)

  let sent = 0
  let paused = 0
  let stopped = 0
  let skipped = 0

  for (const leadId of ghostIds) {
    try {
      // ── Load lead with joined contact ─────────────────────────────────────
      const { data: lead, error: leadError } = await supabase
        .from('leads')
        .select('*, contacts(isa_reengage_allowed)')
        .eq('id', leadId)
        .single()

      if (leadError || !lead) {
        console.error(`[ghost-reengagement] Could not load lead ${leadId}:`, leadError?.message)
        continue
      }

      // ── STOP CHECKS — pure policy (reply count resolved first so the single
      //    decision sees the real replyReceived + the attempt count) ──────────
      const contactRow = Array.isArray(lead.contacts)
        ? lead.contacts[0]
        : lead.contacts

      const { count: replyCount } = await supabase
        .from('lifecycle_events')
        .select('id', { count: 'exact', head: true })
        .eq('entity_id', leadId)
        .eq('entity_type', 'lead')
        .eq('event_type', KernelEvent.ISA_REPLY_RECEIVED)

      const stopReason = ghostReengagementStopReason({
        lifecycle_state: lead.lifecycle_state,
        is_active: lead.is_active,
        reengagement_status: lead.reengagement_status,
        contactReengageAllowed: contactRow?.isa_reengage_allowed ?? null,
        replyReceived: (replyCount ?? 0) > 0,
        outreachAttempts: lead.reengagement_attempt_count ?? 0,
      })

      // HANDED TO SPHERE — after a year+ of quarterly seasonal touches with no reply, the
      // ISA does NOT abandon the relationship: it HANDS the long-tail to the Sphere of
      // Influence manager (the lifetime-nurture owner) and rests its own automated loop.
      // The lead stays alive as a sphere relationship — managers working together, no
      // dead-end. Marked terminal for the ISA so the detector stops re-picking it.
      if (stopReason === 'handed_to_sphere') {
        await supabase.from('leads').update({ reengagement_status: 'handed_to_sphere' }).eq('id', leadId)
        const { publishManagerSignal } = await import('@/lib/kernel/manager-signals')
        await publishManagerSignal({
          brokerageId,
          fromManager: 'ai_isa',
          toManager: 'sphere_of_influence',
          signalType: 'long_horizon_nurture_handoff',
          message: `${lead.first_name || 'A lead'} went a year+ without replying — handing the long-tail to lifetime sphere nurture (no reply ≠ no future).`,
          entityType: 'lead',
          entityId: leadId,
          contactId: lead.contact_id ?? null,
          payload: { attempts: lead.reengagement_attempt_count ?? 0, first_name: lead.first_name ?? null },
        }, supabase)
        stopped++
        continue
      }

      if (stopReason) {
        await supabase
          .from('leads')
          .update({ reengagement_status: 'completed' })
          .eq('id', leadId)
        stopped++
        continue
      }

      // ── ACTIVE → SEASONAL TRANSITION ──────────────────────────────────────
      // At the active-cadence ceiling the loop does NOT give up — it downshifts to the
      // quarterly seasonal nurture. We escalate ONCE to a human (FYI: "auto-nurture
      // continues; consider a personal call") and flag the lead long_horizon so the
      // escalation never re-fires. The seasonal cadence keeps the lead alive for a year+.
      const attempts = lead.reengagement_attempt_count ?? 0
      const phaseInfo = ghostReengagementPhase(attempts)
      if (phaseInfo.escalateOnEntry && lead.reengagement_status !== 'long_horizon') {
        await supabase.from('leads').update({ reengagement_status: 'long_horizon' }).eq('id', leadId)
        const { escalateExhaustedGhostLead } = await import('@/lib/ai-isa/ghost-escalation')
        await escalateExhaustedGhostLead(supabase, {
          leadId,
          brokerageId,
          attempts,
          firstName: lead.first_name ?? null,
        })
      }

      // ── PAUSE CHECK: under_contract ───────────────────────────────────────
      if (lead.contact_id) {
        const { count: ucCount } = await supabase
          .from('transactions')
          .select('id', { count: 'exact', head: true })
          .eq('contact_id', lead.contact_id)
          .eq('status', 'under_contract')

        if ((ucCount ?? 0) > 0) {
          await supabase.from('lifecycle_events').insert({
            brokerage_id: brokerageId,
            entity_type: 'lead',
            entity_id: leadId,
            event_type: KernelEvent.ISA_OUTREACH_PAUSED,
            metadata: { reason: 'under_contract' },
            created_at: new Date().toISOString(),
          })
          await processKernelEvent({
            event: KernelEvent.ISA_OUTREACH_PAUSED,
            brokerageId,
            entityType: 'lead',
            entityId: leadId,
          })
          paused++
          continue
        }
      }

      // ── CADENCE CHECK ─────────────────────────────────────────────────────
      const { data: firstLog } = await supabase
        .from('isa_outreach_log')
        .select('sent_at')
        .eq('lead_id', leadId)
        .order('sent_at', { ascending: true })
        .limit(1)
        .single()

      const { data: lastLog } = await supabase
        .from('isa_outreach_log')
        .select('sent_at')
        .eq('lead_id', leadId)
        .order('sent_at', { ascending: false })
        .limit(1)
        .single()

      // CADENCE — pure policy: Phase 1 (≤14d from first outreach) Mon/Wed/Fri only;
      // Phase 2 (>14d) every 30 days. Single source of truth, exhaustively tested.
      const cadence = shouldSendGhostOutreach({
        firstSentAt: firstLog?.sent_at ?? null,
        lastSentAt: lastLog?.sent_at ?? null,
        now: today,
        attempts, // ≥ ceiling → Phase 3 quarterly seasonal nurture (long-horizon)
      })
      const inPhase1 = cadence.phase === 1
      const daysSinceStart = cadence.daysSinceStart

      if (!cadence.shouldSend) {
        skipped++
        continue
      }

      // ── SEND ──────────────────────────────────────────────────────────────

      // If this lead has been converted to a contact AND is assigned to an agent,
      // route re-engagement to the contact-level engine instead of the lead engine.
      // This ensures consent-aware, contact-scoped nurture on converted records.
      if (lead.contact_id && lead.agent_id) {
        const contactResult = await initiateAIISAContactEngagement(lead.contact_id)
        if (contactResult.success) {
          sent++
        } else {
          skipped++
        }
        continue
      }

      // Mark reengagement active on first send — but NEVER downgrade a long_horizon
      // (seasonal) lead back to 'active' (it has graduated past the aggressive cadence).
      if (lead.reengagement_status !== 'active' && lead.reengagement_status !== 'long_horizon') {
        await supabase
          .from('leads')
          .update({ reengagement_status: 'active' })
          .eq('id', leadId)

        await supabase.from('lifecycle_events').insert({
          brokerage_id: brokerageId,
          entity_type: 'lead',
          entity_id: leadId,
          event_type: KernelEvent.REENGAGEMENT_STARTED,
          metadata: { phase: cadence.phase },
          created_at: new Date().toISOString(),
        })
        await processKernelEvent({
          event: KernelEvent.REENGAGEMENT_STARTED,
          brokerageId,
          entityType: 'lead',
          entityId: leadId,
        })
      }

      // Increment attempt counter
      const newCount = (lead.reengagement_attempt_count ?? 0) + 1
      await supabase
        .from('leads')
        .update({
          reengagement_attempt_count: newCount,
          last_activity_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', leadId)

      // Micro-personalized subject + body from enrichment_profile (never hardcoded)
      const reengageFacts = buildPersonalizationFacts({
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
      const reengageCopy = buildDeterministicCopy(reengageFacts, 'email', lead.first_name ?? undefined)

      // ADAPTIVE, THEM-FIRST ANGLE — vary the opening by attempt (life-context →
      // market → expertise → soft-close) AND tone it to the lead's generational cohort
      // (from enrichment age), so a non-responder gets a FRESH, age-appropriate reason
      // to reply instead of the same note repeated. Style/angle only — Fair-Housing safe.
      const adaptive = adaptiveReengagementHook({
        attempt: newCount,
        enrichment: lead.enrichment_profile as { age?: number | null; age_range?: string | null } | null,
      })
      const reengageBody = `${adaptive.hook}\n\n${reengageCopy.body}`

      // Log outreach via isa-outreach-logger
      await logISAOutreach({
        brokerageId,
        entity: { entityType: 'lead', leadId },
        channel: 'email',
        subject: reengageCopy.subject ?? `Checking in, ${lead.first_name ?? 'there'}`,
        bodySnippet: reengageBody.substring(0, 200),
        compliancePassed: true,
      })

      // Emit lifecycle event
      await supabase.from('lifecycle_events').insert({
        brokerage_id: brokerageId,
        entity_type: 'lead',
        entity_id: leadId,
        event_type: KernelEvent.GHOST_LEAD_DETECTED,
        metadata: {
          phase: inPhase1 ? 1 : 2,
          attempt: newCount,
          daysSinceStart,
          angle: adaptive.angle,
          cohort: adaptive.cohort,
        },
        created_at: new Date().toISOString(),
      })
      await processKernelEvent({
        event: KernelEvent.GHOST_LEAD_DETECTED,
        brokerageId,
        entityType: 'lead',
        entityId: leadId,
      })

      sent++
    } catch (err) {
      // Log to automation_errors — never abort the loop
      const supabaseErr = createServiceClient()
      // automation_errors canonical shape: workflow_name (NOT NULL) + error_message
      // + lead_id; no entity_id/entity_type/error_type/message columns.
      await supabaseErr
        .from('automation_errors')
        .insert({
          brokerage_id: brokerageId,
          lead_id: leadId,
          workflow_name: 'ghost_reengagement',
          error_message: err instanceof Error ? err.message : String(err),
          severity: 'medium',
          status: 'open',
          created_at: new Date().toISOString(),
        })
        .then(() => void 0)
    }
  }

  return {
    processed: ghostIds.length,
    sent,
    paused,
    stopped,
    skipped,
  }
}
