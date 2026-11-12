/**
 * lib/transactions/closing-compliance.ts — CLOSING COMPLIANCE, THE I/O HALF.
 *
 * Owner (wave 143): "The brokerage gives the COMPLETE list of required documents for each contract
 * type, for compliance including closing. Compliance = signatures/initials + document checks.
 * CLOSING compliance also checks that commission and contract terms match the settlement (which
 * party pays the title owner's policy, etc.); a counter supersedes the contract terms."
 *
 * WHAT THIS RUNS (one call, `runClosingCompliance`)
 *   1. TERMS   — the governing executed terms (original offer → executed counters → executed
 *                addenda; the latest executed instrument wins per term, nothing is deleted) against
 *                the settlement statement the title company / closing attorney sent
 *                (lib/transactions/closing-compliance-core.ts is the rule).
 *   2. DOCS    — the brokerage's checklist AT THE CLOSING STAGE (lib/compliance/required-documents.ts
 *                auditTransactionDocuments) and, for each signature-bearing document in the file,
 *                signatures AND initials (the creation gate's findUnexecutedDocuments).
 *   3. PEOPLE  — who the deal's STATE says belongs at the closing (lib/state-forms/closing-participants.ts).
 *
 * WHERE THE VERDICT LIVES — ON THE SURVIVOR, NOT A NEW TABLE. Every finding is a row in
 * `transaction_compliance_log` (check_type `closing_terms.*`, `closing_docs.*`,
 * `closing_participants.*`), the table the transaction's compliance tab, `canProceedToClosingPrep` and
 * `runFinalComplianceCheck` already read. So a mismatch shows on the screen the TC already works from,
 * blocks the same gate, and is resolved the same way (updateComplianceCheck: pass / waive with notes) —
 * the AUTHORIZED CORRECTION path. This module never edits a signed term, a contract, an offer or a
 * settlement statement; it writes only compliance-log rows, one audit event and a notification.
 *
 * A HUMAN'S WAIVER STANDS UNTIL THE NUMBERS MOVE. A row a person waived is left alone while the values
 * compared are the ones they waived; when a corrected statement changes a value the signature changes,
 * and the row re-opens with a note saying so.
 *
 * TRIGGERS: the scanner's post-scan hook (a settlement statement, contract, counter or addendum was
 * just read — lib/documents/scan-uploaded-document.ts), and runFinalComplianceCheck (the pre-CDA gate).
 * Idempotent: re-running with nothing changed writes nothing and notifies nobody.
 *
 * GOVERNING TERMS READER. `deps.governingTerms` is the seam for lane A's `governingContractTerms`
 * (the versioned authoritative terms record). Until it is wired this file reads the records itself
 * (offers chain, executed contract / counter / addendum documents) through the same precedence rule.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
// Lane 144D's concession vocabulary (lib/commission/agent-concession.ts, m850) — TYPES only, so a renamed status or treatment
// breaks the build here instead of silently matching nothing (CLAUDE.md §6).
import type { AgentConcessionApprovalStatus, ConcessionSettlementTreatment } from "@/lib/commission/agent-concession"
// WAVE 151 (lane 151K): the ONE reader's "two executed addenda contradict each other" shape — TYPE only (the rule is pure).
// WAVE 152 (lane 152E): + the term ledger's row shape and the ONE per-term evidence rule (re-asked of the document's current readings).
import { termEvidenceFor, type UnresolvedTermConflict, type TermLedgerRow } from "@/lib/offers/governing-terms-rule"
import { isValidUUID } from "@/lib/validations"
import { auditTransactionDocuments } from "@/lib/compliance/required-documents"
import { documentClassificationLabel } from "@/lib/compliance/required-documents"
import { financingKindFor } from "@/lib/compliance/checklist-dimensions"
import { evaluateExecution } from "@/lib/compliance/signature-completeness"
import { assessClosingParticipants, closingPolicyAgeDays, VERIFY_EVERY_DAYS } from "@/lib/state-forms/closing-participants"
import {
  CLOSING_DOC_CHECK_PREFIX,
  CLOSING_PARTICIPANT_CHECK_PREFIX,
  CLOSING_TERM_CHECK_PREFIX,
  CONTRACT_FIELD_TO_TERM,
  SETTLEMENT_FIELD_TO_TERM,
  DEAL_RECORD_TERM_COLUMNS,
  compareClosingTerms,
  compareDealRecordTerms,
  findingToLogRow,
  parseDateOnly,
  parseParty,
  parseUsd,
  superimposeGoverningTerms,
  CLOSING_TERM_KEYS,
  type ClosingComparison,
  type Confidence,
  type GoverningTerms,
  type LogRowSpec,
  type SettlementSnapshot,
  type TermConflict,
  type TermFact,
  type TermFinding,
  type TermMap,
  type TermsInstrument,
  type ClosingTermKey,
  type InstrumentKind,
} from "./closing-compliance-core"

type Svc = SupabaseClient<any, any, any>

// ── Row shapes (hoisted: scripts/tenant-scope-guard.ts reads the 500 characters after `.from("<table>")`) ──

const TX_COLUMNS = "id, brokerage_id, offer_id, listing_id, deal_type, agent_id, buyer_agent_id, seller_agent_id, property_state, financing_type, purchase_price, close_date, earnest_money, closing_cost_contribution, listing_offered_commission_percentage, contract_date, buyer_contact_id, seller_contact_id, contact_id, contract_closing_date, contract_closing_terms, contract_closing_source"
const OFFER_COLUMNS = "id, parent_offer_id, current_round, offer_type, offer_number, offer_price, earnest_money, closing_date, closing_cost_contribution, disclosed_buyer_commission_pct, disclosed_buyer_commission_flat, esign_status, buyer_signed_at, seller_signed_at, fully_signed_contract_received_at, created_at, updated_at, brokerage_id"
const DOC_COLUMNS = "id, classification, classification_confidence, signature_completeness, extracted_fields, metadata, created_at, updated_at, transaction_id"

export interface TransactionRow {
  id: string
  brokerage_id: string
  offer_id: string | null
  listing_id: string | null
  deal_type: string | null
  agent_id: string | null
  buyer_agent_id: string | null
  seller_agent_id: string | null
  property_state: string | null
  financing_type: string | null
  purchase_price: number | null
  close_date: string | null
  earnest_money: number | null
  closing_cost_contribution: number | null
  listing_offered_commission_percentage: number | null
  contract_date: string | null
  buyer_contact_id: string | null
  seller_contact_id: string | null
  contact_id: string | null
  /** WAVE 152 (lane 152E): the contractual closing date the governed writer holds, how the contract words it, and what set it. */
  contract_closing_date?: string | null
  contract_closing_terms?: string | null
  contract_closing_source?: string | null
}

/** The seam for lane A's `governingContractTerms`; the default reads the records. `unresolvedTerms` (wave 151, lane 151K): the closing
 *  terms two executed addenda / amendments contradict each other on with nothing signed to order them — filed as conflicts. */
export type GoverningTermsReader = (svc: Svc, tx: TransactionRow) => Promise<{ ok: true; governing: GoverningTerms; unresolvedTerms?: ClosingTermKey[] } | { ok: false; error: string }>

export interface RunClosingComplianceInput {
  transactionId: string
  /** THE SESSION'S (or the verified row's) tenant — never a request body's. */
  brokerageId: string
  /** wave 145: "contract_addendum" — an executed addendum / amendment changed the governing terms (compliance re-review,
   *  lib/offers/governing-terms-consequences.ts). */
  trigger: "settlement_scanned" | "contract_document_scanned" | "final_check" | "manual" | "contract_addendum"
  actorUserId?: string | null
  /**
   * WAVE 151 (lane 151K — "re-run compliance … ONLY for changed terms"): on a `contract_addendum` trigger, the governing term keys
   * the executed instrument changed. The run then compares ONLY the closing terms those keys reach, writes only their rows, and
   * leaves the document / participant checks and every other term's row as they were. Absent → the full run (every other trigger).
   */
  changedTerms?: string[]
  /**
   * WAVE 151 (lane 151K): contradictions the ONE reader reported for this instrument (two executed addenda / amendments disagree
   * on a term with nothing signed to order them). Each is filed as a BLOCKING `conflict` row for a person — with or without a
   * settlement statement on file. The reader's own `unresolved` is read here too, so a lingering contradiction is filed on every run.
   */
  unresolved?: UnresolvedTermConflict[]
}

export interface RowWriteCounts { inserted: number; updated: number; unchanged: number; reopened: number }

export interface ClosingComplianceOutcome {
  ran: boolean
  /** Why it did not run, or what is still open. */
  reason: string | null
  governingOnFile: boolean
  settlementOnFile: boolean
  comparison: ClosingComparison | null
  rows: RowWriteCounts
  /** Open (fail / needs_review) closing rows after this run. */
  openBlocking: number
  openReview: number
  notified: number
  /** One line per open finding — what a TC reads. */
  summary: string[]
  /** The subset that HOLDS the closing (blocking rows), for the pre-CDA gate. */
  blockingSummary: string[]
  /** An unsupported state's question, or null. */
  stateQuestion: string | null
  /** WAVE 152 (lane 152E): the executed terms against the deal record (empty when that side did not run). */
  recordComparison: TermFinding[]
  /** WAVE 152 (lane 152E): executed terms held because their reading on the signed document is not confirmed. */
  evidenceHolds: number
  /** WAVE 152 (lane 152E): the corrective requests opened / refreshed / settled by this run. */
  corrections: { opened: number; refreshed: number; completed: number; errors: string[] }
}

const empty = (reason: string): ClosingComplianceOutcome => ({
  ran: false, reason, governingOnFile: false, settlementOnFile: false, comparison: null,
  rows: { inserted: 0, updated: 0, unchanged: 0, reopened: 0 }, openBlocking: 0, openReview: 0, notified: 0, summary: [], blockingSummary: [], stateQuestion: null,
  recordComparison: [], evidenceHolds: 0, corrections: { opened: 0, refreshed: 0, completed: 0, errors: [] },
})

// ── Facts out of extraction rows ───────────────────────────────────────────────

interface LedgerRow { document_id: string; field_key: string; field_value_json: unknown; confidence: string | null; verified_at: string | null }

const asConfidence = (c: string | null | undefined, verifiedAt: string | null | undefined): Confidence =>
  verifiedAt ? "verified" : c === "high" || c === "medium" || c === "low" ? c : "low"

