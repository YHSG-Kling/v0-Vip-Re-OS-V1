// lib/voice/call-coaching.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE COACHING RAIL'S MISSING WRITER.
//
// `call_coaching_insights` had SIX readers and ZERO writers (opposite-missing
// census, category 1b — every one of its columns listed):
//
//   app/dashboard/voice/isa/page.tsx:177          the ISA coaching card
//   app/dashboard/voice/isa/coaching-insights-panel.tsx:89  its dismiss action
//   app/dashboard/voice/review/[callId]/page.tsx:141        per-call review
//   app/dashboard/coaching/page.tsx (via app/actions/assistant.ts:633)
//   app/actions/weekly-insights.ts:228           "insights surfaced + acted on"
//   app/actions/smarter-this-week.ts:304-311     the week-over-week metric
//
// None of that renders an error when the table is empty: it renders "nothing to
// improve". An agent was being shown a clean bill of health by a panel that had
// never had anything to show, and the weekly metric reported a flat zero as if
// it had been measured.
//
// THIS IS NOT A SECOND EXTRACTOR. The facts below are already produced by the
// call analysers — objections, coaching score, sentiment, urgency — and this
// module only PROJECTS them into the typed, prioritised, dismissible row shape
// the panels read. Nothing here calls a model, so a coaching insight can never
// say something the analysis did not. A fact that is absent produces no insight
// rather than a zero.
//
// WHY HERE AND NOT ON A CRON: the fact becomes known the moment a call analysis
// completes. Both analysers call `writeCallCoachingInsights` at that moment —
// the autonomous sweep (lib/voice/call-analysis.ts) and the on-demand analyser
// (app/actions/ai-voice-transcription.ts) — so the vocabulary cannot fork per
// lane (§6).
//
// VOCABULARY: `insight_type` and `priority` are live CHECK constraints, cached
// at scripts/check-vocabularies.ts:385-388. A value outside them is refused
// ENTIRELY (23514 — not "most of the row": nothing, the §3 trap), so the unions
// below are the constraint, not a preference.
// ─────────────────────────────────────────────────────────────────────────────

/** call_coaching_insights.insight_type CHECK (live, scripts/check-vocabularies.ts:386). */
export const COACHING_INSIGHT_TYPES = [
  "closing",
  "improvement",
  "objection_handling",
  "rapport",
  "strength",
] as const
export type CoachingInsightType = (typeof COACHING_INSIGHT_TYPES)[number]

/** call_coaching_insights.priority CHECK (live, scripts/check-vocabularies.ts:387). */
export const COACHING_PRIORITIES = ["high", "medium", "low"] as const
export type CoachingPriority = (typeof COACHING_PRIORITIES)[number]

export interface DerivedCoachingInsight {
  insight_type: CoachingInsightType
  priority: CoachingPriority
  /** The agent-facing sentence. Grounded in the analysis — never invented. */
  content: string
}

/** The analysis facts a coaching insight can be grounded in. Every field is
 *  optional because both analysers produce a different subset, and a missing
 *  fact must produce NO insight rather than a default one. */
export interface CoachingSourceFacts {
  /** Concerns/pushback the caller voiced (call_analyses.objections). */
  objections?: string[] | null
  /** 0-100: did the conversation serve the caller (call_analyses.coaching_score). */
  coachingScore?: number | null
  /** call_analyses.sentiment — the CHECK vocabulary is positive|neutral|negative|mixed. */
  sentiment?: string | null
  /** 0-100: how soon the caller intends to act (call_analyses.urgency_score). */
  urgencyScore?: number | null
  /** The next action the analysis suggested (call_analyses.suggested_next_action). */
  suggestedNextAction?: string | null
  /** Free-text coaching notes the on-demand analyser already produces. */
  coachingOpportunities?: string[] | null
}

/** A conversation scoring at or below this served the caller poorly enough that
 *  the improvement note leads the agent's list. Same 0-100 scale the analyser
 *  writes (lib/voice/call-analysis.ts VoiceIntelSchema.coachingScore). */
