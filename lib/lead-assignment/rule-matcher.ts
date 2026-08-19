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

/**
 * The methods a broker can choose from. All five are admitted by
 * assignment_rules.rule_type; 'manual' was admitted and offered by no picker.
 *
 * Until now only 'round_robin' changed anything — every other value fell through
 * to `pool[0]`, so a broker who chose "Load Balance" or "Specialization" sent
 * every matching lead to the first agent in the list, forever. Worse, a
 * capacity-aware load balancer already existed (selectAgentByCapacity, used by
 * the fallback path and the Capacity Guardian) and the rule type of the same
 * name never called it. pickAgentForRule below makes each choice mean what it
 * says.
 */
export type RuleType = 'round_robin' | 'load_balance' | 'geo_based' | 'specialization' | 'manual'

export const RULE_TYPES: readonly RuleType[] = [
  'round_robin', 'load_balance', 'geo_based', 'specialization', 'manual',
] as const

export const RULE_TYPE_LABELS: Record<RuleType, string> = {
  round_robin: 'Round Robin',
  load_balance: 'Load Balance',
  geo_based: 'Geographic',
  specialization: 'Expertise',
  manual: 'Manual (hold for a person)',
}

export const RULE_TYPE_HELP: Record<RuleType, string> = {
  round_robin: 'Rotates evenly through the pool, in order, one lead each.',
  load_balance: 'Goes to whoever has the most headroom under their capacity ceiling.',
  geo_based: 'Prefers an agent who works that ZIP; falls back to the lightest load.',
  specialization: 'Prefers an agent whose stated expertise matches the lead; falls back to the lightest load.',
  manual: 'Assigns nobody. The lead waits for a person to route it by hand.',
}

export function isRuleType(v: string | null | undefined): v is RuleType {
  return !!v && (RULE_TYPES as readonly string[]).includes(v)
}

// ─── THE ASSIGNMENT GATE ─────────────────────────────────────────────────────
//
// OWNER RULING: "The only way to assign a lead to an agent is if the lead has
// been qualified OR positive intent."
//
// It was an AND in both places that enforce it — `autoAssignLead`
// (lib/lead-assignment/tier-routing.ts) for every AUTOMATIC path and
// `manualAssignLead` (app/actions/lead-assignment/assign-lead.ts) for the admin's
// hand-placement — and the two carried SEPARATE copies of the same expression, so
// they could drift. The gate now lives here, PURE, and both call it. (A third,
// simulator-only copy still exists at lib/ai-isa/qualification-core.ts:116
// `engine2GatePasses`; it has no production caller and now contradicts the
// ruling — see the lane report.)
//
// ── WHICH lifecycle_state VALUES ARE "POSITIVE INTENT", AND WHY ──────────────
//
// leads_lifecycle_state_check admits EXACTLY eight values (read live):
//   appointment · assigned · consented · isa_qualifying · long_term_nurture ·
//   raw · representation · unconsented
//
// A state counts as positive intent when the ROW ITSELF records that the person
// said yes — not that the OS hoped they would:
//
//   consented       ✓ THE positive-intent state. lib/kernel/lead-acquisition-handlers.ts
//                     handleConsentReceived is its only writer, and its only callers
//                     are positive-reply paths (accept-handoff.ts:70 on a positive ISA
//                     conversation, the qualification evaluator on readiness). The
//                     person replied yes.
//   appointment     ✓ They booked a meeting. Strictly downstream of consented and a
//                     stronger signal than the consent that preceded it.
//   representation  ✓ They signed. The strongest signal the schema can carry.
//   assigned        ✓ Downstream of consented as well; kept so a lead whose agent_id
//                     was cleared (agent offboarded, mis-assignment undone) can be
//                     re-placed without being re-qualified. Both callers already
//                     refuse a lead that still HAS an agent_id, so this can never
//                     become a second assignment.
//
//   raw             ✗ The pipeline birth state. Nothing has been said at all.
//   unconsented     ✗ The row explicitly records the ABSENCE of consent.
//   isa_qualifying  ✗ The ISA is still ASKING. The attempt is not the answer — this
//                     is precisely the state that must not reach an agent.
//   long_term_nurture ✗ The ISA wound them down after silence. The opposite of positive.

