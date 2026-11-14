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

// WAVE 152 (lane 152E): the ONE override reason floor (client-safe, no server imports) — an override of a computed check holds it too.
import { OVERRIDE_REASON_MIN_CHARS } from "@/lib/kernel/status-override"

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
  // wave 145 (lane 145C — 144C Still open 3): an approved agent concession credited to the SELLER (off that agent's gross)
  "agent_credit_seller",
  // wave 145 (lane 145C — owner ruling 5): fees the CLIENT's agreement establishes (client_agreement_fees, m859), settled on
  // that party's side. Never an agent-agreement fee (those are the agent's, charged by the commission engine).
  "seller_transaction_fee",
  "seller_admin_fee",
  "buyer_transaction_fee",
  "buyer_admin_fee",
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
  agent_credit_seller:      "Agent credit to seller (approved agent concession)",
  seller_transaction_fee:   "Seller's transaction fee (listing agreement)",
  seller_admin_fee:         "Seller's administrative fee (listing agreement)",
  buyer_transaction_fee:    "Buyer's transaction fee (buyer-broker agreement)",
  buyer_admin_fee:          "Buyer's administrative fee (buyer-broker agreement)",
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
  "purchase_price", "earnest_money", "seller_credit", "agent_credit", "agent_credit_seller", "owner_title_policy_payer",
  "seller_transaction_fee", "seller_admin_fee", "buyer_transaction_fee", "buyer_admin_fee",
  "commission_listing_side", "commission_buyer_side", "commission_total",
])

/** How far to trust a stated fact. `record` = a typed column a person or a signed flow wrote. */
export type Confidence = "record" | "verified" | "high" | "medium" | "low"
const CONFIDENCE_RANK: Record<Confidence, number> = { record: 4, verified: 4, high: 3, medium: 2, low: 1 }
const isDecisive = (c: Confidence): boolean => CONFIDENCE_RANK[c] >= CONFIDENCE_RANK.medium

export type Party = "buyer" | "seller" | "split"

/** Instruments that can state contract terms (see KIND_ORDER for how they rank). */
export type InstrumentKind = "original_offer" | "counter" | "addendum" | "listing_agreement" | "executed_contract"
  /** wave 144: the broker-APPROVED agent concessions on the deal (commission_adjustments, m850). States `agent_credit` (and,
   *  wave 145, `agent_credit_seller`) only. */
  | "approved_concession"
  /** wave 145 (lane 145C): the VERIFIED client-agreement fees (client_agreement_fees, m859). States the four fee terms only. */
  | "client_agreement_fee"

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
const KIND_ORDER: Record<InstrumentKind, number> = { listing_agreement: 0, original_offer: 1, counter: 2, executed_contract: 3, addendum: 4, approved_concession: 5, client_agreement_fee: 6 }

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
  // wave 145: the agent / broker credit printed in the SELLER's column, and the client-agreement fee lines
  agent_credit_to_seller:   { term: "agent_credit_seller",      unit: "usd" },
  broker_credit_to_seller:  { term: "agent_credit_seller",      unit: "usd" },
  seller_transaction_fee:   { term: "seller_transaction_fee",   unit: "usd" },
  seller_admin_fee:         { term: "seller_admin_fee",         unit: "usd" },
  buyer_transaction_fee:    { term: "buyer_transaction_fee",    unit: "usd" },
  buyer_admin_fee:          { term: "buyer_admin_fee",          unit: "usd" },
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

/**
 * WAVE 152 (lane 152E — directive 152E "CLASSIFY MATCH / MISSING / CONTRADICTORY / SUPERSEDED / REQUIRES HUMAN INTERPRETATION").
 * NOT a second spelling of the verdict (CLAUDE.md §6): it REFINES it, by ONE mapping (classOf below) — the verdict still drives the
 * row's status and signature (so no waiver re-opens); the class says WHAT KIND of correction is owed and by whom:
 *   match → nothing · missing → one side does not state the term (obtain it) · contradictory → both state it, decisively, differently
 *   (the issuer corrects) · superseded → the other side still shows a value a LATER executed instrument replaced (send the issuer the
 *   executed instrument) · requires_human_interpretation → the paper disagrees with itself, or a difference rests on a low-confidence
 *   reading or an incomparable form — a person (the responsible licensed professional / closing attorney where meaning is in doubt)
 *   reads it; nothing here interprets a clause.
 */