function coerceFact(unit: TermFact["unit"], raw: unknown, confidence: Confidence, source: string, instrumentId: string | null, executedAt: string | null): TermFact | null {
  if (unit === "usd") { const v = parseUsd(raw); return v === null ? null : { unit, value: v, confidence, source, instrumentId, executedAt } }
  if (unit === "pct") { const v = parseUsd(raw); return v === null ? null : { unit, value: v, confidence, source, instrumentId, executedAt } }
  if (unit === "date") { const v = parseDateOnly(raw); return v === null ? null : { unit, value: v, confidence, source, instrumentId, executedAt } }
  const v = parseParty(raw); return v === null ? null : { unit, value: v, confidence, source, instrumentId, executedAt }
}

/** Ledger rows for a set of documents, tenant-pinned. A refused read is an error, never "no facts". */
async function readLedger(svc: Svc, brokerageId: string, documentIds: string[]): Promise<{ ok: true; rows: LedgerRow[] } | { ok: false; error: string }> {
  if (documentIds.length === 0) return { ok: true, rows: [] }
  const { data, error } = await svc
    .from("document_field_extractions")
    .select("document_id, field_key, field_value_json, confidence, verified_at")
    .eq("brokerage_id", brokerageId)
    .in("document_id", documentIds)
  if (error) return { ok: false, error: `extraction ledger could not be read: ${error.message}` }
  return { ok: true, rows: (data ?? []) as LedgerRow[] }
}

/** One document's facts: the verified/ledger value for a key if present, else the scan blob's. */
function documentFacts(
  doc: { id: string; extracted_fields: unknown; classification_confidence: string | null },
  ledger: LedgerRow[],
  mapping: Readonly<Record<string, { term: ClosingTermKey; unit: TermFact["unit"] }>>,
  source: string,
  executedAt: string | null,
): TermMap {
  const out: TermMap = {}
  const blob = doc.extracted_fields && typeof doc.extracted_fields === "object" && !Array.isArray(doc.extracted_fields) ? (doc.extracted_fields as Record<string, unknown>) : {}
  const mine = ledger.filter((l) => l.document_id === doc.id)
  for (const [key, { term, unit }] of Object.entries(mapping)) {
    const row = mine.find((l) => l.field_key === key)
    const raw = row ? row.field_value_json : blob[key]
    if (raw === undefined || raw === null || raw === "") continue
    const confidence = row ? asConfidence(row.confidence, row.verified_at) : asConfidence(doc.classification_confidence, null)
    const fact = coerceFact(unit, raw, confidence, source, doc.id, executedAt)
    // Two keys can map to one term (price / counter_price): the first one stated wins within a document.
    if (fact && !out[term]) out[term] = fact
  }
  return out
}

// ── Governing terms: the default reader ─────────────────────────────────────────

const EXECUTED_ESIGN = new Set(["fully_executed", "fully_signed"])

function offerInstrument(o: Record<string, any>, isAccepted: boolean, label: string): TermsInstrument {
  const executed = isAccepted || EXECUTED_ESIGN.has(String(o.esign_status ?? "")) || (!!o.buyer_signed_at && !!o.seller_signed_at)
  // The moment it was SIGNED — never `updated_at`, which moves whenever anything touches the row and would
  // let a later edit re-order the negotiation. No signature timestamp → null; the round orders the chain.
  const executedAt: string | null = (o.fully_signed_contract_received_at as string | null) ?? (o.seller_signed_at as string | null) ?? null
  const terms: TermMap = {}
  const src = `${label} (offer record)`
  const put = (k: ClosingTermKey, f: TermFact | null) => { if (f) terms[k] = f }
  const price = parseUsd(o.offer_price)
  if (price !== null && price > 0) put("purchase_price", { unit: "usd", value: price, confidence: "record", source: src, instrumentId: o.id, executedAt })
  const em = parseUsd(o.earnest_money)
  if (em !== null && em > 0) put("earnest_money", { unit: "usd", value: em, confidence: "record", source: src, instrumentId: o.id, executedAt })
  const cd = parseDateOnly(o.closing_date)
  if (cd) put("closing_date", { unit: "date", value: cd, confidence: "record", source: src, instrumentId: o.id, executedAt })
  const credit = parseUsd(o.closing_cost_contribution)
  if (credit !== null && credit > 0) put("seller_credit", { unit: "usd", value: credit, confidence: "record", source: src, instrumentId: o.id, executedAt })
  const pct = parseUsd(o.disclosed_buyer_commission_pct)
  const flat = parseUsd(o.disclosed_buyer_commission_flat)
  if (flat !== null && flat > 0) put("commission_buyer_side", { unit: "usd", value: flat, confidence: "record", source: src, instrumentId: o.id, executedAt })
  else if (pct !== null && pct > 0) put("commission_buyer_side", { unit: "pct", value: pct, confidence: "record", source: src, instrumentId: o.id, executedAt })
  return {
    id: String(o.id), kind: o.parent_offer_id ? "counter" : "original_offer", label, executed, executedAt,
    round: typeof o.current_round === "number" ? o.current_round : null, terms,
  }
}

async function loadOfferInstruments(svc: Svc, tx: TransactionRow): Promise<{ ok: true; instruments: TermsInstrument[]; chainIds: string[] } | { ok: false; error: string }> {
  if (!tx.offer_id || !isValidUUID(tx.offer_id)) return { ok: true, instruments: [], chainIds: [] }
  // THE WHOLE CHAIN, THROUGH THE ONE CHAIN WALK (wave 144, lane 144C — owner ruling 2). This used to read the accepted row's
  // PARENT as "the root" and then only that root's direct children — so a round-3 counter lost the original offer (its parent is
  // round 2, not the root) — and it marked EVERY row sorted before the accepted one as "incorporated", which made a REJECTED or
  // never-accepted sibling counter an executed baseline whose terms could govern a term the accepted counter does not restate.
  // "Unaccepted counters never become terms … the authoritative terms come from the actually accepted sequence, not the latest
  // draft." Now: the chain is read root-to-leaves at any depth (lib/offers/governing-terms.ts loadOfferChainRows), and only the
  // instruments the accepted row INCORPORATES (lib/offers/governing-terms-rule.ts sequenceThrough — its path from the root minus
  // void ancestors, the same reading the terms record uses) are executed. Every other row is kept and shown, never terms.
  const { loadOfferChainRows } = await import("@/lib/offers/governing-terms")
  const { sequenceThrough } = await import("@/lib/offers/governing-terms-rule")
  const chain = await loadOfferChainRows(svc as any, String(tx.brokerage_id ?? ""), tx.offer_id, OFFER_COLUMNS.split(",").map((c) => c.trim()))
  if (!chain.ok) return { ok: false, error: `the offer / counter chain could not be read: ${chain.reason}` }
  if (chain.rows.length === 0) return { ok: true, instruments: [], chainIds: [] }
  const rows = ([...chain.rows] as Array<Record<string, any>>).sort((a, b) =>
    (Number(a.current_round ?? 1) - Number(b.current_round ?? 1)) || String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))
  // The offer the transaction was created from is executed by definition (the creation gate refuses an offer that is not fully
  // executed); the instruments it incorporates are the lower-precedence baseline under it.
  const incorporates = new Set(sequenceThrough(chain.rows, tx.offer_id) ?? [tx.offer_id])
  const instruments = rows.map((o) => {
    const accepted = o.id === tx.offer_id
    const incorporated = !accepted && incorporates.has(String(o.id))
    const base = o.parent_offer_id ? `counter, round ${o.current_round ?? "?"}` : "original offer"
    const label = accepted ? `${base} (accepted)` : incorporated ? `${base} (incorporated by the executed counter)` : `${base} (not part of the accepted sequence — kept, never governs)`
    return offerInstrument(o, accepted || incorporated, label)
  })
  return { ok: true, instruments, chainIds: rows.map((o) => String(o.id)) }
}

/** Executed contract / counter / addendum DOCUMENTS filed on the deal — the signed paper behind the records. */
async function loadDocumentInstruments(svc: Svc, tx: TransactionRow, chainIds: string[]): Promise<{ ok: true; instruments: TermsInstrument[] } | { ok: false; error: string }> {
  const { data, error } = await svc
    .from("documents")
    .select(DOC_COLUMNS)
    .eq("brokerage_id", tx.brokerage_id)
    .eq("transaction_id", tx.id)
    .in("classification", ["signed_contract", "counter_offer", "addendum"])
    .order("created_at", { ascending: true })
  if (error) return { ok: false, error: `the deal's contract documents could not be read: ${error.message}` }
  const docs = (data ?? []) as Array<Record<string, any>>
  void chainIds
  const ledger = await readLedger(svc, tx.brokerage_id, docs.map((d) => String(d.id)))
  if (!ledger.ok) return ledger
  const instruments: TermsInstrument[] = docs.map((d, i) => {
    // A counter / addendum AGREES the terms once BOTH parties have signed. Missing initials are a
    // separate finding (closing_docs.executed.*) — they must not make a signed amendment vanish from the
    // precedence walk and turn the amended figure into a false mismatch. The ONE predicate is used; only
    // its INITIALS lines are tolerated here.
    const raw = evaluateExecution(d.signature_completeness, ["buyer", "seller"])
    const verdict = { executed: raw.missing.every((m) => m.endsWith("initials")) }
    const kind = d.classification === "signed_contract" ? "executed_contract" : d.classification === "counter_offer" ? "counter" : "addendum"
    const f = (d.extracted_fields && typeof d.extracted_fields === "object" ? d.extracted_fields : {}) as Record<string, unknown>
    // The date it became executed, when the scan read one; otherwise null so the kind ladder orders it.
    const dates = Array.isArray(f.signed_dates) ? (f.signed_dates as unknown[]).map(parseDateOnly).filter((x): x is string => !!x).sort() : []
    const executedAt = (dates.length ? dates[dates.length - 1] : parseDateOnly(f.seller_signed_at) ?? parseDateOnly(f.contract_effective_date)) ?? null
    const label = `${documentClassificationLabel(d.classification)} on file${executedAt ? ` (${executedAt})` : ""}`
    return {
      id: String(d.id), kind, label, executed: verdict.executed, executedAt, round: i,
      terms: documentFacts({ id: String(d.id), extracted_fields: d.extracted_fields, classification_confidence: d.classification_confidence ?? null }, ledger.rows, CONTRACT_FIELD_TO_TERM, label, executedAt),
    }
  })
  return { ok: true, instruments }
}

