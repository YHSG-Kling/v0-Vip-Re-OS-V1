// lib/finance/tax-planning.ts
//
// SELF-EMPLOYED AGENT ESTIMATED-TAX PLANNING — THE ONE ESTIMATOR (no second tax engine anywhere: the planning panels,
// the quarterly concierge and the server actions all compose this file).
//
// WAVE 153 (lane 153A) — owner ruling, verbatim: "make sure estimate quarterly taxes work (if we cant determine their tax
// percentages, then the user can enter that in)". What changed, and why each part is load-bearing:
//   · NO DEFAULT RATE. The previous engine fell back to a 12% income-tax rate (and the database to 12% / 25%) for anyone
//     who never entered one, so every reminder quoted a liability computed from a number nobody chose. A personal tax
//     rate is not something this platform can determine (filing status, other income, withholding, deductions, state
//     residency, prior-year safe harbor), so it is ENTERED — by the person (self_entered) or their accountant
//     (accountant_supplied) — with its period, last-updated time and a version. Until it is, the plan says "needs input"
//     and quotes no reserve. Self-employment tax stays computed: it is a statutory formula, not a guess.
//   · A RESERVE IS NOT THE AMOUNT LEGALLY DUE. Every output is labelled a cash-planning reserve; the four quantities the
//     directive names are kept separate: period-to-date net estimate, projected reserve, already set aside / paid, and
//     remaining suggested reserve.
//   · INCOME AS CONFIGURED. Commission income is recognized on the person's chosen basis — cash (when paid_at lands in
//     the window) or accrual (when the deal closed, close_date) — so a commission earned in December and paid in January
//     falls in different years under the two bases. Disputed commissions are excluded and shown.
//   · DEDUCTIBILITY IS NEVER ASSUMED. The old engine called every business expense "inherently deductible". Now only the
//     categories the person/accountant CONFIRMED reduce the estimate; the rest are shown, with their amount, as "not yet
//     confirmed deductible" (a conservative reserve, never an invented deduction).
//   · DUE DATES DERIVED PER TAX YEAR (IRS Publication 505): the 15th of the 4th, 6th and 9th months of the tax year and of
//     the 1st month after it (calendar year: Apr 15, Jun 15, Sep 15, Jan 15), moved to the next business day when that
//     falls on a Saturday, Sunday or legal holiday (federal holidays and DC Emancipation Day, which is what moved
//     April 15, 2022 to April 18). Fiscal-year filers and user-entered schedules (e.g. a state's dates or a disaster
//     postponement) are supported. Nothing here pays anything.
//   · REFORECAST WITHOUT REWRITING HISTORY. A changed assumption only changes the suggestion for quarters still ahead;
//     recorded payments / set-asides are facts the plan reads and never recomputes.
//
// Personal vs entity: this is the 1099 agent's PERSONAL planner, fed by THEIR commission (agent_commissions.agent_commission
// — their split), never by consolidated brokerage or team revenue. A multi-office rollup is managerial reporting, not a
// filer; a brokerage entity's estimated taxes (pass-through vs corporation) are outside this estimator and referred to a
// tax professional.

export type FilingStatus = "single" | "married_joint" | "married_separate" | "head_of_household"

// Statutory self-employment tax rates (12.4% Social Security + 2.9% Medicare on 92.35% of net SE income). The Social
// Security WAGE BASE changes yearly, so it is a PARAMETER (never hardcoded to a guessed future value).
export const SE_NET_FACTOR = 0.9235
const SS_RATE = 0.124
const MEDICARE_RATE = 0.029
// TOMBSTONE (wave 153, lane 153A — owner ruling "if we cant determine their tax percentages, then the user can enter
// that in"): `DEFAULT_EFFECTIVE_INCOME_RATE = 0.12` lived here and was the fallback income-tax rate for anyone who had
// not entered one. Deleted, not replaced: an unentered rate is now "needs input" (buildTaxPlan → plan.inputs.status).
// Survivor for the rate itself: the person's own entry, parseTaxAssumptions (this file) → TaxAssumptions.federalRate /
// stateRate, written by app/actions/tax-planning.ts saveTaxAssumptionsAction.