const TERM_COMPARISON_CLASSES = ["match", "missing", "contradictory", "superseded", "requires_human_interpretation"] as const
// module-private: readers take it as TermFinding["classification"] (lane 152G reads the runner's outcome)
type TermComparisonClass = (typeof TERM_COMPARISON_CLASSES)[number]

export interface TermFinding {
  term:        ClosingTermKey
  label:       string
  verdict:     Verdict
  /** WAVE 152 (lane 152E): the directive's class — a refinement of `verdict` (classOf). */
  classification: TermComparisonClass
  /** WAVE 152 (lane 152E): what the governing terms were compared AGAINST (default: the settlement statement). */
  against?:    "settlement" | "deal_record"
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
  agent_credit_seller:      "An agent concession credited to the SELLER comes off THAT agent's gross commission — never out of the buyer's funds or the seller's own proceeds. Compare the approved concessions on the CDA page; ask title to correct the line, or have the agent request and the broker decide it.",
  seller_transaction_fee:   "The seller's transaction fee is what the EXECUTED listing agreement (or its executed amendment) establishes, verified on the client-agreement fees record. Ask title to correct the line; a fee the agreement includes in the commission is not charged again; never an agent-agreement fee.",
  seller_admin_fee:         "The seller's administrative fee is what the EXECUTED listing agreement (or its executed amendment) establishes, verified on the client-agreement fees record. Ask title to correct the line, or record the executed amendment that changed it.",
  buyer_transaction_fee:    "The buyer's transaction fee is what the EXECUTED buyer-broker agreement (or its executed amendment) establishes, verified on the client-agreement fees record. Ask title to correct the line; a fee the agreement includes in the commission is not charged again.",
  buyer_admin_fee:          "The buyer's administrative fee is what the EXECUTED buyer-broker agreement (or its executed amendment) establishes, verified on the client-agreement fees record. Ask title to correct the line, or record the executed amendment that changed it.",
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

/** The comparison's options (wave 152, lane 152E). */
interface CompareOptions {
  /** How the executed contract words its closing date (transactions.contract_closing_terms); null = not read — unknown stays unknown. */
  closingWording?: "on" | "on_or_before" | null
  /** Values a later executed instrument REPLACED, per term (superimposeGoverningTerms' history) — a settlement showing one is SUPERSEDED. */
  history?: GoverningTerms["history"]
}

/** PURE — the directive's class of one finding (see TERM_COMPARISON_CLASSES). The ONE mapping from the verdict. */
function classOf(f: Omit<TermFinding, "classification">, superseded: boolean): TermComparisonClass {
  if (f.verdict === "match") return "match"
  if (f.verdict === "conflict") return "requires_human_interpretation"
  if (f.verdict === "mismatch") return superseded ? "superseded" : "contradictory"
  return f.governing !== null && f.settlement !== null ? "requires_human_interpretation" : "missing"
}

function compareTerm(term: ClosingTermKey, gov: TermFact | undefined, set: TermFact | undefined, governingPrice: number | null, conflict?: TermConflict, opts: CompareOptions = {}): TermFinding {
  // WAVE 152 (lane 152E): the other side still shows a value a LATER executed instrument replaced — the issuer used the pre-amendment term.
  const replaced = set ? (opts.history?.[term] ?? []).find((h) => h.fact.unit === set.unit && h.fact.value === set.value && (!gov || gov.value !== set.value)) : undefined
  const f = compareTermVerdict(term, gov, set, governingPrice, conflict, opts)
  if (f.verdict === "mismatch" && replaced) {
    return { ...f, classification: "superseded",
      why: `${CLOSING_TERM_LABEL[term]}: the settlement statement shows ${f.settlement}, the value REPLACED by the ${replaced.supersededBy} — the governing term is ${f.governing}.`,
      correction: `Send the issuer of the statement (title company / closing attorney) the ${replaced.supersededBy} and ask for a corrected statement; the signed terms are never edited here.` }
  }
  return { ...f, classification: classOf(f, false) }
}

function compareTermVerdict(term: ClosingTermKey, gov: TermFact | undefined, set: TermFact | undefined, governingPrice: number | null, conflict: TermConflict | undefined, opts: CompareOptions): Omit<TermFinding, "classification"> {
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
    // WAVE 152 (lane 152E — directive 476: "'on or before' early close does not fabricate need for amendment"). The executed contract
    // says closing occurs ON OR BEFORE its date (read deterministically — lib/transactions/contract-terms.ts readClosingDateWording —
    // and held on transactions.contract_closing_terms): an earlier settlement date IS the contract, not a departure from it. A fixed
    // "on" day, or wording nobody has read, keeps the existing reading (a difference flagged for review); a LATER date always needs
    // the executed extension.
    if (!equal && term === "closing_date" && opts.closingWording === "on_or_before" && set.value < gov.value && isDecisive(set.confidence)) {
      return { ...base, verdict: "match", governing: `on or before ${gov.value}`, settlement: setText, blocking: false,
        why: `${CLOSING_TERM_LABEL[term]}: the statement's ${set.value} is within the executed contract's "on or before ${gov.value}" — an earlier closing needs no amendment.`, correction: "" }
    }
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
export function compareClosingTerms(governing: TermMap, settlement: TermMap, conflicts: GoverningTerms["conflicts"] = {}, opts: CompareOptions = {}): ClosingComparison {
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
      findings.push(compareTerm(term, synthetic ?? governing.commission_total, settlement.commission_total, price, undefined, opts))
      continue
    }
    const gov = governing[term]
    const set = settlement[term]
    // A term neither side states is not a finding at all (nothing to compare, nothing was promised) — unless the executed paper
    // CONTRADICTS ITSELF on it (wave 151, lane 151K: two executed addenda, nothing signed to order them): that is a finding for a
    // person whether or not a settlement statement states the term yet.
    if (!gov && !set && !conflicts[term]) continue
    findings.push(compareTerm(term, gov, set, price, conflicts[term], opts))
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

// ── WAVE 152 (lane 152E): the governing terms against the STRUCTURED TRANSACTION RECORD ─────────────────────────────────────
//
// Directive 152E: "→ COMPARE TO STRUCTURED TRANSACTION RECORD → COMPARE TO APPLICABLE FINANCIAL/SETTLEMENT RECORDS". The settlement
// half existed (compareClosingTerms); the record half did not: the commission engine, the CDA and the closing figures are PRICED
// FROM the deal record (transactions.purchase_price / earnest_money / closing_cost_contribution / contract_closing_date), and a deal
// record that drifted from the executed contract (a hand edit, a mirror that failed) was compared against nothing. Pure.

/** The closing terms the deal record carries, and the record column each one is (the runner reads exactly these). */
export const DEAL_RECORD_TERM_COLUMNS: Readonly<Partial<Record<ClosingTermKey, string>>> = {
  purchase_price: "purchase_price",
  earnest_money: "earnest_money",
  seller_credit: "closing_cost_contribution",
  closing_date: "contract_closing_date",
}

const RECORD_CORRECTION: Partial<Record<ClosingTermKey, string>> = {
  purchase_price: "The transaction coordinator corrects the deal's price to the executed term — or records the executed amendment that changed it, which updates the deal record itself. The signed contract is never edited here.",
  earnest_money: "The transaction coordinator corrects the deal's earnest money to the executed term, or records the executed amendment that changed it.",
  seller_credit: "The transaction coordinator corrects the deal's seller credit to the executed term, or records the executed amendment that changed it.",
  closing_date: "Record the executed contract's closing date on the deal's closing dates, or record the executed extension that moved it.",
}

/**
 * PURE — the governing executed terms against the deal record. Only a term the EXECUTED paper states is compared (a governing
 * fact that IS the deal record — a hand-built deal with no offer — is never compared with itself). Both sides stated → match or
 * contradictory (money terms block: they price the commission). The deal record silent on the PRICE the contract states → missing,
 * for review (the engine cannot price it). Formatting never matters: the values are parsed figures and calendar days.
 */
export function compareDealRecordTerms(governing: TermMap, record: TermMap): TermFinding[] {
  const out: TermFinding[] = []
  for (const term of Object.keys(DEAL_RECORD_TERM_COLUMNS) as ClosingTermKey[]) {
    const gov = governing[term]
    if (!gov || String(gov.instrumentId ?? "").startsWith("tx:")) continue
    const rec = record[term]
    const label = `${CLOSING_TERM_LABEL[term]} on the deal record`
    const base = { term, label, against: "deal_record" as const, governingSource: gov.source, settlementSource: rec?.source ?? null, correction: RECORD_CORRECTION[term] ?? "" }
    if (!rec) {
      if (term !== "purchase_price") continue
      out.push({ ...base, verdict: "unverifiable", classification: "missing", governing: formatFact(gov), settlement: null, blocking: false,
        why: `The executed contract states ${CLOSING_TERM_LABEL[term].toLowerCase()} ${formatFact(gov)}, but the deal record does not carry it — the commission and the closing figures are priced from the deal record.` })
      continue
    }
    const equal = gov.unit === "usd" && rec.unit === "usd" ? Math.abs(gov.value - rec.value) <= STATED_USD_TOLERANCE : gov.unit === rec.unit && gov.value === rec.value
    if (equal) {
      out.push({ ...base, verdict: "match", classification: "match", governing: formatFact(gov), settlement: formatFact(rec), blocking: false, why: `${label} agrees with the executed contract (${formatFact(rec)}).`, correction: "" })
      continue
    }
    out.push({ ...base, verdict: "mismatch", classification: "contradictory", governing: formatFact(gov), settlement: formatFact(rec), blocking: BLOCKING_TERMS.has(term),
      why: `The deal record says ${formatFact(rec)}; the executed contract (${gov.source}) says ${formatFact(gov)}. What is priced from the deal record — the commission, the CDA, the closing figures — would be wrong.` })
  }
  return out
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
  /** WAVE 152 (lane 152E): WHO corrects it, in words — the corrective request the runner opens names them. */
  responsible?:   string | null
}

/** WAVE 152 (lane 152E): the person / party who owes the correction, by class and by what the terms were compared against. */
function responsibleFor(f: TermFinding): string {
  if (f.against === "deal_record") return "the transaction coordinator (the deal record)"
  if (f.classification === "requires_human_interpretation") return "the responsible licensed professional or closing attorney (a person reads the instruments — nothing here interprets them)"
  if (f.classification === "missing" && !f.governing) return "the agent or transaction coordinator (upload the executed instrument that states it)"
  return "the issuer of the settlement statement / Closing Disclosure (title company or closing attorney), asked by the transaction coordinator"
}

/** PURE. A term finding as the compliance-log row it becomes. */
export function findingToLogRow(f: TermFinding): LogRowSpec {
  const status: LogStatus = f.verdict === "match" ? "pass" : f.verdict === "mismatch" ? "fail" : "needs_review"
  const record = f.against === "deal_record"
  return {
    check_type:  record ? `${CLOSING_TERM_CHECK_PREFIX}record.${f.term}` : closingTermCheckType(f.term),
    check_label: record ? `Closing: ${f.label} matches the executed contract` : `Closing: ${f.label} matches the settlement`,
    status,
    // A mismatch on a money / who-pays term holds the closing; so does executed paper that contradicts itself on one.
    is_blocking: (status === "fail" || f.verdict === "conflict") && f.blocking,
    failure_reason: status === "pass" ? null : `${f.why} ${f.correction}`.trim(),
    signature: `${f.verdict}|${f.governing ?? "-"}|${f.settlement ?? "-"}`,
    responsible: status === "pass" ? null : responsibleFor(f),
  }
}

// ── WAVE 152 (lane 152E): THE OVERRIDE RULE for a compliance-log row ───────────────────────────────────────────────────────
//
// Directive 152E: "Preserve urgent, responsible human override only when actually authorized, reasoned and audited; no
// indiscriminate 'approve all'" and "prevent falsely certifying contract compliance". A row the closing engine COMPUTES (its
// three prefixes) is CLEARED only by the comparison when the documents agree — a person marking it "pass" would certify what
// nobody verified, and the next run would re-open it anyway. A person may OVERRIDE it: WAIVE, with the override authority and a
// written reason (the same floor every override holds — OVERRIDE_REASON_MIN_CHARS), ledgered by the door. A waiver of any other
// BLOCKING row is an override too. A batch never carries a computed or a blocking row. PURE: the door hands in whether the actor
// holds the override authority.

const COMPUTED_CHECK_PREFIXES = [CLOSING_TERM_CHECK_PREFIX, CLOSING_DOC_CHECK_PREFIX, CLOSING_PARTICIPANT_CHECK_PREFIX] as const
// WAVE 153 (lane 153C, integrator): settled from the receipt ledger / the lender insurance checkpoint — cleared by evidence, never by a person
const COMPUTED_CHECK_TYPES: ReadonlySet<string> = new Set(["trid_timing", "lender_insurance_evidence"])
const isComputedCheck = (checkType: string): boolean => COMPUTED_CHECK_TYPES.has(checkType) || COMPUTED_CHECK_PREFIXES.some((p) => checkType.startsWith(p))

export function decideComplianceCheckChange(input: {
  checkType: string
  isBlocking: boolean
  toStatus: string
  /** The actor holds the override authority (the door derives it from the tenant roster — never a body field). */
  actorMayOverride: boolean
  reason?: string | null
  /** A batch request (several rows at once). */
  batch?: boolean
}): { ok: true; override: boolean } | { ok: false; reason: string } {
  const computed = isComputedCheck(input.checkType)
  if (input.batch && (computed || input.isBlocking)) {
    return { ok: false, reason: computed ? "a check the closing comparison computes is never approved in a batch — it clears when the documents agree, or one authorized person waives it with a reason" : "a blocking check is reviewed one at a time, never in a batch" }
  }
  if (computed && input.toStatus === "pass") {
    return { ok: false, reason: "this check clears only when the compared documents agree — upload the corrected statement, the executed amendment or the confirmed reading and it re-checks; an authorized reviewer may instead WAIVE it with a written reason" }
  }
  if (input.toStatus === "waived" && (computed || input.isBlocking)) {
    if (!input.actorMayOverride) return { ok: false, reason: "only a broker, a brokerage admin or the compliance officer may override a blocking compliance check" }
    if (!input.reason || input.reason.trim().length < OVERRIDE_REASON_MIN_CHARS) return { ok: false, reason: `an override needs a written reason (at least ${OVERRIDE_REASON_MIN_CHARS} characters) — it is kept as the audit record` }
    return { ok: true, override: true }
  }
  return { ok: true, override: false }
}

// ═══ WAVE 153 (lane 153D) — FINAL CLOSING COMPLIANCE: THE PURE RULE ═══════════════════════════════════════════════════════════
//
// Owner (verbatim, 2026-11-14): "when the transaction is closing and goes through a compliance review, they take charge of approving
// and making sure all docs are accurate and submitted (settlement statement and cda-if required are part of the check)". The ONE
// readiness list a closing reviewer reads (buildClosingReadiness), who may record a decision on it and when approval is refused
// (decideClosingReview), whether the review is required for this tenant (closingReviewRequired) and where the closing stands with its
// reviewer (closingReviewStanding). Pure and client-safe (no import added). The reads, the writer and the close gate are
// lib/transactions/closing-compliance.ts (loadClosingReadiness / recordClosingReviewDecision / closingReviewGate).

type ReadinessGroup = "required_documents" | "execution" | "terms" | "commission" | "settlement" | "trid" | "insurance" | "cda" | "attestation" | "document_safety" | "other_compliance"
type ReadinessState = "ready" | "open" | "blocked" | "not_applicable"

interface ReadinessItem { key: string; group: ReadinessGroup; label: string; state: ReadinessState; blocking: boolean; detail: string | null }

export const READINESS_GROUP_LABEL: Record<ReadinessGroup, string> = {
  required_documents: "Required documents", execution: "Signed and initialed", terms: "Contract terms", commission: "Commission",
  settlement: "Settlement statement / Closing Disclosure", trid: "TRID", insurance: "Insurance", cda: "CDA", attestation: "Closing question",
  document_safety: "Document safety", other_compliance: "Other compliance checks",
}

export interface ClosingReadinessInput {
  complianceRows: ReadonlyArray<{ check_type: string; check_label: string | null; status: string; is_blocking: boolean | null; failure_reason: string | null }>
  /** The CURRENT (non-superseded) documents in the deal file — their identities are part of what was approved. */
  dealFileDocumentIds: ReadonlyArray<string>
  settlement: { state: string | null; finalOnFile: boolean | null; fingerprint: string | null } | null
  trid: { tracked: boolean; deliveredDate: string | null }
  /** The deal's CDA RECORD when one exists (null = no CDA on this deal) — never the brokerage's CDA setting. */
  cda: { status: string | null; complianceApprovedAt: string | null; brokerSignedAt: string | null; deliveredAt: string | null } | null
  /** The closing question row's status (152G), or null when it was never asked. */
  attestationStatus: string | null
  /** The closing question's compliance-row type (lib/commission/closing-verification.ts CLOSING_ATTESTATION_CHECK_TYPE — passed in so this module stays client-safe). */
  attestationCheckType: string
  flaggedDocuments: ReadonlyArray<{ id: string; label: string }>
}

export interface ClosingReadiness { items: ReadinessItem[]; blocking: number; open: number; ready: boolean; fingerprint: string }

const READINESS_SIG_RE = /\[sig:([^\]]*)\]\s*$/

function readinessGroupOf(checkType: string, attestationCheckType: string): ReadinessGroup {
  if (checkType === attestationCheckType) return "attestation"
  if (checkType.startsWith("closing_docs.executed.")) return "execution"
  if (checkType.startsWith("closing_docs.")) return "required_documents"
  if (/^closing_terms\.(?:record\.|evidence\.)?commission/.test(checkType)) return "commission"
  if (checkType.startsWith("closing_terms.")) return "terms"
  if (/insurance/i.test(checkType)) return "insurance"
  if (/trid/i.test(checkType)) return "trid"
  return "other_compliance"
}

/** FNV-1a (32-bit) — a stable, dependency-free digest of the list (client-safe; the readiness card and the gate compute the same one). */
export function readinessDigest(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, "0")
}