/** The listing-side commission the brokerage contracted for: the transaction's recorded offer, else the listing's rate. */
async function loadListingSideInstrument(svc: Svc, tx: TransactionRow): Promise<{ ok: true; instrument: TermsInstrument | null } | { ok: false; error: string }> {
  if (tx.deal_type === "buyer") return { ok: true, instrument: null } // the listing belongs to another brokerage
  let pct = parseUsd(tx.listing_offered_commission_percentage)
  let source = "transaction record (listing-offered commission)"
  if ((pct === null || pct <= 0) && tx.listing_id && isValidUUID(tx.listing_id)) {
    const { data, error } = await svc
      .from("listings")
      .select("id, commission_rate")
      .eq("id", tx.listing_id)
      .eq("brokerage_id", tx.brokerage_id)
      .maybeSingle()
    if (error) return { ok: false, error: `the listing's commission could not be read: ${error.message}` }
    pct = parseUsd((data as { commission_rate?: unknown } | null)?.commission_rate)
    source = "listing record (listing agreement commission rate)"
  }
  if (pct === null || pct <= 0) return { ok: true, instrument: null }
  return { ok: true, instrument: {
    id: `listing:${tx.listing_id ?? tx.id}`, kind: "listing_agreement", label: "listing agreement", executed: true, executedAt: null, round: null,
    terms: { commission_listing_side: { unit: "pct", value: pct, confidence: "record", source } },
  } }
}

/**
 * THE APPROVED AGENT CONCESSIONS on the deal (wave 144, lane 144C — handed over by lane 144D Outside-lane 5; owner ruling 4: an agent
 * concession is a credit the AGENT gives, subtracted from THAT agent's gross commission, approved by the broker where the brokerage
 * requires it). Read from lane 144D's ONE record — commission_adjustments (applies_to 'gross', direction 'credit', m850's
 * settlement_treatment / approval_status) — and stated as ONE instrument carrying the governing `agent_credit`: the sum of the
 * ACTIVE, broker-APPROVED (or no-approval-required) FLAT credits to the BUYER that settle as a closing-statement credit. Never the
 * seller credit; never a requested, denied or withdrawn concession (a statement showing one is a finding, not a match).
 * A PERCENT concession's dollar figure is the commission engine's (it depends on the gross), so it is not restated here: when one
 * exists the term is NOT stated at all rather than half-stated (a partial sum would accuse a correct statement). A refused read
 * is an error (fail closed), never "no concessions".
 */
const CONCESSION_APPLIES: ReadonlySet<AgentConcessionApprovalStatus> = new Set<AgentConcessionApprovalStatus>(["approved", "not_required"])
const STATEMENT_CREDIT: ConcessionSettlementTreatment = "closing_statement_credit"
async function loadApprovedAgentConcessionInstrument(svc: Svc, tx: TransactionRow): Promise<{ ok: true; instrument: TermsInstrument | null } | { ok: false; error: string }> {
  const { data, error } = await svc
    .from("commission_adjustments")
    .select("*")
    .eq("brokerage_id", tx.brokerage_id)
    .eq("transaction_id", tx.id)
    .eq("applies_to", "gross")
    .eq("direction", "credit")
  if (error) return { ok: false, error: `the deal's agent concessions could not be read: ${error.message}` }
  const credits = ((data ?? []) as Array<Record<string, any>>).filter((r) =>
    r.is_active !== false && r.settlement_treatment === STATEMENT_CREDIT && (r.recipient_type === "buyer" || r.recipient_type === "seller")
    && CONCESSION_APPLIES.has(String(r.approval_status ?? "not_required") as AgentConcessionApprovalStatus))
  if (credits.length === 0) return { ok: true, instrument: null }
  // WAVE 145 (lane 145C — 144C Still open 3): a PERCENT concession's dollars are the ENGINE's (they depend on the gross) — read
  // from the latest calculation's evidence (commission_calculations.breakdown_json.agent_concessions, stage 03's own record of
  // what it applied), never recomputed here. No calculation yet, or the row not applied there → that side's term is not stated
  // (a partial sum would accuse a correct statement).
  let engineApplied: Map<string, number> | null = null
  if (credits.some((r) => r.value_type !== "flat")) {
    const { data: calc, error: cErr } = await svc
      .from("commission_calculations")
      .select("breakdown_json, calculated_at")
      .eq("brokerage_id", tx.brokerage_id)
      .eq("transaction_id", tx.id)
      .order("calculated_at", { ascending: false })
      .limit(1)
    if (cErr) return { ok: false, error: `the commission calculation behind a percent concession could not be read: ${cErr.message}` }
    const evidence = (((calc ?? [])[0] as { breakdown_json?: { agent_concessions?: Array<Record<string, unknown>> } } | undefined)?.breakdown_json?.agent_concessions) ?? []
    engineApplied = new Map(evidence.filter((e) => e.verdict === "applied" && typeof e.adjustment_id === "string").map((e) => [String(e.adjustment_id), Math.abs(Number(e.signed_amount ?? 0))]))
  }
  const dollarsOf = (r: Record<string, any>): number | null => r.value_type === "flat" ? Number(r.value ?? 0) : (engineApplied?.get(String(r.id)) ?? null)
  const terms: TermMap = {}
  for (const [side, term] of [["buyer", "agent_credit"], ["seller", "agent_credit_seller"]] as const) {
    const mine = credits.filter((r) => r.recipient_type === side)
    if (mine.length === 0) continue
    const amounts = mine.map(dollarsOf)
    if (amounts.some((a) => a === null)) continue
    const total = Math.round((amounts as number[]).reduce((s, a) => s + a, 0) * 100) / 100
    if (!(total > 0)) continue
    terms[term] = { unit: "usd", value: total, confidence: "record", source: `commission_adjustments ${mine.map((r) => r.id).join(", ")} (broker-approved agent concession${mine.some((r) => r.value_type !== "flat") ? "; percent concessions at the commission engine's applied amount" : ""})` }
  }
  if (Object.keys(terms).length === 0) return { ok: true, instrument: null }
  const decided = credits.map((r) => (r.approval_decided_at as string | null) ?? null).filter((d): d is string => !!d).sort()
  return { ok: true, instrument: {
    id: `concessions:${tx.id}`, kind: "approved_concession", label: "approved agent concession(s) — credit off the agent's gross commission",
    executed: true, executedAt: decided.length ? decided[decided.length - 1] : null, round: null,
    terms,
  } }
}

/**
 * WAVE 145 (lane 145C — owner ruling 5): the VERIFIED client-agreement fees that settle as their own lines (verified against the
 * executed listing / buyer-broker agreement, brokerage policy permits, payable at closing, NOT already inside the commission),
 * per payer and kind — through the ONE resolver (lib/commission/client-agreement-fees.ts). A refused read is an error (fail
 * closed); m859 not applied yet → no instrument (said by the resolver's own finding), never a guess.
 */
async function loadClientAgreementFeeInstrument(svc: Svc, tx: TransactionRow): Promise<{ ok: true; instrument: TermsInstrument | null } | { ok: false; error: string }> {
  const { loadClientAgreementFeesForTransaction, CLIENT_FEE_SETTLEMENT_TERM } = await import("@/lib/commission/client-agreement-fees")
  const r = await loadClientAgreementFeesForTransaction(svc as never, tx.brokerage_id, tx.id)
  if (!r.ok) return { ok: false, error: `the client-agreement fees could not be read: ${r.error}` }
  if (!r.available) return { ok: true, instrument: null }
  const terms: TermMap = {}
  for (const payer of ["seller", "buyer"] as const) {
    for (const [kind, amount] of Object.entries(r.resolution.settlementTotals[payer]) as Array<["transaction_fee" | "admin_fee", number]>) {
      if (!(amount > 0)) continue
      const term = CLIENT_FEE_SETTLEMENT_TERM[payer][kind] as ClosingTermKey
      const ids = r.resolution.fees.filter((f) => f.payer === payer && f.kind === kind && f.settlesAsOwnLine).map((f) => f.feeId).join(", ")
      terms[term] = { unit: "usd", value: amount, confidence: "record", source: `client_agreement_fees ${ids} (verified against the executed ${payer === "seller" ? "listing" : "buyer-broker"} agreement)` }
    }
  }
  if (Object.keys(terms).length === 0) return { ok: true, instrument: null }
  return { ok: true, instrument: { id: `client-fees:${tx.id}`, kind: "client_agreement_fee", label: "verified client-agreement fees (listing / buyer-broker agreement)", executed: true, executedAt: null, round: null, terms } }
}

/** DEFAULT READER — superimposes the offer chain, the executed documents and the listing-side commission. */
/** lane A's term key → this file's closing term (+ unit). Both spellings of a usd amount are admitted; the first hit wins. */
const RECORD_KEY_MAP: ReadonlyArray<readonly [string, ClosingTermKey, "usd" | "pct" | "date" | "party"]> = [
  ["offer_price", "purchase_price", "usd"], ["purchase_price", "purchase_price", "usd"],
  ["earnest_money", "earnest_money", "usd"], ["closing_date", "closing_date", "date"],
  ["closing_cost_contribution", "seller_credit", "usd"], ["seller_credit", "seller_credit", "usd"],
  ["title_policy_payer", "owner_title_policy_payer", "party"],
  ["buyer_agent_commission_flat", "commission_buyer_side", "usd"], ["buyer_agent_commission_pct", "commission_buyer_side", "pct"],
]
/**
 * WAVE 151 (lane 151K): the ONE reader's unresolved contradictions (two executed addenda / amendments disagree on a governing term
 * and nothing signed orders them) as the comparison's own `conflict` facts — two record-confidence facts, NEITHER governing. The
 * comparison then files a blocking `conflict` row for a person; nothing here picks one.
 */
function unresolvedToClosingConflicts(unresolved: ReadonlyArray<UnresolvedTermConflict>): Partial<Record<ClosingTermKey, TermConflict>> {
  const out: Partial<Record<ClosingTermKey, TermConflict>> = {}
  for (const u of unresolved) {
    const map = RECORD_KEY_MAP.find(([from]) => from === u.key)
    if (!map) continue
    const [, to, unit] = map
    const facts = u.versions
      .map((v) => coerceFact(unit, v.value, "record", `${v.source} ${v.versionNo} (executed ${(v.executedAt ?? "").slice(0, 10) || "—"}${v.effectiveAt ? `, effective ${v.effectiveAt.slice(0, 10)}` : ""})`, `record:${v.source}:v${v.versionNo}`, v.executedAt))
      .filter((f): f is TermFact => !!f)
    if (facts.length < 2 || out[to]) continue
    out[to] = { winner: facts[facts.length - 1], loser: facts[0] }
  }
  return out
}

