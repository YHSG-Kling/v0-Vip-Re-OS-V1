// lib/transactions/tax-proration.ts
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE DEAL'S TAX-PRORATION INSTRUCTION — the one writer and reader of transactions.tax_proration (wave 145, lane 145Z;
// lane 145C requirement 7 "proration input screen"; m873).
//
// The math is lane 144D's (lib/offers/seller-closing-costs.ts prorateTax, reached through estimateSellerClosingCosts —
// every convention an INPUT, nothing defaulted). What was missing was the INPUT: the settlement agent's instruction for
// THIS deal. This module validates it (every term required, the source required, no jurisdiction default — a nationwide
// constant is exactly what 144D refused), stores it, reads it back, and computes the line through the ONE engine.
//
//   parseTaxProrationInstruction(raw)          PURE — the instruction, or the terms still missing / invalid.
//   prorationLineFor(stored, deal)             PURE — the engine's "Property-tax proration" line for this deal.
//   persistTaxProration(svc, …)                the column's ONE writer: its own UPDATE, tenant-pinned, row-counted;
//                                              42703 / PGRST204 = m873 not applied (reported, never thrown).
//   readTaxProration(svc, …)                   the column's ONE reader: a star select (a database without m873 reads null).
//
// Not server-only: every read is behind an injected client.

import type { SupabaseClient } from "@supabase/supabase-js"
import {
  estimateSellerClosingCosts,
  type ClosingDayOwner, type ProrationDayBasis, type SellerCostLine, type TaxPaymentTiming, type TaxProrationInput,
} from "@/lib/offers/seller-closing-costs"

type Svc = SupabaseClient<any, any, any>

const MISSING_COLUMN = new Set(["42703", "PGRST204"])

/** The engine's own vocabularies — the form offers exactly these, the writer accepts nothing else. */
export const TAX_PAYMENT_TIMINGS: readonly TaxPaymentTiming[] = ["arrears", "advance"]
export const CLOSING_DAY_OWNERS: readonly ClosingDayOwner[] = ["seller", "buyer"]
export const PRORATION_DAY_BASES: readonly ProrationDayBasis[] = ["actual_365", "actual_actual", "banker_360"]

export interface StoredTaxProration extends TaxProrationInput {
  recorded_by: string | null
  recorded_at: string | null
}

const YMD = /^\d{4}-\d{2}-\d{2}$/
const validYmd = (s: unknown): s is string => typeof s === "string" && YMD.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s

/**
 * PURE — the instruction as recorded. Every term is required (lane 144D: none is defaulted), the source is required (where
 * the convention came from — the settlement agent's instruction, or an approved jurisdiction rule's citation), and the
 * closing date must fall inside the stated tax period. A refusal names every missing or invalid term.
 */
export function parseTaxProrationInstruction(raw: unknown): { ok: true; value: TaxProrationInput } | { ok: false; missing: string[] } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const missing: string[] = []
  const annualTax = typeof r.annualTax === "string" ? Number(r.annualTax.replace(/[$,\s]/g, "")) : Number(r.annualTax)
  if (!(Number.isFinite(annualTax) && annualTax > 0)) missing.push("the tax bill for the whole period (a positive dollar amount)")
  if (!validYmd(r.periodStart)) missing.push("the tax period's start date (YYYY-MM-DD)")
  if (!TAX_PAYMENT_TIMINGS.includes(r.timing as TaxPaymentTiming)) missing.push("whether the jurisdiction collects in arrears or in advance")
  if (!validYmd(r.closeDate)) missing.push("the closing date (YYYY-MM-DD)")
  if (!CLOSING_DAY_OWNERS.includes(r.closingDayOwner as ClosingDayOwner)) missing.push("who owns the closing day (seller or buyer)")
  if (!PRORATION_DAY_BASES.includes(r.dayBasis as ProrationDayBasis)) missing.push("the day-count basis (actual/365, actual/actual or 30/360)")
  const source = typeof r.source === "string" ? r.source.trim().slice(0, 500) : ""
  if (!source) missing.push("the source of the instruction (the settlement agent's instruction, or the approved jurisdiction rule's citation)")
  if (missing.length === 0) {
    const start = String(r.periodStart), close = String(r.closeDate)
    const end = `${Number(start.slice(0, 4)) + 1}${start.slice(4)}`
    if (close < start || close >= end) missing.push("a closing date inside the stated tax period")
  }
  if (missing.length > 0) return { ok: false, missing }
  return {
    ok: true,
    value: {
      annualTax: Math.round(annualTax * 100) / 100,
      periodStart: String(r.periodStart),
      timing: r.timing as TaxPaymentTiming,
      closeDate: String(r.closeDate),
      closingDayOwner: r.closingDayOwner as ClosingDayOwner,
      dayBasis: r.dayBasis as ProrationDayBasis,
      source,
    },
  }
}

