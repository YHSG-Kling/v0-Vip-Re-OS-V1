/**
 * lib/forms/intake-from-notes.ts — THE FORMWIZARD COACH LISTENS: "describe the deal in your own words".
 *
 * Owner (wave 142/143): the FormWizard's AI "asks 'listing forms or an offer?', gathers specifics
 * conversationally … clarify, identify forms from approved packets/providers, explain requirements, detect
 * missing info, prefill verified fields, guide human review … never invents legal terms, signatures or
 * material facts." The spine (lib/forms/form-wizard-sequence.ts) already asks the questions and explains each
 * one in scripted coach lines. This adds the conversational half: the agent types or dictates what they know
 * ("cash offer at $400,000, $5,000 earnest, ten day inspection, close December 1st"), and the coach SUGGESTS
 * answers to the intake questions for the agent to confirm. It never applies one itself.
 *
 * THE SAME SHAPE AS THE ONE NATURAL-LANGUAGE PARSER ALREADY HERE (lib/buyer-search/parse-buyer-criteria.ts,
 * lane 91C): deterministic RULES first, a routed MODEL ASSIST for what the rules left open, and a VERIFIER that
 * every proposal passes before the agent sees it. The model is never trusted — it can only propose, and a
 * proposal survives only if the agent's OWN WORDS back it:
 *
 *   · the key must be one of the purpose's intake questions;
 *   · it carries an EVIDENCE quote that must appear in the agent's notes (whitespace/case-normalised);
 *   · a number must be a number the evidence states (400k, $400,000 and 400000 are the same figure; a figure the
 *     model computed is not in the evidence and is dropped);
 *   · a date must be an explicit calendar date in the evidence — "in 30 days" is NEVER turned into a date;
 *   · a text answer (special terms, compensation) must be a verbatim span of the notes — the coach does not write
 *     contract language;
 *   · a choice must be one of the question's options and be named in the evidence.
 *
 * What the coach may not do, by construction: author a price, a date, a party, a legal term or a signature. It
 * transcribes what the agent said into the question it answers, shows the quote it relied on, and waits for a
 * person. Spend is booked through generateObjectRouted (fair-use pre-flight, ai_tool_usage ledger) on the
 * existing `offer_data_extraction` routing key — no new model route, no new vendor.
 */

import { z } from "zod"
import { LISTING_INTAKE, OFFER_INTAKE, type FormWizardPurpose, type IntakeQuestion } from "./form-wizard-sequence"

export const INTAKE_NOTES_MAX_CHARS = 1500

export interface IntakeProposal {
  key: string
  /** The question as the agent saw it — so the suggestion reads in context. */
  label: string
  value: string | number | boolean
  /** The value as a person reads it ("$400,000", "Cash", "2026-12-01"). */
  display: string
  /** The agent's own words this rests on, verbatim. */
  evidence: string
  via: "rules" | "model"
}

export interface IntakeSuggestion {
  proposals: IntakeProposal[]
  /** Proposals the verifier refused, and why — shown so a person can see the coach did not guess. */
  dropped: Array<{ key: string; reason: string }>
  via: "rules" | "rules+model"
  notes: string[]
}

type Raw = { key: string; value: unknown; evidence: string }

const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim()
const questionsFor = (purpose: FormWizardPurpose): readonly IntakeQuestion[] => (purpose === "listing" ? LISTING_INTAKE : OFFER_INTAKE)

// ── Figures and dates, as the evidence states them ───────────────────────────────────

/** Every figure in a span of text: 400000, $400,000, 400k, 1.2m, 10. (A figure the span does not contain is not evidence.) */
function figuresIn(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(/\$?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?([km])?\b/gi)) {
    const base = Number(m[1].replace(/,/g, ""))
    if (!Number.isFinite(base)) continue
    out.push(m[2] ? base * (m[2].toLowerCase() === "k" ? 1_000 : 1_000_000) : base)
  }
  return out
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]