/** The closing terms a set of governing term keys reaches (through RECORD_KEY_MAP; a key already in the closing vocabulary maps to itself). */
function closingTermsFor(governingKeys: readonly string[]): Set<ClosingTermKey> {
  const out = new Set<ClosingTermKey>()
  for (const k of governingKeys) {
    for (const [from, to] of RECORD_KEY_MAP) if (from === k) out.add(to)
    if ((CLOSING_TERM_KEYS as readonly string[]).includes(k)) out.add(k as ClosingTermKey)
  }
  // WAVE 152 (lane 152E — "RECOMPUTE DEPENDENT FIELDS"): a percentage commission's DOLLARS are the governing price times its rate, so
  // an executed price change re-judges the commission lines too (the changed-terms-only re-check had left them on the old price).
  if (out.has("purchase_price")) for (const dep of ["commission_listing_side", "commission_buyer_side", "commission_total"] as const) out.add(dep)
  return out
}

/** The authoritative versioned record (lib/offers/governing-terms.ts) as ONE executed instrument; null when nothing governs
 *  or the record is unreadable (said on the console — the instruments alone then decide, never a silent "no terms").
 *  WAVE 151 (lane 151K): also the record's UNRESOLVED contradictions as closing conflicts (empty when none). */
async function recordedTermsInstrument(svc: Svc, tx: TransactionRow): Promise<{ instrument: TermsInstrument | null; conflicts: Partial<Record<ClosingTermKey, TermConflict>> }> {
  try {
    const { governingContractTerms } = await import("@/lib/offers/governing-terms")
    const r = await governingContractTerms(svc as any, String(tx.brokerage_id ?? ""), { transactionId: tx.id })
    if (!r.ok || !r.governing.governingVersion) return { instrument: null, conflicts: {} }
    const conflicts = unresolvedToClosingConflicts(r.governing.unresolved ?? [])
    const terms: TermMap = {}
    let executedAt: string | null = null
    const recordTerms = r.governing.terms as Record<string, { value: unknown; versionNo: number; source: string; executedAt: string | null } | undefined>
    for (const [from, to, unit] of RECORD_KEY_MAP) {
      if (terms[to]) continue
      const g = recordTerms[from]
      if (!g || g.value == null) continue
      const source = `contract_term_versions v${g.versionNo} (${g.source})`
      if (g.executedAt && (!executedAt || g.executedAt > executedAt)) executedAt = g.executedAt
      if (unit === "usd" || unit === "pct") {
        const n = typeof g.value === "number" ? g.value : parseUsd(g.value as string)
        if (n === null || !Number.isFinite(n)) continue
        terms[to] = { unit, value: n, confidence: "record", source, executedAt: g.executedAt } as TermFact
      } else if (unit === "date") {
        const d = parseDateOnly(g.value as string); if (!d) continue
        terms[to] = { unit: "date", value: d, confidence: "record", source, executedAt: g.executedAt }
      } else {
        const p = parseParty(g.value as string); if (!p) continue
        terms[to] = { unit: "party", value: p, confidence: "record", source, executedAt: g.executedAt }
      }
    }
    if (Object.keys(terms).length === 0) return { instrument: null, conflicts }
    const gv = r.governing.governingVersion
    const kind: InstrumentKind = gv.source === "offer" ? "original_offer" : gv.source === "counter" ? "counter" : "addendum"
    // wave 152 (lane 152E): the label is read by a TC in a corrective request ("the value executed addendum 2 replaced"), so it is plain words
    return { instrument: { id: `record:${gv.source}:v${gv.versionNo}`, kind, label: gv.source === "offer" ? "executed contract (contract terms record)" : `executed ${gv.source} ${gv.versionNo} (contract terms record)`, executed: true, executedAt, terms }, conflicts }
  } catch (e) {
    console.warn("[closing-compliance] authoritative terms record unreadable — the instruments alone decide:", e instanceof Error ? e.message : String(e))
    return { instrument: null, conflicts: {} }
  }
}

const readGoverningTermsFromRecords: GoverningTermsReader = async (svc, tx) => {
  const offers = await loadOfferInstruments(svc, tx)
  if (!offers.ok) return offers
  const docs = await loadDocumentInstruments(svc, tx, offers.chainIds)
  if (!docs.ok) return docs
  const listing = await loadListingSideInstrument(svc, tx)
  if (!listing.ok) return listing

  const concessions = await loadApprovedAgentConcessionInstrument(svc, tx)
  if (!concessions.ok) return concessions
  const clientFees = await loadClientAgreementFeeInstrument(svc, tx)
  if (!clientFees.ok) return clientFees

  const instruments: TermsInstrument[] = [...offers.instruments, ...docs.instruments]
  if (listing.instrument) instruments.push(listing.instrument)
  if (concessions.instrument) instruments.push(concessions.instrument)
  if (clientFees.instrument) instruments.push(clientFees.instrument)
  // Wave 143 integration (one canonical path, CLAUDE.md law 2): lane A's VERSIONED record — contract_term_versions
  // plus the offer chain (lib/offers/governing-terms.ts governingContractTerms) — is the authoritative terms record;
  // an executed counter / addendum recorded there supersedes what the instruments above say. It rides in as ONE
  // executed instrument so the superimposition rule below stays the only precedence rule.
  const recorded = await recordedTermsInstrument(svc, tx)
  if (recorded.instrument) instruments.push(recorded.instrument)
  // No offer on the transaction (a hand-built one): the transaction's own recorded terms, labelled as such.
  if (offers.instruments.length === 0) {
    const t = tx
    const terms: TermMap = {}
    const src = "transaction record"
    const p = parseUsd(t.purchase_price); if (p !== null && p > 0) terms.purchase_price = { unit: "usd", value: p, confidence: "record", source: src }
    const e = parseUsd(t.earnest_money); if (e !== null && e > 0) terms.earnest_money = { unit: "usd", value: e, confidence: "record", source: src }
    const c = parseDateOnly(t.close_date); if (c) terms.closing_date = { unit: "date", value: c, confidence: "record", source: src }
    const cr = parseUsd(t.closing_cost_contribution); if (cr !== null && cr > 0) terms.seller_credit = { unit: "usd", value: cr, confidence: "record", source: src }
    if (Object.keys(terms).length > 0) instruments.push({ id: `tx:${t.id}`, kind: "original_offer", label: "transaction record", executed: true, executedAt: t.contract_date, round: null, terms })
  }
  const governing = superimposeGoverningTerms(instruments)
  // WAVE 151 (lane 151K): a term two executed addenda contradict each other on has NO governing value — whatever an earlier
  // instrument said, the comparison sees the contradiction (a blocking `conflict` row), never a confident match.
  const unresolvedTerms: ClosingTermKey[] = []
  for (const [k, c] of Object.entries(recorded.conflicts) as Array<[ClosingTermKey, TermConflict]>) {
    governing.conflicts[k] = c
    delete governing.terms[k]
    unresolvedTerms.push(k)
  }
  return { ok: true, governing, unresolvedTerms }
}

// ── Settlement snapshot ─────────────────────────────────────────────────────────

async function loadSettlement(svc: Svc, tx: TransactionRow): Promise<{ ok: true; snapshot: SettlementSnapshot } | { ok: false; error: string }> {
  const { data: cda, error: cdaErr } = await svc
    .from("closing_disclosure_agreement")
    .select("id, preliminary_cd_document_id, final_cd_document_id, brokerage_id")
    .eq("brokerage_id", tx.brokerage_id)
    .eq("transaction_id", tx.id)
    .order("updated_at", { ascending: false })
    .limit(1)
  if (cdaErr) return { ok: false, error: `the CDA's settlement documents could not be read: ${cdaErr.message}` }
  const cdaRow = ((cda ?? [])[0] ?? null) as { preliminary_cd_document_id: string | null; final_cd_document_id: string | null } | null

  const { data, error } = await svc
    .from("documents")
    .select(DOC_COLUMNS)
    .eq("brokerage_id", tx.brokerage_id)
    .eq("transaction_id", tx.id)
    .in("classification", ["closing_disclosure", "preliminary_closing_statement"])
    .order("created_at", { ascending: false })
    .limit(8)
  if (error) return { ok: false, error: `the settlement statements could not be read: ${error.message}` }
  type SettlementDocRow = { id: string; classification: string; classification_confidence: string | null; extracted_fields: unknown; stage: "final" | "preliminary" | "unlabeled" }
  const docs: SettlementDocRow[] = ((data ?? []) as Array<Record<string, any>>).map((d) => ({
    id: String(d.id), classification: String(d.classification), classification_confidence: (d.classification_confidence as string | null) ?? null, extracted_fields: d.extracted_fields,
    stage: d.id === cdaRow?.final_cd_document_id ? "final" as const : d.id === cdaRow?.preliminary_cd_document_id ? "preliminary" as const : "unlabeled" as const,
  }))
  // FINAL beats PRELIMINARY beats unlabeled; within a stage the newest scan.
  const rank = { final: 0, preliminary: 1, unlabeled: 2 } as const
  docs.sort((a, b) => rank[a.stage] - rank[b.stage])

  const ledger = await readLedger(svc, tx.brokerage_id, docs.map((d) => String(d.id)))
  if (!ledger.ok) return ledger
  const terms: TermMap = {}
  for (const d of docs) {
    const label = `${d.stage === "final" ? "final" : d.stage === "preliminary" ? "preliminary" : "settlement"} ${documentClassificationLabel(d.classification).toLowerCase()}`
    const facts = documentFacts({ id: String(d.id), extracted_fields: d.extracted_fields, classification_confidence: d.classification_confidence ?? null }, ledger.rows, SETTLEMENT_FIELD_TO_TERM, label, null)
    for (const [k, f] of Object.entries(facts) as Array<[ClosingTermKey, TermFact]>) if (!terms[k]) terms[k] = f
  }
  return { ok: true, snapshot: { documents: docs.map((d) => ({ id: String(d.id), classification: String(d.classification), stage: d.stage })), terms } }
}

// ── Writing the verdict to the compliance log ────────────────────────────────────

const SIG = (s: string) => `[sig:${s}]`

interface ExistingLogRow { id: string; check_type: string; status: string; is_blocking: boolean | null; failure_reason: string | null }

/** Rows that exist only while a fault holds (inputs unreadable, nothing to compare); cleared when it no longer does. */
const FAULT_ROW_TYPES = [
  `${CLOSING_TERM_CHECK_PREFIX}inputs`,
  `${CLOSING_TERM_CHECK_PREFIX}settlement_statement`,
  `${CLOSING_TERM_CHECK_PREFIX}governing_terms`,
  `${CLOSING_DOC_CHECK_PREFIX}checklist`,
  // WAVE 152 (lane 152E): the executed terms' evidence could not be read (the evidence hold could not run — a blocking fault)
  `${CLOSING_TERM_CHECK_PREFIX}evidence_ledger`,
] as const

