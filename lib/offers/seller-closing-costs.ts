// lib/offers/seller-closing-costs.ts
//
// SELLER CLOSING-COST BREAKDOWN (owner round 36: "closing costs is for seller
// side and another closing costs for buyer side") — the first-class SELLER
// sibling of lib/offers/buyer-closing-costs. PURE estimator: every regional
// line is a LOW–HIGH RANGE derived from the SAME 50-state + DC convention
// table (lib/offers/regional-closing-costs) the buyer side uses — the seller's
// customary share is the exact COMPLEMENT of the buyer's (sellerShareFactor),
// so the two sides can never double-claim or drop a cost between them.
//
// HONESTY CONTRACT (mirrors the buyer side, seller-flavored):
//   - COMMISSION IS NEVER ASSUMED. The seller's largest cost comes ONLY from
//     the deal's own records (the listing agreement rate, the transaction's
//     commission record) with a provenance label on the line. No record → the
//     line is PENDING, excluded from totals — a fabricated 6% would be as much
//     an invention as a fabricated 80% LTV on the buyer side.
//   - MORTGAGE PAYOFF IS NEVER ASSUMED. A real payoff figure rides with its
//     provenance note; otherwise the line is honestly "payoff pending" — a $0
//     placeholder would overstate the seller's net by the whole balance.
//   - Regional lines carry "regional estimate — {state} conventions"; the
//     SETTLEMENT STATEMENT (and the Closing Disclosure where one is issued) is
//     the named authority. Where a custom "varies", the band is honestly wide
//     (seller share 0.5–1×), never a faked precision.
//   - Property-tax proration is a NOTE, not a number: its direction and size
//     depend on the close date and the county's paid-through status, neither
//     of which this estimator invents.
//
// KEEP-ONE with the seller net sheet (lib/kernel/offer-net-sheet →
// lib/offers/net-sheet-calc): the net sheet stays the CANONICAL seller-money
// surface. This module supplies its CLOSING-COST section —
// deriveNetSheetClosingCostSection replaces the flat "other prorated fees"
// default with the state-convention band (labeled regional_estimate; manual
// overrides and injected costsResolvers always win).

import {
  getRegionalConventions,
  regionalLabel,
  sellerShareFactor,
  type RegionalConventions,
} from "./regional-closing-costs"

// ─── Line model (same shape as BuyerCostLine — the two sides speak one idiom) ─

export type SellerCostLineSource = "deal_fact" | "regional_estimate" | "industry_band"

export interface SellerCostLine {
  label: string
  low: number
  high: number
  note?: string
  /** true = the figure depends on a real record not on file yet (commission
   *  record, payoff statement, close date) — PENDING, excluded from totals,
   *  never a fabricated $0. */
  pending?: boolean
  /** provenance: deal_fact (the deal's own records), regional_estimate (state
   *  conventions), industry_band (generic — no state known) */
  source?: SellerCostLineSource
  /** human-readable provenance, e.g. "regional estimate — Texas conventions"
   *  or "per the listing agreement rate on file" */
  sourceLabel?: string
}

/** Commission comes ONLY from a real record — an amount or a rate, each with
 *  the provenance note that travels onto the line. */
export type SellerCommissionInput =
  | { kind: "amount"; amount: number; sourceNote: string }
  | { kind: "rate"; rateDecimal: number; sourceNote: string }

export interface SellerCostInput {
  salePrice: number
  /** the property's state ("TX" / "Texas"); unknown → generic industry bands,
   *  no regional labels (never a guessed state). */
  state?: string | null
  /** null = NO commission record on the listing/transaction — the line goes
   *  PENDING. A percentage is NEVER assumed. */
  commission: SellerCommissionInput | null
  /** null = no payoff statement on file — honest "payoff pending". */
  mortgagePayoff?: { amount: number; sourceNote: string } | null
  /** the buyer's negotiated closing-cost credit on the accepted offer
   *  (offers.closing_cost_contribution) — a deal fact. */
  buyerClosingCredit?: number | null
  /** WAVE 144 (lane 144D, owner ruling 6): the property-tax proration CONVENTION for this deal, as the settlement agent
   *  states it (or a compliance-approved jurisdiction rule). When every term is present the proration line becomes a
   *  NUMBER (prorateTax); otherwise it stays a pending note naming what is missing — never one state's rule for all. */
  taxProration?: Partial<TaxProrationInput> | null
}

