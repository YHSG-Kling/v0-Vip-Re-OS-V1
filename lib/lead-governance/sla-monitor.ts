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
  await supabase.from('activities').insert({
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

  console.log(`[SLAMonitor] Escalation logged for lead ${leadId}: ${slaStatus.escalationReason}`)
}
