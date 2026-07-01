// lib/finance/tax-planning.ts
//
// SELF-EMPLOYED AGENT TAX PLANNING — the solo-agent differentiator. A 1099 real-estate agent owes
// self-employment tax + income tax and must pay QUARTERLY estimates; nobody withholds for them. This
// pure engine turns their real YTD income (GCI − deductible business expenses) into: a tax set-aside,
// a precise self-employment-tax figure, and the four quarterly estimated-tax payments with their IRS
// due dates — grounded, no fabricated tax brackets (the income-tax portion uses the agent's own
// blended effective rate, defaulting to the recommended set-aside). Pure → unit-tested; the server
// action feeds it real data and persists the profile + payments.

export type FilingStatus = "single" | "married_joint" | "married_separate" | "head_of_household"

// Statutory self-employment tax rates (stable — 12.4% Social Security + 2.9% Medicare on 92.35% of
// net SE income). The Social Security WAGE BASE changes yearly, so it is a PARAMETER (never hardcoded
// to a guessed future value). Half of SE tax is deductible against income — modeled below.
export const SE_NET_FACTOR = 0.9235
export const SS_RATE = 0.124
export const MEDICARE_RATE = 0.029
// Sensible default blended INCOME-tax effective rate for a self-employed agent (fed + state), used
// only when the agent hasn't set their own. Deliberately conservative; the agent overrides it.
export const DEFAULT_EFFECTIVE_INCOME_RATE = 0.12

export interface SelfEmploymentTax {
  taxableBase: number
  socialSecurity: number
  medicare: number
  total: number
}

/**
 * PURE: the precise self-employment tax on net SE income. Social Security is capped at the wage base
 * (net of any W-2 SS wages already paid this year); Medicare has no cap. Pass the CURRENT year's wage
 * base — omit it and SS is uncapped (conservative overestimate, never a silent underestimate).
 */
export function computeSelfEmploymentTax(input: {
  netSelfEmploymentIncome: number
  socialSecurityWageBase?: number | null
  priorSocialSecurityWages?: number
}): SelfEmploymentTax {
  const net = Math.max(0, input.netSelfEmploymentIncome)
  const taxableBase = net * SE_NET_FACTOR
  const priorWages = Math.max(0, input.priorSocialSecurityWages ?? 0)
  const ssCap = input.socialSecurityWageBase != null && input.socialSecurityWageBase > 0
    ? Math.max(0, input.socialSecurityWageBase - priorWages)
    : Infinity
  const ssTaxable = Math.min(taxableBase, ssCap)
  const socialSecurity = round2(ssTaxable * SS_RATE)
  const medicare = round2(taxableBase * MEDICARE_RATE)
  return { taxableBase: round2(taxableBase), socialSecurity, medicare, total: round2(socialSecurity + medicare) }
}

/** PURE: net self-employment income = gross commission income − deductible business expenses. */
export function computeNetSelfEmploymentIncome(grossIncome: number, deductibleExpenses: number): number {
  return Math.max(0, round2((grossIncome || 0) - Math.max(0, deductibleExpenses || 0)))
}

/**
 * PURE: an agent's business expenses are inherently deductible (marketing, training, technology,
 * office, travel, professional services). Sum them; honor an optional per-row deductible flag/percent
 * when present (future-proofing), else count the full amount.
 */
export function sumDeductibleExpenses(
  expenses: Array<{ amount?: number | string | null; is_deductible?: boolean | null; deduction_percentage?: number | null }>,
): number {
  let total = 0
  for (const e of expenses ?? []) {
    const amt = Number(e.amount ?? 0)
    if (!Number.isFinite(amt) || amt <= 0) continue
    const pct = e.deduction_percentage != null ? Math.max(0, Math.min(100, e.deduction_percentage)) / 100
      : e.is_deductible === false ? 0 : 1
    total += amt * pct
  }
  return round2(total)
}

export interface QuarterlyEstimate {
  quarter: 1 | 2 | 3 | 4
  /** IRS estimated-tax due date (ISO yyyy-mm-dd) for the tax year. */
  dueDate: string
  amount: number
  /** True once a payment covering this quarter has been recorded. */
  paid: boolean
}

// IRS quarterly estimated-tax due dates (standard; Q4 falls in January of the following year).
// Weekend/holiday shifting is a refinement — the standard dates are used here.
export function quarterlyDueDates(taxYear: number): string[] {
  return [
    `${taxYear}-04-15`,
    `${taxYear}-06-15`,
    `${taxYear}-09-15`,
    `${taxYear + 1}-01-15`,
  ]
}