// ─── PROPERTY-TAX PRORATION — the deterministic math, every convention an INPUT (wave 144, lane 144D) ───────────────
//
// Owner (2026-10-25): "Net sheet math applies to closing math: tax proration (state-dependent) … estimates are compared with
// the authoritative final title/closing statement; never hard-code one state's rule for all."
// WHAT VARIES (realestate-mortgage skill: "Location matters — property tax rates vary … use local rates"; "show the math"):
// whether the jurisdiction collects in ARREARS (the seller has not yet paid their share of the period, so the seller credits
// the buyer) or in ADVANCE (the seller prepaid the period, so the buyer reimburses the seller); when the tax period starts (a
// calendar year, a July fiscal year, a county's own year); the day count (actual days of a 365-day year, actual/actual, or a
// 30/360 banker's year); and who owns the closing day. NONE of these is defaulted here: each is a required input, supplied by
// the settlement agent's proration instruction for the deal or by a compliance-approved jurisdiction rule (lane 144A's
// adaptive vocabulary) — a missing term leaves the line PENDING with the missing terms named. The settlement statement
// remains the authority; lib/offers/closing-cost-accuracy.ts grades the estimate against it.

export type TaxPaymentTiming = "arrears" | "advance"
export type ProrationDayBasis = "actual_365" | "actual_actual" | "banker_360"
export type ClosingDayOwner = "buyer" | "seller"

export interface TaxProrationInput {
  /** The tax bill for the WHOLE tax period, in dollars (the tax record / the title's figure). */
  annualTax: number
  /** The tax period's first day (YYYY-MM-DD). */
  periodStart: string
  timing: TaxPaymentTiming
  /** YYYY-MM-DD — the closing date, inside the tax period. */
  closeDate: string
  closingDayOwner: ClosingDayOwner
  dayBasis: ProrationDayBasis
  /** Where the convention came from — the settlement agent's instruction, or the approved jurisdiction rule's citation. */
  source: string
}

type TaxProrationResult =
  | {
      ok: true
      /** arrears → the seller credits the buyer; advance → the buyer reimburses the seller. */
      direction: "seller_credits_buyer" | "buyer_reimburses_seller"
      amount: number
      sellerDays: number
      totalDays: number
      note: string
    }
  | { ok: false; pending: true; missing: string[] }

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function ymdParts(s: unknown): { y: number; m: number; d: number } | null {
  if (typeof s !== "string") return null
  const m = YMD_RE.exec(s.slice(0, 10))
  if (!m) return null
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  const dim = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]
  return mo >= 1 && mo <= 12 && d >= 1 && d <= (dim ?? 0) ? { y, m: mo, d } : null
}

/** Whole days from a to b (b − a), on UTC calendar dates — no local-time drift. */
const dayIndex = (p: { y: number; m: number; d: number }) => Math.round(Date.UTC(p.y, p.m - 1, p.d) / 86_400_000)

/** 30/360 (US) day count from a to b. */
function days360(a: { y: number; m: number; d: number }, b: { y: number; m: number; d: number }): number {
  const d1 = Math.min(a.d, 30)
  const d2 = b.d === 31 && d1 === 30 ? 30 : b.d
  return (b.y - a.y) * 360 + (b.m - a.m) * 30 + (d2 - d1)
}

/**
 * PURE — the property-tax proration for a deal, from the deal's own convention. Rounded to the cent once, at the end.
 * The seller owns the days from the period start up to the closing (through the closing day when the seller owns it).
 * Module-private: reached through estimateSellerClosingCosts({ taxProration }) — the net-sheet engine the proofs drive.
 */
