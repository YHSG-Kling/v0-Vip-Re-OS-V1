// lib/lead-pipeline/source-wording-diagnostic.ts
//
// SOURCE WORDING-vs-QUALITY DIAGNOSTIC (pure). Before ever downranking a lead source by outcomes,
// answer the question that actually matters: is the source BAD, or is our COPY not landing? A
// great source with a weak opener looks identical to a bad source if you only watch reply rates —
// and downranking it would throw away good leads over a fixable wording problem.
//
// The discriminator: ENGAGEMENT (do they open/reply to our touches?) vs DOWNSTREAM CONVERSION (when
// they DO engage, do they progress to appointments/closings?).
//   • low engagement + HEALTHY downstream  → the source produces good leads; the COPY isn't landing
//                                            → WORDING issue → test different copy (NOT downrank)
//   • low engagement + LOW downstream       → the leads themselves don't convert → SOURCE quality
//   • leads arrive but don't qualify to contacts → TARGETING issue
//   • everything healthy                    → keep as is
//
// ADVISORY ONLY — emits a verdict + recommendation; never auto-downranks. Pure (no I/O), so the
// discrimination logic is unit-tested directly.

export type SourceVerdict = "wording_issue" | "source_quality_issue" | "targeting_issue" | "healthy" | "insufficient_data"
export type SourceRecommendation = "test_different_copy" | "test_cadence" | "downrank" | "keep_as_is" | "gather_more_data"

export interface SourceDiagnosticInput {
  /** Funnel rates for THIS source (0–100), from source-analytics. */
  leadToContactRate: number | null
  contactToApptRate: number | null
  closeRate: number | null
  /** Engagement on our reactivation/nurture touches to this source's people (0–1). */
  earlyStepOpenRate: number | null   // step 1–2 opens / sent
  earlyStepReplyRate: number | null  // step 1–2 replies / sent
  /** How many touches we've actually sent — guards against judging on tiny samples. */
  sentVolume: number
  /** Brokerage-wide medians to compare against (so "low" is relative, not absolute). */
  benchmarks: {
    leadToContactRate: number
    contactToApptRate: number
    earlyStepReplyRate: number
  }
  /** Minimum touches before we'll diagnose (avoid noise). */
  minVolume?: number
}

export interface SourceDiagnostic {
  verdict: SourceVerdict
  recommendation: SourceRecommendation
  why: string
}

const DEFAULT_MIN_VOLUME = 25

/** Decide whether a source's poor outcomes are a WORDING problem (fixable) or a SOURCE problem. Pure. */
export function diagnoseSource(input: SourceDiagnosticInput): SourceDiagnostic {
  const minVol = input.minVolume ?? DEFAULT_MIN_VOLUME
  if (input.sentVolume < minVol) {
    return { verdict: "insufficient_data", recommendation: "gather_more_data", why: `only ${input.sentVolume} touches sent (< ${minVol}) — not enough signal to judge source vs wording` }
  }

  const b = input.benchmarks
  const replyRate = input.earlyStepReplyRate ?? 0
  const lowEngagement = replyRate < b.earlyStepReplyRate * 0.5 // < half the brokerage median reply rate
  // Downstream health: when people from this source DO engage, do they convert? Use the funnel
  // stages AFTER first contact (contact→appt, close) — these reflect lead QUALITY, not our copy.
  const contactToAppt = input.contactToApptRate ?? 0
  const close = input.closeRate ?? 0
  const downstreamHealthy = contactToAppt >= b.contactToApptRate * 0.8 || close > 0
  const leadToContact = input.leadToContactRate ?? 0
  const qualifies = leadToContact >= b.leadToContactRate * 0.6

  if (!lowEngagement) {
    return { verdict: "healthy", recommendation: "keep_as_is", why: `early-step reply rate (${(replyRate * 100).toFixed(1)}%) is near/above benchmark — copy is landing` }
  }

  // Low engagement from here on — distinguish the cause.
  if (downstreamHealthy && qualifies) {
    return {
      verdict: "wording_issue",
      recommendation: "test_different_copy",
      why: `low early-step replies (${(replyRate * 100).toFixed(1)}% vs ${(b.earlyStepReplyRate * 100).toFixed(1)}% benchmark) BUT downstream conversion is healthy (contact→appt ${contactToAppt}%, close ${close}%) — the leads are good, the opener isn't landing. Test a different copy angle, don't downrank.`,
    }
  }
  if (!qualifies) {
    return {
      verdict: "targeting_issue",
      recommendation: "test_cadence",
      why: `leads from this source rarely qualify to contacts (${leadToContact}% vs ${b.leadToContactRate}% benchmark) — a targeting/cadence mismatch more than pure copy. Adjust cadence/qualification before judging the source.`,
    }
  }
  // Low engagement AND weak downstream → the leads themselves don't convert.
  return {
    verdict: "source_quality_issue",
    recommendation: "downrank",
    why: `low engagement (${(replyRate * 100).toFixed(1)}% reply) AND weak downstream conversion (contact→appt ${contactToAppt}%, close ${close}%) — those who engage still don't convert, so it's the source, not the copy. Candidate to downrank (human decision).`,
  }
}
