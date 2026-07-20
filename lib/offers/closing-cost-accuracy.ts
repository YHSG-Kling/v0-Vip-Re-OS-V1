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
import { normalizeStateCode } from "./regional-closing-costs"

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

export interface ActualCdFigures {
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
export function isProvenanceUsable(row: LedgerFieldRow): boolean {
  if (row.verified_at != null) return true
  return row.confidence === "high" || row.confidence === "medium"
}

/** Pure: fold provenance-usable ledger rows into the actual CD figures. */
export function extractActualCdFigures(rows: LedgerFieldRow[]): {
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

export interface AccuracyLine {
  key: AccuracyLineKey
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
export function mapAccuracyLines(estimateLines: BuyerCostLine[], actual: ActualCdFigures): AccuracyLine[] {
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

// ─── Pure: per-state aggregation for the report ─────────────────────────────

export interface StateAccuracyLineStat {
  key: AccuracyLineKey
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
    for (const key of Object.keys(ACCURACY_LINE_LABELS) as AccuracyLineKey[]) {
      const graded = observations.flatMap((obs) => obs.filter((l) => l.key === key))
      if (graded.length === 0) continue // honest: ungraded lines don't appear
      lineStats.push({
        key,
        label: ACCURACY_LINE_LABELS[key],
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
}

/** Record an accuracy observation for a transaction. Honest at every exit:
 *  each precondition that fails names itself instead of inventing data.
 *  Idempotent: upsert on (transaction_id, document_id) — a re-scan with new
 *  figures refreshes the observation; the same figures are a no-op rewrite. */
export async function recordClosingCostAccuracy(
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
  const { data: saved, error } = await svc
    .from("closing_cost_accuracy_observations")
    .upsert(row, { onConflict: "transaction_id,document_id" })
    .select("id")
    .maybeSingle()
  if (error) {
    // Table not provisioned yet (migration 1104 is report-only until applied) or
    // any other write failure — degrade honestly, never throw into a close path.
    return { recorded: false, reason: `observation not stored: ${error.message}` }
  }
  return { recorded: true, reason: "observation recorded", observationId: (saved as any)?.id, lineCount: lines.length }
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