/** Explicit calendar dates in a span → YYYY-MM-DD. Relative phrases ("in 30 days", "end of month") are not dates. */
function datesIn(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) out.push(`${m[1]}-${m[2]}-${m[3]}`)
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) out.push(`${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`)
  for (const m of text.matchAll(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/gi)) {
    out.push(`${m[3]}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`)
  }
  return out
}

/** What an agent's words must be ABOUT for the coach to propose a yes / no. Keys with no entry are never answered by the coach. */
const BOOLEAN_CUES: Readonly<Record<string, RegExp>> = {
  appraisal_contingency: /apprais/i,
  sale_of_buyer_home: /(sell|sale|selling|sold)\b.{0,40}\b(home|house|property)|home[- ]sale|contingen\w*.{0,30}\bsale\b/i,
  escalation_clause: /escalat/i,
  pre_1978: /built|year built|1978|lead[- ]?paint|\b(18|19)\d{2}\b/i,
  hoa: /\bhoa\b|homeowners?'?s?[- ]association|condo\w*|\bassociation\b/i,
  list_price_confirmed: /list(ing)?[- ]price|asking price/i,
  seller_disclosures_ready: /disclosure/i,
}

// ── The verifier (PURE): nothing reaches the agent that their own words do not back ──────

function show(q: IntakeQuestion, v: string | number | boolean): string {
  if (q.kind === "number" && typeof v === "number") return /price|earnest|payment|credit|cap|fee|amount/i.test(q.key) ? `$${v.toLocaleString("en-US")}` : String(v)
  if (q.kind === "select") return q.options?.find((o) => o.value === v)?.label ?? String(v)
  if (q.kind === "boolean") return v === true ? "Yes" : "No"
  return String(v)
}

function verifyProposals(purpose: FormWizardPurpose, notes: string, raw: readonly Raw[], via: IntakeProposal["via"]): { proposals: IntakeProposal[]; dropped: Array<{ key: string; reason: string }> } {
  const proposals: IntakeProposal[] = []
  const dropped: Array<{ key: string; reason: string }> = []
  const body = normalise(notes)
  const seen = new Set<string>()
  for (const r of raw) {
    const q = questionsFor(purpose).find((x) => x.key === r.key)
    if (!q) { dropped.push({ key: String(r.key), reason: "not a question this form asks" }); continue }
    if (seen.has(q.key)) continue
    const evidence = String(r.evidence ?? "").trim().slice(0, 240)
    if (!evidence || !body.includes(normalise(evidence))) { dropped.push({ key: q.key, reason: "the quoted evidence is not in your notes" }); continue }
    let value: string | number | boolean | null = null
    let why = ""
    if (q.kind === "number") {
      const n = typeof r.value === "number" ? r.value : Number(String(r.value).replace(/[$,\s]/g, ""))
      if (!Number.isFinite(n)) why = "not a number"
      else if (!figuresIn(evidence).some((f) => Math.abs(f - n) < 0.5)) why = "that figure is not stated in the evidence (the coach does not calculate)"
      else value = n
    } else if (q.kind === "date") {
      const d = typeof r.value === "string" ? r.value : ""
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) why = "not a calendar date"
      else if (!datesIn(evidence).includes(d)) why = "no explicit calendar date in the evidence (a relative date is never computed)"
      else value = d
    } else if (q.kind === "boolean") {
      // A yes / no is the easiest answer for a model to fabricate from an unrelated quote, so it is held to a CUE:
      // the evidence must be about THIS question. A question with no cue defined cannot be answered by the coach.
      const cue = BOOLEAN_CUES[q.key]
      if (typeof r.value !== "boolean") why = "not yes / no"
      else if (!cue) why = "the coach does not answer this yes / no question — it is the agent's call"
      else if (!cue.test(evidence)) why = "the evidence is not about this question"
      else if (q.key === "pre_1978") {
        const year = /\b(1[89]\d{2}|20\d{2})\b/.exec(evidence)?.[1]
        if (year && (Number(year) < 1978) !== r.value) why = "the year in the evidence contradicts that answer"
        else value = r.value
      } else value = r.value
    } else if (q.kind === "select") {
      const opt = q.options?.find((o) => o.value === r.value)
      const ev = normalise(evidence)
      const named = opt && (ev.includes(opt.value.toLowerCase()) || opt.label.toLowerCase().split(/[^a-z0-9]+/).some((t) => t.length >= 3 && ev.includes(t)))
      if (!opt) why = "not one of the options"
      else if (!named) why = "the evidence does not name that option"
      else value = opt.value
    } else {
      const text = typeof r.value === "string" ? r.value.trim() : ""
      if (!text || text.length > 500) why = "empty or too long"
      else if (!body.includes(normalise(text))) why = "free text must be a verbatim span of your notes — the coach does not write contract language"
      else value = text
    }
    if (value === null) { dropped.push({ key: q.key, reason: why }); continue }
    seen.add(q.key)
    proposals.push({ key: q.key, label: q.prompt, value, display: show(q, value), evidence, via })
  }
  return { proposals, dropped }
}

