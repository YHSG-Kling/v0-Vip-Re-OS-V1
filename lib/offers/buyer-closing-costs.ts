// lib/offers/buyer-closing-costs.ts
//
// BUYER CLOSING-COST BREAKDOWN (owner: "buyer gets a closing cost breakdown")
// — the buyer-side companion to the seller net sheet (net-sheet-calc stays
// seller-only; keep-one, different audience, different math). PURE estimator:
// every line is a LOW–HIGH RANGE from industry-standard cost bands scaled to
// the deal's real numbers, every assumption is stated on the line, and the
// disclaimer names the binding documents (the lender's Loan Estimate and the
// Closing Disclosure). HONESTY: this never claims precision it doesn't have —
// ranges, sources, and "varies by region/contract" notes over false exactness.
// LOAN TERMS ARE NEVER ASSUMED (owner correction): the loan amount comes from a
// real record (the lender row, the transaction, the offer's own down-payment
// terms, or the buyer's pre-approval — the caller resolves the hierarchy and
// passes provenance). When financing terms are genuinely unknown, the
// loan-dependent lines are presented as PENDING the lender's terms — a $0
// placeholder range would be as much an invention as a fabricated 80% LTV.
//
// REGION LAYER (owner: "closing costs are derived by REGION estimates"): when
// the property's state is known, the estimable-pre-lender lines (owner's title,
// transfer/recording, settlement model, property-tax prepaids) derive from that
// state's REAL published conventions (lib/offers/regional-closing-costs) and
// every such figure is labeled "regional estimate — {state} conventions".
// Pending-lender lines carry the state's rate CONVENTION as a labeled note —
// never a fabricated dollar figure, because dollars there need the loan amount.
// Every line declares its source: lender_fact | regional_estimate |
// industry_band | ai_refined — and the lender's Loan Estimate stays the named
// authority (TRID) whenever any line is an estimate.

import {
  getRegionalConventions,
  regionalLabel,
  buyerShareFactor,
  taxEscrowMonths,
  lenderTitleConvention,
  type RegionalConventions,
} from "./regional-closing-costs"

export type BuyerCostLineSource = "lender_fact" | "regional_estimate" | "industry_band" | "ai_refined"

export interface BuyerCostInput {
  purchasePrice: number
  /** >0 = the REAL loan amount on file; 0 = cash purchase; null = financed but
   *  the terms are genuinely UNKNOWN (no lender record, offer terms, or
   *  pre-approval) — loan-dependent lines go PENDING, never assumed. */
  loanAmount: number | null
  /** the seller credit negotiated on the accepted offer */
  sellerCredit: number
  /** county annual property tax, when known (else the state's reviewed regional band, else PENDING) */
  annualTaxEstimate?: number | null
  /** year-one homeowner's insurance, when known (else PENDING — no percentage of the price) */
  annualInsuranceEstimate?: number | null
  /** the REAL quoted/locked rate from the lender record (percent, e.g. 6.5), when on file */
  interestRatePct?: number | null
  /** provenance for the loan figure — e.g. "per your pre-approval from Acme Lending" */
  loanSourceNote?: string | null
  /** the property's state ("CA" / "California"); falls back to the brokerage's
   *  state at the caller. Unknown → generic industry bands, no regional labels. */
  state?: string | null
}

export interface BuyerCostLine {
  label: string
  low: number
  high: number
  note?: string
  /** true = this line depends on loan terms that are not on file yet — the
   *  figure is pending the lender's terms, not zero. */
  pending?: boolean
  /** provenance: lender_fact (a real record), regional_estimate (state
   *  conventions), industry_band (generic), ai_refined (bounded AI adjustment) */
  source?: BuyerCostLineSource
  /** the human-readable provenance label, e.g. "regional estimate — Texas conventions" */
  sourceLabel?: string
}