export const COACHING_SCORE_POOR = 60
/** At or above this the call is worth naming as a STRENGTH — coaching that only
 *  ever criticises stops being read. */
export const COACHING_SCORE_STRONG = 85
/** A caller this urgent makes securing the next step the coaching point. */
export const COACHING_URGENCY_CLOSING = 70
/** Cap per analysis. A wall of notes is the same non-signal as an empty panel. */
export const MAX_INSIGHTS_PER_ANALYSIS = 5

function clean(s: unknown): string {
  return typeof s === "string" ? s.trim() : ""
}

/**
 * PURE: analysis facts → typed coaching insights. Exported so a simulator can
 * drive it with no database.
 *
 * Every branch is grounded in a fact the analysis actually recorded. A call
 * with no objections, a mid-range coaching score, neutral sentiment and no
 * urgency yields ZERO insights — which is the honest reading, and different
 * from the old permanent zero because it is now a measurement.
 *
 * NOT EXPORTED: writeCallCoachingInsights below is this module's door, and both
 * analyser lanes reach the derivation through it. Exporting the pure half as
 * well would claim a second entry point nobody uses — the shape
 * orphan-export-guard raises as an unfinished feature. If a proof is ever
 * written for these branches it should export it THEN, with the proof, rather
 * than leave the keyword standing as an IOU.
 */
function deriveCoachingInsights(facts: CoachingSourceFacts): DerivedCoachingInsight[] {
  const out: DerivedCoachingInsight[] = []

  // ── OBJECTIONS → objection_handling ──────────────────────────────────────
  // The caller's own words are quoted back; nothing is characterised for them.
  const objections = (facts.objections ?? []).map(clean).filter(Boolean)
  if (objections.length > 0) {
    out.push({
      insight_type: "objection_handling",
      // Three or more objections in one call is the pattern worth interrupting
      // a day for; one is worth noting.
      priority: objections.length >= 3 ? "high" : "medium",
      content:
        objections.length === 1
          ? `They pushed back on: "${objections[0]}". Prepare an answer before the next contact.`
          : `They raised ${objections.length} concerns: ${objections.slice(0, 4).map((o) => `"${o}"`).join(" · ")}. Work the objections in that order.`,
    })
  }

  // ── COACHING SCORE → improvement / strength ──────────────────────────────
  const score = typeof facts.coachingScore === "number" ? facts.coachingScore : null
  if (score != null && score <= COACHING_SCORE_POOR) {
    out.push({
      insight_type: "improvement",
      priority: score <= COACHING_SCORE_POOR / 2 ? "high" : "medium",
      content: `This call scored ${Math.round(score)}/100 on serving the caller — questions answered, clarity, and a next step secured. Listen back to the last minute: that is where the next step is usually lost.`,
    })
  } else if (score != null && score >= COACHING_SCORE_STRONG) {
    out.push({
      insight_type: "strength",
      priority: "low",
      content: `Strong call — ${Math.round(score)}/100 on serving the caller. Whatever you did in the close is worth repeating.`,
    })
  }

  // ── SENTIMENT → rapport ──────────────────────────────────────────────────
  // Only NEGATIVE earns a rapport note. 'mixed' and 'neutral' are not a problem
  // to coach, and treating them as one is how a panel becomes noise.
  if (clean(facts.sentiment).toLowerCase() === "negative") {
    out.push({
      insight_type: "rapport",
      priority: "high",
      content: "The caller left this conversation negative. Open the next contact by naming what frustrated them rather than moving straight to business.",
    })
  }

  // ── URGENCY → closing ────────────────────────────────────────────────────
  const urgency = typeof facts.urgencyScore === "number" ? facts.urgencyScore : null
  if (urgency != null && urgency >= COACHING_URGENCY_CLOSING) {
    const next = clean(facts.suggestedNextAction)
    out.push({
      insight_type: "closing",
      priority: urgency >= 85 ? "high" : "medium",
      content: next
        ? `They intend to act soon (urgency ${Math.round(urgency)}/100). The analysis's next step: ${next}`
        : `They intend to act soon (urgency ${Math.round(urgency)}/100). Secure a dated next step on the next contact, not a "we'll be in touch".`,
    })
  }

  // ── FREE-TEXT COACHING NOTES → improvement ───────────────────────────────
  // The on-demand analyser (app/actions/ai-voice-transcription.ts) already
  // produces these as prose and wrote them ONLY into the
  // call_analyses.coaching_opportunities blob, which no coaching surface reads.
  // They arrive typed here instead of being extracted a second time.
  for (const note of (facts.coachingOpportunities ?? []).map(clean).filter(Boolean)) {
    out.push({ insight_type: "improvement", priority: "medium", content: note })
  }

  // Highest priority first, then insertion order — the panels order by
  // created_at and the review page orders by priority, so a stable ranking here
  // is what makes both agree.
  const rank: Record<CoachingPriority, number> = { high: 0, medium: 1, low: 2 }
  return out
    .sort((a, b) => rank[a.priority] - rank[b.priority])
    .slice(0, MAX_INSIGHTS_PER_ANALYSIS)
}

