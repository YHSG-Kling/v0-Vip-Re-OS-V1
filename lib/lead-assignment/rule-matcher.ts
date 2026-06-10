// lib/lead-assignment/rule-matcher.ts
//
// PURE assignment-rule matcher — the single source of truth for "which rule fires
// for this lead". Extracted from assignment-engine.ts so that:
//   • the engine (Engine 2, post-qualification) evaluates with it,
//   • the Assignment Rules settings UI can run a client-side ROUTING PREVIEW
//     (broker types a sample lead, sees exactly which rule wins — no DB writes),
//   • the simulator regression-tests the precedence semantics.
//
// Canonical precedence (resolveAgentForContact / Engine 2):
//   1. owner hint (agent-tagged form/ad)  2. solo-agent brokerage shortcut
//   3. assignment_rules in priority order 4. load-balance fallback
// This module owns step 3's matching + agent-pick semantics only.

export type RuleType = 'round_robin' | 'load_balance' | 'geo_based' | 'specialization'

export interface MatchableRule {
  id: string
  name?: string
  rule_type: RuleType | string
  conditions: Record<string, unknown> | null
  agent_ids: string[] | null
  priority: number
  is_active: boolean
  times_triggered: number | null
}

export interface LeadRoutingHints {
  lead_score?: number | null
  property_zip_code?: string | null
  source?: string | null
  urgency_level?: string | null
  motivation_type?: string | null
  persona?: string | null
}

/** All-conditions-must-match evaluation (identical semantics to Engine 2). */
export function evaluateRuleConditions(
  hints: LeadRoutingHints,
  conditions: Record<string, unknown>,
): boolean {
  for (const [key, value] of Object.entries(conditions)) {
    switch (key) {
      case 'min_score':
        if ((hints.lead_score ?? 0) < (value as number)) return false
        break
      case 'max_score':
        if ((hints.lead_score ?? 0) > (value as number)) return false
        break
      case 'zip_codes': {
        const zips = value as string[]
        if (!hints.property_zip_code || !zips.includes(hints.property_zip_code)) return false
        break
      }
      case 'sources': {
        const sources = value as string[]
        if (!hints.source || !sources.includes(hints.source)) return false
        break
      }
      case 'urgency_levels': {
        const levels = value as string[]
        if (!hints.urgency_level || !levels.includes(hints.urgency_level)) return false
        break
      }
      case 'motivation_types': {
        const motivations = value as string[]
        if (!hints.motivation_type || !motivations.includes(hints.motivation_type)) return false
        break
      }
      case 'contact_personas': {
        const personas = value as string[]
        if (!hints.persona || !personas.includes(hints.persona)) return false
        break
      }
      default:
        break
    }
  }
  return true
}

/** Round-robin pick — times_triggered indexes the rotation deterministically. */
export function pickRoundRobinAgent(agentIds: string[], timesTriggered: number): string {
  return agentIds[timesTriggered % agentIds.length]
}

export interface RoutingPreviewResult {
  /** The rule that wins (highest priority, all conditions matched), or null. */
  rule: MatchableRule | null
  /** The agents.id the rule would pick (rotation-aware), or null. */
  agentId: string | null
  /** 'rule' when a rule matched, 'load_balance' when routing falls through. */
  method: 'rule' | 'load_balance'
}

/**
 * Dry-run step 3 of the precedence chain: evaluate active rules in priority order
 * against a sample lead. Pure — safe to run client-side in the settings UI.
 */
export function previewRuleRouting(
  rules: MatchableRule[],
  hints: LeadRoutingHints,
): RoutingPreviewResult {
  const ordered = [...rules]
    .filter((r) => r.is_active && (r.agent_ids?.length ?? 0) > 0)
    .sort((a, b) => b.priority - a.priority)

  for (const rule of ordered) {
    if (!evaluateRuleConditions(hints, rule.conditions ?? {})) continue
    const agentId =
      rule.rule_type === 'round_robin'
        ? pickRoundRobinAgent(rule.agent_ids as string[], rule.times_triggered ?? 0)
        : (rule.agent_ids as string[])[0]
    return { rule, agentId, method: 'rule' }
  }
  return { rule: null, agentId: null, method: 'load_balance' }
}
