/**
 * lib/transactions/closing-compliance-core.ts — CLOSING COMPLIANCE, THE PURE HALF.
 *
 * Owner (wave 143): "Compliance = signatures/initials + document checks. CLOSING compliance also
 * checks that commission and contract terms match the settlement (which party pays the title
 * owner's policy, etc.); a counter supersedes the contract terms."
 *
 * This file is the arithmetic and the rule, with no database in it, so scripts/closing-compliance-guard.ts
 * drives it directly with fixtures (and a positive control for every defect it claims to catch).
 * The I/O half — reading the records, writing the compliance log, notifying — is
 * lib/transactions/closing-compliance.ts.
 *
 * THREE RULES THIS FILE HOLDS
 *
 *  1. THE GOVERNING TERMS ARE THE LATEST EXECUTED INSTRUMENT THAT STATES THEM, PER TERM.
 *     `superimposeGoverningTerms` walks the executed instruments oldest → newest (original offer,
 *     counters by round, executed addenda). A term a later instrument states replaces the earlier
 *     value; a term it does not state is inherited. Nothing is deleted: every superseded value stays
 *     in `history`, so the original is preserved and a report can say "price $400,000 → $395,000 by
 *     the executed counter of 2026-10-02". An instrument that is NOT executed never governs — it is
 *     listed under `ignored` so a reader sees it was seen and set aside.
 *
 *  2. NOTHING IS CHANGED, ONLY FLAGGED. A mismatch produces a finding whose `correction` names who
 *     can fix it (the title company corrects a settlement statement; a signed amendment is UPLOADED,
 *     never typed in). No function here returns a value to be written onto a signed term.
 *
 *  3. "COULD NOT TELL" IS NEVER "MATCHED". Both sides must state a term for it to match or mismatch.
 *     A term one side does not state is `unverifiable`; a DIFFERENCE where either side is a low-
 *     confidence AI extraction is `unverifiable` too (an OCR slip must not accuse a clean deal), and
 *     a MATCH is a match whatever the confidence (two independent sources agreeing is evidence).
 */

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** Every term the comparison speaks. One spelling each (CLAUDE.md §6). */
export const CLOSING_TERM_KEYS = [
  "purchase_price",
  "earnest_money",
  "closing_date",
  "seller_credit",
  // wave 144 (lane 144C, handed over by lane 144D Outside-lane 5 — owner ruling 4): the AGENT's credit to the buyer, approved
  // under the brokerage's concession policy. NEVER the seller credit: it comes off that agent's gross commission, not the
  // seller's proceeds — two terms, two lines on the statement, never conflated.
  "agent_credit",
  "owner_title_policy_payer",
  "commission_listing_side",
  "commission_buyer_side",
  "commission_total",
] as const
export type ClosingTermKey = (typeof CLOSING_TERM_KEYS)[number]

const CLOSING_TERM_LABEL: Record<ClosingTermKey, string> = {
  purchase_price:           "Purchase price",
  earnest_money:            "Earnest money / deposit",
  closing_date:             "Closing date",
  seller_credit:            "Seller credit to buyer",
  agent_credit:             "Agent credit to buyer (approved agent concession)",
  owner_title_policy_payer: "Who pays the owner's title policy",
  commission_listing_side:  "Listing-side commission",
  commission_buyer_side:    "Buyer-side commission",
  commission_total:         "Total commission",
}

/**
 * The terms whose mismatch BLOCKS the closing (money and who-pays). A date mismatch is flagged for
 * review but does not block: an extension is often legitimate and its amendment may be in flight.
 */
export const BLOCKING_TERMS: ReadonlySet<ClosingTermKey> = new Set<ClosingTermKey>([
  "purchase_price", "earnest_money", "seller_credit", "agent_credit", "owner_title_policy_payer",
  "commission_listing_side", "commission_buyer_side", "commission_total",
])

/** How far to trust a stated fact. `record` = a typed column a person or a signed flow wrote. */
export type Confidence = "record" | "verified" | "high" | "medium" | "low"
const CONFIDENCE_RANK: Record<Confidence, number> = { record: 4, verified: 4, high: 3, medium: 2, low: 1 }
const isDecisive = (c: Confidence): boolean => CONFIDENCE_RANK[c] >= CONFIDENCE_RANK.medium