/** PURE. The ONE readiness list a closing reviewer reads, with what holds the closing and the fingerprint an approval is pinned to. */
export function buildClosingReadiness(input: ClosingReadinessInput): ClosingReadiness {
  const items: ReadinessItem[] = []
  const ATT = input.attestationCheckType
  const reason = (r: string | null) => (r ?? "").replace(READINESS_SIG_RE, "").trim() || null
  const sigs: string[] = []
  for (const row of input.complianceRows) {
    const group = readinessGroupOf(row.check_type, ATT)
    const blockingRow = row.is_blocking === true
    // Seeded, non-blocking checks that are not part of the closing file stay on the compliance tab; the closing list carries the rest.
    if (group === "other_compliance" && !blockingRow && !row.check_type.startsWith("closing_")) continue
    const passed = row.status === "pass" || row.status === "waived"
    const state: ReadinessState = passed ? "ready" : blockingRow ? "blocked" : "open"
    items.push({ key: row.check_type, group, label: (row.check_label ?? row.check_type).replace(/^Closing:\s*/, ""), state, blocking: state === "blocked", detail: passed ? (row.status === "waived" ? "Waived by an authorized reviewer" : null) : reason(row.failure_reason) })
    sigs.push(`${row.check_type}:${row.status}:${blockingRow ? 1 : 0}:${READINESS_SIG_RE.exec(row.failure_reason ?? "")?.[1] ?? ""}`)
  }

  const s = input.settlement
  if (!s) {
    items.push({ key: "settlement.reconciled", group: "settlement", label: "The settlement record agrees with the executed contract", state: "blocked", blocking: true, detail: "No settlement statement or Closing Disclosure has been reconciled against the executed contract yet." })
  } else {
    const ok = s.state === "ready"
    items.push({ key: "settlement.reconciled", group: "settlement", label: "The settlement record agrees with the executed contract", state: ok ? "ready" : "blocked", blocking: !ok, detail: ok ? null : `Settlement check: ${String(s.state ?? "not reconciled").replace(/_/g, " ")}.` })
    items.push({ key: "settlement.final_on_file", group: "settlement", label: "The final settlement statement / Closing Disclosure is on file", state: s.finalOnFile ? "ready" : "blocked", blocking: !s.finalOnFile, detail: s.finalOnFile ? null : "Only a preliminary statement is on file — the final one from title / the lender is needed before closing." })
  }

  if (input.trid.tracked) {
    const ok = !!input.trid.deliveredDate
    items.push({ key: "trid.cd_delivered", group: "trid", label: "The Closing Disclosure delivery to the buyer is recorded", state: ok ? "ready" : "blocked", blocking: !ok, detail: ok ? `Delivered ${input.trid.deliveredDate}` : "The lender's Closing Disclosure delivery date is not on file — the three-business-day wait cannot be confirmed." })
  } else {
    items.push({ key: "trid.not_tracked", group: "trid", label: "TRID", state: "not_applicable", blocking: false, detail: "No TRID timeline on this deal (cash, or not a TRID-covered loan)." })
  }

  // THE CDA IF THIS DEAL HAS ONE — read off the deal's CDA RECORD, never the brokerage's CDA setting (lane 152H's census: no CDA setting
  // can clear a hold). Whether a deal NEEDS a CDA stays the close gate's own step (stage-progression step 5, the delivered-CDA milestone
  // under the deal's effective policy); a CDA that exists is reviewed here step by step, and one created after an approval reopens it.
  const c = input.cda
  if (c) {
    const steps: Array<[string, string, string | null, string]> = [
      ["cda.compliance_approved", "Compliance approved the CDA", c.complianceApprovedAt, "Compliance has not approved the agent's CDA yet."],
      ["cda.broker_signed", "The broker signed the CDA", c.brokerSignedAt, "The broker has not signed the approved CDA yet."],
      ["cda.delivered", "The signed CDA was delivered to title / the closing party", c.deliveredAt, "The broker-signed CDA has not been delivered to the closing party yet."],
    ]
    for (const [key, label, at, missing] of steps) items.push({ key, group: "cda", label, state: at ? "ready" : "blocked", blocking: !at, detail: at ? `Recorded ${at.slice(0, 10)}` : missing })
  } else {
    items.push({ key: "cda.none", group: "cda", label: "No CDA on this deal", state: "not_applicable", blocking: false, detail: "No CDA record exists for this deal. A deal that closes without one needs the same document, settlement and commission accuracy, and the closing question answered." })
  }
  // The closing question (152G) — asked at CDA submit with a CDA, at the gated close without one; never answered → it holds the approval.
  if (!input.complianceRows.some((r) => r.check_type === ATT)) {
    items.push({ key: ATT, group: "attestation", label: "The closing question is answered", state: "blocked", blocking: true, detail: "Before closing, the agent or TC confirms no executed change is unrecorded." })
    sigs.push(`${ATT}:unasked`)
  }

  for (const d of input.flaggedDocuments) {
    items.push({ key: `document_safety.${d.id}`, group: "document_safety", label: `${d.label}: contains text that tries to give instructions`, state: "open", blocking: false, detail: "The words were treated as data and nothing was done because of them. Check the document's readings by hand before relying on them." })
  }

  const blocking = items.filter((i) => i.blocking).length
  const open = items.filter((i) => i.state === "open").length
  const canon = [
    ...items.filter((i) => !i.key.startsWith("closing_")).map((i) => `${i.key}=${i.state}`),
    ...sigs,
    `docs=${[...input.dealFileDocumentIds].sort().join(",")}`,
    `settlement=${s?.fingerprint ?? s?.state ?? "none"}`,
  ].sort().join("|")
  return { items, blocking, open, ready: blocking === 0, fingerprint: readinessDigest(canon) }
}

