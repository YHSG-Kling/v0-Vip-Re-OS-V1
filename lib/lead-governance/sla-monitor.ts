/**
 * SLA & ESCALATION LOGIC (PRE-CONTACT LEADS)
 * 
 * Monitors time-in-state for leads and triggers escalations when SLAs are breached.
 * 
 * SLA RULES:
 * - New leads unassigned >7 days = escalate to broker
 * - Assigned leads with no activity >7 days = escalate to broker
 * - Leads in "qualified" stage >14 days = escalate for review
 * 
 * This system MONITORS and LOGS, it does NOT block automation.
 */

import { resolveLeadBrokerageId } from "@/lib/activities/activity-tenant"

export interface SLAStatus {
  isBreached: boolean
  daysInState: number
  escalationRequired: boolean
  escalationReason: string
  escalationRecipient: 'broker' | 'admin' | 'none'
}

/**
 * Evaluate SLA status for a lead
 */
export function evaluateSLA(lead: any): SLAStatus {
  const now = new Date()
  
  // Calculate days in current state
  const stateEnteredAt = lead.stage_entered_at ? new Date(lead.stage_entered_at) : new Date(lead.created_at)
  const daysInState = Math.floor((now.getTime() - stateEnteredAt.getTime()) / (1000 * 60 * 60 * 24))

  let isBreached = false
  let escalationRequired = false
  let escalationReason = ''
  let escalationRecipient: 'broker' | 'admin' | 'none' = 'none'

  // RULE 1: Unassigned leads >7 days
  if (!lead.agent_id && daysInState > 7) {
    isBreached = true
    escalationRequired = true
    escalationReason = `Lead unassigned for ${daysInState} days (SLA: 7 days)`
    escalationRecipient = 'broker'
  }

  // RULE 2: Assigned leads with no recent activity >7 days
  if (lead.agent_id && lead.last_contacted_at) {
    const lastActivity = new Date(lead.last_contacted_at)
    const daysSinceActivity = Math.floor((now.getTime() - lastActivity.getTime()) / (1000 * 60 * 60 * 24))
    
    if (daysSinceActivity > 7) {
      isBreached = true
      escalationRequired = true
      escalationReason = `No agent activity for ${daysSinceActivity} days (SLA: 7 days)`
      escalationRecipient = 'broker'
    }
  }

  // RULE 3: Leads stuck in ISA qualifying too long
  if (lead.lifecycle_state === 'isa_qualifying' && daysInState > 14) {
    isBreached = true
    escalationRequired = true
    escalationReason = `Lead stuck in ISA qualifying for ${daysInState} days (SLA: 14 days)`
    escalationRecipient = 'broker'
  }

  return {
    isBreached,
    daysInState,
    escalationRequired,
    escalationReason,
    escalationRecipient,
  }
}

// Agent task (correct location, no changes) — activity_type: sla_escalation
/**
 * Log escalation activity
 */
export async function logEscalation(
  leadId: string,
  slaStatus: SLAStatus,
  supabase: any
): Promise<void> {
  // THE ROW HAD NO ANCHOR OF ANY KIND, so `activities_set_brokerage` — the
  // BEFORE INSERT trigger that made every census bucket this table as "netted" —
  // matched none of its eight branches and left `brokerage_id` NULL. That column
  // is NOT NULL, so this was never a hidden row: every SLA breach escalation was
  // **refused, 23502**, and the log line below was the only trace.
  //
  // Note what the row also did not carry: the LEAD. `leadId` appeared in this
  // function's log lines and nowhere in its record. `entity_type`/`entity_id` now
  // file it against the lead — the same anchor `app/actions/lead-governance/
  // govern-lead.ts:231` already uses for its own routing rows — which is both the
  // tenant path and the reason the row is findable at all.
  const tenant = await resolveLeadBrokerageId(supabase, leadId)
  if (!tenant.ok || !tenant.brokerageId) {
    console.error(
      `[SLAMonitor] Escalation NOT logged for lead ${leadId}: ${
        tenant.ok ? 'lead carries no brokerage_id' : tenant.reason
      } — refusing to attempt an insert that cannot satisfy activities.brokerage_id NOT NULL`,
    )
    return
  }

  // An SLA BREACH escalation that vanishes is the one record you cannot afford
  // to lose — it is the evidence that the miss was noticed at all. Read the
  // result and say so loudly; this function returns void, so a log line is the
  // only channel it has.
  const { error } = await supabase.from('activities').insert({
    // TENANT: the lead's own brokerage — `leads.brokerage_id` is NOT NULL.
    brokerage_id: tenant.brokerageId,
    entity_type: 'lead',
    entity_id: leadId,
    activity_type: 'sla_escalation',
    title: 'Lead SLA Breach - Escalation Required',
    description: slaStatus.escalationReason,
    status: 'pending',
    priority: 'high',
    notes: JSON.stringify({
      daysInState: slaStatus.daysInState,
      escalationRecipient: slaStatus.escalationRecipient,
      timestamp: new Date().toISOString(),
    }),
    created_at: new Date().toISOString(),
  })

  if (error) {
    console.error(`[SLAMonitor] Escalation NOT logged for lead ${leadId}:`, error.message)
    return
  }

  console.log(`[SLAMonitor] Escalation logged for lead ${leadId}: ${slaStatus.escalationReason}`)
}
