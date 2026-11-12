// lib/offers/closing-cost-accuracy.ts
//
// CLOSING-COST ACCURACY FLYWHEEL (owner round 34, rec 5): compare the REGIONAL
// closing-cost estimates (lib/offers/regional-closing-costs — the published-
// convention model, code not data) against the ACTUAL Closing Disclosures that
// already flow through the document kernel, and record one accuracy observation
// per closed deal so per-state accuracy is measured from real outcomes.
//
// HONESTY CONTRACT:
//   - ACTUALS come ONLY from the document kernel's per-field extraction ledger
//     (document_field_extractions) — real extracted figures, provenance-checked
//     (human-verified rows always count; unverified rows only at high/medium
//     scan confidence). Nothing is inferred, defaulted, or back-filled.
//   - LINE MAPPING IS HONEST: only estimate lines with a clean CD counterpart
//     are compared (owner's title, settlement/closing fee, recording+transfer,
//     lender's title). cash_to_close is NEVER compared to the estimate total —
//     it includes the down payment and is not the same quantity. A missing CD
//     figure means the line is NOT graded, never a fabricated $0 delta.
//   - NO AUTO-ADJUSTMENT: the convention table stays code. This module records
//     observations and renders the per-state report that ARMS the yearly
//     finance review — it never rewrites a convention.
//   - EMPTY STATE IS EMPTY: no observations → no invented accuracy. The report
//     says "no observations" instead of synthesizing numbers.
//
// Storage: closing_cost_accuracy_observations (migration
// scripts/1104-closing-cost-accuracy-observations.sql — REPORT-ONLY until
// applied; every writer/reader here degrades honestly while the table is
// absent). One observation per (transaction, closing-disclosure document).
//
// Wiring: recordClosingCostAccuracy runs best-effort from (a) the CLOSED
// branch of stage-progression (deal closes with a CD already scanned) and
// (b) the universal scanner's post-scan hooks (a CD lands on an already-CLOSED
// deal). Both paths are idempotent via upsert on (transaction_id, document_id).

import type { SupabaseClient } from "@supabase/supabase-js"
import { estimateBuyerClosingCosts, type BuyerCostLine } from "./buyer-closing-costs"
import {
  estimateSellerClosingCosts,
  resolveSellerCommission,
  type SellerCostLine,
} from "./seller-closing-costs"
import { normalizeStateCode } from "./regional-closing-costs"
// WAVE 152 (lane 152G): the PURE contract-to-settlement reconciliation rule (client-safe, no I/O) — this file reads, it decides.
import { reconcileSettlement, resolveCdaMode, preliminaryReviewOf, type SettlementReconciliation } from "@/lib/transactions/cda-closing-policy"
import { financingKindFor } from "@/lib/compliance/checklist-dimensions"

type Svc = SupabaseClient<any, any, any>

// ─── Pure: the CD field keys the kernel can extract, and their parsing ──────

/** Ledger field keys read off a scanned Closing Disclosure. The first four are
 *  the original scan shape; the rest are the line-level figures the scanner
 *  extracts when they are explicitly stated on the document (borrower-paid
 *  column). Absent = not on the document = not graded. */
export const CD_ACCURACY_FIELD_KEYS = [
  "loan_amount",
  "cash_to_close",
  "total_closing_costs",
  "owner_title_premium",
  "lender_title_premium",
  "settlement_fee",
  "transfer_taxes",
  "recording_fees",
] as const

// internal type — used only by extractActualCdFigures/mapAccuracyLines, both un-exported in-file helpers
interface ActualCdFigures {
  loanAmount: number | null
  cashToClose: number | null
  totalClosingCosts: number | null
  ownerTitlePremium: number | null
  lenderTitlePremium: number | null
  settlementFee: number | null
  transferTaxes: number | null
  recordingFees: number | null
}

export interface LedgerFieldRow {
  field_key: string
  field_value_json: unknown
  confidence: "high" | "medium" | "low" | string
  verified_at: string | null
}

/** Tolerant money parse: 12345, "12,345.67", "$12,345" → number; else null.
 *  Negative or non-numeric values are refused (a CD line is never negative). */
