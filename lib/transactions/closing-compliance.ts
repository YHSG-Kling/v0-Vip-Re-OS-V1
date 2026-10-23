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
  compareClosingTerms,
  findingToLogRow,
  parseDateOnly,
  parseParty,
  parseUsd,
  superimposeGoverningTerms,
  type ClosingComparison,
  type Confidence,
  type GoverningTerms,
  type LogRowSpec,
  type SettlementSnapshot,
  type TermFact,
  type TermMap,
  type TermsInstrument,
  type ClosingTermKey,
} from "./closing-compliance-core"

type Svc = SupabaseClient<any, any, any>

// ── Row shapes (hoisted: scripts/tenant-scope-guard.ts reads the 500 characters after `.from("<table>")`) ──

const TX_COLUMNS = "id, brokerage_id, offer_id, listing_id, deal_type, agent_id, buyer_agent_id, seller_agent_id, property_state, financing_type, purchase_price, close_date, earnest_money, closing_cost_contribution, listing_offered_commission_percentage, contract_date, buyer_contact_id, seller_contact_id, contact_id"
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
}

/** The seam for lane A's `governingContractTerms`; the default reads the records. */
export type GoverningTermsReader = (svc: Svc, tx: TransactionRow) => Promise<{ ok: true; governing: GoverningTerms } | { ok: false; error: string }>

export interface RunClosingComplianceInput {
  transactionId: string
  /** THE SESSION'S (or the verified row's) tenant — never a request body's. */
  brokerageId: string
  trigger: "settlement_scanned" | "contract_document_scanned" | "final_check" | "manual"
  actorUserId?: string | null
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
}