async function applyLogRowsOnce(svc: Svc, tx: TransactionRow, specs: LogRowSpec[], opts: { partial?: boolean } = {}): Promise<{ counts: RowWriteCounts; changed: LogRowSpec[]; cleared: LogRowSpec[]; error: string | null; raced?: boolean }> {
  const counts: RowWriteCounts = { inserted: 0, updated: 0, unchanged: 0, reopened: 0 }
  const changed: LogRowSpec[] = []
  // WAVE 152 (lane 152E): the rows that were OPEN and now agree — their corrective request is settled (exactly those, no other).
  const cleared: LogRowSpec[] = []

  const { data: existingRows, error: readErr } = await svc
    .from("transaction_compliance_log")
    .select("id, check_type, status, is_blocking, failure_reason")
    .eq("brokerage_id", tx.brokerage_id)
    .eq("transaction_id", tx.id)
  // A refused read is NOT "no rows yet": writing duplicates over an unread log is the worse outcome.
  if (readErr) return { counts, changed, cleared, error: `the compliance log could not be read: ${readErr.message}` }
  const byType = new Map<string, ExistingLogRow>()
  for (const r of (existingRows ?? []) as ExistingLogRow[]) byType.set(r.check_type, r)

  const now = new Date().toISOString()
  const inserts: Array<Record<string, unknown>> = []
  for (const spec of specs) {
    const reason = spec.status === "pass" ? null : `${spec.failure_reason ?? ""} ${SIG(spec.signature)}`.trim()
    const existing = byType.get(spec.check_type)
    if (!existing) {
      inserts.push({
        transaction_id: tx.id, brokerage_id: tx.brokerage_id, check_type: spec.check_type, check_label: spec.check_label,
        is_blocking: spec.is_blocking, status: spec.status, failure_reason: reason, checked_at: now, created_at: now,
      })
      if (spec.status !== "pass") changed.push(spec)
      continue
    }
    const sameSignature = (existing.failure_reason ?? "").includes(SIG(spec.signature))
    // A person's waiver stands while the values they waived are the values compared.
    if (existing.status === "waived" && (sameSignature || spec.status === "pass")) { counts.unchanged++; continue }
    if (existing.status === spec.status && (spec.status === "pass" || sameSignature)) { counts.unchanged++; continue }

    const reopened = existing.status === "waived"
    const patch: Record<string, unknown> = {
      status: spec.status, is_blocking: spec.is_blocking, check_label: spec.check_label, failure_reason: reason,
      checked_at: now, updated_at: now,
    }
    if (spec.status === "pass") {
      patch.resolved_at = now
      patch.resolution_notes = "Cleared automatically: the values compared now agree."
    } else if (reopened) {
      patch.resolved_at = null
      patch.resolution_notes = "Waiver superseded: the values on the documents changed after it was granted."
    }
    const { data: upd, error: updErr } = await svc
      .from("transaction_compliance_log")
      .update(patch)
      .eq("id", existing.id)
      .eq("brokerage_id", tx.brokerage_id)
      .select("id")
    if (updErr) return { counts, changed, cleared, error: `a compliance row could not be updated: ${updErr.message}` }
    // An UPDATE that matches nothing also resolves (CLAUDE.md §3): the row is gone or the tenant predicate refused.
    if (!upd || upd.length === 0) return { counts, changed, cleared, error: `compliance row ${existing.check_type} was not updated — it no longer exists in this brokerage` }
    counts.updated++
    if (reopened) counts.reopened++
    if (spec.status !== "pass") changed.push(spec)
    else if (existing.status === "fail" || existing.status === "needs_review") cleared.push(spec)
  }

  // A fault row whose fault is gone clears itself (an unreadable input that is readable again). A PARTIAL run (wave 151, lane 151K:
  // an addendum's changed terms only) did not re-evaluate the faults, so it clears none of them.
  for (const type of opts.partial ? [] : FAULT_ROW_TYPES) {
    if (specs.some((s) => s.check_type === type)) continue
    const stale = byType.get(type)
    if (!stale || stale.status === "pass" || stale.status === "waived") continue
    const clearPatch = { status: "pass", failure_reason: null, resolved_at: now, updated_at: now, checked_at: now, resolution_notes: "Cleared automatically: the check ran and the condition no longer holds." }
    // (the local result is `clearedRows`, never `cleared` — that name is the outer list of specs this run cleared, returned below)
    const { data: clearedRows, error: clearErr } = await svc
      .from("transaction_compliance_log")
      .update(clearPatch)
      .eq("brokerage_id", tx.brokerage_id)
      .eq("id", stale.id)
      .select("id")
    if (clearErr) return { counts, changed, cleared, error: `a stale compliance row could not be cleared: ${clearErr.message}` }
    if (clearedRows && clearedRows.length > 0) counts.updated++
  }

  if (inserts.length > 0) {
    const { data: ins, error: insErr } = await svc.from("transaction_compliance_log").insert(inserts).select("id")
    if (insErr) return { counts, changed, cleared, error: `compliance rows could not be written: ${insErr.message}`, raced: String((insErr as { code?: string }).code ?? "") === "23505" }
    counts.inserted = (ins ?? []).length
    if (counts.inserted !== inserts.length) return { counts, changed, cleared, error: `only ${counts.inserted} of ${inserts.length} compliance rows were written` }
  }
  return { counts, changed, cleared, error: null }
}

/**
 * Two scans of one transaction can land together (a settlement statement and the contract). The m806 partial
 * unique index admits ONE closing row per (transaction, check_type); the loser of that race re-reads the log —
 * which now holds the winner's rows — and reconciles instead of failing the check.
 */
async function applyLogRows(svc: Svc, tx: TransactionRow, specs: LogRowSpec[], opts: { partial?: boolean } = {}): Promise<{ counts: RowWriteCounts; changed: LogRowSpec[]; cleared: LogRowSpec[]; error: string | null }> {
  const first = await applyLogRowsOnce(svc, tx, specs, opts)
  if (!first.raced) return first
  return applyLogRowsOnce(svc, tx, specs, opts)
}

// ── The checks that are not term comparisons ─────────────────────────────────────

async function documentSpecs(svc: Svc, tx: TransactionRow): Promise<{ specs: LogRowSpec[]; unavailable: string | null; policyVersion: number | null }> {
  const contactIds = [tx.buyer_contact_id, tx.seller_contact_id, tx.contact_id]
  const dealType = tx.deal_type === "seller" || tx.deal_type === "dual" ? tx.deal_type : "buyer"
  // The deal's financing TERM (wave 145, lane 145Z — m871): the brokerage term carried onto the transaction
  // (transactions.financing_subtype) is resolved through the brokerage's vocabulary; without one, the platform roll-up.
  // Read through the column's ONE reader (a database without m871 reads null — never a refused query).
  const { readFinancingSubtype } = await import("@/lib/offers/financing-subtype")
  const finTerm = await readFinancingSubtype(svc as any, { table: "transactions", id: tx.id, brokerageId: tx.brokerage_id })
  let financing = financingKindFor(tx.financing_type)
  if (finTerm.ok && finTerm.subtype) {
    const { loadTenantVocabulary, financingTypeResolver } = await import("@/lib/compliance/adaptive-vocabulary")
    const vocab = await loadTenantVocabulary(svc as any, tx.brokerage_id)
    if (vocab.ok) financing = financingKindFor(finTerm.subtype, financingTypeResolver(vocab.vocabulary)) ?? financing
  }
  const audit = await auditTransactionDocuments(svc, {
    transactionId: tx.id, brokerageId: tx.brokerage_id, offerId: tx.offer_id, listingId: tx.listing_id, contactIds,
    dealType, stateCode: tx.property_state, stage: "closing", financing,
  })
  // An audit that could not run is a BLOCKING row: "nobody checked" must not read as "checked and fine".
  if (audit.unavailable_reason) {
    return {
      unavailable: audit.unavailable_reason, policyVersion: null,
      specs: [{ check_type: `${CLOSING_DOC_CHECK_PREFIX}checklist`, check_label: "Closing: required-document checklist could run", status: "fail", is_blocking: true,
        failure_reason: `The closing checklist could not be read or applied (${audit.unavailable_reason}). Nothing was verified.`, signature: `unavailable|${audit.unavailable_reason}` }],
    }
  }
  const specs: LogRowSpec[] = []
  const fp = audit.checklist_fingerprint ?? "none"
  for (const r of audit.required_breakdown) {
    const label = documentClassificationLabel(r.classification)
    const present = audit.present.includes(r.classification)
    const warnOnly = r.unresolved && r.unresolved.length > 0
    specs.push({
      check_type: `${CLOSING_DOC_CHECK_PREFIX}${r.classification}`,
      check_label: `Closing: ${label} on file`,
      status: present ? "pass" : r.block_on_missing ? "fail" : "needs_review",
      is_blocking: !present && r.block_on_missing,
      failure_reason: present ? null : `${label} is required by the brokerage's checklist at the closing stage and is not in the deal file.` +
        (warnOnly ? ` (Applies as a warning: the deal's ${r.unresolved!.join(", ").replace(/_/g, " ")} could not be confirmed.)` : "") +
        ` Upload it or request it from the client; checklist ${fp}.`,
      signature: `${present ? "present" : "missing"}|${r.block_on_missing ? "block" : "warn"}|v${r.policy_version ?? 1}`,
    })
  }
  // Present-but-unsigned: signatures AND initials, the creation gate's one predicate.
  const { findUnexecutedDocuments } = await import("@/lib/transactions/transaction-creation-gate")
  const required = audit.required_breakdown.map((r) => r.classification)
  for (const u of findUnexecutedDocuments(audit.deal_file, required)) {
    const bits = [...u.missingSignatures, ...u.missingInitials]
    specs.push({
      check_type: `${CLOSING_DOC_CHECK_PREFIX}executed.${u.documentId}`,
      check_label: `Closing: ${u.label} fully signed and initialed`,
      status: "fail", is_blocking: true,
      failure_reason: u.unscanned
        ? `${u.label} is in the file but its signatures were never verified — every signature and initial must be confirmed before closing.`
        : `${u.label} is not fully executed: ${bits.join(", ")}.`,
      signature: `unexecuted|${bits.join("+")}`,
    })
  }
  return { specs, unavailable: null, policyVersion: audit.policy_version ?? null }
}

/** The brokerage-wide closing setting (lib/brokerage/get-brokerage-settings.ts) — one default, which a state that requires an attorney overrides. */
const defaultClosingEntity = async (brokerageId: string): Promise<string | null> => {
  try {
    const { getClosingEntityType } = await import("@/lib/brokerage/get-brokerage-settings")
    return await getClosingEntityType(brokerageId)
  } catch { return null }
}