export type Party = "buyer" | "seller" | "split"

/** Instruments that can state contract terms (see KIND_ORDER for how they rank). */
export type InstrumentKind = "original_offer" | "counter" | "addendum" | "listing_agreement" | "executed_contract"
  /** wave 144: the broker-APPROVED agent concessions on the deal (commission_adjustments, m850). States `agent_credit` only. */
  | "approved_concession"

interface FactBase { confidence: Confidence; source: string; instrumentId?: string | null; executedAt?: string | null; kind?: InstrumentKind }
export type TermFact =
  | ({ unit: "usd";   value: number } & FactBase)
  | ({ unit: "pct";   value: number } & FactBase)
  | ({ unit: "date";  value: string } & FactBase)
  | ({ unit: "party"; value: Party  } & FactBase)

export type TermMap = Partial<Record<ClosingTermKey, TermFact>>

export interface TermsInstrument {
  id:         string
  kind:       InstrumentKind
  label:      string
  /** Only an executed instrument governs. */
  executed:   boolean
  /** ISO timestamp the instrument became fully executed; null when unknown. */
  executedAt: string | null
  /** Negotiation round (counters), for a stable order when timestamps tie or are missing. */
  round?:     number | null
  terms:      TermMap
}

/** A term two executed instruments state differently, whose order the paper does not settle. */
export interface TermConflict { winner: TermFact; loser: TermFact }

export interface GoverningTerms {
  /** The term values in force. */
  terms:   TermMap
  /** Every value a later instrument replaced, per term, newest first. */
  history: Partial<Record<ClosingTermKey, Array<{ fact: TermFact; supersededBy: string }>>>
  /** Terms whose governing instrument cannot be established from the paper — a person must say which one governs. */
  conflicts: Partial<Record<ClosingTermKey, TermConflict>>
  /** Instruments that were read and not applied, with the reason. */
  ignored: Array<{ id: string; label: string; reason: string }>
  /** The instruments that governed, in the order they were applied. */
  applied: Array<{ id: string; kind: InstrumentKind; label: string; executedAt: string | null }>
}

/**
 * The rank of an instrument KIND. A counter responds to an offer; the executed contract carries the agreed
 * (countered) terms; an addendum amends the executed contract. Within one kind the timestamp, then the
 * negotiation round, decide. A TOTAL order on purpose (kind, then time, then round): a comparator that
 * mixes "by time" and "by kind" depending on which timestamps happen to exist is not transitive.
 */
const KIND_ORDER: Record<InstrumentKind, number> = { listing_agreement: 0, original_offer: 1, counter: 2, executed_contract: 3, addendum: 4, approved_concession: 5 }

const tsOf = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN)

function instrumentOrder(a: TermsInstrument, b: TermsInstrument): number {
  if (KIND_ORDER[a.kind] !== KIND_ORDER[b.kind]) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
  const ta = tsOf(a.executedAt), tb = tsOf(b.executedAt)
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb
  return (a.round ?? 0) - (b.round ?? 0)
}

const sameValue = (a: TermFact, b: TermFact): boolean => a.unit === b.unit && a.value === b.value

/**
 * PURE. THE PRECEDENCE RULE: the latest executed instrument that states a term governs it.
 * (Lane A's reader `governingContractTerms` is the system of record once it lands; this is the
 * rule the default loader and the guard both run, so the two cannot disagree about precedence.)
 *
 * ONE CASE THE PAPER DOES NOT SETTLE — and it is reported, not guessed. A COUNTER and the EXECUTED
 * CONTRACT document can state different values of one term (a client uploads the ORIGINAL contract
 * after a counter changed the price). By kind the contract outranks the counter; if the counter is
 * the LATER paper, or either has no date, we cannot tell which one the parties meant. That term is
 * recorded under `conflicts` (cleared if a later addendum restates it) and compared as a conflict,
 * never as a confident match or mismatch.
 */