// ── The reviewer's decision ─────────────────────────────────────────────────────────────────────────────────────────────────

export type ClosingReviewDecision = "approve" | "hold" | "reject"
const REVIEW_DECISION_COLOR: Record<ClosingReviewDecision, "green" | "amber" | "red"> = { approve: "green", hold: "amber", reject: "red" }
const REVIEW_NOTES_MIN = 10

/** Is the in-app review REQUIRED to close? For a tenant that is a BROKERAGE by its own plan tier (lib/errors resolveTenantPayer) — the
 *  supervising licensee's compliance staff take charge. A team / solo subscription closes on the agent's closing attestation (152G). */
export function closingReviewRequired(tenantKind: "brokerage" | "team" | "solo" | "unknown"): boolean {
  return tenantKind === "brokerage"
}

/** PURE. May this reviewer record this decision on this readiness list? Approval is refused while anything holds the closing. */
export function decideClosingReview(input: {
  readiness: ClosingReadiness
  decision: ClosingReviewDecision
  notes: string | null | undefined
  /** Decided by the I/O layer against THE reviewer roster (lib/transactions/closing-compliance.ts mayReviewClosing). */
  reviewer: { isReviewer: boolean }
}): { ok: true; color: "green" | "amber" | "red" } | { ok: false; error: string } {
  if (!input.reviewer.isReviewer) return { ok: false, error: "Only compliance, the broker or an account admin can record the closing review. Ask your compliance officer." }
  if (!REVIEW_DECISION_COLOR[input.decision]) return { ok: false, error: "Choose approve, hold or reject." }
  const notes = String(input.notes ?? "").trim()
  if (input.decision !== "approve" && notes.length < REVIEW_NOTES_MIN) return { ok: false, error: "Say what needs to change (at least a short sentence) so the agent and TC know what to fix." }
  if (input.decision === "approve" && input.readiness.blocking > 0) {
    return { ok: false, error: `${input.readiness.blocking} item${input.readiness.blocking === 1 ? " still holds" : "s still hold"} this closing. Approval is not an override — clear them (or hold the closing with a note) first.` }
  }
  return { ok: true, color: REVIEW_DECISION_COLOR[input.decision] }
}