export interface WriteCoachingResult {
  written: number
  skipped: boolean
  error?: string
}

/**
 * THE one writer of `call_coaching_insights`.
 *
 * IDENTITY: `agent_id` is AGENTS-class — `cci_agent_id_fkey` references
 * agents(id) (verified live), and every reader filters it with the agents.id
 * `getAgentContext()` returns (app/dashboard/voice/isa/page.tsx:36-42 states the
 * disjointness in capitals). A users.id here is 23503 and, because supabase-js
 * RESOLVES a refusal, would look exactly like a successful write.
 *
 * `agent_id`, `brokerage_id`, `call_analysis_id` and `content` are all NOT NULL,
 * so a call with no resolved agent writes NOTHING rather than a partial row —
 * an untenanted or unattributed coaching note would surface on somebody else's
 * board.
 *
 * IDEMPOTENT per analysis: the sweep re-runs hourly and the review page can be
 * re-analysed, so an existing row for this `call_analysis_id` means the insights
 * for this call are already recorded and this call is a no-op. Nothing here
 * updates, so a dismissed insight can never resurrect.
 */
export async function writeCallCoachingInsights(
  svc: any,
  params: {
    callAnalysisId: string
    brokerageId: string | null | undefined
    /** agents.id — NOT users.id. See above. */
    agentId: string | null | undefined
    facts: CoachingSourceFacts
  },
): Promise<WriteCoachingResult> {
  const { callAnalysisId, brokerageId, agentId } = params
  if (!callAnalysisId || !brokerageId || !agentId) {
    // Not a failure — an unattributed call genuinely has no agent to coach.
    return { written: 0, skipped: true }
  }

  const insights = deriveCoachingInsights(params.facts)
  if (insights.length === 0) return { written: 0, skipped: true }

  // supabase-js RESOLVES a refused read, so `error` is the only thing that tells
  // "already written" apart from "we were not allowed to look" — and the two
  // must not both mean "skip", or a refusal would silently suppress the write.
  const { data: existing, error: dupError } = await svc
    .from("call_coaching_insights")
    .select("id")
    .eq("call_analysis_id", callAnalysisId)
    .limit(1)
  if (dupError) return { written: 0, skipped: false, error: `dedupe read refused: ${dupError.message}` }
  if ((existing ?? []).length > 0) return { written: 0, skipped: true }

  const rows = insights.map((i) => ({
    call_analysis_id: callAnalysisId,
    brokerage_id: brokerageId,
    agent_id: agentId,
    insight_type: i.insight_type,
    priority: i.priority,
    content: i.content.slice(0, 2000),
    dismissed: false,
  }))

  const { data: inserted, error } = await svc
    .from("call_coaching_insights")
    .insert(rows)
    .select("id")
  if (error) return { written: 0, skipped: false, error: error.message }
  return { written: (inserted ?? []).length, skipped: false }
}
