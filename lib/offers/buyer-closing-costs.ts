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

export interface BuyerCostInput {
  purchasePrice: number
  /** >0 = the REAL loan amount on file; 0 = cash purchase; null = financed but
   *  the terms are genuinely UNKNOWN (no lender record, offer terms, or
   *  pre-approval) — loan-dependent lines go PENDING, never assumed. */
  loanAmount: number | null
  /** the seller credit negotiated on the accepted offer */
  sellerCredit: number
  /** county annual property tax, when known (else estimated at ~1.1% of price) */
  annualTaxEstimate?: number | null
  /** year-one homeowner's insurance, when known (else ~0.35% of price) */
  annualInsuranceEstimate?: number | null
  /** the REAL quoted/locked rate from the lender record (percent, e.g. 6.5), when on file */
  interestRatePct?: number | null
  /** provenance for the loan figure — e.g. "per your pre-approval from Acme Lending" */
  loanSourceNote?: string | null
}

export interface BuyerCostLine {
  label: string
  low: number
  high: number
  note?: string
  /** true = this line depends on loan terms that are not on file yet — the
   *  figure is pending the lender's terms, not zero. */
  pending?: boolean
}

export interface BuyerClosingEstimate {
  isCash: boolean
  /** false = financed but no loan record/pre-approval on file — lender-dependent
   *  lines are pending and excluded from the totals (stated in the disclaimer). */
  loanKnown: boolean
  /** where the loan figure came from (provenance), when known */
  loanSourceNote: string | null
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
}

const r = (n: number) => Math.round(n / 10) * 10

/** PURE: the buyer's estimated cash-to-close beyond the down payment. */
export function estimateBuyerClosingCosts(i: BuyerCostInput): BuyerClosingEstimate {
  const price = Math.max(0, i.purchasePrice)
  const loanKnown = i.loanAmount != null && Number.isFinite(i.loanAmount)
  const loan = loanKnown ? Math.max(0, i.loanAmount as number) : 0
  const isCash = loanKnown && loan === 0
  const financed = !isCash // includes the terms-unknown case — the buyer IS financing
  const annualTax = i.annualTaxEstimate && i.annualTaxEstimate > 0 ? i.annualTaxEstimate : price * 0.011
  const annualIns = i.annualInsuranceEstimate && i.annualInsuranceEstimate > 0 ? i.annualInsuranceEstimate : price * 0.0035
  const rate = i.interestRatePct && i.interestRatePct > 0 ? i.interestRatePct : null

  const PENDING_NOTE = "pending your lender's terms — attach your pre-approval or lender details to complete this line"
  const pendingLine = (label: string): BuyerCostLine => ({ label, low: 0, high: 0, pending: true, note: PENDING_NOTE })

  const lines: BuyerCostLine[] = []
  if (financed && loanKnown) {
    lines.push({ label: "Lender fees (origination + underwriting)", low: r(loan * 0.005), high: r(loan * 0.01), note: "typically 0.5%–1% of the loan" })
    lines.push({ label: "Appraisal", low: 500, high: 800 })
    lines.push({ label: "Credit, flood cert & tax service", low: 100, high: 250 })
    lines.push({ label: "Lender's title insurance", low: r(loan * 0.002), high: r(loan * 0.0035), note: "scales with the loan amount" })
    if (rate != null) {
      const daily = (loan * (rate / 100)) / 365
      lines.push({ label: "Prepaid interest (~15 days)", low: r(daily * 15), high: r(daily * 15), note: `at your lender's ${rate}% rate on file` })
    } else {
      lines.push({ label: "Prepaid interest (~15 days)", low: r((loan * 0.065 / 365) * 15), high: r((loan * 0.07 / 365) * 15), note: "estimated 6.5%–7% band until your lender's rate is on file" })
    }
    lines.push({ label: "Tax & insurance escrow deposit (~3 months)", low: r((annualTax + annualIns) / 4), high: r((annualTax + annualIns) / 3), note: "the lender's cushion — it stays your money" })
  } else if (financed && !loanKnown) {
    // Honest unknown: each loan-dependent line is PENDING the lender's terms —
    // no loan amount, type, or rate is on file, and nothing is assumed.
    lines.push(pendingLine("Lender fees (origination + underwriting)"))
    lines.push({ label: "Appraisal", low: 500, high: 800 })
    lines.push({ label: "Credit, flood cert & tax service", low: 100, high: 250 })
    lines.push(pendingLine("Lender's title insurance"))
    lines.push(pendingLine("Prepaid interest (~15 days)"))
    lines.push({ label: "Tax & insurance escrow deposit (~3 months)", low: r((annualTax + annualIns) / 4), high: r((annualTax + annualIns) / 3), note: "the lender's cushion — it stays your money" })
  }
  lines.push({ label: "Owner's title insurance", low: r(price * 0.003), high: r(price * 0.005), note: "who pays varies by region and contract" })
  lines.push({ label: "Settlement / escrow fee", low: 500, high: 1200 })
  lines.push({ label: "Recording & transfer charges", low: 150, high: 400, note: "transfer taxes vary widely by state" })
  lines.push({ label: "Homeowner's insurance (year one, paid at closing)", low: r(annualIns * 0.9), high: r(annualIns * 1.1) })

  const totalLow = lines.reduce((s, l) => s + (l.pending ? 0 : l.low), 0)
  const totalHigh = lines.reduce((s, l) => s + (l.pending ? 0 : l.high), 0)
  const credit = Math.max(0, i.sellerCredit)
  const baseDisclaimer =
    "Planning estimates only — every line is a range, not a quote. Your lender's Loan Estimate and the final Closing Disclosure are the binding documents, and your agent will walk you through both."
  const disclaimer = financed && !loanKnown
    ? `${baseDisclaimer} Lines marked pending depend on your loan terms, which aren't on file yet — they are excluded from the totals, not zero. Share your pre-approval or lender details and this completes itself.`
    : baseDisclaimer
  return {
    isCash,
    loanKnown,
    loanSourceNote: i.loanSourceNote ?? null,
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
