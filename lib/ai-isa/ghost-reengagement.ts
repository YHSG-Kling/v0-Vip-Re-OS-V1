import { createServiceClient } from '@/lib/supabase/service'
import { KernelEvent } from '@/lib/kernel/events'
import { processKernelEvent } from '@/lib/kernel'
import { logISAOutreach } from '@/lib/ai-isa/isa-outreach-logger'
import { initiateAIISAContactEngagement } from '@/app/actions/ai-isa/initiate-contact-engagement'

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
    .not('reengagement_status', 'in', '("completed","opted_out")')
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
  const todayDOW = today.getDay() // 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat

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

      // ── STOP CHECKS 1-3 + 5 ──────────────────────────────────────────────
      const contactRow = Array.isArray(lead.contacts)
        ? lead.contacts[0]
        : lead.contacts

      const shouldStop =
        lead.lifecycle_state === 'representation' ||
        lead.is_active === false ||
        contactRow?.isa_reengage_allowed === false ||
        lead.reengagement_status === 'opted_out'

      if (shouldStop) {
        await supabase
          .from('leads')
          .update({ reengagement_status: 'completed' })
          .eq('id', leadId)
        stopped++
        continue
      }

      // ── STOP CHECK 4: reply received ──────────────────────────────────────
      const { count: replyCount } = await supabase
        .from('lifecycle_events')
        .select('id', { count: 'exact', head: true })
        .eq('entity_id', leadId)
        .eq('entity_type', 'lead')
        .eq('event_type', KernelEvent.ISA_REPLY_RECEIVED)

      if ((replyCount ?? 0) > 0) {
        await supabase
          .from('leads')
          .update({ reengagement_status: 'completed' })
          .eq('id', leadId)
        stopped++
        continue
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

      const phaseStart = firstLog?.sent_at ? new Date(firstLog.sent_at) : today
      const daysSinceStart = Math.floor(
        (today.getTime() - phaseStart.getTime()) / 86400000,
      )
      const inPhase1 = daysSinceStart <= 14

      let shouldSend = false
      if (inPhase1) {
        // Mon=1, Wed=3, Fri=5 only
        shouldSend = [1, 3, 5].includes(todayDOW)
      } else {
        if (!lastLog?.sent_at) {
          shouldSend = true
        } else {
          const daysSinceLast = Math.floor(
            (today.getTime() - new Date(lastLog.sent_at).getTime()) / 86400000,
          )
          shouldSend = daysSinceLast >= 30
        }
      }

      if (!shouldSend) {
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

      // Mark reengagement active on first send
      if (lead.reengagement_status !== 'active') {
        await supabase
          .from('leads')
          .update({ reengagement_status: 'active' })
          .eq('id', leadId)

        await supabase.from('lifecycle_events').insert({
          brokerage_id: brokerageId,
          entity_type: 'lead',
          entity_id: leadId,
          event_type: KernelEvent.REENGAGEMENT_STARTED,
          metadata: { phase: inPhase1 ? 1 : 2 },
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

      // Log outreach via isa-outreach-logger
      await logISAOutreach({
        brokerageId,
        entity: { entityType: 'lead', leadId },
        channel: 'email',
        subject: `Still here for you, ${lead.first_name ?? 'there'}`,
        bodySnippet: `Re-engagement #${newCount} — phase ${inPhase1 ? 1 : 2}`,
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
      await supabaseErr
        .from('automation_errors')
        .insert({
          brokerage_id: brokerageId,
          entity_type: 'lead',
          entity_id: leadId,
          error_type: 'ghost_reengagement',
          message: err instanceof Error ? err.message : String(err),
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