export interface BuyerClosingEstimate {
  isCash: boolean
  /** false = financed but no loan record/pre-approval on file — lender-dependent
   *  lines are pending and excluded from the totals (stated in the disclaimer). */
  loanKnown: boolean
  /** where the loan figure came from (provenance), when known */
  loanSourceNote: string | null
  /** the resolved region ("TX") when state conventions applied; null = no state — those lines are pending */
  regionState: string | null
  /** "regional estimate — Texas conventions" when regionState is set */
  regionLabel: string | null
  lines: BuyerCostLine[]
  totalLow: number
  totalHigh: number
  sellerCredit: number
  netLow: number
  netHigh: number
  /** total as % of price, for the "roughly X–Y% of the purchase price" line */
  pctLow: number
  pctHigh: number
  disclaimer: string
  /** true once the optional AI refinement step adjusted any line (within bounds) */
  aiRefined?: boolean
  /** the AI's own stated summary of what it adjusted and why */
  aiRefineSummary?: string | null
}

const r = (n: number) => Math.round(n / 10) * 10

/** PURE: the buyer's estimated cash-to-close beyond the down payment. */
export function estimateBuyerClosingCosts(i: BuyerCostInput): BuyerClosingEstimate {
  const price = Math.max(0, i.purchasePrice)
  const loanKnown = i.loanAmount != null && Number.isFinite(i.loanAmount)
  const loan = loanKnown ? Math.max(0, i.loanAmount as number) : 0
  const isCash = loanKnown && loan === 0
  const financed = !isCash // includes the terms-unknown case — the buyer IS financing
  const conv: RegionalConventions | null = getRegionalConventions(i.state)
  const regLabel = conv ? regionalLabel(conv) : null
  // WAVE 156 (lane 156H, round 4): no invented fallback — the tax comes from the buyer's estimate or the state's reviewed effective
  // band (REGIONAL_CONVENTION_CITATION); the insurance only from the buyer's own estimate. Unknown → null → the line is PENDING.
  const annualTax: number | null = i.annualTaxEstimate && i.annualTaxEstimate > 0
    ? i.annualTaxEstimate
    : conv
      ? price * ((conv.propertyTaxLowPct + conv.propertyTaxHighPct) / 2 / 100)
      : null
  const annualIns: number | null = i.annualInsuranceEstimate && i.annualInsuranceEstimate > 0 ? i.annualInsuranceEstimate : null
  const rate = i.interestRatePct && i.interestRatePct > 0 ? i.interestRatePct : null
  const lenderFactLabel = i.loanSourceNote ?? "per the loan terms on file"

  const PENDING_NOTE = "pending your lender's terms — attach your pre-approval or lender details to complete this line"
  const pendingLine = (label: string, regionalNote?: string): BuyerCostLine => ({
    label, low: 0, high: 0, pending: true,
    note: regionalNote ? `${PENDING_NOTE}. ${regionalNote}` : PENDING_NOTE,
    ...(regionalNote && regLabel ? { sourceLabel: regLabel } : {}),
  })

  const lines: BuyerCostLine[] = []
  if (financed && loanKnown) {
    // Lender charges come from the lender's Loan Estimate — the "0.5%–1% of the loan", "$500–$800" and "$100–$250" bands were not.
    lines.push(pendingLine("Lender fees (origination + underwriting)"))
    lines.push(pendingLine("Appraisal"))
    lines.push(pendingLine("Credit, flood cert & tax service"))
    if (conv) {
      const lt = lenderTitleConvention(conv)
      lines.push({ label: "Lender's title insurance", low: r(loan * (lt.pctOfLoanLow / 100)), high: r(Math.max(loan * (lt.pctOfLoanHigh / 100), 100)), note: lt.note, source: "regional_estimate", sourceLabel: regLabel! })
    } else {
      lines.push(pendingLine("Lender's title insurance"))
    }
    if (rate != null) {
      const daily = (loan * (rate / 100)) / 365
      lines.push({ label: "Prepaid interest (~15 days)", low: r(daily * 15), high: r(daily * 15), note: `at your lender's ${rate}% rate on file`, source: "lender_fact", sourceLabel: lenderFactLabel })
    } else {
      lines.push(pendingLine("Prepaid interest (~15 days)"))
    }
    lines.push(escrowDepositLine(annualTax, annualIns, conv, regLabel))
  } else if (financed && !loanKnown) {
    // Honest unknown: each loan-dependent line is PENDING the lender's terms —
    // no loan amount, type, or rate is on file, and nothing is assumed. Where
    // the REGION knows the rate convention, the note says so (a labeled
    // convention, not a fabricated dollar figure).
    lines.push(pendingLine("Lender fees (origination + underwriting)"))
    lines.push(pendingLine("Appraisal"))
    lines.push(pendingLine("Credit, flood cert & tax service"))
    if (conv) {
      const lt = lenderTitleConvention(conv)
      lines.push(pendingLine("Lender's title insurance", `In ${conv.stateName}: ${lt.note} (~${lt.pctOfLoanLow}%–${lt.pctOfLoanHigh}% of the loan — ${regLabel})`))
    } else {
      lines.push(pendingLine("Lender's title insurance"))
    }
    lines.push(pendingLine("Prepaid interest (~15 days)"))
    lines.push(escrowDepositLine(annualTax, annualIns, conv, regLabel))
  }

  // ── The lines estimable BEFORE a lender exists — regional when the state is known ──
  if (conv) {
    const share = buyerShareFactor(conv.ownerTitlePayer)
    lines.push({
      label: "Owner's title insurance",
      low: r(price * (conv.ownerTitleLowPct / 100) * share.low),
      high: r(price * (conv.ownerTitleHighPct / 100) * share.high),
      note: conv.ownerTitlePayer === "seller"
        ? `customarily SELLER-paid in ${conv.stateName} — your contract controls. ${conv.titleNote}`
        : conv.titleNote,
      source: "regional_estimate",
      sourceLabel: regLabel!,
    })
    lines.push({
      label: conv.settlementModel === "attorney" ? "Settlement / closing attorney fee" : "Settlement / escrow fee",
      low: conv.settlementFeeLow,
      high: conv.settlementFeeHigh,
      note: conv.attorneyClosing ? `${conv.stateName} is an attorney-closing state` : undefined,
      source: "regional_estimate",
      sourceLabel: regLabel!,
    })
    const tShare = buyerShareFactor(conv.transferTaxPayer)
    lines.push({
      label: "Recording & transfer charges",
      low: r(conv.recordingFeeLow + price * (conv.transferTaxPct / 100) * tShare.low),
      high: r(conv.recordingFeeHigh + price * (conv.transferTaxPct / 100) * tShare.high),
      note: conv.transferTaxNote,
      source: "regional_estimate",
      sourceLabel: regLabel!,
    })
  } else {
    // No state → no reviewed convention: these are PENDING (the generic 0.3%–0.5% / $500–$1,200 / $150–$400 bands were unsourced).
    const ask = "pending — enter the property's state (for the reviewed regional convention) or a quote; no generic band is assumed"
    lines.push({ label: "Owner's title insurance", low: 0, high: 0, pending: true, note: ask })
    lines.push({ label: "Settlement / escrow fee", low: 0, high: 0, pending: true, note: ask })
    lines.push({ label: "Recording & transfer charges", low: 0, high: 0, pending: true, note: ask })
  }
  lines.push(annualIns != null
    ? { label: "Homeowner's insurance (year one, paid at closing)", low: r(annualIns), high: r(annualIns), note: "your insurance estimate", source: "lender_fact", sourceLabel: "your estimate" }
    : { label: "Homeowner's insurance (year one, paid at closing)", low: 0, high: 0, pending: true, note: "pending — enter your insurance quote; no percentage of the price is assumed" })

  const totalLow = lines.reduce((s, l) => s + (l.pending ? 0 : l.low), 0)
  const totalHigh = lines.reduce((s, l) => s + (l.pending ? 0 : l.high), 0)
  const credit = Math.max(0, i.sellerCredit)
  const baseDisclaimer =
    "Planning estimates only — every line is a range, not a quote. Your lender's Loan Estimate and the final Closing Disclosure are the binding documents, and your agent will walk you through both."
  const regionalDisclaimer = conv
    ? ` Labeled lines are estimated from ${conv.stateName} closing conventions — your lender's Loan Estimate is the authority.`
    : ""
  const disclaimer = financed && !loanKnown
    ? `${baseDisclaimer}${regionalDisclaimer} Lines marked pending depend on your loan terms, which aren't on file yet — they are excluded from the totals, not zero. Share your pre-approval or lender details and this completes itself.`
    : `${baseDisclaimer}${regionalDisclaimer}`
  return {
    isCash,
    loanKnown,
    loanSourceNote: i.loanSourceNote ?? null,
    regionState: conv?.state ?? null,
    regionLabel: regLabel,
    lines,
    totalLow,
    totalHigh,
    sellerCredit: credit,
    netLow: Math.max(0, totalLow - credit),
    netHigh: Math.max(0, totalHigh - credit),
    pctLow: price > 0 ? Math.round((totalLow / price) * 1000) / 10 : 0,
    pctHigh: price > 0 ? Math.round((totalHigh / price) * 1000) / 10 : 0,
    disclaimer,
  }
}