const empty = (reason: string): ClosingComplianceOutcome => ({
  ran: false, reason, governingOnFile: false, settlementOnFile: false, comparison: null,
  rows: { inserted: 0, updated: 0, unchanged: 0, reopened: 0 }, openBlocking: 0, openReview: 0, notified: 0, summary: [], blockingSummary: [], stateQuestion: null,
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
  const { data: accepted, error: accErr } = await svc
    .from("offers")
    .select("id, parent_offer_id, brokerage_id")
    .eq("id", tx.offer_id)
    .eq("brokerage_id", tx.brokerage_id)
    .maybeSingle()
  if (accErr) return { ok: false, error: `the transaction's offer could not be read: ${accErr.message}` }
  if (!accepted) return { ok: true, instruments: [], chainIds: [] }
  const rootId = ((accepted as { parent_offer_id: string | null }).parent_offer_id ?? tx.offer_id) as string
  if (!isValidUUID(rootId)) return { ok: true, instruments: [], chainIds: [] }
  const { data: chain, error: chainErr } = await svc
    .from("offers")
    .select(OFFER_COLUMNS)
    .eq("brokerage_id", tx.brokerage_id)
    .or(`id.eq.${rootId},parent_offer_id.eq.${rootId}`)
    .order("current_round", { ascending: true })
  if (chainErr) return { ok: false, error: `the offer / counter chain could not be read: ${chainErr.message}` }
  const rows = (chain ?? []) as Array<Record<string, any>>
  // The offer the transaction was created from is executed by definition (the creation gate refuses an offer
  // that is not fully executed). Every EARLIER round is the paper that executed counter restates and
  // incorporates: a term the counter does not change is the earlier round's term, so those rounds are
  // applied as the lower-precedence baseline rather than dropped as "unexecuted".
  const acceptedIdx = rows.findIndex((o) => o.id === tx.offer_id)
  const instruments = rows.map((o, i) => {
    const incorporated = acceptedIdx >= 0 && i < acceptedIdx
    const base = o.parent_offer_id ? `counter, round ${o.current_round ?? "?"}` : "original offer"
    return offerInstrument(o, o.id === tx.offer_id || incorporated, incorporated ? `${base} (incorporated by the executed counter)` : `${base}${o.id === tx.offer_id ? " (accepted)" : ""}`)
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

/** DEFAULT READER — superimposes the offer chain, the executed documents and the listing-side commission. */
const readGoverningTermsFromRecords: GoverningTermsReader = async (svc, tx) => {
  const offers = await loadOfferInstruments(svc, tx)
  if (!offers.ok) return offers
  const docs = await loadDocumentInstruments(svc, tx, offers.chainIds)
  if (!docs.ok) return docs
  const listing = await loadListingSideInstrument(svc, tx)
  if (!listing.ok) return listing

  const instruments: TermsInstrument[] = [...offers.instruments, ...docs.instruments]
  if (listing.instrument) instruments.push(listing.instrument)
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
  return { ok: true, governing: superimposeGoverningTerms(instruments) }
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
] as const

async function applyLogRowsOnce(svc: Svc, tx: TransactionRow, specs: LogRowSpec[]): Promise<{ counts: RowWriteCounts; changed: LogRowSpec[]; error: string | null; raced?: boolean }> {
  const counts: RowWriteCounts = { inserted: 0, updated: 0, unchanged: 0, reopened: 0 }
  const changed: LogRowSpec[] = []

  const { data: existingRows, error: readErr } = await svc
    .from("transaction_compliance_log")
    .select("id, check_type, status, is_blocking, failure_reason")
    .eq("brokerage_id", tx.brokerage_id)
    .eq("transaction_id", tx.id)
  // A refused read is NOT "no rows yet": writing duplicates over an unread log is the worse outcome.
  if (readErr) return { counts, changed, error: `the compliance log could not be read: ${readErr.message}` }
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
    if (updErr) return { counts, changed, error: `a compliance row could not be updated: ${updErr.message}` }
    // An UPDATE that matches nothing also resolves (CLAUDE.md §3): the row is gone or the tenant predicate refused.
    if (!upd || upd.length === 0) return { counts, changed, error: `compliance row ${existing.check_type} was not updated — it no longer exists in this brokerage` }
    counts.updated++
    if (reopened) counts.reopened++
    if (spec.status !== "pass") changed.push(spec)
  }

  // A fault row whose fault is gone clears itself (an unreadable input that is readable again).
  for (const type of FAULT_ROW_TYPES) {
    if (specs.some((s) => s.check_type === type)) continue
    const stale = byType.get(type)
    if (!stale || stale.status === "pass" || stale.status === "waived") continue
    const clearPatch = { status: "pass", failure_reason: null, resolved_at: now, updated_at: now, checked_at: now, resolution_notes: "Cleared automatically: the check ran and the condition no longer holds." }
    const { data: cleared, error: clearErr } = await svc
      .from("transaction_compliance_log")
      .update(clearPatch)
      .eq("brokerage_id", tx.brokerage_id)
      .eq("id", stale.id)
      .select("id")
    if (clearErr) return { counts, changed, error: `a stale compliance row could not be cleared: ${clearErr.message}` }
    if (cleared && cleared.length > 0) counts.updated++
  }

  if (inserts.length > 0) {
    const { data: ins, error: insErr } = await svc.from("transaction_compliance_log").insert(inserts).select("id")
    if (insErr) return { counts, changed, error: `compliance rows could not be written: ${insErr.message}`, raced: String((insErr as { code?: string }).code ?? "") === "23505" }
    counts.inserted = (ins ?? []).length
    if (counts.inserted !== inserts.length) return { counts, changed, error: `only ${counts.inserted} of ${inserts.length} compliance rows were written` }
  }
  return { counts, changed, error: null }
}

/**
 * Two scans of one transaction can land together (a settlement statement and the contract). The m806 partial
 * unique index admits ONE closing row per (transaction, check_type); the loser of that race re-reads the log —
 * which now holds the winner's rows — and reconciles instead of failing the check.
 */
async function applyLogRows(svc: Svc, tx: TransactionRow, specs: LogRowSpec[]): Promise<{ counts: RowWriteCounts; changed: LogRowSpec[]; error: string | null }> {
  const first = await applyLogRowsOnce(svc, tx, specs)
  if (!first.raced) return first
  return applyLogRowsOnce(svc, tx, specs)
}

// ── The checks that are not term comparisons ─────────────────────────────────────

async function documentSpecs(svc: Svc, tx: TransactionRow): Promise<{ specs: LogRowSpec[]; unavailable: string | null; policyVersion: number | null }> {
  const contactIds = [tx.buyer_contact_id, tx.seller_contact_id, tx.contact_id]
  const dealType = tx.deal_type === "seller" || tx.deal_type === "dual" ? tx.deal_type : "buyer"
  const audit = await auditTransactionDocuments(svc, {
    transactionId: tx.id, brokerageId: tx.brokerage_id, offerId: tx.offer_id, listingId: tx.listing_id, contactIds,
    dealType, stateCode: tx.property_state, stage: "closing", financing: financingKindFor(tx.financing_type),
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
    const sent = await notifyComplianceFlag(svc, {
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
    })
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

// ── The runner ──────────────────────────────────────────────────────────────────

export async function runClosingCompliance(
  svc: Svc,
  input: RunClosingComplianceInput,
  deps: { governingTerms?: GoverningTermsReader; notify?: ClosingNotifier; audit?: ClosingAuditor; closingEntity?: (brokerageId: string) => Promise<string | null> } = {},
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

  const specs: LogRowSpec[] = []
  let comparison: ClosingComparison | null = null
  let readFault: string | null = null

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
      } else {
        return { ...empty("no settlement statement on file yet — nothing to compare"), governingOnFile: Object.keys(gov.governing.terms).length > 0 }
      }
    } else if (Object.keys(gov.governing.terms).length === 0) {
      specs.push({ check_type: `${CLOSING_TERM_CHECK_PREFIX}governing_terms`, check_label: "Closing: executed contract terms are on file", status: "fail", is_blocking: true,
        failure_reason: "No executed contract, counter or addendum states any term, so nothing can be checked against the settlement statement. Upload the fully executed contract.", signature: "no-governing" })
    } else {
      comparison = compareClosingTerms(gov.governing.terms, settlement.snapshot.terms, gov.governing.conflicts)
      // Listing-side commission belongs to the brokerage that took the listing; skip it on a buyer-only deal.
      for (const f of comparison.findings) {
        if (tx.deal_type === "buyer" && f.term === "commission_listing_side") continue
        specs.push(findingToLogRow(f))
      }
    }
  }

  const docs = await documentSpecs(svc, tx)
  specs.push(...docs.specs)
  const people = await participantSpecs(svc, tx, deps.closingEntity ?? defaultClosingEntity)
  specs.push(...people.specs)

  const written = await applyLogRows(svc, tx, specs)
  if (written.error) {
    return { ...empty(written.error), governingOnFile: gov.ok && Object.keys(gov.governing.terms).length > 0, settlementOnFile: settlement.ok && settlement.snapshot.documents.length > 0, comparison }
  }

  const open = specs.filter((s) => s.status !== "pass")
  const openBlocking = open.filter((s) => s.is_blocking).length
  const notified = await (deps.notify ?? notifyOpenFindings)(svc, tx, written.changed, input.trigger)

  // LAW 5 evidence. Not allowed to fail the check (the auditor swallows and logs its own fault).
  await (deps.audit ?? auditClosingRun)(tx, {
    trigger: input.trigger, actorUserId: input.actorUserId ?? null,
    metadata: {
      written: written.counts, open_blocking: openBlocking, open_review: open.length - openBlocking,
      checklist_policy_version: docs.policyVersion,
      governing_applied: gov.ok ? gov.governing.applied.map((a) => ({ id: a.id, kind: a.kind, executedAt: a.executedAt })) : [],
      governing_ignored: gov.ok ? gov.governing.ignored : [],
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
  }
}