/**
 * PURE: the four equal quarterly estimated-tax payments for the year (safe-harbor style — annual
 * liability split into four), each flagged paid when a recorded payment covers that quarter.
 */
export function computeQuarterlyEstimates(input: {
  projectedAnnualTaxLiability: number
  taxYear: number
  paidQuarters?: number[]
}): QuarterlyEstimate[] {
  const perQuarter = round2(Math.max(0, input.projectedAnnualTaxLiability) / 4)
  const dates = quarterlyDueDates(input.taxYear)
  const paid = new Set(input.paidQuarters ?? [])
  return ([1, 2, 3, 4] as const).map((q) => ({
    quarter: q,
    dueDate: dates[q - 1],
    amount: perQuarter,
    paid: paid.has(q),
  }))
}

export interface TaxPlan {
  taxYear: number
  ytdGrossIncome: number
  deductibleExpenses: number
  netSelfEmploymentIncome: number
  /** Straight-line projection of net income to full year from the fraction of the year elapsed. */
  projectedAnnualNetIncome: number
  selfEmploymentTax: SelfEmploymentTax
  /** Income tax at the agent's blended effective rate, on income net of the deductible half of SE tax. */
  estimatedIncomeTax: number
  projectedAnnualTaxLiability: number
  /** The agent's chosen buffer to set aside from gross (their safety cushion). */
  setAsideAmount: number
  setAsidePercent: number
  quarterly: QuarterlyEstimate[]
  effectiveIncomeRate: number
}

/**
 * PURE: the full tax plan from the agent's real YTD numbers + their profile. Projects net income to
 * the full year by the fraction elapsed, computes SE tax + an effective-rate income-tax estimate
 * (net of the deductible half of SE tax), the total projected liability, the four quarterly payments,
 * and the agent's set-aside buffer. `fractionOfYearElapsed` (0..1) annualizes YTD → projected annual.
 */
export function buildTaxPlan(input: {
  taxYear: number
  ytdGrossIncome: number
  deductibleExpenses: number
  setAsidePercent: number
  effectiveIncomeRate?: number
  fractionOfYearElapsed: number
  socialSecurityWageBase?: number | null
  paidQuarters?: number[]
}): TaxPlan {
  const gross = Math.max(0, input.ytdGrossIncome || 0)
  const deductible = Math.max(0, input.deductibleExpenses || 0)
  const netYtd = computeNetSelfEmploymentIncome(gross, deductible)
  const frac = Math.min(1, Math.max(0.01, input.fractionOfYearElapsed || 1))
  const projectedAnnualNet = round2(netYtd / frac)

  // SE tax on the PROJECTED annual net income (that's what quarterly estimates must cover).
  const seTax = computeSelfEmploymentTax({
    netSelfEmploymentIncome: projectedAnnualNet,
    socialSecurityWageBase: input.socialSecurityWageBase,
  })
  const effectiveRate = clampRate(input.effectiveIncomeRate ?? DEFAULT_EFFECTIVE_INCOME_RATE)
  // Half of SE tax is deductible against income for income-tax purposes.
  const incomeBase = Math.max(0, projectedAnnualNet - seTax.total / 2)
  const incomeTax = round2(incomeBase * effectiveRate)
  const totalLiability = round2(seTax.total + incomeTax)

  const setAsidePercent = Math.max(0, Math.min(50, input.setAsidePercent || 0))
  const setAsideAmount = round2(netYtd * (setAsidePercent / 100))

  return {
    taxYear: input.taxYear,
    ytdGrossIncome: round2(gross),
    deductibleExpenses: round2(deductible),
    netSelfEmploymentIncome: netYtd,
    projectedAnnualNetIncome: projectedAnnualNet,
    selfEmploymentTax: seTax,
    estimatedIncomeTax: incomeTax,
    projectedAnnualTaxLiability: totalLiability,
    setAsideAmount,
    setAsidePercent,
    quarterly: computeQuarterlyEstimates({ projectedAnnualTaxLiability: totalLiability, taxYear: input.taxYear, paidQuarters: input.paidQuarters }),
    effectiveIncomeRate: effectiveRate,
  }
}

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100
}
function clampRate(r: number): number {
  const n = Number(r)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_EFFECTIVE_INCOME_RATE
  return Math.min(0.5, n)
}
