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

export interface BuyerCostInput {
  purchasePrice: number
  /** null/0 = cash purchase (loan lines are dropped) */
  loanAmount: number | null
  /** the seller credit negotiated on the accepted offer */
  sellerCredit: number
  /** county annual property tax, when known (else estimated at ~1.1% of price) */
  annualTaxEstimate?: number | null
  /** year-one homeowner's insurance, when known (else ~0.35% of price) */
  annualInsuranceEstimate?: number | null
}

export interface BuyerCostLine {
  label: string
  low: number
  high: number
  note?: string
}

export interface BuyerClosingEstimate {
  isCash: boolean
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
  const loan = Math.max(0, i.loanAmount ?? 0)
  const isCash = loan === 0
  const annualTax = i.annualTaxEstimate && i.annualTaxEstimate > 0 ? i.annualTaxEstimate : price * 0.011
  const annualIns = i.annualInsuranceEstimate && i.annualInsuranceEstimate > 0 ? i.annualInsuranceEstimate : price * 0.0035

  const lines: BuyerCostLine[] = []
  if (!isCash) {
    lines.push({ label: "Lender fees (origination + underwriting)", low: r(loan * 0.005), high: r(loan * 0.01), note: "typically 0.5%–1% of the loan" })
    lines.push({ label: "Appraisal", low: 500, high: 800 })
    lines.push({ label: "Credit, flood cert & tax service", low: 100, high: 250 })
    lines.push({ label: "Lender's title insurance", low: r(loan * 0.002), high: r(loan * 0.0035), note: "scales with the loan amount" })
    lines.push({ label: "Prepaid interest (~15 days)", low: r((loan * 0.065 / 365) * 15), high: r((loan * 0.07 / 365) * 15), note: "assumes ~6.5%–7% until your rate locks" })
    lines.push({ label: "Tax & insurance escrow deposit (~3 months)", low: r((annualTax + annualIns) / 4), high: r((annualTax + annualIns) / 3), note: "the lender's cushion — it stays your money" })
  }
  lines.push({ label: "Owner's title insurance", low: r(price * 0.003), high: r(price * 0.005), note: "who pays varies by region and contract" })
  lines.push({ label: "Settlement / escrow fee", low: 500, high: 1200 })
  lines.push({ label: "Recording & transfer charges", low: 150, high: 400, note: "transfer taxes vary widely by state" })
  lines.push({ label: "Homeowner's insurance (year one, paid at closing)", low: r(annualIns * 0.9), high: r(annualIns * 1.1) })

  const totalLow = lines.reduce((s, l) => s + l.low, 0)
  const totalHigh = lines.reduce((s, l) => s + l.high, 0)
  const credit = Math.max(0, i.sellerCredit)
  return {
    isCash,
    lines,
    totalLow,
    totalHigh,
    sellerCredit: credit,
    netLow: Math.max(0, totalLow - credit),
    netHigh: Math.max(0, totalHigh - credit),
    pctLow: price > 0 ? Math.round((totalLow / price) * 1000) / 10 : 0,
    pctHigh: price > 0 ? Math.round((totalHigh / price) * 1000) / 10 : 0,
    disclaimer: "Planning estimates only — every line is a range, not a quote. Your lender's Loan Estimate and the final Closing Disclosure are the binding documents, and your agent will walk you through both.",
  }
}