function prorateTax(input: Partial<TaxProrationInput> | null | undefined): TaxProrationResult {
  const i = input ?? {}
  const missing: string[] = []
  const annualTax = Number(i.annualTax)
  if (!(Number.isFinite(annualTax) && annualTax > 0)) missing.push("the tax bill for the period")
  const start = ymdParts(i.periodStart)
  if (!start) missing.push("the tax period's start date")
  if (i.timing !== "arrears" && i.timing !== "advance") missing.push("whether the jurisdiction collects in arrears or in advance")
  const close = ymdParts(i.closeDate)
  if (!close) missing.push("the closing date")
  if (i.closingDayOwner !== "buyer" && i.closingDayOwner !== "seller") missing.push("who owns the closing day")
  if (i.dayBasis !== "actual_365" && i.dayBasis !== "actual_actual" && i.dayBasis !== "banker_360") missing.push("the day-count basis")
  if (!String(i.source ?? "").trim()) missing.push("the source of the convention (the settlement agent's instruction or the approved jurisdiction rule)")
  if (missing.length > 0 || !start || !close) return { ok: false, pending: true, missing }

  const end = { y: start.y + 1, m: start.m, d: start.d }
  const startIdx = dayIndex(start)
  const endIdx = dayIndex(end) // exclusive: the next period's first day
  const closeIdx = dayIndex(close)
  if (closeIdx < startIdx || closeIdx >= endIdx) return { ok: false, pending: true, missing: ["a closing date inside the stated tax period"] }

  // The seller's last owned day: the day before closing when the buyer owns the closing day, else the closing day itself.
  const sellerLastIdx = i.closingDayOwner === "buyer" ? closeIdx - 1 : closeIdx
  let sellerDays: number
  let totalDays: number
  if (i.dayBasis === "banker_360") {
    totalDays = 360
    const lastDate = new Date((sellerLastIdx + 1) * 86_400_000) // the day AFTER the seller's last day = the count's end
    const after = { y: lastDate.getUTCFullYear(), m: lastDate.getUTCMonth() + 1, d: lastDate.getUTCDate() }
    sellerDays = Math.max(0, Math.min(360, days360(start, after)))
  } else {
    totalDays = i.dayBasis === "actual_365" ? 365 : endIdx - startIdx
    sellerDays = Math.max(0, Math.min(totalDays, sellerLastIdx - startIdx + 1))
  }
  const cents = (n: number) => Math.round(n * 100) / 100
  if (i.timing === "arrears") {
    const amount = cents((annualTax * sellerDays) / totalDays)
    return {
      ok: true,
      direction: "seller_credits_buyer",
      amount,
      sellerDays,
      totalDays,
      note: `taxes are paid in arrears here, so the seller credits the buyer for the seller's ${sellerDays} of ${totalDays} days of the $${annualTax.toLocaleString("en-US")} bill (${i.dayBasis}; the ${i.closingDayOwner} owns the closing day) — ${String(i.source).trim()}`,
    }
  }
  const amount = cents((annualTax * (totalDays - sellerDays)) / totalDays)
  return {
    ok: true,
    direction: "buyer_reimburses_seller",
    amount,
    sellerDays,
    totalDays,
    note: `taxes are paid in advance here, so the buyer reimburses the seller for the buyer's ${totalDays - sellerDays} of ${totalDays} days of the $${annualTax.toLocaleString("en-US")} bill the seller prepaid (${i.dayBasis}; the ${i.closingDayOwner} owns the closing day) — ${String(i.source).trim()}`,
  }
}

/** The proration LINE: a number when the convention is complete, else the pending note (with what is missing). A
 *  reimbursement to the seller is a NEGATIVE cost (it raises the net). */
function prorationLine(i: SellerCostInput, fallbackNote: string, sourceLabel: string | null): SellerCostLine {
  const p = i.taxProration ? prorateTax(i.taxProration) : null
  if (p && p.ok) {
    const signed = p.direction === "seller_credits_buyer" ? p.amount : -p.amount
    return { label: "Property-tax proration", low: signed, high: signed, note: p.note, source: "deal_fact", sourceLabel: String(i.taxProration?.source ?? "").trim() }
  }
  const missingNote = p && !p.ok ? ` Still needed to compute it: ${p.missing.join("; ")}.` : ""
  return { label: "Property-tax proration", low: 0, high: 0, pending: true, note: `${fallbackNote}${missingNote}`, ...(sourceLabel ? { sourceLabel } : {}) }
}