export interface LatestClosingReview { decision: "green" | "amber" | "red"; fingerprint: string | null; notes: string | null; decidedBy: string | null; decidedAt: string | null }

export type ClosingReviewStandingState = "approved" | "reopened" | "on_hold" | "rejected" | "awaiting_review" | "not_required"

/** PURE. Where the closing stands with its reviewer — and the blocker the gated close reads (null = the review does not hold it). */
export function closingReviewStanding(input: { required: boolean; latest: LatestClosingReview | null; currentFingerprint: string }): { state: ClosingReviewStandingState; blocker: string | null } {
  const l = input.latest
  const at = l?.decidedAt ? ` on ${l.decidedAt.slice(0, 10)}` : ""
  if (l?.decision === "red") return { state: "rejected", blocker: `Final closing compliance REJECTED this closing${at}: ${l.notes ?? "see the review notes"}` }
  if (l?.decision === "amber") return { state: "on_hold", blocker: `Final closing compliance put this closing ON HOLD${at}: ${l.notes ?? "see the review notes"}` }
  if (l?.decision === "green" && l.fingerprint === input.currentFingerprint) return { state: "approved", blocker: null }
  if (l?.decision === "green") return { state: "reopened", blocker: input.required ? `Final closing compliance approved this closing${at}, but the closing file changed since (a document was corrected or added, a statement or term changed, or a check reopened) — compliance re-reviews before closing.` : null }
  return { state: input.required ? "awaiting_review" : "not_required", blocker: input.required ? "Final closing compliance has not approved this closing yet — compliance reviews the closing file and approves it before closing." : null }
}