export function superimposeGoverningTerms(instruments: readonly TermsInstrument[]): GoverningTerms {
  const out: GoverningTerms = { terms: {}, history: {}, conflicts: {}, ignored: [], applied: [] }
  const executed: TermsInstrument[] = []
  for (const ins of instruments) {
    if (!ins.executed) { out.ignored.push({ id: ins.id, label: ins.label, reason: "not fully executed — an unexecuted instrument never governs" }); continue }
    executed.push(ins)
  }
  executed.sort(instrumentOrder)
  for (const ins of executed) {
    out.applied.push({ id: ins.id, kind: ins.kind, label: ins.label, executedAt: ins.executedAt })
    for (const key of CLOSING_TERM_KEYS) {
      const fact = ins.terms[key]
      if (!fact) continue
      const next: TermFact = { ...fact, instrumentId: fact.instrumentId ?? ins.id, executedAt: fact.executedAt ?? ins.executedAt, kind: ins.kind }
      const prior = out.terms[key]
      if (prior) {
        (out.history[key] ??= []).unshift({ fact: prior, supersededBy: ins.label })
        delete out.conflicts[key] // a later instrument restating the term settles whatever was in doubt before it
        if (prior.kind === "counter" && ins.kind === "executed_contract" && !sameValue(prior, next)) {
          const priorTs = tsOf(prior.executedAt), nextTs = tsOf(next.executedAt)
          const decided = Number.isFinite(priorTs) && Number.isFinite(nextTs) && nextTs >= priorTs
          if (!decided) out.conflicts[key] = { winner: next, loser: prior }
        }
      }
      out.terms[key] = next
    }
  }
  return out
}

// ── Settlement side ───────────────────────────────────────────────────────────

export interface SettlementSnapshot {
  /** The settlement documents read (final first), so a finding can name its source. */
  documents: Array<{ id: string; classification: string; stage: "final" | "preliminary" | "unlabeled" }>
  terms:     TermMap
}

/** Map a scanned settlement document's extracted keys onto the comparison's terms. */
export const SETTLEMENT_FIELD_TO_TERM: Readonly<Record<string, { term: ClosingTermKey; unit: TermFact["unit"] }>> = {
  sales_price:              { term: "purchase_price",           unit: "usd" },
  earnest_money_deposit:    { term: "earnest_money",            unit: "usd" },
  closing_date:             { term: "closing_date",             unit: "date" },
  seller_credit_to_buyer:   { term: "seller_credit",            unit: "usd" },
  // the statement's agent / broker credit line to the buyer — compared against the APPROVED agent concessions (wave 144)
  agent_credit_to_buyer:    { term: "agent_credit",             unit: "usd" },
  broker_credit_to_buyer:   { term: "agent_credit",             unit: "usd" },
  owner_title_policy_payer: { term: "owner_title_policy_payer", unit: "party" },
  commission_listing_broker:{ term: "commission_listing_side",  unit: "usd" },
  commission_buyer_broker:  { term: "commission_buyer_side",    unit: "usd" },
  commission_total:         { term: "commission_total",         unit: "usd" },
}

/** The extracted keys of a CONTRACT / COUNTER / ADDENDUM document that state governing terms. */
export const CONTRACT_FIELD_TO_TERM: Readonly<Record<string, { term: ClosingTermKey; unit: TermFact["unit"] }>> = {
  price:                    { term: "purchase_price",           unit: "usd" },
  counter_price:            { term: "purchase_price",           unit: "usd" },
  earnest_money_amount:     { term: "earnest_money",            unit: "usd" },
  closing_date:             { term: "closing_date",             unit: "date" },
  seller_concession_amount: { term: "seller_credit",            unit: "usd" },
  owner_title_policy_payer: { term: "owner_title_policy_payer", unit: "party" },
}