// ── Rules first (PURE): the obvious things, with their quotes ────────────────────────

const quoteAround = (text: string, index: number, length: number) => text.slice(Math.max(0, index - 25), Math.min(text.length, index + length + 25)).trim()

function extractByRules(purpose: FormWizardPurpose, notes: string): Raw[] {
  if (purpose !== "offer") return []
  const out: Raw[] = []
  const text = notes
  const fin = /\b(all[- ]cash|cash offer|cash purchase|paying cash|\bcash\b)/i.exec(text)
  if (fin) out.push({ key: "financing_type", value: "cash", evidence: quoteAround(text, fin.index, fin[0].length) })
  else {
    const kinds: Array<[RegExp, string]> = [[/\bfha\b/i, "fha"], [/\bva (loan|financing|mortgage)\b|\bveteran'?s? (loan|affairs)\b/i, "va"], [/\busda\b/i, "usda"], [/\bconventional\b/i, "conventional"]]
    for (const [re, value] of kinds) { const m = re.exec(text); if (m) { out.push({ key: "financing_type", value, evidence: quoteAround(text, m.index, m[0].length) }); break } }
  }
  const insp = /(\d{1,2})[- ]day(?:s)?\s+(?:home\s+)?inspection|inspection(?:\s+period)?(?:\s+of)?\s+(\d{1,2})\s+days?/i.exec(text)
  if (insp) out.push({ key: "inspection_period_days", value: Number(insp[1] ?? insp[2]), evidence: quoteAround(text, insp.index, insp[0].length) })
  const earnest = /(\$?\s?\d[\d,]*(?:\.\d+)?\s?k?)\s+(?:earnest(?:\s+money)?|deposit)|(?:earnest(?:\s+money)?|deposit)(?:\s+of)?\s+(\$?\s?\d[\d,]*(?:\.\d+)?\s?k?)/i.exec(text)
  if (earnest) {
    const fig = figuresIn(earnest[1] ?? earnest[2] ?? "")[0]
    if (fig !== undefined) out.push({ key: "earnest_money", value: fig, evidence: quoteAround(text, earnest.index, earnest[0].length) })
  }
  const price = /(?:offer(?:ing|ed)?|price)(?:\s+of|\s+at)?\s+(\$\s?\d[\d,]*(?:\.\d+)?\s?[km]?|\d{4,}[\d,]*)|(\$\s?\d[\d,]{4,}(?:\.\d+)?\s?[km]?)\s+offer/i.exec(text)
  if (price) {
    const fig = figuresIn(price[1] ?? price[2] ?? "")[0]
    if (fig !== undefined && fig >= 1000) out.push({ key: "offer_price", value: fig, evidence: quoteAround(text, price.index, price[0].length) })
  }
  return out
}

// ── The model assist (routed, booked) and the whole suggestion ────────────────────────

const MODEL_SCHEMA = z.object({
  answers: z.array(z.object({
    key: z.string().describe("the question key, exactly as given"),
    value: z.union([z.string(), z.number(), z.boolean()]),
    evidence: z.string().describe("the exact words from the agent's notes that state it"),
  })).max(24),
})

const SYSTEM = [
  "You transcribe a real-estate agent's own notes into the answers of a form intake.",
  "Return ONLY what the notes literally state. Never infer, estimate, calculate, total or fill a typical value.",
  "For every answer, quote the exact words of the notes that state it in `evidence`.",
  "Dates: only an explicit calendar date written in the notes. 'In 30 days' or 'end of the month' is NOT a date — omit it.",
  "Numbers: the figure as the notes state it. Do not add, convert or compute.",
  "Free-text answers (special terms, compensation, inclusions): copy the agent's words verbatim; never write or improve contract language.",
  "If a question is not answered by the notes, leave it out. Silence is the correct answer.",
].join(" ")

export interface SuggestDeps {
  /** The routed, booked model call. Injectable so the verifier — not the model — is what is proven. */
  generate?: (args: { system: string; prompt: string; brokerageId: string; userId: string | null }) => Promise<{ answers: Raw[] }>
}

async function routedGenerate(args: { system: string; prompt: string; brokerageId: string; userId: string | null }): Promise<{ answers: Raw[] }> {
  const { generateObjectRouted } = await import("@/lib/ai/models")
  const { object } = await generateObjectRouted({
    feature: "offer_data_extraction", brokerageId: args.brokerageId, userId: args.userId,
    system: args.system, prompt: args.prompt, maxTokens: 900, temperature: 0, schema: MODEL_SCHEMA,
  })
  return { answers: (object as z.infer<typeof MODEL_SCHEMA>).answers }
}

/**
 * Suggest answers from the agent's notes. `brokerageId` is the SESSION's (the route resolves it); with no
 * tenant the model assist is skipped (never a guessed tenant to bill) and the rules still answer.
 */
export async function suggestIntakeAnswers(
  input: { purpose: FormWizardPurpose; notes: string; brokerageId: string | null; userId: string | null; alreadyAnswered?: readonly string[] },
  deps: SuggestDeps = {},
): Promise<IntakeSuggestion> {
  const notes = (input.notes ?? "").trim().slice(0, INTAKE_NOTES_MAX_CHARS)
  const result: IntakeSuggestion = { proposals: [], dropped: [], via: "rules", notes: [] }
  if (notes.length < 8) { result.notes.push("Write a little more about the deal and the coach will suggest answers."); return result }

  const rules = verifyProposals(input.purpose, notes, extractByRules(input.purpose, notes), "rules")
  result.proposals.push(...rules.proposals)
  result.dropped.push(...rules.dropped)

  const settled = new Set([...rules.proposals.map((p) => p.key), ...(input.alreadyAnswered ?? [])])
  const open = questionsFor(input.purpose).filter((q) => !settled.has(q.key))
  if (open.length === 0) return result
  if (!input.brokerageId) { result.notes.push("Model assist skipped: no tenant to book the AI spend against — the rules' suggestions only."); return result }

  try {
    const prompt = [
      "Questions the form asks (answer only those the notes address):",
      ...open.map((q) => `- ${q.key} (${q.kind}${q.options ? `: ${q.options.map((o) => o.value).join(" | ")}` : ""}): ${q.prompt}`),
      "",
      `The agent's notes:\n"""${notes}"""`,
    ].join("\n")
    const generated = await (deps.generate ?? routedGenerate)({ system: SYSTEM, prompt, brokerageId: input.brokerageId, userId: input.userId })
    const modelPart = verifyProposals(input.purpose, notes, generated.answers.filter((a) => !settled.has(a.key)), "model")
    if (modelPart.proposals.length > 0) result.via = "rules+model"
    result.proposals.push(...modelPart.proposals)
    result.dropped.push(...modelPart.dropped)
  } catch (err) {
    result.notes.push(`Model assist unavailable (${err instanceof Error ? err.message : "error"}) — the rules' suggestions only.`)
  }
  return result
}
