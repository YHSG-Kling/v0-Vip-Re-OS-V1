/**
 * POLICY-DRIVEN ROUTING EVALUATOR
 * 
 * This system determines whether a lead is eligible for agent assignment
 * based on explicit, configurable policies.
 * 
 * Routing is a DECISION, not a suggestion.
 * If criteria are NOT met, the lead stays in AI-only nurturing.
 */

export interface RoutingPolicy {
  minimumScore: number
  requiresEmail: boolean
  requiresPhone: boolean
  blockedStages: string[]
  requiresEnrichmentComplete: boolean
}

export interface RoutingDecision {
  eligible: boolean
  reason: string
  policy: RoutingPolicy
  evaluatedAt: string
}

/**
 * Default routing policy
 * Can be overridden per brokerage
 */
const DEFAULT_POLICY: RoutingPolicy = {
  minimumScore: 50, // Must score at least 50/100
  requiresEmail: true,
  requiresPhone: false, // Email OR phone
  blockedStages: ['rejected', 'duplicate', 'invalid'],
  requiresEnrichmentComplete: true,
}

export function evaluateRoutingEligibility(
  lead: any,
  policy: RoutingPolicy = DEFAULT_POLICY
): RoutingDecision {
  // Check blocked stages
  if (policy.blockedStages.includes(lead.lead_stage)) {
    return {
      eligible: false,
      reason: `Lead is in blocked stage: ${lead.lead_stage}`,
      policy,
      evaluatedAt: new Date().toISOString(),
    }
  }

  // Check score threshold
  if (lead.lead_score < policy.minimumScore) {
    return {
      eligible: false,
      reason: `Lead score ${lead.lead_score} below minimum ${policy.minimumScore}`,
      policy,
      evaluatedAt: new Date().toISOString(),
    }
  }

  // Check enrichment status
  if (policy.requiresEnrichmentComplete && lead.enrichment_status !== 'complete') {
    return {
      eligible: false,
      reason: `Enrichment status is ${lead.enrichment_status}, not complete`,
      policy,
      evaluatedAt: new Date().toISOString(),
    }
  }

  // Check contact requirements
  if (policy.requiresEmail && !lead.email) {
    return {
      eligible: false,
      reason: 'Email required but missing',
      policy,
      evaluatedAt: new Date().toISOString(),
    }
  }

  if (policy.requiresPhone && !lead.phone) {
    return {
      eligible: false,
      reason: 'Phone required but missing',
      policy,
      evaluatedAt: new Date().toISOString(),
    }
  }

  // All criteria met
  return {
    eligible: true,
    reason: 'All routing criteria met',
    policy,
    evaluatedAt: new Date().toISOString(),
  }
}