async function participantSpecs(svc: Svc, tx: TransactionRow, closingEntity: (brokerageId: string) => Promise<string | null>): Promise<{ specs: LogRowSpec[]; question: string | null; staleNote: string | null }> {
  const { data, error } = await svc
    .from("transaction_participants")
    .select("role")
    .eq("brokerage_id", tx.brokerage_id)
    .eq("transaction_id", tx.id)
  // An unreadable roster is not an empty one: say nothing rather than accuse the deal of a missing attorney.
  if (error) return { specs: [], question: null, staleNote: null }
  const entity = await closingEntity(tx.brokerage_id)
  const a = assessClosingParticipants({
    stateCode: tx.property_state,
    participantRoles: ((data ?? []) as Array<{ role: string | null }>).map((r) => r.role),
    brokerageClosingEntityType: entity,
  })
  const specs: LogRowSpec[] = []
  if (a.status === "verified" && a.policy) {
    const source = a.policy.sources[0]
    a.gaps.forEach((g, i) => {
      // The brokerage-wide closing setting disagreeing with the state rides on the FIRST gap (see below).
      const conflict = i === 0 && a.conflicts.length > 0 ? ` ${a.conflicts[0]}` : ""
      specs.push({ check_type: `${CLOSING_PARTICIPANT_CHECK_PREFIX}${g.role}`, check_label: `State closing participant: ${g.role.replace(/_/g, " ")}`,
        status: "needs_review", is_blocking: false, failure_reason: `${g.message}${conflict} Source: ${source.title}.`, signature: `gap|${g.role}|${a.state}` })
    })
    // `a.conflicts` (the brokerage-wide closing_entity_type disagreeing with the state) is not filed as a
    // row of its own: the setting defaults to 'title_company' for a brokerage that never chose, so a row per
    // deal would be noise — it rides on the missing-attorney gap, which is the actionable form.
    if (a.gaps.length === 0) {
      specs.push({ check_type: `${CLOSING_PARTICIPANT_CHECK_PREFIX}state_policy`, check_label: `${a.policy.stateName} closing participants present`,
        status: "pass", is_blocking: false, failure_reason: null, signature: `ok|${a.state}` })
    }
  }
  const age = closingPolicyAgeDays()
  return { specs, question: a.question, staleNote: age > VERIFY_EVERY_DAYS ? `The state closing-participants table was last verified ${age} days ago; re-verify its sources.` : null }
}

// ── Notification ────────────────────────────────────────────────────────────────

export type ClosingNotifier = (svc: Svc, tx: TransactionRow, changed: LogRowSpec[], trigger: string) => Promise<number>
export type ClosingAuditor = (tx: TransactionRow, event: { trigger: string; actorUserId: string | null; metadata: Record<string, unknown> }) => Promise<void>

const notifyOpenFindings: ClosingNotifier = async (svc, tx, changed, trigger) => {
  if (changed.length === 0) return 0
  const blocking = changed.filter((c) => c.is_blocking)
  try {
    const { notifyComplianceFlag } = await import("@/lib/notifications/notify-helpers")
    const { resolveAgentRecordToUserId } = await import("@/lib/kernel/agent-identity-resolver")
    const users = new Set<string>()
    for (const agentId of [tx.agent_id, tx.buyer_agent_id, tx.seller_agent_id]) {
      if (!agentId) continue
      const u = await resolveAgentRecordToUserId(agentId)
      if (u) users.add(u)
    }
    const lines = changed.slice(0, 8).map((c) => `• ${c.check_label}: ${(c.failure_reason ?? "").replace(/\s*\[sig:[^\]]*\]\s*$/, "")}`)
    // LAW 5 (wave 146, lane 146I — closes lane 143B Outside-lane 10): each closing notice is a ledger row — who was told, why
    // (COMPLIANCE_NOTICE), what changed, which trigger. The checklist rows that answered carry their own policy versions
    // (required_document:<rule_id>, wave 144); the notice itself runs under no tenant policy key, so none is claimed.
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    const sent = await withActionLedger<{ notified_count: number }>(
      {
        brokerageId: tx.brokerage_id,
        action: "compliance.closing_notice.send",
        actor: { type: "system" },
        subject: { type: "transaction", id: tx.id },
        reasonCode: "COMPLIANCE_NOTICE",
        reasonDetail: `${changed.length} closing-compliance item(s) changed (${blocking.length} blocking) — ${trigger}`.slice(0, 500),
        channel: "in_app",
        riskClass: "COMMUNICATION",
        systemSource: "closing_compliance",
        detail: { trigger, changed: changed.map((c) => c.check_type).slice(0, 20), blocking: blocking.length, recipients: users.size },
      },
      async () => notifyComplianceFlag(svc, {
        brokerageId: tx.brokerage_id,
        agentUserId: [...users][0] ?? null,
        alsoNotifyUserIds: [...users].slice(1),
        transactionId: tx.id,
        flag: {
          type: "compliance.closing_discrepancy",
          severity: blocking.length > 0 ? "high" : "medium",
          title: blocking.length > 0
            ? `Closing compliance: ${blocking.length} item${blocking.length === 1 ? "" : "s"} must be corrected before the CDA`
            : `Closing compliance: ${changed.length} item${changed.length === 1 ? "" : "s"} need review`,
          body: `${lines.join("\n")}${changed.length > 8 ? `\n…and ${changed.length - 8} more` : ""}\nNothing on the signed contract was changed — correct the settlement statement, or upload the executed amendment, then it re-checks automatically. (${trigger})`,
          entityType: "transaction",
          entityId: tx.id,
        },
      }),
      {
        settle: (r) => r.notified_count > 0
          ? { status: "executed", outcome: `notified:${r.notified_count}` }
          : { status: "skipped", outcome: "no_recipient", error: "no agent on the deal resolved to a user to tell" },
        // No cycle is given, so a replay cannot occur; a ledger that REFUSES the claim holds the notice (said, never silent) —
        // the blocking compliance rows above still stand and the gate still refuses on them.
        replay: (claim) => { console.error(`[closing-compliance] closing notice for ${tx.id} held — the action ledger did not claim it (${claim.kind}${claim.kind === "refused" ? `: ${claim.error}` : ""})`); return { notified_count: 0 } },
      },
      { client: svc as never },
    )
    return sent.notified_count
  } catch (err) {
    console.error("[closing-compliance] notification failed (non-fatal):", (err as Error)?.message ?? err)
    return 0
  }
}

/** LAW 5: one audit-only kernel event per run — what ran, what governed, what was set aside, which checklist version. */
const auditClosingRun: ClosingAuditor = async (tx, event) => {
  try {
    const { emitKernelEvent } = await import("@/lib/kernel/emit")
    await emitKernelEvent({
      event: "closing_compliance.checked", brokerageId: tx.brokerage_id, entityType: "transaction", entityId: tx.id,
      actorUserId: event.actorUserId, source: "system", auditOnly: true, metadata: { trigger: event.trigger, state: tx.property_state, ...event.metadata },
    })
  } catch (err) {
    console.error("[closing-compliance] audit event failed (non-fatal):", (err as Error)?.message ?? err)
  }
}

// ── WAVE 152 (lane 152E): THE CONTRACT SIDE — the deal record, the evidence hold, the corrective request ─────────────────────

/** The closing terms the deal record states (DEAL_RECORD_TERM_COLUMNS), as record-confidence facts. A contractual closing date the
 *  governed writer took from an EXECUTED AMENDMENT names its own executed instrument, so it is not held against the terms record. */
function dealRecordTerms(tx: TransactionRow): TermMap {
  const out: TermMap = {}
  const row = tx as unknown as Record<string, unknown>
  for (const [term, column] of Object.entries(DEAL_RECORD_TERM_COLUMNS) as Array<[ClosingTermKey, string]>) {
    const src = `deal record (transactions.${column})`
    if (term === "closing_date") {
      if (tx.contract_closing_source === "executed_amendment") continue
      const d = parseDateOnly(row[column]); if (d) out[term] = { unit: "date", value: d, confidence: "record", source: src }
      continue
    }
    const n = parseUsd(row[column]); if (n !== null) out[term] = { unit: "usd", value: n, confidence: "record", source: src }
  }
  return out
}

type TermLedgerReader = (svc: Svc, tx: TransactionRow) => Promise<{ ok: true; rows: TermLedgerRow[] } | { ok: false; error: string }>

/** THE ONE READER's term ledger (lib/offers/governing-terms.ts contractTermLedger), tenant-pinned to the verified row. */
const readTermLedger: TermLedgerReader = async (svc, tx) => {
  const { contractTermLedger } = await import("@/lib/offers/governing-terms")
  const r = await contractTermLedger(svc as any, tx.brokerage_id, { transactionId: tx.id })
  return r.ok ? { ok: true, rows: r.ledger.rows } : { ok: false, error: r.reason }
}

const EVIDENCE_CHECK_PREFIX = `${CLOSING_TERM_CHECK_PREFIX}evidence.`
const EVIDENCE_LEDGER_FAULT = `${CLOSING_TERM_CHECK_PREFIX}evidence_ledger`
const EVIDENCE_RESPONSIBLE = "a person who reads the signed document — the transaction coordinator or the compliance officer confirms the reading in the document's review; an authorized reviewer may instead override with a written reason"

/**
 * THE EVIDENCE HOLD (owner decision "addendum evidence — refuse or flag", OWNER-SQL §M; the SAFE DEFAULT — HOLD + FLAG, never
 * silently accept, never refuse the history). An executed addendum / amendment whose governing term was recorded WITHOUT a located
 * reading (term_evidence `person_reading_unlocated`) or against a disagreeing low-confidence reading stays recorded — and the
 * closing is HELD on that term until a VERIFIED / HIGH reading of the same signed document agrees (re-asked here through the ONE
 * evidence rule, termEvidenceFor, on every run) or an authorized person overrides. A confirmed reading that DISAGREES is a
 * contradiction (fail). A version recorded before per-term evidence existed is not accused (published blind spot).
 */
