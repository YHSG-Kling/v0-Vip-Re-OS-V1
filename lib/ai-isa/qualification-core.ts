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
  /** leads.timeline (e.g. 'immediate') — secondary urgency signal. */
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
 * Engine 2's assignment gate (assignment-engine Step 2): leads are ONLY assigned
 * after the AI ISA qualified them AND consent exists. Assignment then converts the
 * lead to a contact (handleLeadAssigned) per the canonical business process.
 */
export function engine2GatePasses(leadStage: string | null, lifecycleState: string | null): boolean {
  return leadStage === 'qualified' &&
    ['consented', 'qualified', 'assigned'].includes(lifecycleState ?? '')
}
