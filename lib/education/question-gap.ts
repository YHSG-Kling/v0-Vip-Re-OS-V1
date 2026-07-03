// lib/education/question-gap.ts
//
// QUESTION → CURRICULUM (recruiting_manager) — the education engine learns what to teach from what people
// actually ASK. Alongside objection-drill scores and compliance flags, the curriculum author now mines the
// recurring questions in the assistant/tutor logs: when the same topic gets asked again and again, that is
// a proven gap the OS should author a lesson for. The spec's high-frequency-question detection.
//
// HONEST + deterministic: questions are classified against a fixed real-estate topic lexicon (a coarse but
// real signal — an uncategorizable question is skipped, never force-fit), and a topic must recur across at
// least QUESTION_MIN_ASKERS distinct questions before it becomes a gap (a one-off is noise). No LLM in the
// clustering, so the loop is testable and free to run; the AUTHORING (a human-reviewed draft) reuses the
// existing curriculum author unchanged.

import type { GapSignal } from "@/lib/education/knowledge-gap-detector"

/** A topic must be asked this many times in the window before it warrants a lesson (spec: ~5/week). */
export const QUESTION_MIN_ASKERS = 5

/** Fixed real-estate topic lexicon: canonical topic → trigger keywords. First match wins (order = priority). */
const TOPIC_LEXICON: Array<{ topic: string; label: string; keywords: string[] }> = [
  { topic: "escrow", label: "how escrow works", keywords: ["escrow"] },
  { topic: "earnest_money", label: "earnest money", keywords: ["earnest"] },
  { topic: "appraisal", label: "the appraisal process", keywords: ["appraisal", "appraiser", "appraise"] },
  { topic: "inspection", label: "the inspection process", keywords: ["inspection", "inspector"] },
  { topic: "contingency", label: "contingencies", keywords: ["contingency", "contingencies"] },
  { topic: "closing_costs", label: "closing costs", keywords: ["closing cost", "closing costs"] },
  { topic: "clear_to_close", label: "clear to close / final week", keywords: ["clear to close", "final week", "closing disclosure"] },
  { topic: "pre_approval", label: "pre-approval vs pre-qualification", keywords: ["pre-approval", "preapproval", "pre approval", "pre-qual", "prequal"] },
  { topic: "underwriting", label: "loan underwriting", keywords: ["underwriting", "underwriter"] },
  { topic: "refinance", label: "refinancing", keywords: ["refinance", "refi"] },
  { topic: "commission", label: "commission (post-NAR)", keywords: ["commission", "nar settlement", "buyer agent comp"] },
  { topic: "title_insurance", label: "title & title insurance", keywords: ["title insurance", "title company", "title search"] },
  { topic: "hoa", label: "HOAs", keywords: ["hoa", "homeowners association", "home owners association"] },
  { topic: "property_tax", label: "property taxes & appeals", keywords: ["property tax", "tax appeal", "tax assessment"] },
  { topic: "insurance", label: "homeowners insurance", keywords: ["homeowners insurance", "home insurance", "hazard insurance"] },
  { topic: "buyer_agency", label: "buyer agency agreements", keywords: ["buyer agency", "agency agreement", "representation agreement"] },
  { topic: "offer_strategy", label: "offer & negotiation strategy", keywords: ["escalation clause", "highest and best", "multiple offer", "counteroffer", "counter offer"] },
  { topic: "wire_fraud", label: "wire fraud / safe closing funds", keywords: ["wire fraud", "wire instructions", "wiring money"] },
]

/** PURE: classify a free-text question to a canonical topic, or null when it matches no known topic. */
export function classifyQuestion(text: string | null | undefined): { topic: string; label: string } | null {
  const t = (text ?? "").toLowerCase()
  if (t.trim().length < 8) return null
  for (const entry of TOPIC_LEXICON) {
    if (entry.keywords.some((k) => t.includes(k))) return { topic: entry.topic, label: entry.label }
  }
  return null
}

export interface RawQuestion { text: string; ref?: string | null }

/**
 * PURE: cluster classified questions into GapSignals. A topic only becomes a signal when it recurs across at
 * least `minAskers` questions in the window. weakCount = the recurrence; avgScore null (recurrence-only, so
 * the detector treats it like compliance); evidence = de-identified sample questions to ground authoring.
 */
export function buildQuestionSignals(questions: RawQuestion[], opts: { minAskers?: number } = {}): GapSignal[] {
  const minAskers = opts.minAskers ?? QUESTION_MIN_ASKERS
  const byTopic = new Map<string, { label: string; count: number; evidence: string[] }>()
  for (const q of questions) {
    const cls = classifyQuestion(q.text)
    if (!cls) continue
    const e = byTopic.get(cls.topic) ?? { label: cls.label, count: 0, evidence: [] }
    e.count++
    if (e.evidence.length < 5) e.evidence.push(q.text.trim().slice(0, 160))
    byTopic.set(cls.topic, e)
  }
  const signals: GapSignal[] = []
  for (const [topic, e] of byTopic) {
    if (e.count < minAskers) continue
    signals.push({
      topicKey: `question:${topic}`, topicLabel: e.label, source: "question",
      weakCount: e.count, totalCount: e.count, avgScore: null, evidence: e.evidence,
    })
  }
  return signals
}