async function evidenceHoldSpecs(svc: Svc, tx: TransactionRow, rows: TermLedgerRow[], scopeKeys: ReadonlySet<string> | null): Promise<{ ok: true; specs: LogRowSpec[] } | { ok: false; error: string }> {
  const owed = rows.filter((r) => r.status === "governing" && !!r.source?.documentId && (r.source.kind === "addendum" || r.source.kind === "amendment")
    && !!r.evidence && (r.evidence.source === "person_reading_unlocated" || r.evidence.agrees === false) && (!scopeKeys || scopeKeys.has(r.key)))
  if (owed.length === 0) return { ok: true, specs: [] }
  const documentIds = [...new Set(owed.map((r) => r.source!.documentId as string))]
  const { data, error } = await svc
    .from("document_field_extractions")
    .select("document_id, field_key, field_value_json, confidence, verified_at")
    .eq("brokerage_id", tx.brokerage_id)
    .in("document_id", documentIds)
  if (error) return { ok: false, error: `the executed documents' readings could not be read: ${error.message}` }
  const readings = (data ?? []) as LedgerRow[]
  return { ok: true, specs: owed.map((r): LogRowSpec => {
    const src = r.source!
    const instrument = `${src.kind} ${src.versionNo}`
    const term = r.key.replace(/_/g, " ")
    const value = JSON.stringify(r.value)
    const base = { check_type: `${EVIDENCE_CHECK_PREFIX}${r.key}`, check_label: `Closing: ${term} confirmed on the executed ${instrument}` }
    const again = termEvidenceFor({ terms: { [r.key]: r.value }, extractions: readings.filter((x) => x.document_id === src.documentId) })
    if (!again.ok) {
      return { ...base, status: "fail", is_blocking: true, signature: `evidence|contradicted|${instrument}|${value}`, responsible: EVIDENCE_RESPONSIBLE,
        failure_reason: `The executed ${instrument} was recorded as setting ${term} to ${value}, but a confirmed reading of that signed document says otherwise (${again.reason}). The closing is held on this term until the paper and the recorded term agree — record the corrected executed instrument, or an authorized reviewer overrides with a written reason.` }
    }
    const te = again.termEvidence[r.key]
    if (te?.source === "document_extraction" && te.agrees === true && (te.confidence === "verified" || te.confidence === "high")) {
      return { ...base, status: "pass", is_blocking: false, failure_reason: null, signature: `evidence|confirmed|${instrument}|${value}` }
    }
    return { ...base, status: "needs_review", is_blocking: true, signature: `evidence|unlocated|${instrument}|${value}`, responsible: EVIDENCE_RESPONSIBLE,
      failure_reason: `The executed ${instrument} sets ${term} to ${value}. It is recorded, but where the signed document states it was never noted and no confident reading of the document confirms it yet, so the closing is held on this term. Confirm it on the page in the document's reading review (it then clears on its own), or an authorized reviewer overrides with a written reason.` }
  }) }
}

const CORRECTION_CATEGORY = "compliance_correction"
const correctionTitle = (checkLabel: string): string => `[Compliance correction] ${checkLabel.replace(/^Closing:\s*/, "")}`.slice(0, 180)

type CorrectionOutcome = { opened: number; refreshed: number; completed: number; errors: string[] }
type CorrectionRequester = (svc: Svc, tx: TransactionRow, open: LogRowSpec[], cleared: LogRowSpec[], trigger: string) => Promise<CorrectionOutcome>

/**
 * Settle the corrective requests of EXACTLY these checks (the rows that now agree, or that one authorized person overrode) —
 * a counted update of the open `transaction_tasks` rows the request opened; any other request stays open. Also read by the
 * override door (app/actions/transaction-compliance.ts) when a person waives a computed check.
 */
export async function completeCorrectionRequests(svc: Svc, input: { brokerageId: string; transactionId: string; checkLabels: string[]; completedBy?: string | null }): Promise<{ completed: number; error: string | null }> {
  let completed = 0
  const now = new Date().toISOString()
  for (const label of [...new Set(input.checkLabels)]) {
    const { data, error } = await svc
      .from("transaction_tasks")
      .update({ status: "completed", completed_at: now, completed_by: input.completedBy ?? null, updated_at: now })
      .eq("brokerage_id", input.brokerageId)
      .eq("transaction_id", input.transactionId)
      .eq("category", CORRECTION_CATEGORY)
      .eq("title", correctionTitle(label))
      .in("status", ["pending", "in_progress"])
      .select("id")
    if (error) return { completed, error: `a corrective request could not be settled: ${error.message}` }
    completed += (data ?? []).length
  }
  return { completed, error: null }
}

/**
 * THE CORRECTIVE REQUEST + FOLLOW-UP (directive 152E: "trigger corrective request and follow-up, not merely a warning in a document
 * viewer"; "notify responsible party via existing managers"). For every finding that is a real departure (a fail, or anything that
 * holds the closing), the Compliance Officer opens ONE deduped `transaction_tasks` row — the deal coordination task survivor the
 * manager bus already uses — assigned to the deal's TC (else its agent), naming what differs, what it affects and WHO corrects it.
 * Ledgered (LAW 5) with an idempotency key of the check AND the values compared, so a replayed scan / webhook opens nothing twice;
 * a changed finding refreshes the open request; a row that clears settles exactly its own request. The platform never messages
 * the title company or attorney itself (an external request is the TC's, under the deal's communication rules).
 */
const requestCorrections: CorrectionRequester = async (svc, tx, open, cleared, trigger) => {
  const out: CorrectionOutcome = { opened: 0, refreshed: 0, completed: 0, errors: [] }
  try {
    if (open.length > 0) {
      const { resolveTransactionTeamUsers } = await import("@/lib/kernel/deal-save-huddle")
      const { withActionLedger } = await import("@/lib/kernel/action-ledger")
      const team = await resolveTransactionTeamUsers(svc as any, tx.id, tx.brokerage_id)
      const assignee = team.coordinatorUserId ?? team.agentUserId ?? null
      const now = new Date().toISOString()
      for (const spec of open) {
        const title = correctionTitle(spec.check_label)
        const description = `${(spec.failure_reason ?? "").replace(/\s*\[sig:[^\]]*\]\s*$/, "")}\n\nWho corrects it: ${spec.responsible ?? "the transaction coordinator"}.\nThe closing gate holds while this is open; it re-checks on its own when the corrected document or the executed instrument is recorded. Nothing on the signed contract was changed.`.slice(0, 2000)
        const { data: have, error: readErr } = await svc
          .from("transaction_tasks")
          .select("id, description")
          .eq("brokerage_id", tx.brokerage_id)
          .eq("transaction_id", tx.id)
          .eq("category", CORRECTION_CATEGORY)
          .eq("title", title)
          .in("status", ["pending", "in_progress"])
          .limit(1)
        if (readErr) { out.errors.push(`the open corrective requests could not be read: ${readErr.message}`); continue }
        const existing = ((have ?? []) as Array<{ id: string; description: string | null }>)[0]
        if (existing) {
          if (existing.description === description) continue
          const { data: upd, error: uErr } = await svc.from("transaction_tasks").update({ description, updated_at: now }).eq("id", existing.id).eq("brokerage_id", tx.brokerage_id).select("id")
          if (uErr || !upd || upd.length === 0) out.errors.push(`the corrective request for ${spec.check_type} was not refreshed${uErr ? `: ${uErr.message}` : " (no row matched)"}`)
          else out.refreshed++
          continue
        }
        const made = await withActionLedger<{ inserted: number }>(
          {
            brokerageId: tx.brokerage_id,
            action: "compliance.correction_request.open",
            actor: { type: "manager", managerKey: "compliance_officer" },
            subject: { type: "transaction", id: tx.id, ref: spec.check_type },
            reasonCode: "COMPLIANCE_NOTICE",
            reasonDetail: `${spec.check_label} — corrective request (${trigger})`.slice(0, 500),
            riskClass: "LOW_RISK_WRITE",
            systemSource: "closing_compliance",
            idempotencyKey: `compliance-correction:${tx.brokerage_id}:${tx.id}:${spec.check_type}:${spec.signature}`,
            detail: { check_type: spec.check_type, signature: spec.signature, responsible: spec.responsible ?? null, assigned_user_id: assignee, blocking: spec.is_blocking, trigger },
          },
          async () => {
            const { data: ins, error } = await svc.from("transaction_tasks").insert({
              transaction_id: tx.id, brokerage_id: tx.brokerage_id, title, description, priority: spec.is_blocking ? "high" : "medium",
              category: CORRECTION_CATEGORY, ai_generated: false, status: "pending", assigned_user_id: assignee,
            }).select("id")
            if (error) throw new Error(`the corrective request was not written: ${error.message}`)
            return { inserted: (ins ?? []).length }
          },
          {
            settle: (r) => r.inserted === 1 ? { status: "executed", outcome: "corrective_request_opened" } : { status: "failed", outcome: "no_row", error: "the corrective request insert matched no row" },
            // a replayed scan / webhook with the same values: the request already exists — nothing is opened twice
            replay: (claim) => { if (claim.kind === "refused") console.error(`[closing-compliance] corrective request for ${tx.id} not opened — the action ledger refused the claim: ${claim.error}`); return { inserted: 0 } },
          },
          { client: svc as never },
        )
        if (made.inserted === 1) out.opened++
      }
    }
    if (cleared.length > 0) {
      const done = await completeCorrectionRequests(svc, { brokerageId: tx.brokerage_id, transactionId: tx.id, checkLabels: cleared.map((c) => c.check_label) })
      out.completed += done.completed
      if (done.error) out.errors.push(done.error)
    }
  } catch (e) {
    out.errors.push(`corrective requests: ${e instanceof Error ? e.message : String(e)}`)
  }
  return out
}

// ── The runner ──────────────────────────────────────────────────────────────────