export interface SellerClosingEstimate {
  /** resolved region ("TX") when state conventions applied; null = generic bands */
  regionState: string | null
  /** "regional estimate — Texas conventions" when regionState is set */
  regionLabel: string | null
  /** false = no commission record on file — the line is pending, not assumed */
  commissionKnown: boolean
  /** false = no payoff statement on file — the line is pending, not $0 */
  payoffKnown: boolean
  lines: SellerCostLine[]
  /** totals EXCLUDE pending lines (stated in the disclaimer) */
  totalLow: number
  totalHigh: number
  /** total as % of the sale price */
  pctLow: number
  pctHigh: number
  disclaimer: string
}

const r = (n: number) => Math.round(n / 10) * 10
const pctFmt = (n: number) => {
  const p = Math.round(n * 1000) / 10
  return Number.isInteger(p) ? String(p) : p.toFixed(1)
}

/** PURE: the seller's estimated closing costs — the sale-side complement of
 *  estimateBuyerClosingCosts. Deal facts ride with provenance; regional lines
 *  ride the convention table; nothing is assumed. */
export function estimateSellerClosingCosts(i: SellerCostInput): SellerClosingEstimate {
  const price = Math.max(0, i.salePrice)
  const conv: RegionalConventions | null = getRegionalConventions(i.state)
  const regLabel = conv ? regionalLabel(conv) : null
  const lines: SellerCostLine[] = []

  // ── Deal-fact lines: only from real records, provenance on the line ──────
  const commissionKnown = i.commission != null
  if (i.commission) {
    const amount =
      i.commission.kind === "amount" ? Math.max(0, Math.round(i.commission.amount)) : r(price * i.commission.rateDecimal)
    lines.push({
      label: "Real estate commission",
      low: amount,
      high: amount,
      note:
        i.commission.kind === "rate"
          ? `${pctFmt(i.commission.rateDecimal)}% of the sale price — ${i.commission.sourceNote}`
          : i.commission.sourceNote,
      source: "deal_fact",
      sourceLabel: i.commission.sourceNote,
    })
  } else {
    lines.push({
      label: "Real estate commission",
      low: 0,
      high: 0,
      pending: true,
      note:
        "pending — no commission record on the listing or transaction, and a rate is NEVER assumed. Attach the listing agreement to complete this line.",
    })
  }

  const payoffKnown = i.mortgagePayoff != null
  if (i.mortgagePayoff) {
    const amount = Math.max(0, Math.round(i.mortgagePayoff.amount))
    lines.push({
      label: "Mortgage payoff",
      low: amount,
      high: amount,
      note: i.mortgagePayoff.sourceNote,
      source: "deal_fact",
      sourceLabel: i.mortgagePayoff.sourceNote,
    })
  } else {
    lines.push({
      label: "Mortgage payoff",
      low: 0,
      high: 0,
      pending: true,
      note:
        "payoff pending — request the payoff statement from the seller's lender. A $0 placeholder would overstate the net by the whole balance, so this line stays pending until the real figure lands.",
    })
  }

  const credit = i.buyerClosingCredit != null && i.buyerClosingCredit > 0 ? Math.round(i.buyerClosingCredit) : 0
  if (credit > 0) {
    lines.push({
      label: "Buyer closing-cost credit",
      low: credit,
      high: credit,
      note: "the credit negotiated on the accepted offer",
      source: "deal_fact",
      sourceLabel: "per the accepted offer's negotiated credit",
    })
  }

  // ── Regional lines: the SAME convention table, the seller's share ────────
  if (conv) {
    const tShare = sellerShareFactor(conv.transferTaxPayer)
    lines.push({
      label: "Transfer / deed tax (seller share)",
      low: r(price * (conv.transferTaxPct / 100) * tShare.low),
      high: r(price * (conv.transferTaxPct / 100) * tShare.high),
      note:
        conv.transferTaxPayer === "buyer"
          ? `customarily BUYER-paid in ${conv.stateName} — your contract controls. ${conv.transferTaxNote}`
          : conv.transferTaxNote,
      source: "regional_estimate",
      sourceLabel: regLabel!,
    })

    const oShare = sellerShareFactor(conv.ownerTitlePayer)
    lines.push({
      label: "Owner's title insurance (seller share)",
      low: r(price * (conv.ownerTitleLowPct / 100) * oShare.low),
      high: r(price * (conv.ownerTitleHighPct / 100) * oShare.high),
      note:
        conv.ownerTitlePayer === "buyer"
          ? `customarily BUYER-paid in ${conv.stateName} — your contract controls. ${conv.titleNote}`
          : conv.titleNote,
      source: "regional_estimate",
      sourceLabel: regLabel!,
    })

    if (conv.settlementModel === "attorney") {
      lines.push({
        label: "Seller's closing attorney fee",
        low: conv.settlementFeeLow,
        high: conv.settlementFeeHigh,
        note: conv.attorneyClosing
          ? `${conv.stateName} is an attorney-closing state — the seller customarily retains counsel`
          : `attorney closings are customary in ${conv.stateName}`,
        source: "regional_estimate",
        sourceLabel: regLabel!,
      })
    } else {
      // Split conventions vary by county/contract — the band honestly spans
      // half-to-full of the state's settlement band rather than faking a custom.
      lines.push({
        label: "Settlement / escrow fee (seller share)",
        low: r(conv.settlementFeeLow * 0.5),
        high: conv.settlementFeeHigh,
        note: "settlement/escrow charges are customarily shared between the parties — your contract controls",
        source: "regional_estimate",
        sourceLabel: regLabel!,
      })
    }

    lines.push({
      label: "Recording — deed & payoff release",
      low: conv.recordingFeeLow,
      high: conv.recordingFeeHigh,
      note: "recording the deed and the release/reconveyance of the paid-off mortgage",
      source: "regional_estimate",
      sourceLabel: regLabel!,
    })

    // Proration is a NOTE until the deal's own convention is supplied (wave 144: prorateTax) — the close date, the
    // tax bill, arrears vs advance, the period, the day count and the closing-day owner; none is invented here.
    lines.push(prorationLine(
      i,
      `prorated to your closing date — direction and size depend on the close date and the county's paid-through status. ${conv.stateName} effective property tax runs ~${conv.propertyTaxLowPct}%–${conv.propertyTaxHighPct}%/yr (${regLabel})`,
      regLabel!,
    ))
  } else {
    lines.push({
      label: "Transfer / deed tax (seller share)",
      low: 0,
      high: r(price * 0.01),
      note: "transfer taxes — and who customarily pays them — vary widely by state (0% to 1%+ where seller-customary)",
      source: "industry_band",
    })
    lines.push({
      label: "Owner's title insurance (seller share)",
      low: 0,
      high: r(price * 0.005),
      note: "who pays the owner's policy varies by region and contract",
      source: "industry_band",
    })
    lines.push({
      label: "Settlement / escrow fee (seller share)",
      low: 250,
      high: 1200,
      note: "the seller's share of settlement charges varies by regional custom",
      source: "industry_band",
    })
    lines.push({
      label: "Recording — deed & payoff release",
      low: 50,
      high: 300,
      source: "industry_band",
    })
    lines.push(prorationLine(i, "prorated to your closing date — depends on the close date and the county's paid-through status", null))
  }

  const totalLow = lines.reduce((s, l) => s + (l.pending ? 0 : l.low), 0)
  const totalHigh = lines.reduce((s, l) => s + (l.pending ? 0 : l.high), 0)

  const baseDisclaimer =
    "Planning estimates only — every line is a range, not a quote. The settlement statement (and the Closing Disclosure where one is issued) is the binding document, and your agent will walk you through it before closing."
  const regionalDisclaimer = conv
    ? ` Labeled lines are estimated from ${conv.stateName} closing conventions — the settlement statement is the authority.`
    : ""
  const pendingBits: string[] = []
  if (!commissionKnown) pendingBits.push("the commission (no record on file — a rate is never assumed)")
  if (!payoffKnown) pendingBits.push("the mortgage payoff (request the payoff statement)")
  const pendingDisclaimer = pendingBits.length
    ? ` Lines marked pending — ${pendingBits.join(" and ")} — are excluded from the totals, not zero.`
    : ""

  return {
    regionState: conv?.state ?? null,
    regionLabel: regLabel,
    commissionKnown,
    payoffKnown,
    lines,
    totalLow,
    totalHigh,
    pctLow: price > 0 ? Math.round((totalLow / price) * 1000) / 10 : 0,
    pctHigh: price > 0 ? Math.round((totalHigh / price) * 1000) / 10 : 0,
    disclaimer: `${baseDisclaimer}${regionalDisclaimer}${pendingDisclaimer}`,
  }
}

