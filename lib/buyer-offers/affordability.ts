// lib/buyer-offers/affordability.ts
// ─────────────────────────────────────────────────────────────────────────────
// BUYER SELF-SERVE AFFORDABILITY — the math behind the portal tool a buyer uses to answer
// "can I afford this home, and what would it cost me a month?" on a property they like. PURE,
// exact mortgage math; every assumption (rate, tax %, insurance, HOA) is a CLEARLY-LABELED,
// buyer-editable default — we never fabricate a precise market rate. The price + pre-approval
// are real (the listing + buyer_financial_profiles); the buyer tunes the rest. Using the tool
// signals the agent (buyer-as-actor → Shopping Agent), so self-qualification convenes the team.

/** Clearly-labeled ESTIMATE defaults the buyer can override in the UI — not a quoted rate. */
export const AFFORDABILITY_DEFAULTS = {
  annualInterestRatePct: 6.5, // a round, recent-era placeholder the buyer adjusts to their quote
  downPaymentPercent: 20,
  loanTermYears: 30,
  propertyTaxRatePct: 1.1, // annual, % of price — varies widely by state/county; buyer-tunable
  annualInsuranceRatePct: 0.35, // annual homeowners insurance, % of price
  pmiAnnualRatePct: 0.5, // PMI when down payment < 20%, % of loan/yr
  hoaMonthly: 0,
} as const

export interface MonthlyPaymentInput {
  price: number
  downPaymentPercent?: number
  annualInterestRatePct?: number
  loanTermYears?: number
  propertyTaxRatePct?: number
  annualInsuranceRatePct?: number
  pmiAnnualRatePct?: number
  hoaMonthly?: number
}

export interface MonthlyPaymentBreakdown {
  loanAmount: number
  downPayment: number
  principalInterest: number
  propertyTax: number
  insurance: number
  pmi: number
  hoa: number
  total: number
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * estimateMonthlyPayment — PURE. Standard amortized PITI + HOA + PMI. The principal+interest uses
 * the exact amortization formula M = P·r(1+r)^n / ((1+r)^n − 1); a 0% rate degrades to P/n. PMI
 * applies only when the down payment is under 20%. All inputs default to the labeled estimates.
 */
export function estimateMonthlyPayment(input: MonthlyPaymentInput): MonthlyPaymentBreakdown {
  const d = AFFORDABILITY_DEFAULTS
  const price = Math.max(0, input.price || 0)
  const downPct = input.downPaymentPercent ?? d.downPaymentPercent
  const ratePct = input.annualInterestRatePct ?? d.annualInterestRatePct
  const termYears = input.loanTermYears ?? d.loanTermYears
  const taxPct = input.propertyTaxRatePct ?? d.propertyTaxRatePct
  const insPct = input.annualInsuranceRatePct ?? d.annualInsuranceRatePct
  const pmiPct = input.pmiAnnualRatePct ?? d.pmiAnnualRatePct
  const hoa = Math.max(0, input.hoaMonthly ?? d.hoaMonthly)

  const downPayment = price * (downPct / 100)
  const loanAmount = Math.max(0, price - downPayment)
  const n = Math.max(1, Math.round(termYears * 12))
  const r = ratePct / 100 / 12

  const principalInterest =
    loanAmount === 0 ? 0 : r === 0 ? loanAmount / n : (loanAmount * (r * Math.pow(1 + r, n))) / (Math.pow(1 + r, n) - 1)

  const propertyTax = (price * (taxPct / 100)) / 12
  const insurance = (price * (insPct / 100)) / 12
  const pmi = downPct < 20 ? (loanAmount * (pmiPct / 100)) / 12 : 0

  const total = principalInterest + propertyTax + insurance + pmi + hoa
  return {
    loanAmount: round2(loanAmount),
    downPayment: round2(downPayment),
    principalInterest: round2(principalInterest),
    propertyTax: round2(propertyTax),
    insurance: round2(insurance),
    pmi: round2(pmi),
    hoa: round2(hoa),
    total: round2(total),
  }
}

export type AffordabilityVerdict = "within_budget" | "stretch" | "over_budget" | "unknown"

export interface AffordabilityReadInput {
  price: number
  monthlyTotal: number
  /** Lender pre-approval amount on file (the hard ceiling the lender already cleared). */
  preApprovalAmount?: number | null
  /** The buyer's comfortable monthly housing budget, if they enter one. */
  maxMonthlyBudget?: number | null
}

export interface AffordabilityRead {
  /** price ≤ pre-approval (null when no pre-approval on file). */
  withinPreApproval: boolean | null
  /** pre-approval − price (negative = over the lender's ceiling). null when no pre-approval. */
  headroomToPreApproval: number | null
  verdict: AffordabilityVerdict
  reason: string
}

/**
 * affordabilityRead — PURE. Honest read of whether the home fits: against the lender's
 * pre-approval (the real ceiling) and, when the buyer enters one, their comfortable monthly
 * budget. No fabrication — with no pre-approval and no budget, the verdict is "unknown".
 */
export function affordabilityRead(input: AffordabilityReadInput): AffordabilityRead {
  const withinPreApproval =
    typeof input.preApprovalAmount === "number" && input.preApprovalAmount > 0
      ? input.price <= input.preApprovalAmount
      : null
  const headroomToPreApproval =
    typeof input.preApprovalAmount === "number" && input.preApprovalAmount > 0
      ? round2(input.preApprovalAmount - input.price)
      : null

  // Over the lender's ceiling is the strongest signal.
  if (withinPreApproval === false) {
    return { withinPreApproval, headroomToPreApproval, verdict: "over_budget", reason: "above your pre-approval amount" }
  }
  if (typeof input.maxMonthlyBudget === "number" && input.maxMonthlyBudget > 0) {
    if (input.monthlyTotal <= input.maxMonthlyBudget)
      return { withinPreApproval, headroomToPreApproval, verdict: "within_budget", reason: "within your monthly budget" }
    if (input.monthlyTotal <= input.maxMonthlyBudget * 1.1)
      return { withinPreApproval, headroomToPreApproval, verdict: "stretch", reason: "slightly above your monthly budget" }
    return { withinPreApproval, headroomToPreApproval, verdict: "over_budget", reason: "above your monthly budget" }
  }
  if (withinPreApproval === true)
    return { withinPreApproval, headroomToPreApproval, verdict: "within_budget", reason: "within your pre-approval" }
  return { withinPreApproval, headroomToPreApproval, verdict: "unknown", reason: "no pre-approval or budget on file yet" }
}
