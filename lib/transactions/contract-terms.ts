// lib/transactions/contract-terms.ts
// ──────────────────────────────────────────────────────────────────────────────
// ONE definition of "the contract terms", imported by everything that needs it:
// lib/transactions/offer-bridge.ts (which copies them onto the transaction) and
// app/actions/seller-offers.ts (which selects them for the agent's offer list and
// the AI comparison). It lives in its own module rather than on the bridge so
// that adding a term is a single edit and no surface can hand-type a list that
// silently drifts from the one the deal is actually built from — which is how
// these came to be dropped in the first place.

/**
 * THE EXECUTED CONTRACT'S TERMS, as opposed to its DEADLINES.
 *
 * A DEADLINE (`inspection_deadline`) is a DATE derived from the contract date. A
 * TERM (`inspection_period_days`) is the NUMBER WRITTEN ON THE CONTRACT. Both
 * belong on the transaction and neither replaces the other: the deadline tells
 * the deal-health rails when something is due, the term is the contractual fact
 * an amendment or a dispute is argued from. Waves 10 and 11 recorded, honestly,
 * that these were read off the contract onto `offers` and then DROPPED here
 * because no column existed to hold them. m387 added all twelve to
 * `transactions` with the IDENTICAL names they carry on `offers`, precisely so
 * this is a 1:1 copy and no second vocabulary is created.
 *
 * The list is exported because it is the single definition of "the contract
 * terms" — the SELECT, the INSERT and the proof all read it, so a term can
 * never be added to one and forgotten by another.
 */
export const CONTRACT_TERM_COLUMNS = [
  "financing_type",
  "down_payment_amount",
  "down_payment_percent",
  "closing_cost_contribution",
  "possession_terms",
  "escalation_clause",
  "escalation_cap",
  "appraisal_gap",
  "due_diligence_fee",
  "inspection_period_days",
  "appraisal_contingency_days",
  "financing_contingency_days",
] as const

export type ContractTermColumn = (typeof CONTRACT_TERM_COLUMNS)[number]

/**
 * The DATE columns the transaction carries. Named here only so the disjointness
 * from CONTRACT_TERM_COLUMNS is a checkable property rather than a hope — a term
 * must never land in a deadline slot, which is the same class of bug as the
 * earnest DEPOSIT AMOUNT landing in the earnest DUE DATE (owner correction R28).
 */
/** @proofSeam "Named here only so the disjointness from CONTRACT_TERM_COLUMNS is a checkable property" (above) — scripts/contract-terms-storage-orphan-simulator.ts asserts the two sets never overlap; the writer types its columns through CONTRACT_TERM_COLUMNS and never needs the deadline list. */
export const CONTRACT_DEADLINE_COLUMNS = [
  "inspection_deadline",
  "appraisal_deadline",
  "financing_deadline",
  "close_date",
  "estimated_close_date",
  "contract_date",
] as const

/**
 * PURE. Copy the contract terms off an offers row into a transactions payload.
 * Every column is carried, present or not: a term the contract did not state is
 * an explicit NULL, not an absent key, so "we did not read it" and "the contract
 * is silent" look the same on the row — which is the truth in both cases.
 */
export function copyContractTerms(
  offer: Record<string, unknown> | null | undefined,
): Record<ContractTermColumn, unknown> {
  const out = {} as Record<ContractTermColumn, unknown>
  for (const column of CONTRACT_TERM_COLUMNS) {
    const value = (offer as Record<string, unknown> | null | undefined)?.[column]
    out[column] = value === undefined ? null : value
  }
  return out
}