// ─── Commission resolution (records only — the caller passes row snippets) ───

/** PURE: resolve the deal's commission from its OWN records, best record first.
 *  Returns null (→ pending line) when no record exists — never an assumption.
 *  Rates arrive as PERCENT figures (e.g. 5.5), exactly as the columns store them. */
export function resolveSellerCommission(rec: {
  /** transactions.commission_amount — the recorded dollar figure */
  transactionCommissionAmount?: number | null
  /** listings.commission_rate — the listing agreement's percent */
  listingCommissionRatePct?: number | null
  /** transactions.commission_percentage — the transaction's percent on file */
  transactionCommissionPct?: number | null
}): SellerCommissionInput | null {
  const amt = Number(rec.transactionCommissionAmount)
  if (Number.isFinite(amt) && amt > 0) {
    return { kind: "amount", amount: amt, sourceNote: "per the transaction's commission record" }
  }
  const listRate = Number(rec.listingCommissionRatePct)
  if (Number.isFinite(listRate) && listRate > 0 && listRate < 100) {
    return { kind: "rate", rateDecimal: listRate / 100, sourceNote: "per the listing agreement rate on file" }
  }
  const txRate = Number(rec.transactionCommissionPct)
  if (Number.isFinite(txRate) && txRate > 0 && txRate < 100) {
    return { kind: "rate", rateDecimal: txRate / 100, sourceNote: "per the transaction's commission rate on file" }
  }
  return null
}