/** Parse a stated money figure: 425000, "$425,000.00", "425,000". Anything else is not a figure. */
export function parseUsd(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v !== "string") return null
  const t = v.replace(/[$,\s]/g, "")
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** Parse a date to YYYY-MM-DD. Accepts ISO dates/timestamps and US m/d/yyyy; anything else is not a date. */
export function parseDateOnly(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t)
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`
  return null
}

/** Parse a payer: buyer | seller | split (also "borrower"→buyer, "both"/"shared"→split). Anything else is unknown. */
export function parseParty(v: unknown): Party | null {
  if (typeof v !== "string") return null
  const t = v.trim().toLowerCase()
  if (t === "buyer" || t === "borrower" || t === "purchaser") return "buyer"
  if (t === "seller") return "seller"
  if (t === "split" || t === "both" || t === "shared" || t === "50/50") return "split"
  return null
}

// ── The comparison ───────────────────────────────────────────────────────────

/** Rounding slack for a dollar figure DERIVED from a percentage (a title company rounds to the dollar). */
const DERIVED_USD_TOLERANCE = 1.0
/** A stated dollar figure must agree to the cent (half a cent for floating point). */
const STATED_USD_TOLERANCE = 0.005

/** `conflict` = the executed paper disagrees with itself and does not say which instrument governs. */
export type Verdict = "match" | "mismatch" | "unverifiable" | "conflict"

export interface TermFinding {
  term:        ClosingTermKey
  label:       string
  verdict:     Verdict
  governing:   string | null
  settlement:  string | null
  /** One sentence a TC can act on. */
  why:         string
  /** Does this finding hold the closing? (mismatch on a money / who-pays term). */
  blocking:    boolean
  /** Who can correct it and how — never "edit the signed term". */
  correction:  string
  governingSource:  string | null
  settlementSource: string | null
}

export interface ClosingComparison {
  findings:        TermFinding[]
  governingOnFile: boolean
  settlementOnFile: boolean
  counts:          { match: number; mismatch: number; unverifiable: number; conflict: number; blocking: number }
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function formatFact(f: TermFact): string {
  if (f.unit === "usd") return usd(f.value)
  if (f.unit === "pct") return `${f.value}%`
  if (f.unit === "party") return f.value
  return f.value
}

const SETTLEMENT_CORRECTION: Record<ClosingTermKey, string> = {
  purchase_price:           "Ask the title company / closing attorney to correct the settlement statement. If the price was changed after contract, upload the fully executed amendment so it becomes the governing term — the signed terms are never edited here.",
  earnest_money:            "Confirm the deposit with the title company and the earnest-money receipt; the settlement statement is corrected by title, never the contract.",
  closing_date:             "Confirm whether an executed extension exists; if so upload it. Otherwise ask title to correct the date.",
  seller_credit:            "Confirm the credit in the executed contract or counter; ask title to correct the statement, or upload the executed amendment that changed it.",
  agent_credit:             "An agent concession comes off THAT agent's gross commission and is credited to the buyer — never out of the seller's proceeds. Compare the approved concessions on the transaction's CDA page; ask title to correct the line, or have the agent request and the broker decide the concession. A credit the broker has not approved is never a governing term.",
  owner_title_policy_payer: "The executed contract (or the latest executed counter) names who pays the owner's title policy; ask title to move the premium to that party, or upload the executed amendment that changed it.",
  commission_listing_side:  "Compare to the listing agreement and the executed contract; ask title to correct the commission line, or upload the executed amendment. The CDA must follow the signed commission terms.",
  commission_buyer_side:    "Compare to the buyer-broker compensation in the executed contract / buyer agreement; ask title to correct the line, or upload the executed amendment.",
  commission_total:         "Compare to the listing and buyer-side commission terms; ask title to correct the statement, or upload the executed amendment.",
}

const MISSING_CORRECTION = (term: ClosingTermKey, side: "governing" | "settlement"): string =>
  side === "settlement"
    ? `The settlement statement on file does not state ${CLOSING_TERM_LABEL[term].toLowerCase()}. Ask title for the seller's settlement statement / ALTA statement if it is not the document on file; do not assume it matches.`
    : `No executed instrument on file states ${CLOSING_TERM_LABEL[term].toLowerCase()}. Upload the executed contract / counter that does, or record the term on the offer.`

/** Expected dollars for a commission fact against the governing price; null when it cannot be derived. */
function expectedCommissionUsd(fact: TermFact | undefined, price: number | null): { usd: number; derived: boolean } | null {
  if (!fact) return null
  if (fact.unit === "usd") return { usd: fact.value, derived: false }
  if (fact.unit === "pct" && price !== null && price > 0) return { usd: Math.round(price * fact.value) / 100, derived: true }
  return null
}

