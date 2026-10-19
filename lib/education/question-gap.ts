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

/**
 * Wave 142G — the PRODUCT lexicon: what people ask SUPPORT about (how the OS works), as opposed to the real-estate
 * lexicon above (what clients ask about the business). Support ticket subjects + descriptions are classified here;
 * a recurring product topic becomes a `support:<topic>` gap the curriculum author answers with a HELP ARTICLE /
 * walkthrough (channel article) instead of an agent course. Same honesty rules: fixed lexicon, first match wins, an
 * uncategorizable ticket is skipped, never force-fit; no LLM in the clustering.
 */
const PRODUCT_TOPIC_LEXICON: Array<{ topic: string; label: string; keywords: string[] }> = [
  { topic: "forms_esign", label: "sending forms for e-signature (FormWizard / e-sign)", keywords: ["e-sign", "esign", "e sign", "signature", "docusign", "dotloop", "skyslope", "form wizard", "formwizard", "forms"] },
  { topic: "cda", label: "the commission disbursement (CDA) workflow", keywords: ["cda", "commission disbursement", "disbursement"] },
  { topic: "offers", label: "creating and responding to offers", keywords: ["offer", "counter offer", "counteroffer"] },
  { topic: "listings", label: "listings and MLS sync", keywords: ["listing", "mls"] },
  { topic: "transactions", label: "transactions and closings in the OS", keywords: ["transaction", "closing checklist", "closing"] },
  { topic: "billing_seats", label: "billing, plans and seats", keywords: ["billing", "invoice", "seat", "subscription", "plan ", "charged", "payment"] },
  { topic: "website_domain", label: "your website and custom domain", keywords: ["website", "domain", "dns", "landing page"] },
  { topic: "phone_sms", label: "phone numbers, texting and A2P registration", keywords: ["phone number", "a2p", "10dlc", "sms", "text message", "texting", "caller id"] },
  { topic: "integrations", label: "connecting integrations and providers", keywords: ["integration", "connect", "api key", "crm", "zapier", "hubspot", "ghl", "gohighlevel", "oauth"] },
  { topic: "lead_magnets", label: "lead magnets, forms and QR capture", keywords: ["lead magnet", "qr", "form submission", "capture form", "magnet"] },
  { topic: "video", label: "videos, avatars and reels", keywords: ["video", "avatar", "reel", "render"] },
  { topic: "enrichment", label: "contact enrichment and skip tracing", keywords: ["enrichment", "enrich", "skip trace", "skip-trace"] },
  { topic: "login_access", label: "logging in, invitations and permissions", keywords: ["login", "log in", "password", "invite", "invitation", "permission", "access", "locked out"] },
  { topic: "education", label: "the academy and lessons", keywords: ["academy", "course", "lesson", "training"] },
  { topic: "ai_assistant", label: "the AI assistant and voice ISA", keywords: ["assistant", "ai isa", "voice", "copilot", "chatbot", "avatar chat"] },
]

/** PURE: classify a support question to a PRODUCT topic, or null when it matches no known topic. */
/** @proofSeam the proof classifies a how-to and an unrecognisable line directly */
export function classifySupportQuestion(text: string | null | undefined): { topic: string; label: string } | null {
  const t = (text ?? "").toLowerCase()
  if (t.trim().length < 8) return null
  for (const entry of PRODUCT_TOPIC_LEXICON) {
    if (entry.keywords.some((k) => t.includes(k))) return { topic: entry.topic, label: entry.label }
  }
  return null
}

interface RawSupportQuestion { subject: string; description?: string | null; ref?: string | null }

/**
 * PURE: cluster support tickets into `support:<topic>` GapSignals (source "support", recurrence-only like compliance
 * and questions). A topic must recur across at least `minAskers` tickets in the window; evidence = de-identified
 * subjects to ground the help article.
 */
export function buildSupportSignals(tickets: RawSupportQuestion[], opts: { minAskers?: number } = {}): GapSignal[] {
  const minAskers = opts.minAskers ?? QUESTION_MIN_ASKERS
  const byTopic = new Map<string, { label: string; count: number; evidence: string[] }>()
  for (const t of tickets) {
    const cls = classifySupportQuestion(`${t.subject ?? ""} ${t.description ?? ""}`)
    if (!cls) continue
    const e = byTopic.get(cls.topic) ?? { label: cls.label, count: 0, evidence: [] }
    e.count++
    if (e.evidence.length < 5) e.evidence.push((t.subject ?? "").trim().slice(0, 160))
    byTopic.set(cls.topic, e)
  }
  const signals: GapSignal[] = []
  for (const [topic, e] of byTopic) {
    if (e.count < minAskers) continue
    signals.push({
      topicKey: `support:${topic}`, topicLabel: e.label, source: "support",
      weakCount: e.count, totalCount: e.count, avgScore: null, evidence: e.evidence,
    })
  }
  return signals
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