export function parseMoney(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null
  if (typeof v === "string") {
    const cleaned = v.replace(/[$,\s]/g, "")
    if (cleaned === "" || !/^\d+(\.\d+)?$/.test(cleaned)) return null
    const n = Number(cleaned)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** PROVENANCE GATE: a ledger row is usable when a human verified it (any
 *  confidence) or the scan confidence is high/medium. Low-confidence
 *  unverified rows are refused — an uncertain extraction is not an outcome. */
// internal helper — called in-file by mapAccuracyLines/mapSellerAccuracyLines, both reachable from getClosingCostAccuracyReport
function isProvenanceUsable(row: LedgerFieldRow): boolean {
  if (row.verified_at != null) return true
  return row.confidence === "high" || row.confidence === "medium"
}

/** Pure: fold provenance-usable ledger rows into the actual CD figures. */
// internal helper — called in-file by recordClosingCostAccuracy
function extractActualCdFigures(rows: LedgerFieldRow[]): {
  figures: ActualCdFigures
  usableFieldKeys: string[]
  anyVerified: boolean
} {
  const usable = rows.filter(isProvenanceUsable)
  const byKey = new Map<string, unknown>()
  for (const r of usable) byKey.set(r.field_key, r.field_value_json)
  const g = (k: string) => parseMoney(byKey.get(k))
  const figures: ActualCdFigures = {
    loanAmount: g("loan_amount"),
    cashToClose: g("cash_to_close"),
    totalClosingCosts: g("total_closing_costs"),
    ownerTitlePremium: g("owner_title_premium"),
    lenderTitlePremium: g("lender_title_premium"),
    settlementFee: g("settlement_fee"),
    transferTaxes: g("transfer_taxes"),
    recordingFees: g("recording_fees"),
  }
  const usableFieldKeys = (CD_ACCURACY_FIELD_KEYS as readonly string[]).filter(
    (k) => parseMoney(byKey.get(k)) != null,
  )
  return { figures, usableFieldKeys, anyVerified: usable.some((r) => r.verified_at != null) }
}

// ─── Pure: the honest estimate-line ↔ CD-line mapping ───────────────────────

export type AccuracyLineKey = "owner_title" | "settlement_fee" | "transfer_recording" | "lender_title"

export const ACCURACY_LINE_LABELS: Record<AccuracyLineKey, string> = {
  owner_title: "Owner's title insurance",
  settlement_fee: "Settlement / closing fee",
  transfer_recording: "Recording & transfer charges",
  lender_title: "Lender's title insurance",
}

/** SELLER side (round 36): the seller-line keys graded off the settlement
 *  statement / CD on a closed SALE-side deal. */
export type SellerAccuracyLineKey =
  | "commission"
  | "mortgage_payoff"
  | "seller_title_settlement"
  | "seller_transfer_tax"
  | "seller_tax_proration"

export const SELLER_ACCURACY_LINE_LABELS: Record<SellerAccuracyLineKey, string> = {
  commission: "Real estate commission",
  mortgage_payoff: "Mortgage payoff",
  seller_title_settlement: "Seller title & settlement charges",
  seller_transfer_tax: "Transfer / deed tax (seller share)",
  // Wave 144 (144D, owner ruling 6): the proration the net sheet COMPUTED from the deal's convention, graded against the
  // statement's proration figure (magnitudes — statements state the direction in the column, not the sign).
  seller_tax_proration: "Property-tax proration",
}

/** Which side of the deal an observation grades. Rows written before the side
 *  discriminator existed (migration 1105) are buyer-side by construction. */
export type ClosingCostSide = "buyer" | "seller"

export interface AccuracyLine {
  key: AccuracyLineKey | SellerAccuracyLineKey
  label: string
  estimateLow: number
  estimateHigh: number
  /** the real borrower-paid figure off the Closing Disclosure */
  actual: number
  /** actual − band midpoint (positive = we under-estimated) */
  deltaFromMid: number
  /** true when the actual landed inside the estimate's low–high band */
  withinBand: boolean
}

const mkLine = (key: AccuracyLineKey, est: BuyerCostLine, actual: number): AccuracyLine => {
  const mid = (est.low + est.high) / 2
  return {
    key,
    label: ACCURACY_LINE_LABELS[key],
    estimateLow: est.low,
    estimateHigh: est.high,
    actual,
    deltaFromMid: Math.round(actual - mid),
    withinBand: actual >= est.low && actual <= est.high,
  }
}

/** Pure: map estimate lines to CD actuals — ONLY the clean mappings.
 *  Rules (each is refused rather than fudged):
 *   - owner_title      ↔ owner_title_premium
 *   - settlement_fee   ↔ settlement_fee (either settlement-line label variant)
 *   - transfer_recording ↔ transfer_taxes + recording_fees — BOTH must be on
 *     the CD, because the estimate line is their sum (absent ≠ zero).
 *   - lender_title     ↔ lender_title_premium — only when the estimate line was
 *     not pending (a pending line has no band to grade).
 *  cash_to_close and total_closing_costs are deliberately NOT mapped to the
 *  estimate total: cash-to-close includes the down payment, and the CD's
 *  section-J total nets lender credits — neither is the estimated quantity. */
// internal helper — called in-file by recordClosingCostAccuracy
function mapAccuracyLines(estimateLines: BuyerCostLine[], actual: ActualCdFigures): AccuracyLine[] {
  const out: AccuracyLine[] = []
  const find = (pred: (l: BuyerCostLine) => boolean) =>
    estimateLines.find((l) => pred(l) && !l.pending && l.high > 0)

  const owner = find((l) => l.label === "Owner's title insurance")
  if (owner && actual.ownerTitlePremium != null) out.push(mkLine("owner_title", owner, actual.ownerTitlePremium))

  const settlement = find(
    (l) => l.label === "Settlement / escrow fee" || l.label === "Settlement / closing attorney fee",
  )
  if (settlement && actual.settlementFee != null) out.push(mkLine("settlement_fee", settlement, actual.settlementFee))

  const transfer = find((l) => l.label === "Recording & transfer charges")
  if (transfer && actual.transferTaxes != null && actual.recordingFees != null) {
    out.push(mkLine("transfer_recording", transfer, actual.transferTaxes + actual.recordingFees))
  }

  const lenderTitle = find((l) => l.label === "Lender's title insurance")
  if (lenderTitle && actual.lenderTitlePremium != null) {
    out.push(mkLine("lender_title", lenderTitle, actual.lenderTitlePremium))
  }

  return out
}

// ─── Pure: SELLER side — settlement-statement actuals + the honest mapping ──
//
// Seller actuals come off the SAME extraction rail the net-sheet surprise
// guard reads (transaction_documents.extracted_data on the final settlement
// statement / Closing Disclosure) — real extracted figures, gated on the
// document's classification confidence. Nothing is inferred or back-filled.

export interface SellerActualFigures {
  commission: number | null
  mortgagePayoff: number | null
  /** the seller-paid title/escrow/settlement charges, combined as stated */
  titleEscrow: number | null
  transferTax: number | null
  netToSeller: number | null
  /** Wave 144 (144D): the statement's property-tax proration figure, when stated (a magnitude). */
  taxProration?: number | null
}

/** Pure: tolerant pick of SELLER-side figures from a settlement statement's
 *  extracted_data blob. Generous key set (statements vary wildly); a line not
 *  on the document is null — absent, never zero. Negative figures refused. */
export function parseSellerSettlementFigures(
  extracted: Record<string, unknown> | null | undefined,
): SellerActualFigures {
  const e = extracted && typeof extracted === "object" ? (extracted as Record<string, unknown>) : {}
  const pick = (...keys: string[]): number | null => {
    for (const k of keys) {
      const n = parseMoney(e[k])
      if (n != null) return n
    }
    return null
  }
  return {
    commission: pick("commission", "total_commission", "real_estate_commission", "broker_commission"),
    mortgagePayoff: pick("mortgage_payoff", "payoff", "loan_payoff", "existing_loan_payoff"),
    titleEscrow: pick("title_fees", "escrow_fees", "title_escrow", "settlement_fees"),
    transferTax: pick("transfer_tax", "transfer_taxes", "deed_tax", "doc_stamps", "documentary_stamps", "excise_tax", "conveyance_tax"),
    netToSeller: pick("seller_net", "net_to_seller", "cash_to_seller", "seller_net_proceeds", "net_proceeds", "proceeds_to_seller"),
    taxProration: pick("tax_proration", "property_tax_proration", "prorated_taxes", "county_tax_proration", "taxes_prorated"),
  }
}

const mkSellerLine = (key: SellerAccuracyLineKey, low: number, high: number, actual: number): AccuracyLine => {
  const mid = (low + high) / 2
  return {
    key,
    label: SELLER_ACCURACY_LINE_LABELS[key],
    estimateLow: low,
    estimateHigh: high,
    actual,
    deltaFromMid: Math.round(actual - mid),
    withinBand: actual >= low && actual <= high,
  }
}

/** Pure: map SELLER estimate lines to settlement actuals — ONLY the clean
 *  mappings, each refused rather than fudged:
 *   - commission          ↔ the statement's stated commission — graded only
 *     when the estimate rode a REAL record (non-pending); a pending line has
 *     no band, and grading an assumption is exactly what this rail refuses.
 *   - mortgage_payoff     ↔ the statement's payoff — same non-pending rule.
 *   - seller_title_settlement ↔ title/escrow/settlement charges combined:
 *     the estimate side is the SUM of the owner's-title seller share and the
 *     settlement-share bands (the statement states them combined).
 *   - seller_transfer_tax ↔ the statement's transfer/deed tax — only where
 *     the regional band says the seller customarily owes any (high > 0).
 *  netToSeller is deliberately NOT mapped here — the net-vs-promise story is
 *  the net-sheet reconciliation rail's (net_sheet_reconciliations), keep-one. */
export function mapSellerAccuracyLines(
  estimateLines: SellerCostLine[],
  actual: SellerActualFigures,
): AccuracyLine[] {
  const out: AccuracyLine[] = []
  const find = (label: string) => estimateLines.find((l) => l.label === label && !l.pending)

  const commission = find("Real estate commission")
  if (commission && commission.high > 0 && actual.commission != null) {
    out.push(mkSellerLine("commission", commission.low, commission.high, actual.commission))
  }

  const payoff = find("Mortgage payoff")
  if (payoff && payoff.high > 0 && actual.mortgagePayoff != null) {
    out.push(mkSellerLine("mortgage_payoff", payoff.low, payoff.high, actual.mortgagePayoff))
  }

  const ownerTitle = find("Owner's title insurance (seller share)")
  const settlement = estimateLines.find(
    (l) => (l.label === "Settlement / escrow fee (seller share)" || l.label === "Seller's closing attorney fee") && !l.pending,
  )
  if (ownerTitle && settlement && actual.titleEscrow != null) {
    const low = ownerTitle.low + settlement.low
    const high = ownerTitle.high + settlement.high
    if (high > 0) out.push(mkSellerLine("seller_title_settlement", low, high, actual.titleEscrow))
  }

  const transfer = find("Transfer / deed tax (seller share)")
  if (transfer && transfer.high > 0 && actual.transferTax != null) {
    out.push(mkSellerLine("seller_transfer_tax", transfer.low, transfer.high, actual.transferTax))
  }

  // Wave 144 (144D): graded only when the net sheet COMPUTED the proration from the deal's convention (a pending note
  // has no number to grade) and the statement states one. Magnitudes: a reimbursement is a negative cost on our side.
  const proration = find("Property-tax proration")
  if (proration && proration.high !== 0 && actual.taxProration != null) {
    const est = Math.abs(proration.high)
    out.push(mkSellerLine("seller_tax_proration", est, est, Math.abs(actual.taxProration)))
  }

  return out
}

// ─── Pure: per-state aggregation for the report ─────────────────────────────

/** Every gradable line key, both sides — the per-state report shows whichever
 *  keys actually have observations (honest: ungraded keys never appear). */
const ALL_ACCURACY_LINE_LABELS: Record<AccuracyLineKey | SellerAccuracyLineKey, string> = {
  ...ACCURACY_LINE_LABELS,
  ...SELLER_ACCURACY_LINE_LABELS,
}

export interface StateAccuracyLineStat {
  key: AccuracyLineKey | SellerAccuracyLineKey
  label: string
  count: number
  medianDeltaFromMid: number
  /** share of observations where the actual landed inside the estimate band */
  withinBandRate: number
}

export interface StateAccuracyReport {
  state: string
  observationCount: number
  lines: StateAccuracyLineStat[]
}

export function medianOf(values: number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

export function summarizeAccuracyObservations(
  rows: Array<{ state: string; lines: AccuracyLine[] }>,
): StateAccuracyReport[] {
  const byState = new Map<string, AccuracyLine[][]>()
  for (const r of rows) {
    if (!r.state || !Array.isArray(r.lines)) continue
    const bucket = byState.get(r.state) ?? []
    bucket.push(r.lines)
    byState.set(r.state, bucket)
  }
  const reports: StateAccuracyReport[] = []
  for (const [state, observations] of byState) {
    const lineStats: StateAccuracyLineStat[] = []
    for (const key of Object.keys(ALL_ACCURACY_LINE_LABELS) as Array<AccuracyLineKey | SellerAccuracyLineKey>) {
      const graded = observations.flatMap((obs) => obs.filter((l) => l.key === key))
      if (graded.length === 0) continue // honest: ungraded lines don't appear
      lineStats.push({
        key,
        label: ALL_ACCURACY_LINE_LABELS[key],
        count: graded.length,
        medianDeltaFromMid: medianOf(graded.map((l) => l.deltaFromMid)),
        withinBandRate: Math.round((graded.filter((l) => l.withinBand).length / graded.length) * 100) / 100,
      })
    }
    reports.push({ state, observationCount: observations.length, lines: lineStats })
  }
  return reports.sort((a, b) => b.observationCount - a.observationCount || a.state.localeCompare(b.state))
}

// ─── IO: record one observation for a closed deal with a scanned CD ─────────

export interface RecordAccuracyResult {
  recorded: boolean
  reason: string
  observationId?: string
  lineCount?: number
  /** SELLER-side sibling result (round 36) — attached by the combined
   *  entrypoint; absent when the seller pass threw (never blocks the buyer). */
  seller?: RecordAccuracyResult
}

/** Combined entrypoint (unchanged callers: stage-progression CLOSED branch +
 *  the CD post-scan hook). Grades the BUYER side exactly as before, then runs
 *  the SELLER side best-effort on the same deal — sale-side gates live in the
 *  seller recorder itself, and a seller failure never blocks the buyer path. */
export async function recordClosingCostAccuracy(
  svc: Svc,
  input: { transactionId: string; brokerageId: string },
): Promise<RecordAccuracyResult> {
  const buyer = await recordBuyerClosingCostAccuracy(svc, input)
  let seller: RecordAccuracyResult | undefined
  try {
    seller = await recordSellerClosingCostAccuracy(svc, input)
  } catch (e) {
    seller = { recorded: false, reason: `seller pass failed: ${e instanceof Error ? e.message : String(e)}` }
  }
  return { ...buyer, seller }
}

/** Record a BUYER-side accuracy observation for a transaction. Honest at every
 *  exit: each precondition that fails names itself instead of inventing data.
 *  Idempotent: upsert on (transaction_id, document_id, side) — a re-scan with
 *  new figures refreshes the observation; the same figures are a no-op rewrite.
 *  (Pre-migration-1105 ledgers fall back to the legacy 2-column conflict key.) */
export async function recordBuyerClosingCostAccuracy(
  svc: Svc,
  input: { transactionId: string; brokerageId: string },
): Promise<RecordAccuracyResult> {
  const { data: tx } = await svc
    .from("transactions")
    .select("id, brokerage_id, stage, purchase_price, property_state, loan_amount")
    .eq("id", input.transactionId)
    .eq("brokerage_id", input.brokerageId)
    .maybeSingle()
  if (!tx) return { recorded: false, reason: "transaction not found" }
  if (String((tx as any).stage) !== "CLOSED") {
    return { recorded: false, reason: "transaction is not CLOSED — accuracy is only graded on real outcomes" }
  }
  const price = Number((tx as any).purchase_price)
  if (!Number.isFinite(price) || price <= 0) {
    return { recorded: false, reason: "no purchase price on the closed deal" }
  }

  // Region: the property's state, else the brokerage's home state — the same
  // resolution the estimator surface uses. No state → the regional model was
  // never in play, so there is nothing to grade.
  let state = normalizeStateCode((tx as any).property_state)
  if (!state) {
    const { data: brokerage } = await svc
      .from("brokerages").select("state").eq("id", input.brokerageId).maybeSingle()
    state = normalizeStateCode((brokerage as any)?.state)
  }
  if (!state) return { recorded: false, reason: "no state on file — the regional model was never in play" }

  // The scanned Closing Disclosure on the kernel rail (documents + per-field ledger).
  const { data: cdDoc } = await svc
    .from("documents")
    .select("id, scanned_at, classification")
    .eq("transaction_id", input.transactionId)
    .eq("classification", "closing_disclosure")
    .not("scanned_at", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!cdDoc) return { recorded: false, reason: "no scanned Closing Disclosure on the document kernel rail" }

  const { data: ledgerRows } = await svc
    .from("document_field_extractions")
    .select("field_key, field_value_json, confidence, verified_at")
    .eq("document_id", (cdDoc as any).id)
    .in("field_key", [...CD_ACCURACY_FIELD_KEYS])
  const { figures, usableFieldKeys, anyVerified } = extractActualCdFigures(
    ((ledgerRows ?? []) as LedgerFieldRow[]),
  )
  if (usableFieldKeys.length === 0) {
    return { recorded: false, reason: "no provenance-usable extracted figures on the Closing Disclosure" }
  }

  // Recompute the deterministic regional estimate from the deal's real facts.
  // Loan: the CD's own extracted loan amount (a real figure), else the loan on
  // the transaction record, else null (lender-dependent lines go pending and
  // are simply not graded). sellerCredit does not affect line bands.
  const txLoan = Number((tx as any).loan_amount)
  const loanAmount = figures.loanAmount ?? (Number.isFinite(txLoan) && txLoan > 0 && txLoan < price ? txLoan : null)
  const estimate = estimateBuyerClosingCosts({ purchasePrice: price, loanAmount, sellerCredit: 0, state })
  if (!estimate.regionState) {
    return { recorded: false, reason: "regional conventions unavailable for this state" }
  }

  const lines = mapAccuracyLines(estimate.lines, figures)
  if (lines.length === 0) {
    // Today's baseline scan shape (loan_amount + cash_to_close only) lands here —
    // honest: totals that aren't the estimated quantity are not force-compared.
    return { recorded: false, reason: "no extracted CD figure maps cleanly to an estimate line" }
  }

  const row = {
    brokerage_id: input.brokerageId,
    transaction_id: input.transactionId,
    document_id: (cdDoc as any).id,
    state,
    purchase_price: price,
    loan_amount: loanAmount,
    extraction_verified: anyVerified,
    extracted_field_keys: usableFieldKeys,
    lines: lines as unknown,
    line_count: lines.length,
    cash_to_close: figures.cashToClose,
    total_closing_costs: figures.totalClosingCosts,
  }
  let { data: saved, error } = await svc
    .from("closing_cost_accuracy_observations")
    .upsert({ ...row, side: "buyer" }, { onConflict: "transaction_id,document_id,side" })
    .select("id")
    .maybeSingle()
  if (error) {
    // Pre-1105 ledger (no side column / legacy 2-column unique) — legacy write
    // shape; those rows are buyer-side by construction.
    ;({ data: saved, error } = await svc
      .from("closing_cost_accuracy_observations")
      .upsert(row, { onConflict: "transaction_id,document_id" })
      .select("id")
      .maybeSingle())
  }
  if (error) {
    // Table not provisioned yet (migration 1104 is report-only until applied) or
    // any other write failure — degrade honestly, never throw into a close path.
    return { recorded: false, reason: `observation not stored: ${error.message}` }
  }
  return { recorded: true, reason: "observation recorded", observationId: (saved as any)?.id, lineCount: lines.length }
}

// ─── IO: SELLER side — one observation per closed SALE-side deal ────────────

/** Record a SELLER-side accuracy observation. Actuals come off the settlement
 *  statement / CD on the transaction-documents rail (the SAME extractions the
 *  net-sheet surprise guard reconciles against); the estimate is recomputed
 *  from the deal's real facts — commission ONLY from the deal's own records
 *  (resolveSellerCommission), payoff honestly pending (and therefore never
 *  graded) since no payoff-statement ledger exists. Honest at every exit.
 *  Idempotent: upsert on (transaction_id, document_id, side) — requires the
 *  side discriminator (migration 1105); degrades honestly until applied. */
export async function recordSellerClosingCostAccuracy(
  svc: Svc,
  input: { transactionId: string; brokerageId: string },
): Promise<RecordAccuracyResult> {
  const { data: tx } = await svc
    .from("transactions")
    .select("id, brokerage_id, stage, purchase_price, property_state, listing_id, seller_contact_id, seller_agent_id, deal_type, commission_amount, commission_percentage")
    .eq("id", input.transactionId)
    .eq("brokerage_id", input.brokerageId)
    .maybeSingle()
  if (!tx) return { recorded: false, reason: "transaction not found" }
  const t = tx as any
  if (String(t.stage) !== "CLOSED") {
    return { recorded: false, reason: "transaction is not CLOSED — accuracy is only graded on real outcomes" }
  }
  // SALE-side gate: the seller estimate was only ever in play on our sale side.
  const saleSide =
    t.seller_contact_id != null || t.seller_agent_id != null || /sell|list/i.test(String(t.deal_type ?? ""))
  if (!saleSide) {
    return { recorded: false, reason: "not a sale-side transaction — the seller estimate was never in play" }
  }
  const price = Number(t.purchase_price)
  if (!Number.isFinite(price) || price <= 0) {
    return { recorded: false, reason: "no purchase price on the closed deal" }
  }

  let state = normalizeStateCode(t.property_state)
  if (!state) {
    const { data: brokerage } = await svc
      .from("brokerages").select("state").eq("id", input.brokerageId).maybeSingle()
    state = normalizeStateCode((brokerage as any)?.state)
  }
  if (!state) return { recorded: false, reason: "no state on file — the regional model was never in play" }

  // The settlement statement / CD on the guard's rail — real extracted figures.
  const { data: docs } = await svc
    .from("transaction_documents")
    .select("id, doc_type, extracted_data, classification_confidence, created_at")
    .eq("transaction_id", input.transactionId)
    .in("doc_type", ["final_settlement_statement", "closing_disclosure"])
    .order("created_at", { ascending: false })
    .limit(1)
  const doc = ((docs ?? []) as any[])[0]
  if (!doc) {
    return { recorded: false, reason: "no settlement statement / Closing Disclosure on the transaction-documents rail" }
  }
  if (String(doc.classification_confidence ?? "") === "low") {
    return { recorded: false, reason: "low-confidence extraction — an uncertain scan is not an outcome" }
  }
  const actual = parseSellerSettlementFigures(doc.extracted_data)
  const usableFieldKeys = (
    [
      ["commission", actual.commission],
      ["mortgage_payoff", actual.mortgagePayoff],
      ["title_escrow", actual.titleEscrow],
      ["transfer_tax", actual.transferTax],
      ["net_to_seller", actual.netToSeller],
    ] as Array<[string, number | null]>
  ).filter(([, v]) => v != null).map(([k]) => k)
  if (usableFieldKeys.length === 0) {
    return { recorded: false, reason: "no seller-side figures extracted from the settlement statement" }
  }

  // Commission from the deal's OWN records — a rate is never assumed; with no
  // record the commission line stays pending and is simply not graded.
  let listingRatePct: number | null = null
  if (t.listing_id) {
    const { data: lst } = await svc
      .from("listings").select("commission_rate").eq("id", t.listing_id).maybeSingle()
    listingRatePct = (lst as any)?.commission_rate != null ? Number((lst as any).commission_rate) : null
  }
  const commission = resolveSellerCommission({
    transactionCommissionAmount: t.commission_amount != null ? Number(t.commission_amount) : null,
    listingCommissionRatePct: listingRatePct,
    transactionCommissionPct: t.commission_percentage != null ? Number(t.commission_percentage) : null,
  })

  const estimate = estimateSellerClosingCosts({ salePrice: price, state, commission, mortgagePayoff: null })
  if (!estimate.regionState) {
    return { recorded: false, reason: "regional conventions unavailable for this state" }
  }

  const lines = mapSellerAccuracyLines(estimate.lines, actual)
  if (lines.length === 0) {
    return { recorded: false, reason: "no extracted settlement figure maps cleanly to a seller estimate line" }
  }

  const row = {
    brokerage_id: input.brokerageId,
    transaction_id: input.transactionId,
    document_id: doc.id,
    side: "seller",
    state,
    purchase_price: price,
    loan_amount: null, // the seller's payoff is not a loan-amount fact; never back-filled
    extraction_verified: false, // transaction_documents carries no human-verify ledger — stated, not assumed
    extracted_field_keys: usableFieldKeys,
    lines: lines as unknown,
    line_count: lines.length,
    cash_to_close: null,
    total_closing_costs: null,
  }
  const { data: saved, error } = await svc
    .from("closing_cost_accuracy_observations")
    .upsert(row, { onConflict: "transaction_id,document_id,side" })
    .select("id")
    .maybeSingle()
  if (error) {
    // Table (m1104) or the side discriminator (m1105) not provisioned yet, or
    // any other write failure — degrade honestly, never throw into a close path.
    return { recorded: false, reason: `seller observation not stored (side column requires migration 1105): ${error.message}` }
  }
  return { recorded: true, reason: "seller observation recorded", observationId: (saved as any)?.id, lineCount: lines.length }
}

// ─── IO: the read surface (superadmin analytics) ────────────────────────────

export interface ClosingCostAccuracyReport {
  available: boolean
  /** honest reason when unavailable (table not provisioned, read error) */
  unavailableReason: string | null
  totalObservations: number
  states: StateAccuracyReport[]
}

/** Per-state accuracy rollup. Cross-tenant by default (the convention table is
 *  platform code — superadmin surface); pass brokerageId to scope. Degrades
 *  honestly when the observations table is not provisioned yet. */
export async function getClosingCostAccuracyReport(
  svc: Svc,
  opts?: { brokerageId?: string },
): Promise<ClosingCostAccuracyReport> {
  let query = svc
    .from("closing_cost_accuracy_observations")
    .select("state, lines")
    .order("created_at", { ascending: false })
    .limit(5000)
  if (opts?.brokerageId) query = query.eq("brokerage_id", opts.brokerageId)
  const { data, error } = await query
  if (error) {
    return { available: false, unavailableReason: error.message, totalObservations: 0, states: [] }
  }
  const rows = ((data ?? []) as Array<{ state: string; lines: AccuracyLine[] }>)
  return {
    available: true,
    unavailableReason: null,
    totalObservations: rows.length,
    states: summarizeAccuracyObservations(rows),
  }
}

// ─── IO: THE CONTRACT-TO-SETTLEMENT RECONCILIATION (wave 152, lane 152G) ────────────────────────────────────────────────────────
//
// Owner: "anytime there is a change at closing to transaction, the final closing desclosure has to be correct … that is not
// informational." This is the I/O half of lib/transactions/cda-closing-policy.ts reconcileSettlement, run at the TAIL of THE ONE
// closing check (lib/transactions/closing-compliance.ts runClosingCompliance — 152E COMPARE → RECONCILE), so every existing trigger
// reconciles: a statement / CD scanned (the scanner's post-scan hook), an executed addendum (governing-terms consequences), the pre-CDA
// final check, and the gated close (stage-progression canAdvanceStage). No polling engine, no new table:
//   · the latest statement is the one 152E compared (final › preliminary › unlabeled; newest within), read off the documents rail with
//     its extraction ledger under THIS file's provenance gate (isProvenanceUsable) — the issuer's figures are listed, never computed;
//   · VERSIONED SNAPSHOTS on the policy ledger (policy_decisions, target_type `settlement_reconciliation` — THE ledger "why is this deal
//     held" already lives on; insert-only, so history is never overwritten): a snapshot is written only when what was seen CHANGED
//     (fingerprint), under withActionLedger with the idempotency key (previous fingerprint → new fingerprint), so a replayed scan or a
//     callback that lands twice records nothing twice, and an A → B → A swing still records the return to A;
//   · RACES: a snapshot is evidence, never the gate — the close gate re-runs the check and reads the LIVE reconciliation, so a stale
//     callback that lands last can never make a deal read "reconciled";
//   · CORRECTIVE REQUESTS through 152E's ONE requester (the `correct` seam the runner hands in): ONE deduped, ledgered transaction task
//     per item that needs the issuer / a person, naming the ACTUAL responsible party; a resolved item settles exactly its own task.

const RECONCILIATION_TARGET = "settlement_reconciliation"
const STATEMENT_CLASSES = ["closing_disclosure", "preliminary_closing_statement"] as const
/** Transaction-documents rail doc types that are a settlement statement / CD (uploaded by title or the CDA page, not read by the kernel). */
const STATEMENT_DOC_TYPES_OTHER_RAIL = ["final_settlement_statement", "final_closing_disclosure", "closing_disclosure", "settlement_statement", "preliminary_closing_disclosure"]
/** The issuer figures read off a statement (ledger field keys). apr / loan_product / prepayment_penalty are read when the scanner states them. */
const ISSUER_FIGURE_KEYS = { cashToClose: "cash_to_close", loanAmount: "loan_amount", totalClosingCosts: "total_closing_costs", sellerProceeds: "seller_proceeds", apr: "apr", loanProduct: "loan_product", prepaymentPenalty: "prepayment_penalty" } as const
/** The 152E statement-term rows (closing_terms.<term>) — represented by the reconciliation's own items, so not counted twice. */
const STATEMENT_TERM_ROW = /^closing_terms\.(purchase_price|earnest_money|closing_date|seller_credit|agent_credit|agent_credit_seller|seller_transaction_fee|seller_admin_fee|buyer_transaction_fee|buyer_admin_fee|owner_title_policy_payer|commission_listing_side|commission_buyer_side|commission_total)$/
/** Rows the reconciliation represents itself (no statement on file) or that a separate gate owns (the closing question). */
const NOT_A_RECONCILIATION_ROW = (t: string) => t === "closing_terms.settlement_statement" || t.startsWith("closing_verification.")
/** Items that owe a corrective request (the issuer reissues / a person verifies / finance corrects). */
const CORRECTION_STATUSES = new Set(["missing_on_document", "unverified_reading", "not_on_file", "advisory"])

/** A corrective-request spec, the shape 152E's requester takes (closing-compliance-core LogRowSpec, structurally). */
interface CorrectionSpec { check_type: string; check_label: string; status: "pass" | "fail" | "needs_review"; is_blocking: boolean; failure_reason: string | null; signature: string; responsible?: string | null }
type CorrectionRequesterLike = (svc: Svc, tx: never, open: CorrectionSpec[], cleared: CorrectionSpec[], trigger: string) => Promise<{ opened: number; refreshed: number; completed: number; errors: string[] }>

export interface SettlementReconciliationRun {
  ok: boolean
  error: string | null
  reconciliation: SettlementReconciliation | null
  snapshot: { recorded: boolean; replay: boolean; version: number | null; supersedes: string | null; error: string | null }
  corrections: { opened: number; refreshed: number; completed: number; errors: string[] }
}

/** A ledger value may be the bare figure or 152D's evidence envelope { value, page, … } — unwrap, never guess. */
const unwrapLedgerValue = (v: unknown): unknown => (v && typeof v === "object" && !Array.isArray(v) && "value" in (v as Record<string, unknown>) ? (v as Record<string, unknown>).value : v)

type IssuerFigures = Parameters<typeof reconcileSettlement>[0]["figures"]

function figuresFor(docId: string, blob: unknown, blobConfidence: string | null, ledger: Array<LedgerFieldRow & { document_id: string }>): IssuerFigures {
  const out: Record<keyof typeof ISSUER_FIGURE_KEYS, { value: number | string | boolean; confidence: string } | null> = { cashToClose: null, loanAmount: null, totalClosingCosts: null, sellerProceeds: null, apr: null, loanProduct: null, prepaymentPenalty: null }
  const b = blob && typeof blob === "object" ? (blob as Record<string, unknown>) : {}
  for (const [name, key] of Object.entries(ISSUER_FIGURE_KEYS) as Array<[keyof typeof ISSUER_FIGURE_KEYS, string]>) {
    const row = ledger.find((r) => r.document_id === docId && r.field_key === key && isProvenanceUsable(r))
    const v = row ? unwrapLedgerValue(row.field_value_json) : (blobConfidence === "low" ? undefined : b[key])
    out[name] = v === undefined || v === null || v === "" ? null : { value: v as number | string | boolean, confidence: row ? (row.verified_at ? "verified" : String(row.confidence)) : String(blobConfidence ?? "unknown") }
  }
  return out
}

/**
 * Reconcile the deal's current settlement record against the executed terms (152E's comparison, handed in by the runner), snapshot
 * it when it changed, and open / settle the corrective requests. Tenant-pinned; every refused read is a READ FAULT (the
 * reconciliation is then compliance-blocked — "nobody checked" never reads as "reconciled"). Writes: one policy_decisions row per
 * changed state (under the action ledger) and the corrective tasks through 152E's requester — never a term, a document, a CD or a
 * ledger entry.
 */
export async function reconcileClosingSettlement(
  svc: Svc,
  ctx: {
    transactionId: string
    brokerageId: string
    trigger: string
    actorUserId?: string | null
    comparison: { findings: ReadonlyArray<{ term: string; label: string; verdict: "match" | "mismatch" | "unverifiable" | "conflict"; classification: string; governing: string | null; settlement: string | null; blocking: boolean; against?: "settlement" | "deal_record" }> } | null
    readFault: string | null
  },
  deps: { correct?: CorrectionRequesterLike } = {},
): Promise<SettlementReconciliationRun> {
  const none = { opened: 0, refreshed: 0, completed: 0, errors: [] as string[] }
  const fail = (error: string): SettlementReconciliationRun => ({ ok: false, error, reconciliation: null, snapshot: { recorded: false, replay: false, version: null, supersedes: null, error: null }, corrections: none })
  const B = ctx.brokerageId, T = ctx.transactionId
  if (!B) return fail("no_tenant")
  const faults: string[] = ctx.readFault ? [ctx.readFault] : []

  const { data: txRow, error: txErr } = await svc.from("transactions").select("id, brokerage_id, stage, status, financing_type, loan_amount, commission_finalized_at").eq("id", T).eq("brokerage_id", B).maybeSingle()
  if (txErr) return fail(`transaction_read_refused: ${txErr.message}`)
  if (!txRow) return fail("transaction_not_found")
  const tx = txRow as Record<string, unknown>

  const [brk, trid, docs, cda, otherRail, logRows, tasks, prior] = await Promise.all([
    svc.from("brokerages").select("offers_cda, non_cda_payout_default").eq("id", B).maybeSingle(),
    svc.from("trid_timeline").select("id, closing_disclosure_delivered_date").eq("brokerage_id", B).eq("transaction_id", T).maybeSingle(),
    svc.from("documents").select("id, classification, classification_confidence, extracted_fields, created_at").eq("brokerage_id", B).eq("transaction_id", T).in("classification", [...STATEMENT_CLASSES]).order("created_at", { ascending: false }).limit(8),
    svc.from("closing_disclosure_agreement").select("id, final_cd_document_id, preliminary_cd_document_id, field_values").eq("brokerage_id", B).eq("transaction_id", T).order("updated_at", { ascending: false }).limit(1),
    svc.from("transaction_documents").select("id, doc_type").eq("brokerage_id", B).eq("transaction_id", T).in("doc_type", STATEMENT_DOC_TYPES_OTHER_RAIL).limit(5),
    svc.from("transaction_compliance_log").select("check_type, check_label, status, is_blocking").eq("brokerage_id", B).eq("transaction_id", T),
    svc.from("transaction_tasks").select("id").eq("brokerage_id", B).eq("transaction_id", T).eq("category", "compliance_correction").in("status", ["pending", "in_progress"]),
    svc.from("policy_decisions").select("id, evidence_json, created_at").eq("brokerage_id", B).eq("transaction_id", T).eq("target_type", RECONCILIATION_TARGET).order("created_at", { ascending: false }).limit(1),
  ])
  for (const [name, r] of [["brokerage", brk], ["TRID timeline", trid], ["settlement statements", docs], ["CDA", cda], ["uploaded statements", otherRail], ["compliance log", logRows], ["corrective requests", tasks], ["previous reconciliation", prior]] as const) {
    if ((r as { error?: { message: string } | null }).error) faults.push(`the ${name} could not be read: ${(r as { error: { message: string } }).error.message}`)
  }

  type DocRow = { id: string; classification: string; classification_confidence: string | null; extracted_fields: unknown; created_at: string | null }
  const cdaRow = (((cda.data ?? []) as Array<{ final_cd_document_id: string | null; preliminary_cd_document_id: string | null; field_values: Record<string, unknown> | null }>)[0]) ?? null
  // the SAME order 152E's settlement snapshot reads (final › preliminary › unlabeled; newest first within a stage)
  const stageOf = (d: DocRow): "final" | "preliminary" | "unlabeled" => d.id === cdaRow?.final_cd_document_id ? "final" : d.id === cdaRow?.preliminary_cd_document_id ? "preliminary" : "unlabeled"
  const rank = { final: 0, preliminary: 1, unlabeled: 2 } as const
  const docList = ((docs.data ?? []) as DocRow[]).map((d, i) => ({ d, i, stage: stageOf(d) })).sort((a, b) => rank[a.stage] - rank[b.stage] || a.i - b.i)
  const latest = docList[0] ?? null
  const priorCd = latest && latest.d.classification === "closing_disclosure" ? docList.slice(1).find((x) => x.d.classification === "closing_disclosure") ?? null : null

  let ledger: Array<LedgerFieldRow & { document_id: string }> = []
  const ledgerIds = [latest?.d.id, priorCd?.d.id].filter((x): x is string => !!x)
  if (ledgerIds.length > 0) {
    const { data, error } = await svc.from("document_field_extractions").select("document_id, field_key, field_value_json, confidence, verified_at").eq("brokerage_id", B).in("document_id", ledgerIds)
    if (error) faults.push(`the statement readings could not be read: ${error.message}`)
    else ledger = (data ?? []) as Array<LedgerFieldRow & { document_id: string }>
  }

  const b = (brk.data ?? null) as { offers_cda?: boolean | null; non_cda_payout_default?: string | null } | null
  // WAVE 152 (lane 152H): the mode that governs THIS deal (cda-closing-policy.ts §1c); an unreadable history is a named fault.
  const { loadEffectiveCdaModes } = await import("@/lib/transactions/cda-closing-policy")
  const effMode = await loadEffectiveCdaModes(svc, { brokerageId: B, transactionIds: [T], live: { offersCda: b?.offers_cda ?? null, nonCdaPayoutDefault: b?.non_cda_payout_default ?? null } })
  if (!effMode.ok) faults.push(`the deal's CDA policy could not be read: ${effMode.error}`)
  const cdaMode = resolveCdaMode(effMode.ok && effMode.deals[T] ? effMode.deals[T].governing : { offersCda: b?.offers_cda ?? null, nonCdaPayoutDefault: b?.non_cda_payout_default ?? null }).mode
  const review = preliminaryReviewOf(cdaRow?.field_values ?? null)
  const logs = (logRows.data ?? []) as Array<{ check_type: string; check_label: string | null; status: string; is_blocking: boolean | null }>
  const closed = String(tx.stage ?? "") === "CLOSED" || ["closed", "funded"].includes(String(tx.status ?? "").toLowerCase())

  const reconciliation = reconcileSettlement({
    closing: { financing: financingKindFor(tx.financing_type), tridTracked: !!trid.data, closed, commissionFinalized: !!tx.commission_finalized_at },
    findings: ctx.comparison?.findings ?? null,
    otherOpenBlocking: logs.filter((r) => r.is_blocking === true && ["fail", "pending", "needs_review"].includes(r.status) && !STATEMENT_TERM_ROW.test(r.check_type) && !NOT_A_RECONCILIATION_ROW(r.check_type)).map((r) => r.check_label ?? r.check_type),
    waivedTerms: logs.filter((r) => r.status === "waived" && STATEMENT_TERM_ROW.test(r.check_type)).map((r) => r.check_type.slice("closing_terms.".length)),
    statement: latest ? { documentId: latest.d.id, classification: latest.d.classification, stage: latest.stage, receivedAt: latest.d.created_at, versions: docList.length } : null,
    figures: latest ? figuresFor(latest.d.id, latest.d.extracted_fields, latest.d.classification_confidence, ledger) : {},
    priorCdFigures: priorCd ? figuresFor(priorCd.d.id, priorCd.d.extracted_fields, priorCd.d.classification_confidence, ledger) : null,
    dealRecord: { loanAmount: tx.loan_amount != null && Number.isFinite(Number(tx.loan_amount)) ? Number(tx.loan_amount) : null },
    trid: trid.data ? { cdDeliveredDate: ((trid.data as { closing_disclosure_delivered_date?: string | null }).closing_disclosure_delivered_date ?? null) } : null,
    cdaMode,
    cdaRail: {
      finalAttached: !!cdaRow?.final_cd_document_id,
      preliminaryReviewed: review?.status === "reviewed",
      correctionRequestedAt: review?.status === "correction_requested" ? review.requested_at : null,
      correctionRoute: review?.status === "correction_requested" ? review.delivery?.route ?? "none" : null,
    },
    unreadStatementOnFile: ((otherRail.data ?? []) as unknown[]).length > 0,
    openCorrectionTasks: ((tasks.data ?? []) as unknown[]).length,
    readFault: faults.length > 0 ? faults.join("; ") : null,
  })

  // ── the versioned snapshot — only when what was seen changed ──
  const priorRow = (((prior.data ?? []) as Array<{ evidence_json: Record<string, unknown> | null }>)[0]) ?? null
  const priorFp = typeof priorRow?.evidence_json?.fingerprint === "string" ? (priorRow.evidence_json.fingerprint as string) : null
  const priorVersion = typeof priorRow?.evidence_json?.version === "number" ? (priorRow.evidence_json.version as number) : 0
  const priorCorrections = Array.isArray(priorRow?.evidence_json?.corrections) ? (priorRow!.evidence_json!.corrections as Array<{ key: string; label: string }>) : []
  const snapshot: SettlementReconciliationRun["snapshot"] = { recorded: false, replay: false, version: priorVersion || null, supersedes: priorFp, error: null }
  // who owes a correction: the issuer (a line missing / a revised CD's wait), a person (an unverified reading, an unread upload), finance
  // (a corrected statement after closing). Not the read fault (transient — the run itself is the retry) and not "no statement on file"
  // (152E's final check files that hold and its request already).
  const owed = reconciliation.items.filter((i) => i.responsible && CORRECTION_STATUSES.has(i.status) && i.key !== "inputs" && !(i.key === "record" && i.documentSays == null)
    && (i.blocking || i.key === "post_closing.correction"))
  let corrections = none
  if (priorFp !== reconciliation.fingerprint && !prior.error) {
    const version = priorVersion + 1
    const decision = reconciliation.state === "ready" ? "green" : reconciliation.state === "compliance_blocked" ? "red" : "amber"
    const recommended = reconciliation.state === "ready" ? "settlement_reconciled" : reconciliation.state === "awaiting_revised_document" ? "request_revised_statement" : reconciliation.state === "needs_review" ? "verify_reading" : "resolve_compliance_items"
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    const { recordPolicyDecision } = await import("@/lib/documents/policy-decisions")
    const res = await withActionLedger<{ recorded: boolean; replay?: boolean; error?: string }>(
      {
        brokerageId: B,
        action: "compliance.settlement_reconciliation.snapshot",
        actor: { type: "manager", managerKey: "compliance_officer" },
        subject: { type: "transaction", id: T, ref: reconciliation.fingerprint },
        reasonCode: "COMPLIANCE_NOTICE",
        reasonDetail: `settlement reconciliation v${version}: ${reconciliation.state} (${ctx.trigger})`.slice(0, 500),
        riskClass: "LOW_RISK_WRITE",
        systemSource: "closing_compliance",
        idempotencyKey: `settlement-reconciliation:${B}:${T}:${priorFp ?? "none"}>${reconciliation.fingerprint}`,
        detail: { version, state: reconciliation.state, supersedes: priorFp, fingerprint: reconciliation.fingerprint, trigger: ctx.trigger, final_on_file: reconciliation.record.finalOnFile, blocking: reconciliation.blockers.length },
      },
      async () => recordPolicyDecision(svc, {
        brokerageId: B, transactionId: T, documentId: reconciliation.record.documentId, targetType: RECONCILIATION_TARGET, targetId: T,
        verdict: { decision, reasons: reconciliation.blockers.length > 0 ? reconciliation.blockers : ["the executed terms agree with the latest settlement record"], recommendedAction: recommended, requiredApproverRole: decision === "green" ? null : decision === "red" ? "compliance_officer" : "tc" },
        evidence: { version, fingerprint: reconciliation.fingerprint, supersedes: priorFp, trigger: ctx.trigger, actor_user_id: ctx.actorUserId ?? null, state: reconciliation.state, record: reconciliation.record, trid: reconciliation.trid, request: reconciliation.request, items: reconciliation.items, corrections: owed.map((i) => ({ key: i.key, label: i.label })) },
      }),
      {
        settle: (r) => (r.recorded ? { status: "executed", outcome: "snapshot_recorded" } : { status: "failed", outcome: "snapshot_refused", error: "the policy ledger refused the reconciliation snapshot" }),
        // Claim-aware: a REFUSED claim (the action ledger would not record the attempt) is NOT a replay — nothing was
        // written and the snapshot must say it could not be recorded, never "already recorded".
        replay: (claim) => (claim.kind === "refused"
          ? { recorded: false, replay: false, error: `the action ledger refused the reconciliation claim: ${claim.error}` }
          : { recorded: false, replay: true }),
      },
      { client: svc as never },
    )
    snapshot.recorded = res.recorded
    snapshot.replay = res.replay === true
    snapshot.version = res.recorded ? version : priorVersion || null
    if (!res.recorded && !res.replay) snapshot.error = res.error ?? "the policy ledger refused the reconciliation snapshot"

    // ── corrective requests (152E's ONE requester) — only on a NEW snapshot, so a replay opens nothing ──
    if (res.recorded && deps.correct) {
      const spec = (i: { key: string; label: string; status: string; blocking: boolean; contractSays: string | null; documentSays: string | null; action: string | null; responsible: string | null; staffOnly: boolean }): CorrectionSpec => ({
        check_type: `closing_terms.reconciliation.${i.key}`,
        check_label: `Closing: settlement — ${i.label}`,
        status: i.blocking ? "fail" : "needs_review",
        is_blocking: i.blocking,
        failure_reason: `${i.staffOnly ? "" : i.contractSays != null || i.documentSays != null ? `Contract says ${i.contractSays ?? "—"}; the latest document says ${i.documentSays ?? "not shown"}. ` : ""}${i.action ?? ""}`.trim(),
        signature: `${i.status}|${i.contractSays ?? "-"}|${i.documentSays ?? "-"}`,
        responsible: i.responsible,
      })
      const nowKeys = new Set(owed.map((i) => i.key))
      const cleared = priorCorrections.filter((c) => !nowKeys.has(c.key)).map((c) => ({ check_type: `closing_terms.reconciliation.${c.key}`, check_label: `Closing: settlement — ${c.label}`, status: "pass" as const, is_blocking: false, failure_reason: null, signature: "cleared" }))
      try {
        corrections = await deps.correct(svc, { id: T, brokerage_id: B } as never, owed.map(spec), cleared, ctx.trigger)
      } catch (e) {
        corrections = { ...none, errors: [e instanceof Error ? e.message : String(e)] }
      }
    }
  } else if (prior.error) {
    snapshot.error = `the previous reconciliation could not be read (${prior.error.message}) — no snapshot written`
  }

  return { ok: true, error: null, reconciliation, snapshot, corrections }
}

type ClosingRunner = (svc: Svc, input: { transactionId: string; brokerageId: string; trigger: "final_check" }) => Promise<{ ran: boolean; reason: string | null; reconciliation: SettlementReconciliationRun | null }>

/**
 * THE GATED CLOSE'S SETTLEMENT HOLD (wave 152, lane 152G — owner: "that is not informational"). Called by
 * lib/transactions/stage-progression.ts canAdvanceStage for the CLOSED target (both close doors reach it: the stage machine and the
 * kernel's closeTransactionCommand). It runs THE ONE closing check fresh (trigger final_check — idempotent; its tail reconciles), then:
 *   · the reconciliation must be READY and the final settlement record / Closing Disclosure on file — in BOTH CDA modes (a CDA is
 *     never a closing requirement; a wrong or unverified record is);
 *   · WITHOUT a CDA (or when the setting cannot be read — fail closed) the closing question must be answered "no". The caller ASKS it
 *     (askClosingQuestion — the blocking writer stays in stage-progression); this only reads the answer.
 * A check that cannot run refuses. Lines that the compliance gate (canProceedToClosingPrep, step 9) already names — a statement line
 * that differs, a compliance row — are not repeated. Returns plain blocker lines; writes nothing itself.
 */
export async function closingSettlementGate(
  svc: Svc,
  input: { transactionId: string; brokerageId: string },
  deps: {
    askClosingQuestion: () => Promise<{ ok: true; status: string | null } | { ok: false; error: string }>
    runClosingCompliance?: ClosingRunner
  },
): Promise<{ blockers: string[]; reconciliation: SettlementReconciliation | null; cdaMode: "cda" | "no_cda" | "unknown" }> {
  const blockers: string[] = []
  const run: ClosingRunner = deps.runClosingCompliance ?? (async (s, i) => { const { runClosingCompliance } = await import("@/lib/transactions/closing-compliance"); return runClosingCompliance(s, i) })
  const closing = await run(svc, { transactionId: input.transactionId, brokerageId: input.brokerageId, trigger: "final_check" })
  const rec = closing.reconciliation?.reconciliation ?? null
  if (!closing.ran) {
    blockers.push(`Closing compliance could not run (${closing.reason ?? "unknown"}) — nothing was verified, so the deal cannot close.`)
  } else if (!rec) {
    blockers.push(`The settlement check could not run (${closing.reconciliation?.error ?? "unknown"}) — nothing was verified, so the deal cannot close.`)
  } else {
    const { SETTLEMENT_READINESS_LABEL } = await import("@/lib/transactions/cda-closing-policy")
    const blockingItems = rec.items.filter((i) => i.blocking)
    rec.blockers.forEach((line, idx) => {
      const item = blockingItems[idx]
      if (item && ((item.key.startsWith("term.") && item.status === "differs") || item.key.startsWith("compliance."))) return
      blockers.push(`Settlement (${SETTLEMENT_READINESS_LABEL[rec.state]}): ${line}`)
    })
    if (rec.state !== "ready" && blockers.length === 0) blockers.push(`Settlement (${SETTLEMENT_READINESS_LABEL[rec.state]}): resolve the items on the compliance tab — the settlement check re-runs on its own.`)
    if (!rec.record.finalOnFile) {
      blockers.push(`Settlement: the final ${rec.record.kind === "settlement_statement" ? "settlement statement" : "Closing Disclosure / settlement statement"} is not on file — ${rec.record.issuer} issues it; upload it so it is read and compared before closing.`)
    }
  }
  // WAVE 152 (lane 152H): the CDA mode that governs THIS deal — the setting in force when it opened, or a finance admin's switch of the
  // deal (cda-closing-policy.ts §1c). A deal opened before an opt-in closes WITHOUT a CDA, so it answers the closing question here.
  // Fail closed: an unreadable policy keeps the question required.
  const { loadEffectiveCdaModes } = await import("@/lib/transactions/cda-closing-policy")
  const eff = await loadEffectiveCdaModes(svc, { brokerageId: input.brokerageId, transactionIds: [input.transactionId] })
  const governing = eff.ok ? eff.deals[input.transactionId]?.governing : undefined
  const mode = governing ? resolveCdaMode(governing) : null
  if (!mode) blockers.push(`The deal's CDA policy could not be read (${eff.ok ? "deal not found" : eff.error}) — the closing question stays required.`)
  if (!mode || !mode.cdaRequired) {
    const a = await deps.askClosingQuestion()
    if (!a.ok) blockers.push(`The closing question could not be read (${a.error}) — the deal cannot close until it is answered.`)
    else if (a.status === "fail") blockers.push("Closing question: an executed change was reported as not recorded yet — record the executed evidence (addendum, agreement amendment, fee amendment), then answer again.")
    else if (a.status !== "pass") blockers.push("Closing question: the deal's agent or transaction coordinator confirms whether any executed change (agreement amendment, contract addendum, fee change) is not recorded yet — answer it on the deal's closing page.")
  }
  return { blockers, reconciliation: rec, cdaMode: mode ? mode.mode : "unknown" }
}