/**
 * THE TERMS A COUNTER CARRIES FORWARD (wave 95). A counter offer is the SAME
 * deal with some terms changed — it is not a blank offer with a new price. The
 * two counter writers — MERGED in wave 96 (lane 96A): sendCounterOffer is now a
 * gate that delegates to issueCounterOffer, the one writer — (lib/kernel/offers.ts issueCounterOffer, the survivor the
 * approvals queue, voice and the signed-counter recorder call; and
 * app/actions/seller-offers.ts sendCounterOffer, the slide-over) used to insert
 * only the fields the counter named, so the counter row had no closing date and
 * no earnest money, and the transaction built from an ACCEPTED counter
 * (lib/transactions/offer-bridge.ts reads the accepted row) had no close date.
 *
 * Carried: the closing date, the earnest deposit and its due-days term, the
 * contingency list, the property address, the paperwork's origin
 * (`form_source` — what lib/buyer-offer/buyer-signature-evidence.ts
 * isOutsideOriginated reads, so an outside agent's deal stays outside-originated
 * through a counter), and every CONTRACT_TERM_COLUMNS term. NOT carried:
 * `earnest_money_due_at` (a calendar date derived from the EXECUTED contract's
 * date — the parent never executed), signatures, documents, statuses.
 */
export const COUNTER_CARRIED_COLUMNS = [
  "closing_date",
  "earnest_money",
  "earnest_money_due_days",
  "contingencies",
  "property_address",
  "form_source",
  ...CONTRACT_TERM_COLUMNS,
] as const

export type CounterCarriedColumn = (typeof COUNTER_CARRIED_COLUMNS)[number]

/**
 * PURE. The counter row's terms: every carried term from the parent offer, with
 * ONLY the terms the counter changes replaced. `undefined` in `changes` means
 * "the counter did not touch this term" and keeps the parent's value; any other
 * value (including an explicit null — "strike this term") replaces it.
 */
export function carryCounterTerms(
  parent: Record<string, unknown> | null | undefined,
  changes: Partial<Record<CounterCarriedColumn, unknown>> = {},
): Record<CounterCarriedColumn, unknown> {
  const out = {} as Record<CounterCarriedColumn, unknown>
  for (const column of COUNTER_CARRIED_COLUMNS) {
    const changed = changes[column]
    const inherited = (parent as Record<string, unknown> | null | undefined)?.[column]
    out[column] = changed !== undefined ? changed : inherited === undefined ? null : inherited
  }
  return out
}


// ─── THE NON-MODEL CLOSING-WORDING READER (wave 150, lane 150XY — wave-149 §4 carried item, lane 149G Outside-lane 2) ─────────
//
// `transactions.contract_closing_terms` ('on' | 'on_or_before', NULL = not yet read) decides whether an earlier closing needs an
// executed amendment (lib/transactions/closing-dates.ts earlierClosingVerdict, owner ruling 17). Wave 149 left it person-entered
// only: no executed-contract text source had a reader, and "a non-model reader needs a caller first". This is that reader —
// DETERMINISTIC (regular expressions over the executed contract's own text, no model, no network), so it may stand as the
// contract's own words (CLAUDE.md §5: nothing model-authored where it could reach a licensed appraiser). Its caller is
// lib/transactions/offer-bridge.ts createTransactionFromOffer, which reads the executed signed contract on file and records a
// confident reading through the ONE governed door, applyClosingDateChange(kind 'contract_wording', evidence = the document).
//
// It refuses to guess: no closing sentence, a closing sentence with no date, two sentences that disagree (one "on or before",
// one fixed "on"), or a date that differs from the recorded contractual date → `terms: null` with the reason. Unknown stays
// unknown (the wave-148 default "needs an amendment" stays reversed).

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
const MONTH_RE = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
const DATE_SRC = `(\\d{4}-\\d{2}-\\d{2})|(\\d{1,2})/(\\d{1,2})/(\\d{4})|(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`
const DATE_RE = new RegExp(DATE_SRC, "i")
const CLOSING_SUBJECT_RE = /\b(closing|settlement|close of escrow|coe)\b/i
// The qualifier must sit RIGHT BEFORE the date ("on or before December 15, 2026"), so "title no later than 10 days before the
// Closing Date of 12/15/2026" is not read as the closing's own wording.
const NUM_DATE = `(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}/\\d{4}|${MONTH_RE}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4})`
const ON_OR_BEFORE_RE = new RegExp(`\\b(?:on or before|no later than|not later than|on or prior to|prior to or on)\\s+(?:the\\s+)?(?:date\\s+of\\s+)?${NUM_DATE}`, "i")
const FIXED_ON_RE = new RegExp(`\\b(?:(?:shall|will|must)\\s+(?:close|occur|take place|be held|be completed)|closing date\\s+(?:shall be|is|will be))\\s+(?:on\\s+)?(?:the\\s+)?${NUM_DATE}`, "i")