/** leads.lifecycle_state values that record a POSITIVE signal FROM the person. */
export const POSITIVE_INTENT_LIFECYCLE_STATES = [
  'consented',
  'appointment',
  'representation',
  'assigned',
] as const

export type PositiveIntentLifecycleState = (typeof POSITIVE_INTENT_LIFECYCLE_STATES)[number]

/** PURE — does this lifecycle_state record positive intent from the lead?
 *  NOT exported: `evaluateAssignmentEligibility` below is the ONE door, so no
 *  caller can gate on half the rule. */
function leadHasPositiveIntent(lifecycleState: string | null | undefined): boolean {
  return !!lifecycleState &&
    (POSITIVE_INTENT_LIFECYCLE_STATES as readonly string[]).includes(lifecycleState)
}

export interface AssignmentEligibility {
  /** May this lead be handed to an agent at all? */
  ok: boolean
  /** WHICH arm of the OR opened the gate — null when it stayed shut. */
  via: 'qualified' | 'positive_intent' | null
  /** Why, in words a surface can show the admin verbatim. */
  reason: string
}

/**
 * PURE — THE assignment gate. Qualified OR positive intent, never AND.
 *
 * `lead_stage === 'qualified'` is the ISA's verdict; `lifecycle_state` in
 * POSITIVE_INTENT_LIFECYCLE_STATES is the person's own. Either one alone is
 * enough: a lead the ISA qualified without a lifecycle stamp is assignable, and
 * so is a lead who replied "yes" before the ISA ever finished its script.
 *
 * NOTE the value that is deliberately NOT here: 'qualified' is NOT a legal
 * lifecycle_state (the CHECK does not admit it), so a gate that tested
 * lifecycle_state === 'qualified' could never fire. Only lead_stage carries it.
 */
export function evaluateAssignmentEligibility(
  leadStage: string | null | undefined,
  lifecycleState: string | null | undefined,
): AssignmentEligibility {
  const qualified = leadStage === 'qualified'
  const positive = leadHasPositiveIntent(lifecycleState)

  if (qualified) {
    return {
      ok: true,
      via: 'qualified',
      reason: `lead_stage='qualified' — the AI ISA qualified this lead`,
    }
  }
  if (positive) {
    return {
      ok: true,
      via: 'positive_intent',
      reason: `lifecycle_state='${lifecycleState}' — the lead gave a positive signal`,
    }
  }
  return {
    ok: false,
    via: null,
    reason:
      "Assignment requires lead_stage='qualified' OR a positive-intent lifecycle_state " +
      `(${POSITIVE_INTENT_LIFECYCLE_STATES.join('|')}). ` +
      `Got lead_stage='${leadStage ?? 'null'}', lifecycle_state='${lifecycleState ?? 'null'}'.`,
  }
}

