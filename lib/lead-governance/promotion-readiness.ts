/**
 * PROMOTION ELIGIBILITY SIGNAL
 * 
 * Determines when a lead is ready for promotion to contact status.
 * This system emits a SIGNAL only - it does NOT create contacts.
 * 
 * Contact creation is handled by a separate downstream system.
 */

export interface PromotionReadinessResult {
  ready: boolean
  reason: string
  blockers: string[]
  evaluatedAt: string
}

export function evaluatePromotionReadiness(lead: any): PromotionReadinessResult {
  const blockers: string[] = []

  // Must have agent assigned
  if (!lead.agent_id) {
    blockers.push('No agent assigned')
  }

  // Must be in qualified or contacted stage
  const validStages = ['qualified', 'contacted', 'engaged']
  if (!validStages.includes(lead.lead_stage)) {
    blockers.push(`Stage ${lead.lead_stage} not eligible for promotion`)
  }

  // Must have minimum score
  if (lead.lead_score < 60) {
    blockers.push(`Score ${lead.lead_score} below minimum 60 for promotion`)
  }

  // Must have complete enrichment
  if (lead.enrichment_status !== 'complete') {
    blockers.push('Enrichment incomplete')
  }

  // Must have valid contact info
  if (!lead.email && !lead.phone) {
    blockers.push('No contact information available')
  }

  if (blockers.length > 0) {
    return {
      ready: false,
      reason: 'Not eligible for promotion',
      blockers,
      evaluatedAt: new Date().toISOString(),
    }
  }

  return {
    ready: true,
    reason: 'All promotion criteria met',
    blockers: [],
    evaluatedAt: new Date().toISOString(),
  }
}