/** PURE — a calendar day (YYYY-MM-DD) from the first date in a sentence, or null. */
function dateIn(sentence: string): string | null {
  const m = DATE_RE.exec(sentence)
  if (!m) return null
  if (m[1]) return m[1]
  const pad = (n: number) => String(n).padStart(2, "0")
  let y: number, mo: number, d: number
  if (m[2]) { mo = Number(m[2]); d = Number(m[3]); y = Number(m[4]) }
  else { mo = MONTHS.findIndex((x) => x.startsWith(String(m[5]).toLowerCase().slice(0, 3))) + 1; d = Number(m[6]); y = Number(m[7]) }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return `${y}-${pad(mo)}-${pad(d)}`
}

export interface ClosingWordingReading {
  terms: "on" | "on_or_before" | null
  date: string | null
  /** The contract's own sentence the reading rests on (≤ 300 chars) — the evidence a TC checks. */
  quote: string | null
  reason: string
}

/**
 * PURE, DETERMINISTIC — how the executed contract words its closing date. `expectedDate` (the deal's recorded contractual date)
 * must agree with the sentence's date when both exist, or the reading is refused (the text may be a different deal's form).
 */
export function readClosingDateWording(text: string | null | undefined, opts: { expectedDate?: string | null } = {}): ClosingWordingReading {
  const body = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : ""
  if (body.length < 20) return { terms: null, date: null, quote: null, reason: "no executed-contract text to read" }
  const sentences = body.split(/(?<=[.;])\s+(?=[A-Z(])/).filter((s) => CLOSING_SUBJECT_RE.test(s) && DATE_RE.test(s))
  const readings: Array<{ terms: "on" | "on_or_before"; date: string | null; quote: string }> = []
  for (const s of sentences) {
    const before = ON_OR_BEFORE_RE.exec(s)
    const fixed = before ? null : FIXED_ON_RE.exec(s)
    const hit = before ?? fixed
    if (hit) readings.push({ terms: before ? "on_or_before" : "on", date: dateIn(hit[0]), quote: s.slice(0, 300) })
  }
  if (readings.length === 0) return { terms: null, date: null, quote: null, reason: "no sentence states how the closing date is worded (a bare 'Closing Date:' label is not wording)" }
  const kinds = new Set(readings.map((r) => r.terms))
  if (kinds.size > 1) return { terms: null, date: null, quote: readings.map((r) => r.quote).join(" | ").slice(0, 300), reason: "the contract words its closing date two ways (on, and on or before) — a person reads it" }
  const dates = new Set(readings.map((r) => r.date).filter((d): d is string => !!d))
  if (dates.size > 1) return { terms: null, date: null, quote: readings[0].quote, reason: "the closing sentences name different dates — a person reads it" }
  const date = [...dates][0] ?? null
  const expected = typeof opts.expectedDate === "string" ? opts.expectedDate.slice(0, 10) : null
  if (expected && date && expected !== date) return { terms: null, date, quote: readings[0].quote, reason: `the contract text's closing date (${date}) differs from the recorded contractual date (${expected}) — a person reads it` }
  return { terms: readings[0].terms, date, quote: readings[0].quote, reason: readings[0].terms === "on_or_before" ? "the executed contract says closing occurs on or before its date" : "the executed contract fixes the closing day" }
}