export interface MatchableRule {
  id: string
  name?: string
  rule_type: RuleType | string
  conditions: Record<string, unknown> | null
  agent_ids: string[] | null
  /** Team-scoped rule (team tier / multi-location office). When set and agent_ids is
   *  empty, the rule routes within the team's members; when a contact carries a team
   *  hint, rules for OTHER teams never fire. */
  team_id?: string | null
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

/** What an agent brings to a rule that routes on more than rotation. */
export interface AgentProfileForRouting {
  /** agents.specializations — free-text tags the agent set on their profile. */
  specializations?: string[] | null
  /** agents.location_id — the office/branch they work out of. */
  locationId?: string | null
  /** ZIPs this agent farms, when the brokerage tracks them. */
  zipCodes?: string[] | null
}

/**
 * The OUTCOME of applying a rule's method to its pool.
 *
 * 'capacity' is not a cop-out: the load metric lives in the database (working
 * load against the tier ceiling, shared with the Capacity Guardian), so the pure
 * layer narrows the candidates and the async caller picks among them with
 * selectAgentByCapacity. That keeps this module pure — the settings page runs it
 * client-side for the routing preview — without the pure layer having to invent
 * a second, divergent load metric, which is exactly the drift a previous
 * burn-down removed.
 */
export type RuleAgentPick =
  | { kind: 'agent'; agentId: string; method: string }
  | { kind: 'capacity'; candidates: string[]; method: string }
  | { kind: 'manual'; method: 'manual' }

/** The agents columns the expertise + geographic methods read. */
export const ROUTING_PROFILE_COLUMNS = "id, specializations, location_id"

/**
 * Build the profile map from rows already selected with ROUTING_PROFILE_COLUMNS.
 * Kept pure and separate from the query so both engines and the settings preview
 * shape the data identically.
 */
export function toRoutingProfiles(
  rows: Array<{ id: string; specializations?: string[] | null; location_id?: string | null; zip_codes?: string[] | null }>,
): Record<string, AgentProfileForRouting> {
  const out: Record<string, AgentProfileForRouting> = {}
  for (const r of rows) {
    out[r.id] = {
      specializations: r.specializations ?? null,
      locationId: r.location_id ?? null,
      zipCodes: r.zip_codes ?? null,
    }
  }
  return out
}

/** PURE — normalise a tag for comparison ("First-Time Buyers" ≈ "first_time_buyers"). */
function tag(s: string): string {
  return s.toLowerCase().trim().replace(/[\s-]+/g, '_')
}

/**
 * PURE — apply a rule's METHOD to its pool.
 *
 * Every branch that is not round-robin used to be `pool[0]`. Each now means what
 * its label says, and each narrows honestly: an expertise or geographic rule
 * that matches nobody falls back to the whole pool by capacity rather than
 * stranding the lead — a rule matching zero specialists should still route.
 */
export function pickAgentForRule(
  rule: MatchableRule,
  pool: string[],
  hints: LeadRoutingHints,
  profiles?: Record<string, AgentProfileForRouting>,
): RuleAgentPick {
  return pickByMethod(rule.rule_type, pool, hints, profiles, rule.times_triggered ?? 0)
}

/**
 * PURE — apply a METHOD to a pool. Shared by the per-rule path and the
 * brokerage-wide DEFAULT (brokerages.default_assignment_method, m305), so the
 * method a broker picks in Settings behaves identically to the same method
 * chosen on a rule. Two implementations of "what round robin means" is exactly
 * the drift this consolidation exists to prevent.
 */
export function pickByMethod(
  type: string,
  pool: string[],
  hints: LeadRoutingHints,
  profiles?: Record<string, AgentProfileForRouting>,
  rotation = 0,
): RuleAgentPick {
  if (pool.length === 0) return { kind: 'capacity', candidates: [], method: type }

  if (type === 'manual') {
    // A deliberate hold. The lead is left unassigned for a human to route —
    // which is why it must never fall through to a pick.
    return { kind: 'manual', method: 'manual' }
  }

  if (type === 'round_robin') {
    return { kind: 'agent', agentId: pickRoundRobinAgent(pool, rotation), method: 'round_robin' }
  }

  if (type === 'specialization') {
    const wanted = [hints.motivation_type, hints.persona, hints.source]
      .filter((v): v is string => !!v)
      .map(tag)
    const specialists = wanted.length
      ? pool.filter((id) => {
          const spec = (profiles?.[id]?.specializations ?? []).map(tag)
          return spec.some((s) => wanted.includes(s))
        })
      : []
    return specialists.length
      ? { kind: 'capacity', candidates: specialists, method: 'specialization' }
      : { kind: 'capacity', candidates: pool, method: 'specialization_no_match' }
  }

  if (type === 'geo_based') {
    const zip = hints.property_zip_code
    const local = zip
      ? pool.filter((id) => (profiles?.[id]?.zipCodes ?? []).includes(zip))
      : []
    return local.length
      ? { kind: 'capacity', candidates: local, method: 'geo_based' }
      : { kind: 'capacity', candidates: pool, method: 'geo_based_no_match' }
  }

  // load_balance — and any value a future migration adds before this module
  // learns about it. Capacity over the whole pool is the safe, honest default.
  return { kind: 'capacity', candidates: pool, method: 'load_balance' }
}

/**
 * The agents a matched rule may assign to: its explicit agent_ids, else (for a
 * team-scoped rule) the team's members. A team rule with neither is unroutable.
 */
export function effectiveAgentPool(
  rule: MatchableRule,
  teamMembers?: Record<string, string[]>,
): string[] {
  if (rule.agent_ids?.length) return rule.agent_ids
  if (rule.team_id && teamMembers?.[rule.team_id]?.length) return teamMembers[rule.team_id]
  return []
}

/**
 * Team-scope gate: a team-scoped rule fires only when the contact has no team
 * affinity (conditions carry the office's territory, e.g. ZIP farm) or the
 * affinity matches. A contact captured by one office's form never routes into
 * another office's team rule even if conditions overlap.
 */
export function teamScopeAllows(rule: MatchableRule, teamHint?: string | null): boolean {
  if (!rule.team_id) return true
  if (!teamHint) return true
  return rule.team_id === teamHint
}

export interface RoutingPreviewResult {
  /** The rule that wins (highest priority, all conditions matched), or null. */
  rule: MatchableRule | null
  /** The agents.id the rule would pick, or null when the pick needs the database
   *  (capacity) or the rule deliberately assigns nobody (manual). */
  agentId: string | null
  /** 'rule' when a rule matched, 'load_balance' when routing falls through. */
  method: 'rule' | 'load_balance'
  /** How the winning rule decides — 'round_robin', 'specialization',
   *  'geo_based_no_match', 'manual' … so the preview can say so out loud. */
  strategy?: string
  /** Set when the final pick is made in the database by capacity. The preview
   *  shows the shortlist rather than pretending to name a winner it cannot know. */
  candidates?: string[]
}

/**
 * Dry-run step 3 of the precedence chain: evaluate active rules in priority order
 * against a sample lead. Pure — safe to run client-side in the settings UI.
 * Team-scoped rules sort ABOVE brokerage-wide rules of equal priority (the
 * canonical precedence: agent -> team -> brokerage -> platform).
 */
export function previewRuleRouting(
  rules: MatchableRule[],
  hints: LeadRoutingHints,
  opts?: {
    /** teams.id -> member agents.id, for team-scoped rules without explicit agent_ids. */
    teamMembers?: Record<string, string[]>
    /** The contact's team affinity (capture owner's team / team-tagged form). */
    teamHint?: string | null
    /** agents.id -> specializations / location / ZIP farm, for the expertise and
     *  geographic methods. Without it those two narrow to nobody and fall back
     *  to the whole pool, which the preview reports as *_no_match. */
    profiles?: Record<string, AgentProfileForRouting>
  },
): RoutingPreviewResult {
  const ordered = [...rules]
    .filter((r) => r.is_active && effectiveAgentPool(r, opts?.teamMembers).length > 0)
    .sort((a, b) =>
      b.priority - a.priority !== 0
        ? b.priority - a.priority
        : Number(!!b.team_id) - Number(!!a.team_id),
    )

  for (const rule of ordered) {
    if (!teamScopeAllows(rule, opts?.teamHint)) continue
    if (!evaluateRuleConditions(hints, rule.conditions ?? {})) continue
    const pool = effectiveAgentPool(rule, opts?.teamMembers)
    const pick = pickAgentForRule(rule, pool, hints, opts?.profiles)
    if (pick.kind === 'agent') {
      return { rule, agentId: pick.agentId, method: 'rule', strategy: pick.method }
    }
    if (pick.kind === 'manual') {
      // Honest: this rule matches and deliberately assigns nobody.
      return { rule, agentId: null, method: 'rule', strategy: 'manual' }
    }
    // The winner is decided in the database by working load. Naming pool[0] here
    // would be a guess the engine does not make.
    return { rule, agentId: null, method: 'rule', strategy: pick.method, candidates: pick.candidates }
  }
  return { rule: null, agentId: null, method: 'load_balance' }
}