export async function runClosingCompliance(
  svc: Svc,
  input: RunClosingComplianceInput,
  deps: {
    governingTerms?: GoverningTermsReader; notify?: ClosingNotifier; audit?: ClosingAuditor; closingEntity?: (brokerageId: string) => Promise<string | null>
    /** WAVE 152 (lane 152E): the term ledger (default: THE ONE READER's contractTermLedger) and the corrective-request door. */
    termLedger?: TermLedgerReader; correct?: CorrectionRequester
  } = {},
): Promise<ClosingComplianceOutcome> {
  if (!isValidUUID(input.transactionId)) return empty("invalid transaction id")
  if (!input.brokerageId) return empty("no brokerage — the closing check cannot run without a tenant")

  const { data: txData, error: txErr } = await svc
    .from("transactions")
    .select(TX_COLUMNS)
    .eq("id", input.transactionId)
    .eq("brokerage_id", input.brokerageId)
    .maybeSingle()
  if (txErr) return empty(`the transaction could not be read: ${txErr.message}`)
  if (!txData) return empty("transaction not found in this brokerage")
  const tx = txData as unknown as TransactionRow

  const reader = deps.governingTerms ?? readGoverningTermsFromRecords
  const [gov, settlement] = await Promise.all([reader(svc, tx), loadSettlement(svc, tx)])

  // WAVE 151 (lane 151K). SCOPE: on an executed addendum, ONLY the closing terms the changed governing keys reach are compared and
  // written; the document / participant checks and every other term's row stay as they were (a changed contingency period does
  // not re-judge the price lines). UNRESOLVED: a term two executed addenda contradict each other on is filed as a blocking
  // `conflict` row on every run — the reader's own contradictions plus the ones the caller hands in — settlement or no settlement.
  const scope = input.trigger === "contract_addendum" && (input.changedTerms?.length ?? 0) > 0 ? closingTermsFor(input.changedTerms!) : null
  const handedIn = unresolvedToClosingConflicts(input.unresolved ?? [])
  const unresolvedTerms = new Set<ClosingTermKey>(gov.ok ? (gov.unresolvedTerms ?? []) : [])
  if (gov.ok) {
    for (const [k, c] of Object.entries(handedIn) as Array<[ClosingTermKey, TermConflict]>) {
      if (!gov.governing.conflicts[k]) gov.governing.conflicts[k] = c
      delete gov.governing.terms[k]
      unresolvedTerms.add(k)
    }
  }
  const inScope = (term: ClosingTermKey) => !scope || scope.has(term) || unresolvedTerms.has(term)
  /** The comparison narrowed to the unresolved terms alone (no settlement on file yet): only the contradiction rows are filed. */
  const onlyUnresolved = <T,>(m: Partial<Record<ClosingTermKey, T>>): Partial<Record<ClosingTermKey, T>> =>
    Object.fromEntries(Object.entries(m).filter(([k]) => unresolvedTerms.has(k as ClosingTermKey))) as Partial<Record<ClosingTermKey, T>>
  // WAVE 152 (lane 152E): how the executed contract words its closing date — an earlier settlement date under "on or before" IS the contract.
  const closingWording = tx.contract_closing_terms === "on" || tx.contract_closing_terms === "on_or_before" ? tx.contract_closing_terms : null

  const specs: LogRowSpec[] = []
  let comparison: ClosingComparison | null = null
  let readFault: string | null = null
  // A run that writes a SUBSET of the rows must not clear the fault rows it did not re-evaluate.
  let partial = !!scope
  // WAVE 152 (lane 152E): the CONTRACT SIDE (deal record + evidence hold) runs at every checkpoint that compares terms — a
  // settlement statement on file, the pre-CDA gate, an executed addendum — and never on a bare contract scan mid-deal.
  let contractSide = false

  if (!gov.ok) readFault = gov.error
  else if (!settlement.ok) readFault = settlement.error

  if (readFault) {
    // A read that failed is a blocking row, not a skipped check.
    specs.push({ check_type: `${CLOSING_TERM_CHECK_PREFIX}inputs`, check_label: "Closing: contract terms and settlement statement could be read", status: "fail", is_blocking: true,
      failure_reason: `The closing check could not read its inputs (${readFault}). Nothing was verified.`, signature: `fault|${readFault}` })
  } else if (gov.ok && settlement.ok) {
    const settlementOnFile = settlement.snapshot.documents.length > 0
    if (!settlementOnFile) {
      // Only the pre-CDA gate treats "no settlement statement yet" as a hold; a contract upload mid-deal is not a closing event.
      if (input.trigger === "final_check") {
        specs.push({ check_type: `${CLOSING_TERM_CHECK_PREFIX}settlement_statement`, check_label: "Closing: a settlement statement is on file to check the terms against", status: "fail", is_blocking: true,
          failure_reason: "No settlement statement (Closing Disclosure / preliminary closing statement) is on file for this transaction, so the contract terms cannot be checked against it.", signature: "no-settlement" })
        // the contradictions are filed beside it (a settlement will not settle them; a person does)
        if (unresolvedTerms.size > 0) {
          comparison = compareClosingTerms(onlyUnresolved(gov.governing.terms), {}, onlyUnresolved(gov.governing.conflicts))
          for (const f of comparison.findings) if (f.verdict === "conflict") specs.push(findingToLogRow(f))
        }
        contractSide = true
      } else if (input.trigger === "contract_addendum") {
        // WAVE 152 (lane 152E): an executed addendum BEFORE the settlement statement — the deal record it should have moved and the
        // changed terms' evidence are checked now (directive: "recompute dependent fields → verified resolution").
        partial = true
        contractSide = true
        if (unresolvedTerms.size > 0) {
          comparison = compareClosingTerms(onlyUnresolved(gov.governing.terms), {}, onlyUnresolved(gov.governing.conflicts))
          for (const f of comparison.findings) if (f.verdict === "conflict") specs.push(findingToLogRow(f))
        }
      } else if (unresolvedTerms.size === 0) {
        return { ...empty("no settlement statement on file yet — nothing to compare"), governingOnFile: Object.keys(gov.governing.terms).length > 0 }
      } else {
        partial = true
        comparison = compareClosingTerms(onlyUnresolved(gov.governing.terms), {}, onlyUnresolved(gov.governing.conflicts))
        for (const f of comparison.findings) if (f.verdict === "conflict") specs.push(findingToLogRow(f))
      }
    } else if (Object.keys(gov.governing.terms).length === 0 && unresolvedTerms.size === 0) {
      specs.push({ check_type: `${CLOSING_TERM_CHECK_PREFIX}governing_terms`, check_label: "Closing: executed contract terms are on file", status: "fail", is_blocking: true,
        failure_reason: "No executed contract, counter or addendum states any term, so nothing can be checked against the settlement statement. Upload the fully executed contract.", signature: "no-governing" })
    } else {
      comparison = compareClosingTerms(gov.governing.terms, settlement.snapshot.terms, gov.governing.conflicts, { closingWording, history: gov.governing.history })
      // Listing-side commission belongs to the brokerage that took the listing; skip it on a buyer-only deal.
      for (const f of comparison.findings) {
        if (tx.deal_type === "buyer" && f.term === "commission_listing_side") continue
        if (!inScope(f.term)) continue
        specs.push(findingToLogRow(f))
      }
      contractSide = true
    }
  }

  // WAVE 152 (lane 152E) — THE CONTRACT SIDE. (1) The executed terms against the DEAL RECORD the commission, the CDA and the closing
  // figures are priced from. (2) THE EVIDENCE HOLD: an executed addendum term never located on its signed document holds the
  // closing until a confident reading agrees or an authorized person overrides (owner decision "refuse or flag" — the safe default).
  let recordComparison: TermFinding[] = []
  let evidenceHolds = 0
  if (contractSide && gov.ok) {
    recordComparison = compareDealRecordTerms(gov.governing.terms, dealRecordTerms(tx)).filter((f) => inScope(f.term))
    for (const f of recordComparison) specs.push(findingToLogRow(f))
    const ledger = await (deps.termLedger ?? readTermLedger)(svc, tx)
    const holds = ledger.ok ? await evidenceHoldSpecs(svc, tx, ledger.rows, scope ? new Set(input.changedTerms ?? []) : null) : ledger
    if (!holds.ok) {
      // the hold could not be evaluated: that is a hold, not a pass ("nobody checked" never reads as "checked and fine")
      specs.push({ check_type: EVIDENCE_LEDGER_FAULT, check_label: "Closing: the executed terms' evidence could be read", status: "fail", is_blocking: true,
        failure_reason: `Where the executed terms were read on their signed documents could not be checked (${holds.error}). Nothing was verified.`, signature: `fault|${holds.error}` })
    } else {
      specs.push(...holds.specs)
      evidenceHolds = holds.specs.filter((s) => s.status !== "pass").length
    }
  }

  // The document / participant checks are not term comparisons: an addendum re-check leaves them as they were.
  const docs = scope ? { specs: [] as LogRowSpec[], unavailable: null, policyVersion: null } : await documentSpecs(svc, tx)
  specs.push(...docs.specs)
  const people = scope ? { specs: [] as LogRowSpec[], question: null, staleNote: null } : await participantSpecs(svc, tx, deps.closingEntity ?? defaultClosingEntity)
  specs.push(...people.specs)

  const written = await applyLogRows(svc, tx, specs, { partial })
  if (written.error) {
    return { ...empty(written.error), governingOnFile: gov.ok && Object.keys(gov.governing.terms).length > 0, settlementOnFile: settlement.ok && settlement.snapshot.documents.length > 0, comparison, recordComparison, evidenceHolds }
  }

  const open = specs.filter((s) => s.status !== "pass")
  const openBlocking = open.filter((s) => s.is_blocking).length
  const notified = await (deps.notify ?? notifyOpenFindings)(svc, tx, written.changed, input.trigger)
  // WAVE 152 (lane 152E): a real departure (a fail, or anything that holds the closing) gets ONE corrective request with its
  // follow-up owner; a row that now agrees settles exactly its own request. Unchanged rows open nothing (replay-safe).
  const corrections = await (deps.correct ?? requestCorrections)(svc, tx, written.changed.filter((c) => c.status === "fail" || c.is_blocking), written.cleared, input.trigger)

  // LAW 5 evidence. Not allowed to fail the check (the auditor swallows and logs its own fault).
  await (deps.audit ?? auditClosingRun)(tx, {
    trigger: input.trigger, actorUserId: input.actorUserId ?? null,
    metadata: {
      written: written.counts, open_blocking: openBlocking, open_review: open.length - openBlocking,
      checklist_policy_version: docs.policyVersion,
      governing_applied: gov.ok ? gov.governing.applied.map((a) => ({ id: a.id, kind: a.kind, executedAt: a.executedAt })) : [],
      governing_ignored: gov.ok ? gov.governing.ignored : [],
      scope: scope ? [...scope] : null, unresolved_terms: [...unresolvedTerms],
      classes: comparison ? comparison.findings.map((f) => `${f.term}:${f.classification}`) : [],
      deal_record: recordComparison.map((f) => `${f.term}:${f.classification}`), evidence_holds: evidenceHolds,
      corrections: { opened: corrections.opened, refreshed: corrections.refreshed, completed: corrections.completed, errors: corrections.errors.length },
    },
  })

  return {
    ran: true,
    reason: people.staleNote,
    governingOnFile: gov.ok && Object.keys(gov.governing.terms).length > 0,
    settlementOnFile: settlement.ok && settlement.snapshot.documents.length > 0,
    comparison,
    rows: written.counts,
    openBlocking,
    openReview: open.length - openBlocking,
    notified,
    summary: open.map((s) => `${s.check_label}: ${(s.failure_reason ?? "").replace(/\s*\[sig:[^\]]*\]\s*$/, "")}`),
    blockingSummary: open.filter((s) => s.is_blocking).map((s) => `${s.check_label}: ${(s.failure_reason ?? "").replace(/\s*\[sig:[^\]]*\]\s*$/, "")}`),
    stateQuestion: people.question,
    recordComparison,
    evidenceHolds,
    corrections,
  }
}