function compareTerm(term: ClosingTermKey, gov: TermFact | undefined, set: TermFact | undefined, governingPrice: number | null, conflict?: TermConflict): TermFinding {
  const base = {
    term, label: CLOSING_TERM_LABEL[term],
    governingSource: gov?.source ?? null, settlementSource: set?.source ?? null,
  }
  const blockingTerm = BLOCKING_TERMS.has(term)
  if (conflict) {
    // The paper disagrees with itself: never a confident match, never a confident mismatch.
    return { ...base, verdict: "conflict", governing: formatFact(conflict.winner), settlement: set ? formatFact(set) : null, blocking: blockingTerm,
      why: `${CLOSING_TERM_LABEL[term]}: two executed instruments disagree — ${conflict.loser.source} says ${formatFact(conflict.loser)}, ${conflict.winner.source} says ${formatFact(conflict.winner)} — and the documents do not show which one the parties meant to govern, so the settlement statement cannot be checked against either.`,
      correction: "Upload the later fully executed counter or addendum that settles the term, or correct the offer record to the executed value; then the check re-runs on its own." }
  }
  if (!gov) {
    return { ...base, verdict: "unverifiable", governing: null, settlement: set ? formatFact(set) : null, blocking: false,
      why: `${CLOSING_TERM_LABEL[term]} is not stated by any executed contract instrument on file, so the settlement statement cannot be checked against it.`,
      correction: MISSING_CORRECTION(term, "governing") }
  }
  if (!set) {
    return { ...base, verdict: "unverifiable", governing: formatFact(gov), settlement: null, blocking: false,
      why: `${CLOSING_TERM_LABEL[term]} is ${formatFact(gov)} in the governing terms, but the settlement statement on file does not state it.`,
      correction: MISSING_CORRECTION(term, "settlement") }
  }

  // Commission terms compare in dollars: a governing percentage is applied to the GOVERNING price.
  let equal: boolean
  let govText = formatFact(gov)
  let setText = formatFact(set)
  if (term.startsWith("commission_")) {
    const exp = expectedCommissionUsd(gov, governingPrice)
    if (!exp) {
      return { ...base, verdict: "unverifiable", governing: govText, settlement: setText, blocking: false,
        why: `${CLOSING_TERM_LABEL[term]} is a percentage but the governing price is unknown, so the dollar amount on the settlement statement cannot be checked.`,
        correction: MISSING_CORRECTION("purchase_price", "governing") }
    }
    if (set.unit !== "usd") {
      return { ...base, verdict: "unverifiable", governing: govText, settlement: setText, blocking: false,
        why: `${CLOSING_TERM_LABEL[term]} on the settlement statement is not a dollar figure.`, correction: SETTLEMENT_CORRECTION[term] }
    }
    const tol = exp.derived ? DERIVED_USD_TOLERANCE : STATED_USD_TOLERANCE
    equal = Math.abs(exp.usd - set.value) <= tol
    govText = gov.unit === "pct" ? `${formatFact(gov)} of ${usd(governingPrice ?? 0)} = ${usd(exp.usd)}` : usd(exp.usd)
  } else if (gov.unit === "usd" && set.unit === "usd") {
    equal = Math.abs(gov.value - set.value) <= STATED_USD_TOLERANCE
  } else if (gov.unit === "date" && set.unit === "date") {
    equal = gov.value === set.value
  } else if (gov.unit === "party" && set.unit === "party") {
    equal = gov.value === set.value
  } else {
    return { ...base, verdict: "unverifiable", governing: govText, settlement: setText, blocking: false,
      why: `${CLOSING_TERM_LABEL[term]} is stated in different forms (${gov.unit} vs ${set.unit}) and cannot be compared.`, correction: SETTLEMENT_CORRECTION[term] }
  }

  if (equal) {
    return { ...base, verdict: "match", governing: govText, settlement: setText, blocking: false,
      why: `${CLOSING_TERM_LABEL[term]} agrees (${setText}).`, correction: "" }
  }
  // A DIFFERENCE that rests on a low-confidence AI reading is a question for a human, not an accusation.
  if (!isDecisive(gov.confidence) || !isDecisive(set.confidence)) {
    return { ...base, verdict: "unverifiable", governing: govText, settlement: setText, blocking: false,
      why: `${CLOSING_TERM_LABEL[term]} differs (${govText} vs ${setText}) but at least one side is a low-confidence AI reading — a person must verify the figure on the document before it is treated as a mismatch.`,
      correction: "Open the document, verify the figure in the extraction review, then re-run the closing check." }
  }
  return { ...base, verdict: "mismatch", governing: govText, settlement: setText, blocking: blockingTerm,
    why: `${CLOSING_TERM_LABEL[term]} does not match: governing terms say ${govText}; the settlement statement says ${setText}.`,
    correction: SETTLEMENT_CORRECTION[term] }
}

