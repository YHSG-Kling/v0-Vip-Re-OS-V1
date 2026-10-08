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
  thresholdsMet: Record<string, boolean>
  evaluatedAt: string
}

/**
 * Default routing policy
 * Can be overridden per brokerage — see resolveRoutingPolicy() below, which is the
 * half that makes that sentence true.
 */
const DEFAULT_POLICY: RoutingPolicy = {
  minimumScore: 50, // Must score at least 50/100
  requiresEmail: true,
  requiresPhone: false, // Email OR phone
  blockedStages: ['rejected', 'duplicate', 'invalid'],
  requiresEnrichmentComplete: true,
}

/** Where a brokerage's override lives inside `brokerage_settings.settings` (jsonb). */
const POLICY_SETTINGS_KEY = 'lead_routing_policy'

/**
 * BUILT (orphan doctrine §1.2 — no duplicate existed, the capability is wanted).
 *
 * THE INERT ARGUMENTS THIS CLOSES. evaluateRoutingEligibility accepted `brokerageId`
 * and `supabase` and READ NEITHER — both call sites
 * (app/actions/lead-governance/govern-lead.ts:145 and
 * lib/kernel/lead-acquisition-handlers.ts:255) thread them all the way in, and the
 * function dropped them on the floor. So DEFAULT_POLICY governed every tenant while
 * the docstring above promised "Can be overridden per brokerage" — a policy knob that
 * looked configurable, logged as though it had been consulted, and could not be moved.
 * No second per-brokerage routing policy exists anywhere in the tree (searched
 * comment- and string-stripped), so this is a BUILD, not a merge.
 *
 * WHY brokerage_settings.settings AND NOT A NEW TABLE: it is the live per-tenant
 * settings bag this repo already overrides policy in — same shape as the SURVIVOR
 * pattern at app/actions/vendor-verification.ts:238 (vendor_tier_pricing) and
 * app/actions/a2p-registration.ts:42. Nothing to migrate; an absent key simply means
 * "this brokerage has not overridden anything".
 *
 * FAIL CLOSED (CLAUDE.md §4). A REFUSED read is not "this brokerage has no override".
 * supabase-js resolves refusals, so the error is destructured and READ; on refusal —
 * or on a malformed value — the tighter DEFAULT_POLICY stands, which can only ever
 * hold a lead back for human/AI nurturing, never route one that should not have been.
 * Every field is validated on its own: one bad key cannot smuggle the rest of a
 * hand-edited jsonb blob past the gate, and it cannot silently loosen the gate either.
 */
async function resolveRoutingPolicy(
  brokerageId: string,
  supabase: any,
): Promise<RoutingPolicy> {
  if (!brokerageId || !supabase?.from) return DEFAULT_POLICY

  const { data, error } = await supabase
    .from('brokerage_settings')
    .select('settings')
    .eq('brokerage_id', brokerageId)
    .maybeSingle()

  if (error) {
    // Loud, and the strict default stands. A swallowed refusal here would read as
    // "the broker configured nothing", which is a claim we did not verify.
    console.error(
      `[LeadGovernance] routing-policy read REFUSED for brokerage ${brokerageId} — DEFAULT_POLICY stands:`,
      error.message,
    )
    return DEFAULT_POLICY
  }

  const settings = (data as { settings?: Record<string, unknown> } | null)?.settings
  const override = settings && typeof settings === 'object' ? (settings as any)[POLICY_SETTINGS_KEY] : null
  if (!override || typeof override !== 'object' || Array.isArray(override)) return DEFAULT_POLICY

  const o = override as Record<string, unknown>
  const resolved: RoutingPolicy = { ...DEFAULT_POLICY }

  if (typeof o.minimumScore === 'number' && Number.isFinite(o.minimumScore) && o.minimumScore >= 0 && o.minimumScore <= 100) {
    resolved.minimumScore = o.minimumScore
  }
  if (typeof o.requiresEmail === 'boolean') resolved.requiresEmail = o.requiresEmail
  if (typeof o.requiresPhone === 'boolean') resolved.requiresPhone = o.requiresPhone
  if (typeof o.requiresEnrichmentComplete === 'boolean') resolved.requiresEnrichmentComplete = o.requiresEnrichmentComplete
  if (Array.isArray(o.blockedStages) && o.blockedStages.every((s) => typeof s === 'string')) {
    resolved.blockedStages = o.blockedStages as string[]
  }

  return resolved
}

export async function evaluateRoutingEligibility(
  lead: any,
  leadScore: number,
  brokerageId: string,
  supabase: any,
  /**
   * An EXPLICIT policy from the caller always wins — it is how a simulator or a
   * preview asks "what would this exact policy decide". The default is now
   * `undefined` rather than DEFAULT_POLICY precisely so "the caller passed nothing"
   * is distinguishable from "the caller passed the default"; with the old default
   * the brokerage override could never have been consulted at all.
   */
  explicitPolicy?: RoutingPolicy
): Promise<RoutingDecision> {
  // THE ARGUMENTS ARE NOW READ. `policy` is the resolved, effective policy and it is
  // returned on every branch below, so the caller can see which rules actually decided.
  const policy = explicitPolicy ?? (await resolveRoutingPolicy(brokerageId, supabase))

  // Check blocked stages
  if (policy.blockedStages.includes(lead.lead_stage)) {
    return {
      eligible: false,
      reason: `Lead is in blocked stage: ${lead.lead_stage}`,
      policy,
      thresholdsMet: { stageAllowed: false },
      evaluatedAt: new Date().toISOString(),
    }
  }

  // Check score threshold
  const scoreToCheck = leadScore || lead.lead_score || 0
  if (scoreToCheck < policy.minimumScore) {
    return {
      eligible: false,
      reason: `Lead score ${scoreToCheck} below minimum ${policy.minimumScore}`,
      policy,
      thresholdsMet: { scoreThreshold: false },
      evaluatedAt: new Date().toISOString(),
    }
  }

  // Check enrichment status
  if (policy.requiresEnrichmentComplete && lead.enrichment_status !== 'complete') {
    return {
      eligible: false,
      reason: `Enrichment status is ${lead.enrichment_status}, not complete`,
      policy,
      thresholdsMet: { enrichmentComplete: false },
      evaluatedAt: new Date().toISOString(),
    }
  }

  // Check contact requirements
  if (policy.requiresEmail && !lead.email) {
    return {
      eligible: false,
      reason: 'Email required but missing',
      policy,
      thresholdsMet: { contactInfoPresent: false },
      evaluatedAt: new Date().toISOString(),
    }
  }

  if (policy.requiresPhone && !lead.phone) {
    return {
      eligible: false,
      reason: 'Phone required but missing',
      policy,
      thresholdsMet: { contactInfoPresent: false },
      evaluatedAt: new Date().toISOString(),
    }
  }

  // All criteria met
  return {
    eligible: true,
    reason: 'All routing criteria met',
    policy,
    thresholdsMet: {
      scoreThreshold: true,
      enrichmentComplete: true,
      contactInfoPresent: true,
      stageAllowed: true,
    },
    evaluatedAt: new Date().toISOString(),
  }
}