export interface SelfEmploymentTax {
  taxableBase: number
  socialSecurity: number
  medicare: number
  total: number
}

/**
 * PURE: the precise self-employment tax on net SE income. Social Security is capped at the wage base (net of any W-2
 * SS wages already paid this year); Medicare has no cap. Omit the wage base and SS is uncapped (a conservative
 * overestimate, never a silent underestimate).
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

/** PURE: net self-employment income = gross commission income − CONFIRMED deductible business expenses (never below 0). */
export function computeNetSelfEmploymentIncome(grossIncome: number, deductibleExpenses: number): number {
  return Math.max(0, round2((grossIncome || 0) - Math.max(0, deductibleExpenses || 0)))
}

// ─── THE ASSUMPTIONS — entered, sourced, versioned (m901 agent_tax_profile.assumptions) ────────────────────────────

/** ONE vocabulary for where an assumption came from (CLAUDE.md §6). The platform never supplies a personal rate. */
const ASSUMPTION_SOURCES = ["self_entered", "accountant_supplied"] as const
type AssumptionSource = (typeof ASSUMPTION_SOURCES)[number]

interface AssumptionValue<T> {
  value: T
  source: AssumptionSource
  /** The period it applies to: the tax year ("2026"), or a quarter ("2026-Q2") for an accountant target / a due date. */
  period: string
  updatedAt: string
  updatedBy: string | null
  version: number
  note?: string | null
}

type Quarter = 1 | 2 | 3 | 4

export interface TaxAssumptions {
  /** Federal income-tax reserve rate on net income (0–0.5), as a fraction. */
  federalRate: AssumptionValue<number> | null
  /** State income-tax reserve rate (0–0.2). 0 is a real entry (a state with no income tax); absent is "needs input".
   *  A person who files in several states enters the combined rate they (or their accountant) settled on, and may list
   *  the states it covers — state law is never derived here (not from an office's address either). */
  stateRate: AssumptionValue<number> | null
  stateCodes: AssumptionValue<string[]> | null
  /** Optional override of the statutory self-employment tax as a rate on net income (e.g. an S-corp owner's accountant
   *  says 0). Absent = the statutory computation, which is a formula, not an assumption. */
  selfEmploymentRate: AssumptionValue<number> | null
  /** Optional extra reserve (local tax, a cushion) as a rate on net income (0–0.3). */
  otherReserveRate: AssumptionValue<number> | null
  /** Accountant-supplied quarterly targets in dollars — used for that quarter instead of the computed suggestion. */
  accountantTargets: Partial<Record<Quarter, AssumptionValue<number>>>
  /** Cash (received) or accrual (earned at closing). Unset = shown on the cash basis WITH a flag, never silently. */
  incomeBasis: AssumptionValue<"cash" | "accrual"> | null
  /** Expense categories (the one vocabulary, lib/documents/receipt-rules.ts EXPENSE_CATEGORIES) confirmed deductible. */
  deductibleCategories: AssumptionValue<string[]> | null
  /** First month of the tax year (1 = calendar year). */
  fiscalYearStartMonth: AssumptionValue<number> | null
  /** User-entered due dates per quarter (a state schedule, a disaster postponement, an accountant's calendar). */
  dueDateOverrides: Partial<Record<Quarter, AssumptionValue<string>>>
}

type ScalarKey = "federalRate" | "stateRate" | "selfEmploymentRate" | "otherReserveRate"
const RATE_LIMITS: Record<ScalarKey, number> = { federalRate: 0.5, stateRate: 0.2, selfEmploymentRate: 0.2, otherReserveRate: 0.3 }