/**
 * PURE. Compare the governing executed terms to the settlement statement, term by term.
 * Both sides absent → a single blocking `unverifiable` per side is NOT invented here; the caller
 * reads `governingOnFile` / `settlementOnFile` and files the right finding (a missing settlement
 * statement is a different problem from a missing term).
 */
export function compareClosingTerms(governing: TermMap, settlement: TermMap, conflicts: GoverningTerms["conflicts"] = {}): ClosingComparison {
  const price = governing.purchase_price?.unit === "usd" ? governing.purchase_price.value : null
  const findings: TermFinding[] = []
  for (const term of CLOSING_TERM_KEYS) {
    // commission_total is compared only when the settlement states it AND no side-specific figure was stated.
    if (term === "commission_total") {
      const settlementHasSides = !!(settlement.commission_listing_side || settlement.commission_buyer_side)
      if (!settlement.commission_total || settlementHasSides) continue
      // Governing total = listing + buyer side, when both derive to dollars.
      const l = expectedCommissionUsd(governing.commission_listing_side, price)
      const b = expectedCommissionUsd(governing.commission_buyer_side, price)
      const synthetic: TermFact | undefined = l && b
        ? { unit: "usd", value: Math.round((l.usd + b.usd) * 100) / 100, confidence: "record", source: "listing-side + buyer-side governing commission" }
        : undefined
      findings.push(compareTerm(term, synthetic ?? governing.commission_total, settlement.commission_total, price))
      continue
    }
    const gov = governing[term]
    const set = settlement[term]
    // A term neither side states is not a finding at all (nothing to compare, nothing was promised).
    if (!gov && !set) continue
    findings.push(compareTerm(term, gov, set, price, conflicts[term]))
  }
  const counts = {
    match: findings.filter((f) => f.verdict === "match").length,
    mismatch: findings.filter((f) => f.verdict === "mismatch").length,
    unverifiable: findings.filter((f) => f.verdict === "unverifiable").length,
    conflict: findings.filter((f) => f.verdict === "conflict").length,
    blocking: findings.filter((f) => f.blocking).length,
  }
  return { findings, governingOnFile: Object.keys(governing).length > 0, settlementOnFile: Object.keys(settlement).length > 0, counts }
}

// ── The compliance-log shape (what the runner writes; pure so the guard can assert it) ──────

/** `transaction_compliance_log.check_type` for a term finding. ONE spelling, read by the runner and the guard. */
const closingTermCheckType = (term: ClosingTermKey): string => `closing_terms.${term}`
export const CLOSING_TERM_CHECK_PREFIX = "closing_terms."
export const CLOSING_DOC_CHECK_PREFIX = "closing_docs."
export const CLOSING_PARTICIPANT_CHECK_PREFIX = "closing_participants."

export type LogStatus = "pass" | "fail" | "needs_review"

export interface LogRowSpec {
  check_type:     string
  check_label:    string
  status:         LogStatus
  is_blocking:    boolean
  failure_reason: string | null
  /** A stable signature of the values compared — a changed signature re-opens a waived row. */
  signature:      string
}

/** PURE. A term finding as the compliance-log row it becomes. */
export function findingToLogRow(f: TermFinding): LogRowSpec {
  const status: LogStatus = f.verdict === "match" ? "pass" : f.verdict === "mismatch" ? "fail" : "needs_review"
  return {
    check_type:  closingTermCheckType(f.term),
    check_label: `Closing: ${f.label} matches the settlement`,
    status,
    // A mismatch on a money / who-pays term holds the closing; so does executed paper that contradicts itself on one.
    is_blocking: (status === "fail" || f.verdict === "conflict") && f.blocking,
    failure_reason: status === "pass" ? null : `${f.why} ${f.correction}`.trim(),
    signature: `${f.verdict}|${f.governing ?? "-"}|${f.settlement ?? "-"}`,
  }
}