/** PURE: post-NAR-settlement note — the buyer-agent share DISCLOSED on the
 *  accepted offer, when the offer records the seller as its payer. Returns
 *  null when nothing real is disclosed (never an assumed co-op split). */
export function disclosedBuyerAgentCommissionNote(offer: {
  disclosed_buyer_commission_pct?: number | null
  disclosed_buyer_commission_flat?: number | null
  disclosed_commission_payer?: string | null
}): string | null {
  if (offer.disclosed_commission_payer !== "seller") return null
  const pct = Number(offer.disclosed_buyer_commission_pct)
  if (Number.isFinite(pct) && pct > 0) {
    return `includes the buyer-agent share disclosed on the accepted offer (${pctFmt(pct / 100)}%, seller-paid)`
  }
  const flat = Number(offer.disclosed_buyer_commission_flat)
  if (Number.isFinite(flat) && flat > 0) {
    return `includes the buyer-agent share disclosed on the accepted offer ($${Math.round(flat).toLocaleString("en-US")}, seller-paid)`
  }
  return null
}

// ─── Net-sheet integration (keep-one — the net sheet stays canonical) ────────

export interface NetSheetClosingCostSection {
  regionState: string
  regionLabel: string
  /** the REGIONAL closing-cost lines only — commission, payoff, and the
   *  buyer credit are the net sheet's OWN inputs and are never duplicated here */
  lines: SellerCostLine[]
  low: number
  high: number
  /** the band midpoint — the net sheet's "other prorated fees" starting value */
  midpoint: number
}

/** PURE: the closing-cost section the seller net sheet mounts where it used to
 *  hold a flat default. Regional lines only (no deal-fact duplication); null
 *  when the state is unknown or the price is not positive — the net sheet's
 *  flat default then stands, honestly unlabeled. */
export function deriveNetSheetClosingCostSection(
  salePrice: number | null | undefined,
  state: string | null | undefined,
): NetSheetClosingCostSection | null {
  const price = Number(salePrice)
  if (!Number.isFinite(price) || price <= 0) return null
  const est = estimateSellerClosingCosts({ salePrice: price, state, commission: null, mortgagePayoff: null })
  if (!est.regionState || !est.regionLabel) return null
  const lines = est.lines.filter((l) => l.source === "regional_estimate" && !l.pending)
  if (lines.length === 0) return null
  const low = lines.reduce((s, l) => s + l.low, 0)
  const high = lines.reduce((s, l) => s + l.high, 0)
  return {
    regionState: est.regionState,
    regionLabel: est.regionLabel,
    lines,
    low,
    high,
    midpoint: Math.round((low + high) / 2),
  }
}
