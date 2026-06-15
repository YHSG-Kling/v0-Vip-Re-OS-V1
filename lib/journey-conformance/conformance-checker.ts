// lib/journey-conformance/conformance-checker.ts
//
// JOURNEY-CONFORMANCE MONITOR — the live-data proof that the AI team provably FOLLOWS its own
// constitutional business process (JOURNEY_PROGRESS_CONTRACT). The legal-transition map +
// hard gates are ENFORCED only by convention today (validateStateTransition validates, callers
// must honor it; admin overrides skip it). NOTHING audits, after the fact, that every entity's
// ACTUAL transition history obeyed the contract. This is that audit — the live-data sibling of the
// governance egress_coverage_audit. It REPLAYS a transition history against the legal order + hard
// gates and reports violations; it does NOT re-implement the state machine (the legal map + gated
// states are passed IN, built from the canonical lifecycle definitions by the runner).
//
// PURE — no I/O. An authorized OVERRIDE is a legal exception (the contract permits it with a reason),
// so it is NOTED, never counted a violation; the absence of one is the violation.

export interface JourneyTransition {
  from: string
  to: string
  at?: string
  /** True when this was an authorized admin/broker override (logged with a reason). */
  override?: boolean
}

export type ViolationType = "illegal_transition" | "gate_bypassed"

export interface ConformanceViolation {
  type: ViolationType
  from: string
  to: string
  at?: string
  reason: string
}

export interface ConformanceResult {
  compliant: boolean
  violations: ConformanceViolation[]
  /** Authorized overrides used (legal exceptions — surfaced for visibility, not violations). */
  overridesUsed: number
  transitionsChecked: number
}

export interface ConformanceConfig {
  /** state → the legal predecessor states (BUYER_LIFECYCLE_STATES[].allowedFrom). */
  legalMap: Record<string, string[]>
  /** states that require the hard gate to have been passed first. */
  gatedStates: Set<string>
  /** the state whose attainment satisfies the gate (e.g. BUYER_FINANCIALLY_VERIFIED). */
  gateSatisfiedState: string
}

/**
 * Pure: replay an ordered transition history against the contract. A transition violates the
 * contract when (a) `to` is not reachable from `from` per the legal map, or (b) `to` is gated and
 * the gate-satisfying state was never reached beforehand. Authorized overrides bypass BOTH checks
 * (a logged exception) but are counted so the broker sees how often the rails were skipped.
 */
export function checkJourneyConformance(
  transitions: JourneyTransition[],
  config: ConformanceConfig,
): ConformanceResult {
  const violations: ConformanceViolation[] = []
  const reached = new Set<string>()
  let overridesUsed = 0

  // Seed with the very first "from" — the entity's starting state.
  if (transitions[0]?.from) reached.add(transitions[0].from)

  for (const t of transitions) {
    if (t.override) {
      overridesUsed++
      reached.add(t.to)
      continue
    }

    // (a) Legal order — only check states we actually have a rule for.
    const legalFrom = config.legalMap[t.to]
    if (legalFrom && !legalFrom.includes(t.from)) {
      violations.push({
        type: "illegal_transition", from: t.from, to: t.to, at: t.at,
        reason: `illegal skip: ${t.to} can only follow [${legalFrom.join(", ")}], not ${t.from}`,
      })
    }

    // (b) Hard gate — the gated state requires the gate-satisfying state to have been reached first.
    if (config.gatedStates.has(t.to) && !reached.has(config.gateSatisfiedState)) {
      violations.push({
        type: "gate_bypassed", from: t.from, to: t.to, at: t.at,
        reason: `hard gate bypassed: reached ${t.to} without first passing ${config.gateSatisfiedState}`,
      })
    }

    reached.add(t.to)
  }

  return { compliant: violations.length === 0, violations, overridesUsed, transitionsChecked: transitions.length }
}