/** PURE — a stored row's jsonb back to the instruction (null when absent or no longer valid — never a guess). */
function storedTaxProration(raw: unknown): StoredTaxProration | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const parsed = parseTaxProrationInstruction(raw)
  if (!parsed.ok) return null
  const r = raw as Record<string, unknown>
  return { ...parsed.value, recorded_by: typeof r.recorded_by === "string" ? r.recorded_by : null, recorded_at: typeof r.recorded_at === "string" ? r.recorded_at : null }
}

/**
 * PURE — the "Property-tax proration" line the ONE engine computes for this deal. With no instruction it is the engine's
 * pending line (what is missing named); with one, a signed number (positive = the seller credits the buyer; negative =
 * the buyer reimburses the seller). `closeDateDiffers` says when the deal's closing date moved after the instruction was
 * recorded — the instruction is the settlement agent's, so the screen asks for it to be re-confirmed, never silently re-dated.
 */
export function prorationLineFor(
  stored: TaxProrationInput | null,
  deal: { salePrice: number | null; state: string | null; closeDate: string | null },
): { line: SellerCostLine | null; closeDateDiffers: boolean } {
  const price = Number(deal.salePrice)
  const est = estimateSellerClosingCosts({ salePrice: Number.isFinite(price) && price > 0 ? price : 0, state: deal.state, commission: null, mortgagePayoff: null, taxProration: stored })
  const line = est.lines.find((l) => l.label === "Property-tax proration") ?? null
  const dealClose = typeof deal.closeDate === "string" ? deal.closeDate.slice(0, 10) : null
  return { line, closeDateDiffers: !!stored && !!dealClose && dealClose !== stored.closeDate }
}

export type PersistTaxProrationResult = { ok: true; written: number } | { ok: false; notApplied?: true; error: string }

/** The column's ONE writer. Tenant-pinned; a write that matches no row is an error (an UPDATE that matches nothing
 *  RESOLVES — CLAUDE.md §3), and a database without m873 is reported as not applied. `value: null` clears it. */
export async function persistTaxProration(
  svc: Svc,
  input: { transactionId: string; brokerageId: string; value: TaxProrationInput | null; recordedBy: string | null; now?: Date },
): Promise<PersistTaxProrationResult> {
  const payload = input.value
    ? { ...input.value, recorded_by: input.recordedBy, recorded_at: (input.now ?? new Date()).toISOString() }
    : null
  const { data, error } = await svc.from("transactions").update({ tax_proration: payload })
    .eq("id", input.transactionId).eq("brokerage_id", input.brokerageId).select("id")
  if (error) {
    const code = String((error as { code?: string }).code ?? "")
    if (MISSING_COLUMN.has(code)) return { ok: false, notApplied: true, error: "transactions.tax_proration does not exist yet (m873 not applied) — the instruction was not saved" }
    return { ok: false, error: `the proration instruction could not be saved: ${error.message}` }
  }
  const n = (data ?? []).length
  if (n === 0) return { ok: false, error: "that deal matched no row in your brokerage — the proration instruction was not saved" }
  return { ok: true, written: n }
}

/** The column's ONE reader (star select: a database without m873 reads null, never a refused query). */
export async function readTaxProration(
  svc: Svc,
  input: { transactionId: string; brokerageId: string },
): Promise<
  | { ok: true; instruction: StoredTaxProration | null; columnPresent: boolean; deal: { salePrice: number | null; state: string | null; closeDate: string | null; agentId: string | null } }
  | { ok: false; error: string }
> {
  const { data, error } = await svc.from("transactions").select("*").eq("id", input.transactionId).eq("brokerage_id", input.brokerageId).maybeSingle()
  if (error) return { ok: false, error: `the deal could not be read: ${error.message}` }
  if (!data) return { ok: false, error: "that deal is not in your brokerage" }
  const row = data as Record<string, unknown>
  const num = (v: unknown) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null)
  return {
    ok: true,
    instruction: storedTaxProration(row.tax_proration),
    columnPresent: Object.prototype.hasOwnProperty.call(row, "tax_proration"),
    deal: {
      salePrice: num(row.purchase_price),
      state: typeof row.property_state === "string" ? row.property_state : null,
      closeDate: typeof row.close_date === "string" ? row.close_date : typeof row.estimated_close_date === "string" ? row.estimated_close_date : null,
      agentId: typeof row.agent_id === "string" ? row.agent_id : null,
    },
  }
}