function parseEnvelope<T>(raw: unknown, check: (v: unknown) => v is T): AssumptionValue<T> | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  if (!check(r.value)) return null
  if (!(ASSUMPTION_SOURCES as readonly string[]).includes(String(r.source))) return null
  if (typeof r.updatedAt !== "string" || Number.isNaN(Date.parse(r.updatedAt))) return null
  if (typeof r.period !== "string" || !r.period) return null
  const version = Number(r.version)
  if (!Number.isInteger(version) || version < 1) return null
  return { value: r.value, source: r.source as AssumptionSource, period: r.period, updatedAt: r.updatedAt, updatedBy: typeof r.updatedBy === "string" ? r.updatedBy : null, version, note: typeof r.note === "string" ? r.note : null }
}

const isRate = (max: number) => (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max
const isDollars = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 100_000_000
const isIsoDate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`))
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0 && x.length < 60)
const isBasis = (v: unknown): v is "cash" | "accrual" => v === "cash" || v === "accrual"
const isMonth = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 12

/**
 * PURE: THE ONE PARSER of agent_tax_profile.assumptions. Anything malformed (a rate out of range, an unknown source, no
 * timestamp, no version) parses as ABSENT — i.e. "needs input" — never as a usable default.
 */
export function parseTaxAssumptions(raw: unknown): TaxAssumptions {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const quarters = (obj: unknown, check: (v: unknown) => boolean): Partial<Record<Quarter, AssumptionValue<any>>> => {
    const out: Partial<Record<Quarter, AssumptionValue<any>>> = {}
    if (!obj || typeof obj !== "object") return out
    for (const q of [1, 2, 3, 4] as const) {
      const env = parseEnvelope((obj as Record<string, unknown>)[String(q)], check as (v: unknown) => v is unknown)
      if (env) out[q] = env
    }
    return out
  }
  return {
    federalRate: parseEnvelope(r.federalRate, isRate(RATE_LIMITS.federalRate)),
    stateRate: parseEnvelope(r.stateRate, isRate(RATE_LIMITS.stateRate)),
    stateCodes: parseEnvelope(r.stateCodes, isStringList),
    selfEmploymentRate: parseEnvelope(r.selfEmploymentRate, isRate(RATE_LIMITS.selfEmploymentRate)),
    otherReserveRate: parseEnvelope(r.otherReserveRate, isRate(RATE_LIMITS.otherReserveRate)),
    accountantTargets: quarters(r.accountantTargets, isDollars) as Partial<Record<Quarter, AssumptionValue<number>>>,
    incomeBasis: parseEnvelope(r.incomeBasis, isBasis),
    deductibleCategories: parseEnvelope(r.deductibleCategories, isStringList),
    fiscalYearStartMonth: parseEnvelope(r.fiscalYearStartMonth, isMonth),
    dueDateOverrides: quarters(r.dueDateOverrides, isIsoDate) as Partial<Record<Quarter, AssumptionValue<string>>>,
  }
}

/** The keys a person may set, with the value shape each takes (the writer's allowlist). */
export type AssumptionChange =
  | { key: ScalarKey; value: number | null }
  | { key: "stateCodes" | "deductibleCategories"; value: string[] | null }
  | { key: "incomeBasis"; value: "cash" | "accrual" | null }
  | { key: "fiscalYearStartMonth"; value: number | null }
  | { key: "accountantTarget"; quarter: Quarter; value: number | null }
  | { key: "dueDateOverride"; quarter: Quarter; value: string | null }

/**
 * PURE: apply ONE change to the stored assumptions, returning the next object and the history entry for the value it
 * replaced (append-only — the caller appends it to agent_tax_profile.assumption_history). A value outside its allowed
 * range is REFUSED, never clamped into a number the person did not enter. `null` clears it (back to "needs input").
 */
export function applyAssumptionChange(
  stored: unknown,
  change: AssumptionChange,
  meta: { source: string; taxYear: number; userId: string; now: string; note?: string | null },
): { ok: true; next: Record<string, unknown>; replaced: Record<string, unknown> | null } | { ok: false; error: string } {
  if (!(ASSUMPTION_SOURCES as readonly string[]).includes(meta.source)) return { ok: false, error: "Say where this number came from: you, or your accountant." }
  const base = (stored && typeof stored === "object" ? { ...(stored as Record<string, unknown>) } : {}) as Record<string, unknown>
  const valid = (() => {
    if (change.value === null) return true
    switch (change.key) {
      case "federalRate": case "stateRate": case "selfEmploymentRate": case "otherReserveRate": return isRate(RATE_LIMITS[change.key])(change.value)
      case "stateCodes": return isStringList(change.value)
      case "deductibleCategories": return isStringList(change.value)
      case "incomeBasis": return isBasis(change.value)
      case "fiscalYearStartMonth": return isMonth(change.value)
      case "accountantTarget": return isDollars(change.value)
      case "dueDateOverride": return isIsoDate(change.value)
    }
  })()
  if (!valid) return { ok: false, error: change.key.endsWith("Rate") ? `That rate is outside what this planner accepts (0–${Math.round(RATE_LIMITS[change.key as ScalarKey] * 100)}%).` : "That value is not valid for this setting." }
  const quarterKey = change.key === "accountantTarget" ? "accountantTargets" : change.key === "dueDateOverride" ? "dueDateOverrides" : null
  const container: Record<string, unknown> = quarterKey ? { ...((base[quarterKey] as Record<string, unknown> | undefined) ?? {}) } : base
  const slot = quarterKey ? String((change as { quarter: Quarter }).quarter) : change.key
  const prior = (container[slot] as Record<string, unknown> | undefined) ?? null
  const version = (prior && Number.isInteger(Number(prior.version)) ? Number(prior.version) : 0) + 1
  if (change.value === null) delete container[slot]
  else container[slot] = {
    value: change.value, source: meta.source, updatedAt: meta.now, updatedBy: meta.userId, version, note: meta.note ?? null,
    period: quarterKey ? `${meta.taxYear}-Q${(change as { quarter: Quarter }).quarter}` : String(meta.taxYear),
  }
  if (quarterKey) base[quarterKey] = container
  const replaced = prior ? { key: quarterKey ? `${quarterKey}.${slot}` : slot, prior, replaced_at: meta.now, replaced_by: meta.userId } : null
  return { ok: true, next: base, replaced }
}

// ─── INCOME AND EXPENSES, AS CONFIGURED ───────────────────────────────────────

export interface CommissionIncomeRow { agent_commission: number | string | null; close_date: string | null; paid_at: string | null; status: string | null }

/**
 * PURE: the person's commission income in [from, to] on their basis. Cash = paid_at in the window (money received);
 * accrual = close_date in the window (earned at closing; pending / approved / paid). Disputed rows are excluded and
 * reported. `earnedNotPaid` = closed in the window but not paid by its end (the split a cash-basis filer sees later).
 */
export function recognizeCommissionIncome(rows: CommissionIncomeRow[], basis: "cash" | "accrual", window: { from: string; to: string }):
  { recognized: number; earnedNotPaid: number; disputedExcluded: number; rowsCounted: number } {
  let recognized = 0, earnedNotPaid = 0, disputed = 0, counted = 0
  const inWin = (d: string | null) => !!d && d.slice(0, 10) >= window.from && d.slice(0, 10) <= window.to
  for (const r of rows ?? []) {
    const amt = Number(r.agent_commission ?? 0)
    if (!Number.isFinite(amt)) continue
    if (r.status === "disputed") { if (inWin(r.close_date) || inWin(r.paid_at)) disputed += amt; continue }
    if (inWin(r.close_date) && !(r.paid_at && r.paid_at.slice(0, 10) <= window.to)) earnedNotPaid += amt
    const hit = basis === "cash" ? inWin(r.paid_at) : inWin(r.close_date)
    if (hit) { recognized += amt; counted++ }
  }
  return { recognized: round2(recognized), earnedNotPaid: round2(earnedNotPaid), disputedExcluded: round2(disputed), rowsCounted: counted }
}

/**
 * PURE: recorded business expenses split by whether their category is CONFIRMED deductible. Refunds / credits are
 * negative rows and net inside their category. Nothing counts as deductible until confirmed — the unconfirmed amount and
 * its categories are returned so the person sees what confirming would change.
 */
export function sumDeductibleExpenses(
  expenses: Array<{ amount?: number | string | null; category?: string | null }>,
  confirmedCategories: readonly string[] | null,
): { recorded: number; confirmedDeductible: number; unconfirmed: number; unconfirmedCategories: string[] } {
  const confirmed = new Set((confirmedCategories ?? []).map((c) => c.toLowerCase()))
  const byCat = new Map<string, number>()
  for (const e of expenses ?? []) {
    const amt = Number(e.amount ?? 0)
    if (!Number.isFinite(amt)) continue
    const cat = String(e.category ?? "other").toLowerCase() || "other"
    byCat.set(cat, (byCat.get(cat) ?? 0) + amt)
  }
  let recorded = 0, ok = 0, un = 0
  const unCats: string[] = []
  for (const [cat, amt] of byCat) {
    recorded += amt
    if (confirmed.has(cat)) ok += Math.max(0, amt)
    else if (amt > 0) { un += amt; unCats.push(cat) }
  }
  return { recorded: round2(recorded), confirmedDeductible: round2(ok), unconfirmed: round2(un), unconfirmedCategories: unCats.sort() }
}

// ─── DUE DATES (IRS Pub 505: weekend / legal-holiday roll, fiscal years) ──────

const iso = (d: Date) => d.toISOString().slice(0, 10)
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))
function nthWeekday(y: number, m: number, weekday: number, n: number): string {
  const first = utc(y, m, 1)
  const offset = (weekday - first.getUTCDay() + 7) % 7
  return iso(utc(y, m, 1 + offset + (n - 1) * 7))
}
function lastWeekday(y: number, m: number, weekday: number): string {
  const last = utc(y, m + 1, 0)
  const offset = (last.getUTCDay() - weekday + 7) % 7
  return iso(utc(y, m, last.getUTCDate() - offset))
}
function observed(y: number, m: number, d: number): string {
  const day = utc(y, m, d).getUTCDay()
  return iso(day === 6 ? utc(y, m, d - 1) : day === 0 ? utc(y, m, d + 1) : utc(y, m, d))
}

/** The legal holidays (federal + District of Columbia Emancipation Day) observed in a calendar year. */
function legalHolidays(y: number): Set<string> {
  return new Set([
    observed(y, 1, 1), observed(y + 1, 1, 1), nthWeekday(y, 1, 1, 3), nthWeekday(y, 2, 1, 3), observed(y, 4, 16),
    lastWeekday(y, 5, 1), observed(y, 6, 19), observed(y, 7, 4), nthWeekday(y, 9, 1, 1), nthWeekday(y, 10, 1, 2),
    observed(y, 11, 11), nthWeekday(y, 11, 4, 4), observed(y, 12, 25),
  ])
}

/** The next business day on or after `date` (Saturdays, Sundays and legal holidays skipped). */
function rollToBusinessDay(date: string): string {
  let d = new Date(`${date}T00:00:00Z`)
  for (let i = 0; i < 10; i++) {
    const s = iso(d)
    const wd = d.getUTCDay()
    if (wd !== 0 && wd !== 6 && !legalHolidays(d.getUTCFullYear()).has(s)) return s
    d = new Date(d.getTime() + 86_400_000)
  }
  return iso(d)
}

/**
 * PURE: the four estimated-tax due dates of a tax year (Pub 505) — the 15th of the 4th, 6th and 9th months of the tax
 * year and of the month after it ends, each moved to the next business day. `fiscalYearStartMonth` 1 = calendar year
 * (Apr 15 / Jun 15 / Sep 15 / Jan 15). Returns the dates the payments are actually due.
 */
export function quarterlyDueDates(taxYear: number, fiscalYearStartMonth = 1): string[] {
  const start = Math.min(12, Math.max(1, Math.trunc(fiscalYearStartMonth) || 1))
  return [3, 5, 8, 12].map((offset) => {
    const idx = start - 1 + offset
    return rollToBusinessDay(iso(utc(taxYear + Math.floor(idx / 12), (idx % 12) + 1, 15)))
  })
}

/**
 * PURE: the tax year's window — first day, last day, and the period-to-date end (`to` = today, capped at year end).
 * Callers aggregate income and expenses over exactly [from, to] so the plan and its inputs describe the same period.
 */
export function taxYearWindow(taxYear: number, assumptions: Pick<TaxAssumptions, "fiscalYearStartMonth">, today: string): { from: string; to: string; yearEnd: string } {
  const idx = (assumptions.fiscalYearStartMonth?.value ?? 1) - 1
  const from = iso(utc(taxYear + Math.floor(idx / 12), (idx % 12) + 1, 1))
  const yearEnd = iso(new Date(Date.parse(`${iso(utc(taxYear + 1 + Math.floor(idx / 12), (idx % 12) + 1, 1))}T00:00:00Z`) - 86_400_000))
  return { from, to: today < yearEnd ? today : yearEnd, yearEnd }
}

// ─── THE PLAN ─────────────────────────────────────────────────────────────────

export interface RecordedTaxEntry { quarter: number; amount: number; paid_at?: string | null; kind?: "payment" | "set_aside" | null }

export interface QuarterlyEstimate {
  quarter: Quarter
  /** The date the payment is due (rolled per Pub 505, or the person's own schedule). */
  dueDate: string
  dueDateSource: "irs_rule" | "your_schedule"
  /** The suggested reserve for this quarter — null for a quarter already past (history is not recomputed) or when inputs are missing. */
  suggested: number | null
  suggestedSource: "computed" | "accountant" | null
  /** What the person recorded against it (payments + set-asides) — facts, never recomputed. */
  recorded: number
  status: "recorded" | "partly_recorded" | "open" | "past_due_nothing_recorded" | "needs_input"
  /** Kept for the earlier UI contract: true once anything is recorded against this quarter. */
  paid: boolean
}

export interface TaxPlan {
  taxYear: number
  basis: { value: "cash" | "accrual"; chosen: boolean }
  inputs: { status: "ready" | "needs_input"; missing: Array<"federal_rate" | "state_rate">; usingAccountantTargets: boolean; assumptions: TaxAssumptions }
  periodToDate: { from: string; to: string; income: number; recordedExpenses: number; confirmedDeductible: number; unconfirmedDeductible: number; unconfirmedCategories: string[]; net: number; isLoss: boolean; earnedNotPaid: number; disputedExcluded: number }
  projectedAnnualNetIncome: number
  /** Null when inputs are missing — no reserve is quoted from a rate nobody entered. */
  reserve: { selfEmploymentTax: SelfEmploymentTax; selfEmploymentSource: "statutory" | "your_rate"; incomeTaxReserve: number; otherReserve: number; projectedAnnualReserve: number } | null
  alreadySetAsideOrPaid: number
  remainingSuggestedReserve: number | null
  quarterly: QuarterlyEstimate[]
  flags: string[]
  /** Always shown with the numbers. */
  disclaimer: string
}

const DISCLAIMER = "A cash-planning reserve from your recorded numbers and the rates you entered — not the amount legally due, and not tax advice. Your tax professional confirms what you owe."

/**
 * PURE: per-quarter suggestions. Quarters already past are history (their recorded amounts stand, no suggestion is
 * recomputed). Each remaining quarter takes its accountant target when one is entered; the rest share what is left of
 * the projected reserve after everything already recorded and those targets.
 */
export function computeQuarterlyEstimates(input: {
  dueDates: Array<{ quarter: Quarter; dueDate: string; source: "irs_rule" | "your_schedule" }>
  today: string
  projectedAnnualReserve: number | null
  alreadyRecorded: number
  recordedByQuarter: Record<number, number>
  accountantTargets: Partial<Record<Quarter, number>>
}): { quarters: QuarterlyEstimate[]; remainingSuggested: number | null } {
  const remaining = input.dueDates.filter((d) => d.dueDate >= input.today)
  const targetedRemaining = remaining.filter((d) => input.accountantTargets[d.quarter] != null)
  const untargeted = remaining.filter((d) => input.accountantTargets[d.quarter] == null)
  const targetOpen = targetedRemaining.reduce((s, d) => s + Math.max(0, (input.accountantTargets[d.quarter] ?? 0) - (input.recordedByQuarter[d.quarter] ?? 0)), 0)
  const pool = input.projectedAnnualReserve == null ? null : Math.max(0, input.projectedAnnualReserve - input.alreadyRecorded - targetOpen)
  const per = pool == null || untargeted.length === 0 ? null : round2(pool / untargeted.length)
  const quarters = input.dueDates.map((d) => {
    const rec = round2(input.recordedByQuarter[d.quarter] ?? 0)
    const past = d.dueDate < input.today
    const target = input.accountantTargets[d.quarter]
    const suggested = past ? null : target != null ? round2(Math.max(0, target - rec)) : per
    const source: QuarterlyEstimate["suggestedSource"] = past ? null : target != null ? "accountant" : per != null ? "computed" : null
    const status: QuarterlyEstimate["status"] = past
      ? (rec > 0 ? "recorded" : "past_due_nothing_recorded")
      : suggested == null ? "needs_input" : rec > 0 && suggested <= 0.005 ? "recorded" : rec > 0 ? "partly_recorded" : "open"
    return { quarter: d.quarter, dueDate: d.dueDate, dueDateSource: d.source, suggested, suggestedSource: source, recorded: rec, status, paid: rec > 0 }
  })
  const unmet = untargeted.length > 0 && per == null
  const remainingSuggested = unmet ? null : round2(targetOpen + (pool ?? 0) * (untargeted.length > 0 ? 1 : 0))
  return { quarters, remainingSuggested }
}

/**
 * PURE: THE estimated-tax plan. Callers aggregate the person's own recorded facts with recognizeCommissionIncome and
 * sumDeductibleExpenses (this file) and pass them in; nothing here reads a database or invents a rate.
 */
export function buildTaxPlan(input: {
  taxYear: number
  today: string
  assumptions: TaxAssumptions
  income: { recognized: number; earnedNotPaid: number; disputedExcluded: number }
  expenses: { recorded: number; confirmedDeductible: number; unconfirmed: number; unconfirmedCategories: string[] }
  recorded: RecordedTaxEntry[]
  socialSecurityWageBase?: number | null
}): TaxPlan {
  const a = input.assumptions
  const fyStart = a.fiscalYearStartMonth?.value ?? 1
  const statutory = quarterlyDueDates(input.taxYear, fyStart)
  const dueDates = ([1, 2, 3, 4] as const).map((q) => {
    const o = a.dueDateOverrides[q]
    return { quarter: q, dueDate: o ? o.value : statutory[q - 1], source: (o ? "your_schedule" : "irs_rule") as "irs_rule" | "your_schedule" }
  })
  const { from, to, yearEnd } = taxYearWindow(input.taxYear, a, input.today)
  const net = round2(input.income.recognized - input.expenses.confirmedDeductible)
  const isLoss = net < 0
  const elapsed = Math.min(1, Math.max(0.01, (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) + 86_400_000) / (Date.parse(`${yearEnd}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) + 86_400_000)))
  const projectedAnnualNet = isLoss ? 0 : round2(net / elapsed)

  const remainingQuarters = dueDates.filter((d) => d.dueDate >= input.today).map((d) => d.quarter)
  const targets: Partial<Record<Quarter, number>> = {}
  for (const q of [1, 2, 3, 4] as const) if (a.accountantTargets[q]) targets[q] = a.accountantTargets[q]!.value
  const allRemainingTargeted = remainingQuarters.length > 0 && remainingQuarters.every((q) => targets[q] != null)
  const missing: Array<"federal_rate" | "state_rate"> = []
  if (!a.federalRate) missing.push("federal_rate")
  if (!a.stateRate) missing.push("state_rate")
  const ratesReady = missing.length === 0
  const ready = ratesReady || allRemainingTargeted

  let reserve: TaxPlan["reserve"] = null
  if (ratesReady) {
    const se = a.selfEmploymentRate
      ? { taxableBase: projectedAnnualNet, socialSecurity: 0, medicare: 0, total: round2(projectedAnnualNet * a.selfEmploymentRate.value) }
      : computeSelfEmploymentTax({ netSelfEmploymentIncome: projectedAnnualNet, socialSecurityWageBase: input.socialSecurityWageBase })
    const incomeBase = Math.max(0, projectedAnnualNet - se.total / 2)
    const incomeTaxReserve = round2(incomeBase * (a.federalRate!.value + a.stateRate!.value))
    const otherReserve = round2(projectedAnnualNet * (a.otherReserveRate?.value ?? 0))
    reserve = { selfEmploymentTax: se, selfEmploymentSource: a.selfEmploymentRate ? "your_rate" : "statutory", incomeTaxReserve, otherReserve, projectedAnnualReserve: round2(se.total + incomeTaxReserve + otherReserve) }
  }

  const recordedByQuarter: Record<number, number> = {}
  let already = 0
  for (const e of input.recorded ?? []) {
    const amt = Math.max(0, Number(e.amount) || 0)
    if (![1, 2, 3, 4].includes(Number(e.quarter))) continue
    recordedByQuarter[e.quarter] = (recordedByQuarter[e.quarter] ?? 0) + amt
    already += amt
  }
  const q = computeQuarterlyEstimates({ dueDates, today: input.today, projectedAnnualReserve: reserve?.projectedAnnualReserve ?? null, alreadyRecorded: round2(already), recordedByQuarter, accountantTargets: targets })

  const flags: string[] = []
  if (!ready) flags.push(`Enter your ${missing.map((m) => (m === "federal_rate" ? "federal" : "state")).join(" and ")} estimated tax rate${missing.length > 1 ? "s" : ""} (or your accountant's quarterly amounts) to see a reserve. This planner never guesses a personal tax rate.`)
  if (!a.incomeBasis) flags.push("Income is shown when it was received (cash basis), the usual for individual agents. Choose accrual if your accountant keeps your books that way.")
  if (input.expenses.unconfirmed > 0) flags.push(`${usdPlain(input.expenses.unconfirmed)} of recorded expenses (${input.expenses.unconfirmedCategories.join(", ")}) are not yet confirmed deductible, so they do not reduce this estimate. Confirm the categories that apply.`)
  if (isLoss) flags.push("Your recorded expenses exceed your income so far, so no reserve is suggested. Whether a loss carries forward is a question for your tax professional.")
  if (input.income.disputedExcluded > 0) flags.push(`${usdPlain(input.income.disputedExcluded)} of disputed commission is left out until the dispute is resolved.`)
  if (input.income.earnedNotPaid > 0 && (a.incomeBasis?.value ?? "cash") === "cash") flags.push(`${usdPlain(input.income.earnedNotPaid)} closed but not yet paid is not counted until it is received.`)

  return {
    taxYear: input.taxYear,
    basis: { value: a.incomeBasis?.value ?? "cash", chosen: !!a.incomeBasis },
    inputs: { status: ready ? "ready" : "needs_input", missing, usingAccountantTargets: Object.keys(targets).length > 0, assumptions: a },
    periodToDate: {
      from, to, income: round2(input.income.recognized), recordedExpenses: round2(input.expenses.recorded), confirmedDeductible: round2(input.expenses.confirmedDeductible),
      unconfirmedDeductible: round2(input.expenses.unconfirmed), unconfirmedCategories: input.expenses.unconfirmedCategories, net, isLoss,
      earnedNotPaid: round2(input.income.earnedNotPaid), disputedExcluded: round2(input.income.disputedExcluded),
    },
    projectedAnnualNetIncome: projectedAnnualNet,
    reserve,
    alreadySetAsideOrPaid: round2(already),
    remainingSuggestedReserve: ready ? q.remainingSuggested : null,
    quarterly: q.quarters,
    flags,
    disclaimer: DISCLAIMER,
  }
}

function usdPlain(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)
}
function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100
}
