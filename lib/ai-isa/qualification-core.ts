// lib/ai-isa/qualification-core.ts
//
// AI ISA — the PURE qualification core. Single source of truth for the decisions
// that drive the qualify → assign → convert chain:
//
//   conversation signal → lead_temperature + lead_score   (mark_qualification tool)
//   message analysis    → QualificationSignals            (evaluateLeadQualification)
//   signals             → qualification score + readiness (persistQualificationSignals)
//   lead state          → Engine 2 assignment gate        (assignment-engine)
//
// Extracted so the ISA conversation tool and the qualification evaluator share ONE
// definition (they had drifted: the tool wrote a phantom qualification_signal column
// while the evaluator owned the real chain), and so the data-steward-style simulator
// can regression-test the whole decision surface without DB or AI calls.
// No server imports — runs under plain tsx.

export type ISAQualSignal = 'hot' | 'warm' | 'cold' | 'unqualified'

/** Conversation signal → rolling lead_score (readinessForAgent requires >= 50). */
export function signalScore(signal: ISAQualSignal): number {
  return signal === 'hot' ? 90 : signal === 'warm' ? 60 : signal === 'cold' ? 30 : 10
}

/** Conversation signal → leads.lead_temperature (check allows hot|warm|cold|NULL).
 *  'unqualified' maps to NULL — the score (10) + the activities log carry the verdict. */
export function signalTemperature(signal: ISAQualSignal): 'hot' | 'warm' | 'cold' | null {
  return signal === 'unqualified' ? null : signal
}

export interface QualificationSignals {
  confirmedIntent: boolean
  urgency: 'high' | 'medium' | 'low'
  readinessForAgent: boolean
  conversationCount: number
  engagementLevel: 'high' | 'medium' | 'low'
}

const INTENT_KEYWORDS = ['ready', 'interested', 'looking', 'want to', 'need to', 'schedule', 'meet']
const URGENCY_KEYWORDS = ['asap', 'urgent', 'soon', 'quickly', 'immediately', 'this week', 'this month']

/**
 * Derive qualification signals from the conversation state. Mirrors (and now owns)
 * the logic the evaluator runs after loading the lead + messages from the DB.
 */
export function deriveQualificationSignals(input: {
  /** Recent messages joined to one lowercase string. */
  messageText: string
  conversationCount: number
  /**
   * `leads.timeline` — secondary urgency signal. The vocabulary is
   * constants/crm-standards.ts:STANDARD_TIMELINES, and the column now carries
   * the matching live CHECK (m487). Typed `string | null` rather than
   * `StandardTimeline | null` on purpose: this is the raw column value and rows
   * written before that CHECK existed may still be free text.
   */
  timeline?: string | null
  /** Rolling leads.lead_score — the conversation tool keeps this current. */
  leadScore?: number | null
}): QualificationSignals {
  const text = input.messageText.toLowerCase()

  const confirmedIntent = INTENT_KEYWORDS.some((k) => text.includes(k))
  const urgency: QualificationSignals['urgency'] =
    URGENCY_KEYWORDS.some((k) => text.includes(k)) ? 'high'
    : input.timeline === 'immediate' ? 'high'
    : 'medium'
  const engagementLevel: QualificationSignals['engagementLevel'] =
    input.conversationCount >= 3 ? 'high' : input.conversationCount >= 1 ? 'medium' : 'low'

  // Readiness = the handoff trigger: intent + urgency + engagement + a rolling score
  // that has actually persisted (>= 50 — why the phantom score write starved the chain).
  const readinessForAgent =
    confirmedIntent &&
    (urgency === 'high' || urgency === 'medium') &&
    engagementLevel !== 'low' &&
    (input.leadScore ?? 0) >= 50

  return {
    confirmedIntent,
    urgency,
    readinessForAgent,
    conversationCount: input.conversationCount,
    engagementLevel,
  }
}

/** Signals → ai_isa_qualifications.qualification_score. */
export function qualificationScoreFor(signals: QualificationSignals): number {
  return signals.readinessForAgent ? 85
    : signals.confirmedIntent ? 60
    : signals.urgency === 'high' ? 45
    : 25
}

/**
 * VOICE channel → rolling signal. A call's analyzed outcome maps onto the same
 * hot/warm/cold/unqualified vocabulary the email ISA's mark_qualification tool
 * uses, so voice conversations feed the identical readiness + Engine 2 inputs.
 */
export function voiceSignalFor(input: {
  urgencyScore: number
  isPositiveOutcome: boolean
  isNegativeOutcome: boolean
}): ISAQualSignal {
  if (input.isNegativeOutcome) return 'unqualified'
  if (input.urgencyScore >= 70 || input.isPositiveOutcome) return 'hot'
  if (input.urgencyScore >= 45) return 'warm'
  return 'cold'
}

// ─── REMOVED — `engine2GatePasses` ──────────────────────────────────────────
//
// SURVIVOR: lib/lead-assignment/rule-matcher.ts evaluateAssignmentEligibility,
// which BOTH assignment doors now call — the automatic path
// (lib/lead-assignment/tier-routing.ts) and the admin-manual path
// (app/actions/lead-assignment/assign-lead.ts manualAssignLead).
//
// This was a third copy of the gate, and it did not merely duplicate the rule —
// it CONTRADICTED it. The owner ruled that a lead may be assigned when it has
// been qualified **OR** carries positive intent; this copy was the pre-ruling
// AND (`qualified` AND consented), so a lead the ruling makes assignable was
// refused by it. It also admitted a `lifecycleState` of 'qualified', which the
// live leads_lifecycle_state_check has never permitted — that branch could
// never fire against a real row.
//
// It was safe only by accident: it had zero production callers, and the two
// simulators that named it were the only reason it survived earlier sweeps. A
// dormant gate that disagrees with the live one is a trap for the next person
// who wires it, which is why this is a deletion and not a second edit.
//
// Nothing is lost. Everything this expressed, the survivor expresses more
// completely and in one place, with each of the eight legal lifecycle_state
// values classified explicitly rather than by an inclusion list.
