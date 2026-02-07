/**
 * SLA & ESCALATION LOGIC (PRE-CONTACT)
 * 
 * Monitors time-in-state for leads and escalates when SLA is breached.
 * This is pre-contact only - contacts have different SLAs.
 * 
 * Escalation triggers system-level notifications, not UI.
 */

export interface SLARule {
  stage: string
  maxDaysInStage: number
  escalationTarget: 'broker' | 'admin'
}

export interface SLABreachResult {
  breached: boolean
  daysInStage: number
  maxAllowed: number
  escalationTarget: string
  reason: string
}

/**
 * Default SLA rules for lead stages
 */
const DEFAULT_SLA_RULES: SLARule[] = [
  { stage: 'new', maxDaysInStage: 7, escalationTarget: 'broker' },
  { stage: 'qualifying', maxDaysInStage: 14, escalationTarget: 'broker' },
  { stage: 'qualified', maxDaysInStage: 3, escalationTarget: 'broker' },
  { stage: 'contacted', maxDaysInStage: 7, escalationTarget: 'admin' },
]

export function evaluateSLABreach(
  lead: any,
  rules: SLARule[] = DEFAULT_SLA_RULES
): SLABreachResult {
  // Calculate days in current stage
  const stageEnteredAt = lead.stage_entered_at || lead.created_at
  const daysInStage = Math.floor(
    (Date.now() - new Date(stageEnteredAt).getTime()) / (1000 * 60 * 60 * 24)
  )

  // Find applicable rule
  const rule = rules.find((r) => r.stage === lead.lead_stage)

  if (!rule) {
    return {
      breached: false,
      daysInStage,
      maxAllowed: 0,
      escalationTarget: '',
      reason: 'No SLA rule defined for this stage',
    }
  }

  if (daysInStage > rule.maxDaysInStage) {
    return {
      breached: true,
      daysInStage,
      maxAllowed: rule.maxDaysInStage,
      escalationTarget: rule.escalationTarget,
      reason: `Lead has been in ${lead.lead_stage} stage for ${daysInStage} days, exceeding max of ${rule.maxDaysInStage}`,
    }
  }

  return {
    breached: false,
    daysInStage,
    maxAllowed: rule.maxDaysInStage,
    escalationTarget: '',
    reason: 'Within SLA',
  }
}