function escrowDepositLine(
  annualTax: number | null,
  annualIns: number | null,
  conv: RegionalConventions | null,
  regLabel: string | null,
): BuyerCostLine {
  // WAVE 156 (lane 156H, round 4): the deposit needs BOTH a tax figure (the buyer's or the reviewed state band) and the buyer's
  // insurance figure, and a state for the months convention — otherwise it is PENDING, never a generic quarter-of-a-year.
  if (conv && annualTax != null && annualIns != null) {
    const months = taxEscrowMonths(conv)
    return {
      label: `Tax & insurance escrow deposit (~${months.low}–${months.high} months)`,
      low: r((annualTax / 12) * months.low + (annualIns / 12) * 2),
      high: r((annualTax / 12) * months.high + (annualIns / 12) * 3),
      note: `the lender's cushion — it stays your money. ${conv.stateName} effective property tax runs ~${conv.propertyTaxLowPct}%–${conv.propertyTaxHighPct}%/yr`,
      source: "regional_estimate",
      sourceLabel: regLabel!,
    }
  }
  return { label: "Tax & insurance escrow deposit", low: 0, high: 0, pending: true, note: "pending — needs the property's state, the tax bill and your insurance quote (or your lender's escrow figure)" }
}

/** PURE: re-derive the totals after the AI-refinement step swapped in adjusted
 *  lines (bounded by applyAiRefinements). Pending lines stay excluded. */
export function retotalEstimate(
  base: BuyerClosingEstimate,
  lines: BuyerCostLine[],
  purchasePrice: number,
  aiRefineSummary?: string | null,
): BuyerClosingEstimate {
  const totalLow = lines.reduce((s, l) => s + (l.pending ? 0 : l.low), 0)
  const totalHigh = lines.reduce((s, l) => s + (l.pending ? 0 : l.high), 0)
  return {
    ...base,
    lines,
    totalLow,
    totalHigh,
    netLow: Math.max(0, totalLow - base.sellerCredit),
    netHigh: Math.max(0, totalHigh - base.sellerCredit),
    pctLow: purchasePrice > 0 ? Math.round((totalLow / purchasePrice) * 1000) / 10 : 0,
    pctHigh: purchasePrice > 0 ? Math.round((totalHigh / purchasePrice) * 1000) / 10 : 0,
    aiRefined: true,
    aiRefineSummary: aiRefineSummary ?? null,
  }
}
