// lib/calculators/engine.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE CALCULATOR MATH ENGINE (wave 156, lane 156H — owner: "the calculators would be a great lead magnet or added
// asset to the website"). A calculator is an ARTIFACT (like a guide, a flyer or a video), never a channel.
//
// PURE, DETERMINISTIC, NO I/O. The same function runs in the browser (the public calculator on the tenant website, a landing
// page, a QR scan — one route, one component), on the server (the recorded calculation, the opt-in recompute), and behind the
// signed-in seller net sheet. Same inputs → byte-identical result.
//
// THE RULES IT ENFORCES (directive 156H; CLAUDE.md §5):
//   1. NO INVENTED PERCENTAGE. There is no rate literal in this file: every rate a result uses is an input the person typed
//      or a cited statute from lib/calculators/rate-sources.ts selected by jurisdiction. A required value that is missing
//      returns `{ ok: false, missing: [{ message: "Enter a value…" }] }` — never a silent default.
//   2. EXPLICIT. Every result carries `assumptions` (each with its basis: you entered it, you marked it an estimate, a cited
//      source with its URL and the date read, the brokerage's agreement, or "not included"), the `period` it covers, and
//      `disclaimers`. An optional cost left blank is listed as "not included", never zero-filled silently.
//   3. EXTREMES ARE REFUSED OR COMPUTED, NEVER NaN. Negative → refused. Non-numeric → refused. Above the supported range →
//      refused. Zero is computed (a 0% rate amortizes linearly; a $0 price nets $0). Every output is checked finite.
//   4. TWO AUDIENCES, ONE ENGINE. `audience: "internal"` may carry the brokerage's agreed commission (an authorized seat only —
//      resolved by the caller from the SESSION, lib/calculators/artifact.ts computeInternalSellerNet). `audience: "public"`
//      REFUSES it outright: a public estimate never contains an internal commission term.
//   5. Buyer affordability is never presented as lender preapproval; the 1031 calculator is an educational timeline, not
//      individualized legal or tax eligibility.

import { applyPerUnitRule, citedSourceFor, type CitedRateSource } from "./rate-sources"

export const CALCULATOR_ENGINE_VERSION = "156H.1"

export const CALCULATOR_KINDS = [
  "seller_net_sheet",
  "buyer_payment",
  "affordability_range",
  "buy_vs_rent",
  "refinance_break_even",
  "equity_proceeds",
  "closing_cost_estimate",
  "exchange_1031_timeline",
  "investor_cash_flow",
  "marketing_roi",
  "relocation_budget",
  "carry_cost",
] as const
export type CalculatorKind = (typeof CALCULATOR_KINDS)[number]

export type FieldKind = "money" | "percent" | "years" | "months" | "count" | "date" | "choice"

export interface FieldSpec {
  key: string
  label: string
  kind: FieldKind
  /** true = must be entered; "group" = at least one field of `group` must be entered; false = optional ("not included" when blank). */
  required: boolean | "group"
  group?: string
  options?: readonly string[]
  help?: string
}

/** Which side of the business a calculator speaks to — decides the follow-on manager (lib/calculators/artifact.ts). */
export type CalculatorSide = "seller" | "buyer" | "owner" | "investor" | "business" | "relocation"

export interface CalculatorSpec {
  kind: CalculatorKind
  title: string
  side: CalculatorSide
  period: string
  fields: readonly FieldSpec[]
  /** The group labels a "group" requirement reports when nothing in the group was entered. */
  groups?: Record<string, string>
}

// ── supported range (bounds, not rates) ──────────────────────────────────────
export const LIMITS = Object.freeze({ money: 100_000_000_000, percent: 100, years: 50, months: 600, count: 1_000_000_000 })

const money = (key: string, label: string, required: FieldSpec["required"] = true, extra: Partial<FieldSpec> = {}): FieldSpec => ({ key, label, kind: "money", required, ...extra })
const pct = (key: string, label: string, required: FieldSpec["required"] = true, extra: Partial<FieldSpec> = {}): FieldSpec => ({ key, label, kind: "percent", required, ...extra })

const PROPERTY_TAX_GROUP: readonly FieldSpec[] = [
  money("annualPropertyTax", "Annual property tax ($ — from the tax bill)", "group", { group: "property_tax" }),
  pct("propertyTaxRatePct", "Property-tax rate (% of price per year — from your county)", "group", { group: "property_tax" }),
]
const LOAN_FIELDS: readonly FieldSpec[] = [
  pct("ratePct", "Interest rate (% per year — your lender's quote)"),
  { key: "termYears", label: "Loan term (years)", kind: "years", required: true },
]
const TRANSFER_TAX_FIELDS: readonly FieldSpec[] = [
  { key: "includeTransferTax", label: "Include a transfer tax?", kind: "choice", options: ["yes", "no"], required: true },
  money("transferTaxAmount", "Transfer tax ($ — leave blank to use the cited statute for the chosen jurisdiction)", false),
]

export const CALCULATOR_SPECS: Readonly<Record<CalculatorKind, CalculatorSpec>> = Object.freeze({
  seller_net_sheet: {
    kind: "seller_net_sheet", title: "Seller estimated net sheet", side: "seller", period: "One time, at closing",
    groups: { listing_commission: "the listing commission you agreed to (a % or a $ amount)" },
    fields: [
      money("salePrice", "Expected sale price"),
      money("mortgagePayoff", "Mortgage payoff (enter 0 if none)"),
      pct("listingCommissionPct", "Listing commission (% of price — from your listing agreement)", "group", { group: "listing_commission" }),
      money("listingCommissionAmount", "Listing commission ($ — a flat fee instead of a %)", "group", { group: "listing_commission" }),
      pct("buyerBrokerCompPct", "Buyer-broker compensation you agree to pay (% — optional)", false),
      money("buyerBrokerCompAmount", "Buyer-broker compensation you agree to pay ($ — optional)", false),
      money("titleEscrowFees", "Title, escrow and settlement charges (from a quote)"),
      ...TRANSFER_TAX_FIELDS,
      money("otherLiens", "Other liens to pay off", false),
      money("sellerConcessions", "Concessions / credits to the buyer", false),
      money("repairCredits", "Repairs or repair credits", false),
      money("proratedPropertyTax", "Prorated property tax owed at closing", false),
      money("hoaAtClosing", "HOA dues / transfer fees at closing", false),
      money("otherCosts", "Other costs", false),
    ],
  },
  buyer_payment: {
    kind: "buyer_payment", title: "Monthly payment estimate", side: "buyer", period: "Per month",
    groups: { property_tax: "the annual property tax or the property-tax rate" },
    fields: [
      money("price", "Purchase price"),
      money("downPayment", "Down payment ($)"),
      ...LOAN_FIELDS,
      ...PROPERTY_TAX_GROUP,
      money("annualInsurance", "Homeowners insurance per year (from a quote)"),
      money("hoaMonthly", "HOA dues per month", false),
      money("mortgageInsuranceMonthly", "Mortgage insurance per month (from your lender)", false),
    ],
  },
  affordability_range: {
    kind: "affordability_range", title: "Affordability range", side: "buyer", period: "Per month (budget) and purchase price (range)",
    groups: { property_tax: "the annual property tax or the property-tax rate" },
    fields: [
      money("grossMonthlyIncome", "Gross monthly income"),
      money("monthlyDebts", "Monthly debt payments (enter 0 if none)"),
      money("downPayment", "Down payment available ($)"),
      ...LOAN_FIELDS,
      ...PROPERTY_TAX_GROUP,
      money("annualInsurance", "Homeowners insurance per year (estimate)"),
      money("hoaMonthly", "HOA dues per month", false),
      pct("housingRatioPct", "Housing-payment limit (% of gross income — ask your lender which applies)"),
      pct("totalDebtRatioPct", "Total-debt limit (% of gross income — ask your lender which applies)"),
    ],
  },
  buy_vs_rent: {
    kind: "buy_vs_rent", title: "Buy versus rent", side: "buyer", period: "Over the number of years you enter",
    groups: { property_tax: "the annual property tax or the property-tax rate" },
    fields: [
      money("monthlyRent", "Current monthly rent"),
      pct("rentIncreasePct", "Expected yearly rent increase (%)"),
      money("homePrice", "Home price"),
      money("downPayment", "Down payment ($)"),
      ...LOAN_FIELDS,
      ...PROPERTY_TAX_GROUP,
      money("annualInsurance", "Homeowners insurance per year"),
      money("annualMaintenance", "Maintenance budget per year ($)"),
      money("hoaMonthly", "HOA dues per month", false),
      money("buyingClosingCosts", "Your closing costs to buy ($)"),
      pct("appreciationPct", "Expected yearly home-value change (%)"),
      pct("sellingCostPct", "Cost to sell at the end (% of value)"),
      { key: "years", label: "Years you plan to stay", kind: "years", required: true },
      pct("investmentReturnPct", "Yearly return if you invested the cash instead (%, optional)", false),
    ],
  },
  refinance_break_even: {
    kind: "refinance_break_even", title: "Refinance break-even", side: "owner", period: "Months until the costs are recovered",
    fields: [
      money("currentBalance", "Current loan balance"),
      pct("currentRatePct", "Current interest rate (%)"),
      { key: "remainingMonths", label: "Months left on the current loan", kind: "months", required: true },
      pct("newRatePct", "New interest rate (% — your lender's quote)"),
      { key: "newTermMonths", label: "New loan term (months)", kind: "months", required: true },
      money("refinanceCosts", "Refinance closing costs ($)"),
    ],
  },
  equity_proceeds: {
    kind: "equity_proceeds", title: "Equity and estimated proceeds", side: "seller", period: "Today, if sold at the value you enter",
    groups: { selling_costs: "the cost to sell (a % or a $ amount)" },
    fields: [
      money("estimatedValue", "Your estimate of the home's value"),
      money("mortgageBalance", "Mortgage balance (enter 0 if none)"),
      money("otherLiens", "Other liens / home-equity loans", false),
      pct("sellingCostPct", "Cost to sell (% of value)", "group", { group: "selling_costs" }),
      money("sellingCostAmount", "Cost to sell ($)", "group", { group: "selling_costs" }),
    ],
  },
  closing_cost_estimate: {
    kind: "closing_cost_estimate", title: "Closing-cost estimator", side: "buyer", period: "One time, at closing",
    fields: [
      { key: "side", label: "Are you buying or selling?", kind: "choice", options: ["buyer", "seller"], required: true },
      money("price", "Price"),
      money("lenderFees", "Lender fees (from your Loan Estimate)", false),
      money("titleInsurance", "Title insurance (from a quote)", false),
      money("settlementFees", "Escrow / settlement / attorney fees", false),
      money("recordingFees", "Recording fees", false),
      money("prepaidsEscrows", "Prepaid interest, taxes and insurance", false),
      money("inspections", "Inspections and appraisal", false),
      money("otherCosts", "Other costs", false),
      ...TRANSFER_TAX_FIELDS,
    ],
  },
  exchange_1031_timeline: {
    kind: "exchange_1031_timeline", title: "1031 exchange timeline (educational)", side: "investor", period: "Calendar days from the transfer of the property you sell",
    fields: [
      { key: "relinquishedTransferDate", label: "Date the property you sell transfers (YYYY-MM-DD)", kind: "date", required: true },
      { key: "returnDueDate", label: "Your tax return due date with extensions (YYYY-MM-DD, optional)", kind: "date", required: false },
    ],
  },
  investor_cash_flow: {
    kind: "investor_cash_flow", title: "Investor cap-rate and cash-flow worksheet", side: "investor", period: "Per year (and per month)",
    groups: { property_tax: "the annual property tax or the property-tax rate", maintenance: "maintenance (a % of rent or a $ amount per month)" },
    fields: [
      money("purchasePrice", "Purchase price"),
      money("downPayment", "Down payment ($)"),
      ...LOAN_FIELDS,
      money("closingCosts", "Closing and rehab costs paid in cash", false),
      money("monthlyRent", "Monthly rent"),
      pct("vacancyPct", "Vacancy (% of the year)"),
      ...PROPERTY_TAX_GROUP,
      money("annualInsurance", "Insurance per year"),
      money("hoaMonthly", "HOA dues per month", false),
      pct("maintenancePctOfRent", "Maintenance (% of rent)", "group", { group: "maintenance" }),
      money("maintenanceMonthly", "Maintenance ($ per month)", "group", { group: "maintenance" }),
      pct("managementPctOfRent", "Property management (% of rent)", false),
      money("otherMonthly", "Other expenses per month", false),
    ],
  },
  marketing_roi: {
    kind: "marketing_roi", title: "Marketing ROI", side: "business", period: "For the campaign period you enter figures for",
    groups: { conversion: "closings, or the lead-to-closing conversion rate" },
    fields: [
      money("spend", "Marketing spend"),
      { key: "leads", label: "Leads generated", kind: "count", required: true },
      { key: "closings", label: "Closings from those leads", kind: "count", required: "group", group: "conversion" },
      pct("conversionPct", "Lead-to-closing conversion (%)", "group", { group: "conversion" }),
      money("revenuePerClosing", "Your revenue per closing ($)"),
    ],
  },
  relocation_budget: {
    kind: "relocation_budget", title: "Relocation budget", side: "relocation", period: "One time (plus the months you enter)",
    fields: [
      money("movers", "Movers or truck (from quotes)", false),
      money("packing", "Packing supplies", false),
      money("travel", "Travel", false),
      money("temporaryHousingMonthly", "Temporary housing per month", false),
      { key: "temporaryHousingMonths", label: "Months of temporary housing", kind: "months", required: false },
      money("storageMonthly", "Storage per month", false),
      { key: "storageMonths", label: "Months of storage", kind: "months", required: false },
      money("deposits", "Deposits (rent, utilities)", false),
      money("utilitiesSetup", "Utility connection fees", false),
      money("otherCosts", "Other costs", false),
    ],
  },
  carry_cost: {
    kind: "carry_cost", title: "Property-tax and insurance carry cost", side: "owner", period: "Per month, and over the months you enter",
    fields: [
      money("annualPropertyTax", "Annual property tax (from the tax bill)"),
      money("annualInsurance", "Insurance per year"),
      money("hoaMonthly", "HOA dues per month", false),
      money("utilitiesMonthly", "Utilities per month", false),
      money("maintenanceMonthly", "Maintenance per month", false),
      money("mortgagePaymentMonthly", "Mortgage payment per month", false),
      { key: "months", label: "Months to carry the property", kind: "months", required: true },
    ],
  },
})

// ── result contract ──────────────────────────────────────────────────────────
export type AssumptionBasis = "you_entered" | "you_entered_estimate" | "cited_source" | "brokerage_agreement" | "not_included"
export interface Assumption {
  key: string
  label: string
  display: string
  basis: AssumptionBasis
  source?: { citation: string; url: string; retrievedOn: string; caveats: string }
}
export interface ResultLine { key: string; label: string; amount: number }
export type OutputValue = number | string | null
export interface CalculatorResult {
  ok: true
  kind: CalculatorKind
  title: string
  audience: CalculatorAudience
  period: string
  headline: { label: string; value: OutputValue; unit: "usd" | "months" | "years" | "percent" | "date" | "text" }
  outputs: Record<string, OutputValue>
  lines: ResultLine[]
  assumptions: Assumption[]
  notes: string[]
  disclaimers: string[]
  engineVersion: string
}
export interface CalculatorRefusal {
  ok: false
  kind: CalculatorKind | string
  missing: Array<{ key: string; label: string; message: string }>
  refused: Array<{ key: string; label: string; reason: string }>
}
export type CalculatorOutcome = CalculatorResult | CalculatorRefusal

export type CalculatorAudience = "public" | "internal"

/** The brokerage's agreed listing commission — INTERNAL audience only, resolved from the session by the caller. */
export interface AgreedCommission { listingRatePct: number | null; flatAmount: number | null; label: string }

export interface CalculatorContext {
  audience: CalculatorAudience
  /** "US-FL" etc. — selects a cited statute; null → the person enters every figure. */
  jurisdiction?: string | null
  agreedCommission?: AgreedCommission | null
  /** Input keys the person marked as estimates. */
  estimateKeys?: readonly string[]
}

export const DISCLAIMERS = Object.freeze({
  general: "Educational estimate only, built from the figures shown under Assumptions. It is not an appraisal, a loan offer, or legal, tax or financial advice; actual figures come from your contract, your lender and your settlement statement.",
  notPreapproval: "This is not a lender preapproval, a prequalification or a commitment to lend. Only a lender can tell you what you qualify for.",
  legalTax: "Educational timeline only — not individualized legal or tax advice. Whether a sale qualifies for a 1031 exchange, and how the deadlines apply to it, is a question for a qualified intermediary and your tax adviser.",
  investment: "Not investment advice. Rent, vacancy, expenses and value change; verify every figure before you rely on it.",
  equalHousing: "Equal Housing Opportunity.",
})

// ── validation ───────────────────────────────────────────────────────────────
type Values = Record<string, number | string>

function readNumber(raw: unknown): number | "blank" | "nan" {
  if (raw === null || raw === undefined) return "blank"
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : "nan"
  if (typeof raw === "string") {
    const t = raw.trim().replace(/[$,\s]/g, "")
    if (!t) return "blank"
    if (!/^-?\d+(\.\d+)?$/.test(t)) return "nan"
    return Number(t)
  }
  return "nan"
}
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
function readDate(raw: unknown): string | "blank" | "bad" {
  if (raw === null || raw === undefined || (typeof raw === "string" && !raw.trim())) return "blank"
  if (typeof raw !== "string") return "bad"
  const m = DATE_RE.exec(raw.trim())
  if (!m) return "bad"
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const d = new Date(t)
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return "bad"
  return raw.trim()
}

/** PURE. Validate every input against its spec. Missing required → "Enter a value"; negative / non-numeric / out of range → refused. */
export function validateCalculatorInputs(spec: CalculatorSpec, inputs: Record<string, unknown>, skipRequired: ReadonlySet<string> = new Set()): { values: Values; missing: CalculatorRefusal["missing"]; refused: CalculatorRefusal["refused"] } {
  const values: Values = {}
  const missing: CalculatorRefusal["missing"] = []
  const refused: CalculatorRefusal["refused"] = []
  const src = inputs && typeof inputs === "object" ? inputs : {}
  for (const f of spec.fields) {
    const raw = (src as Record<string, unknown>)[f.key]
    if (f.kind === "choice") {
      const v = typeof raw === "string" ? raw.trim().toLowerCase() : ""
      if (!v) { if (f.required === true && !skipRequired.has(f.key)) missing.push({ key: f.key, label: f.label, message: `Enter a value: ${f.label}` }); continue }
      if (!(f.options ?? []).includes(v)) { refused.push({ key: f.key, label: f.label, reason: `choose one of: ${(f.options ?? []).join(", ")}` }); continue }
      values[f.key] = v
      continue
    }
    if (f.kind === "date") {
      const d = readDate(raw)
      if (d === "blank") { if (f.required === true && !skipRequired.has(f.key)) missing.push({ key: f.key, label: f.label, message: `Enter a value: ${f.label}` }); continue }
      if (d === "bad") { refused.push({ key: f.key, label: f.label, reason: "not a real calendar date (YYYY-MM-DD)" }); continue }
      values[f.key] = d
      continue
    }
    const n = readNumber(raw)
    if (n === "blank") { if (f.required === true && !skipRequired.has(f.key)) missing.push({ key: f.key, label: f.label, message: `Enter a value: ${f.label}` }); continue }
    if (n === "nan") { refused.push({ key: f.key, label: f.label, reason: "not a number" }); continue }
    if (n < 0) { refused.push({ key: f.key, label: f.label, reason: "cannot be negative" }); continue }
    const max = f.kind === "money" ? LIMITS.money : f.kind === "percent" ? LIMITS.percent : f.kind === "years" ? LIMITS.years : f.kind === "months" ? LIMITS.months : LIMITS.count
    if (n > max) { refused.push({ key: f.key, label: f.label, reason: `above the supported maximum (${max.toLocaleString("en-US")})` }); continue }
    if ((f.kind === "count" || f.kind === "months") && !Number.isInteger(n)) { refused.push({ key: f.key, label: f.label, reason: "must be a whole number" }); continue }
    values[f.key] = n
  }
  const groups = new Map<string, FieldSpec[]>()
  for (const f of spec.fields) if (f.required === "group" && f.group) groups.set(f.group, [...(groups.get(f.group) ?? []), f])
  for (const [g, fs] of groups) {
    if (fs.some((f) => skipRequired.has(f.key))) continue
    if (fs.some((f) => f.key in values) || fs.some((f) => refused.some((r) => r.key === f.key))) continue
    const label = spec.groups?.[g] ?? fs.map((f) => f.label).join(" or ")
    missing.push({ key: g, label, message: `Enter a value: ${label}` })
  }
  return { values, missing, refused }
}

// ── math helpers (pure) ──────────────────────────────────────────────────────
const cents = (n: number) => Math.round(n * 100) / 100
const usd = (n: number) => `$${cents(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** Monthly principal + interest. A 0% rate amortizes linearly. Stable at very long terms (no (1+r)^n overflow path). */
export function monthlyPrincipalInterest(loan: number, ratePct: number, months: number): number {
  if (!(loan > 0) || !(months > 0)) return 0
  const r = ratePct / 100 / 12
  if (r === 0) return loan / months
  return (loan * r) / (1 - Math.pow(1 + r, -months))
}
/** Balance after k payments of the level payment above. */
export function balanceAfter(loan: number, ratePct: number, months: number, k: number): number {
  if (!(loan > 0) || !(months > 0)) return 0
  const paid = Math.min(Math.max(0, k), months)
  if (paid >= months) return 0
  const r = ratePct / 100 / 12
  const pmt = monthlyPrincipalInterest(loan, ratePct, months)
  if (r === 0) return Math.max(0, loan - pmt * paid)
  const g = Math.pow(1 + r, paid)
  return Math.max(0, loan * g - (pmt * (g - 1)) / r)
}
function addDaysIso(iso: string, days: number): string {
  const m = DATE_RE.exec(iso)!
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + days * 86_400_000
  return new Date(t).toISOString().slice(0, 10)
}

// ── assumption builder ───────────────────────────────────────────────────────
function assumptionsFor(spec: CalculatorSpec, values: Values, ctx: CalculatorContext, skip: ReadonlySet<string> = new Set()): Assumption[] {
  const est = new Set(ctx.estimateKeys ?? [])
  const out: Assumption[] = []
  for (const f of spec.fields) {
    if (skip.has(f.key)) continue
    if (f.key in values) {
      const v = values[f.key]
      const display = typeof v === "string" ? v : f.kind === "money" ? usd(v) : f.kind === "percent" ? `${v}%` : `${v} ${f.kind === "years" ? "years" : f.kind === "months" ? "months" : ""}`.trim()
      out.push({ key: f.key, label: f.label, display, basis: est.has(f.key) ? "you_entered_estimate" : "you_entered" })
    } else if (f.required !== true) {
      out.push({ key: f.key, label: f.label, display: "not included", basis: "not_included" })
    }
  }
  return out
}
const sourceOf = (s: CitedRateSource): Assumption["source"] => ({ citation: s.citation, url: s.url, retrievedOn: s.retrievedOn, caveats: s.caveats })

function finiteOr(outputs: Record<string, OutputValue>, lines: ResultLine[]): string | null {
  for (const [k, v] of Object.entries(outputs)) if (typeof v === "number" && !Number.isFinite(v)) return k
  for (const l of lines) if (!Number.isFinite(l.amount)) return l.key
  return null
}

/** Transfer tax: entered amount, else the cited statute for the jurisdiction, else "enter a value". */
function transferTax(values: Values, ctx: CalculatorContext, consideration: number): { amount: number; assumption: Assumption } | { missing: CalculatorRefusal["missing"][number] } | null {
  if (values.includeTransferTax !== "yes") return null
  if (typeof values.transferTaxAmount === "number") {
    return { amount: values.transferTaxAmount, assumption: { key: "transferTax", label: "Transfer tax", display: usd(values.transferTaxAmount), basis: (ctx.estimateKeys ?? []).includes("transferTaxAmount") ? "you_entered_estimate" : "you_entered" } }
  }
  const s = citedSourceFor("transfer_tax", ctx.jurisdiction ?? null)
  if (!s || s.rule.kind !== "per_unit_ceil") {
    return { missing: { key: "transferTaxAmount", label: "Transfer tax", message: `Enter a value: transfer tax — there is no verified statute for ${ctx.jurisdiction ? String(ctx.jurisdiction) : "this calculator's jurisdiction"} (enter 0 if none applies)` } }
  }
  const amount = applyPerUnitRule(s.rule, consideration)
  return { amount, assumption: { key: "transferTax", label: s.label, display: `${usd(amount)} (${s.rule.amountPerUnit} per ${s.rule.unit} or part)`, basis: "cited_source", source: sourceOf(s) } }
}

function refusal(kind: CalculatorKind | string, missing: CalculatorRefusal["missing"], refused: CalculatorRefusal["refused"]): CalculatorRefusal {
  return { ok: false, kind, missing, refused }
}

const num = (v: Values, k: string): number => (typeof v[k] === "number" ? (v[k] as number) : 0)
const has = (v: Values, k: string): boolean => typeof v[k] === "number"

/**
 * THE ENGINE. PURE. kind + inputs + context → a result with its assumptions, period and disclaimers, or a refusal that
 * names what is missing ("Enter a value…") and what was refused (negative, non-numeric, out of range, an internal term on
 * a public estimate).
 */
export function runCalculator(kind: string, inputs: Record<string, unknown>, ctx: CalculatorContext): CalculatorOutcome {
  if (!(CALCULATOR_KINDS as readonly string[]).includes(kind)) return refusal(kind, [], [{ key: "kind", label: "Calculator", reason: "unknown calculator" }])
  const spec = CALCULATOR_SPECS[kind as CalculatorKind]
  const audience: CalculatorAudience = ctx.audience === "internal" ? "internal" : "public"
  if (audience === "public" && ctx.agreedCommission) {
    return refusal(kind, [], [{ key: "agreedCommission", label: "Brokerage commission terms", reason: "internal commission terms never enter a public estimate" }])
  }
  const agreed = audience === "internal" && kind === "seller_net_sheet" ? ctx.agreedCommission ?? null : null
  if (agreed && !(typeof agreed.flatAmount === "number" && agreed.flatAmount >= 0) && !(typeof agreed.listingRatePct === "number" && agreed.listingRatePct >= 0 && agreed.listingRatePct <= LIMITS.percent)) {
    return refusal(kind, [], [{ key: "agreedCommission", label: "Brokerage commission terms", reason: "the brokerage's agreement carries no usable listing commission" }])
  }
  const skip = new Set<string>(agreed ? ["listingCommissionPct", "listingCommissionAmount"] : [])
  const { values, missing, refused } = validateCalculatorInputs(spec, inputs, skip)
  if (missing.length || refused.length) return refusal(kind, missing, refused)

  const assumptions = assumptionsFor(spec, values, ctx, skip)
  const disclaimers: string[] = [DISCLAIMERS.general]
  const notes: string[] = []
  let outputs: Record<string, OutputValue> = {}
  let lines: ResultLine[] = []
  let headline!: CalculatorResult["headline"]
  const extraMissing: CalculatorRefusal["missing"] = []
  const extraRefused: CalculatorRefusal["refused"] = []

  const taxMonthlyFor = (price: number) => (has(values, "annualPropertyTax") ? num(values, "annualPropertyTax") / 12 : (price * num(values, "propertyTaxRatePct")) / 100 / 12)

  switch (spec.kind) {
    case "seller_net_sheet": {
      const price = num(values, "salePrice")
      const listing = agreed
        ? (typeof agreed.flatAmount === "number" ? agreed.flatAmount : (price * (agreed.listingRatePct as number)) / 100)
        : has(values, "listingCommissionAmount") ? num(values, "listingCommissionAmount") : (price * num(values, "listingCommissionPct")) / 100
      if (agreed) assumptions.unshift({ key: "listingCommission", label: "Listing commission", display: agreed.label, basis: "brokerage_agreement" })
      const buyerSide = has(values, "buyerBrokerCompAmount") ? num(values, "buyerBrokerCompAmount") : (price * num(values, "buyerBrokerCompPct")) / 100
      const tt = transferTax(values, ctx, price)
      if (tt && "missing" in tt) { extraMissing.push(tt.missing); break }
      if (tt) assumptions.push(tt.assumption)
      lines = [
        { key: "mortgagePayoff", label: "Mortgage payoff", amount: num(values, "mortgagePayoff") },
        { key: "otherLiens", label: "Other liens", amount: num(values, "otherLiens") },
        { key: "listingCommission", label: "Listing commission", amount: listing },
        { key: "buyerBrokerComp", label: "Buyer-broker compensation", amount: buyerSide },
        { key: "titleEscrowFees", label: "Title, escrow and settlement", amount: num(values, "titleEscrowFees") },
        { key: "transferTax", label: "Transfer tax", amount: tt ? tt.amount : 0 },
        { key: "sellerConcessions", label: "Concessions / credits", amount: num(values, "sellerConcessions") },
        { key: "repairCredits", label: "Repairs / repair credits", amount: num(values, "repairCredits") },
        { key: "proratedPropertyTax", label: "Prorated property tax", amount: num(values, "proratedPropertyTax") },
        { key: "hoaAtClosing", label: "HOA at closing", amount: num(values, "hoaAtClosing") },
        { key: "otherCosts", label: "Other costs", amount: num(values, "otherCosts") },
      ].map((l) => ({ ...l, amount: cents(l.amount) }))
      const total = cents(lines.reduce((a, l) => a + l.amount, 0))
      const net = cents(price - total)
      outputs = { salePrice: cents(price), totalDeductions: total, estimatedNet: net }
      if (net < 0) notes.push("The deductions exceed the sale price: at this price you would bring money to closing.")
      headline = { label: "Estimated net to you", value: net, unit: "usd" }
      break
    }
    case "buyer_payment": {
      const price = num(values, "price"), down = num(values, "downPayment")
      if (down > price) { extraRefused.push({ key: "downPayment", label: "Down payment", reason: "cannot exceed the purchase price" }); break }
      const months = Math.round(num(values, "termYears") * 12)
      if (months < 1) { extraRefused.push({ key: "termYears", label: "Loan term", reason: "must be at least one month" }); break }
      const loan = price - down
      const pi = monthlyPrincipalInterest(loan, num(values, "ratePct"), months)
      const tax = taxMonthlyFor(price), ins = num(values, "annualInsurance") / 12
      lines = [
        { key: "principalInterest", label: "Principal and interest", amount: pi },
        { key: "propertyTax", label: "Property tax", amount: tax },
        { key: "insurance", label: "Homeowners insurance", amount: ins },
        { key: "hoa", label: "HOA dues", amount: num(values, "hoaMonthly") },
        { key: "mortgageInsurance", label: "Mortgage insurance", amount: num(values, "mortgageInsuranceMonthly") },
      ].map((l) => ({ ...l, amount: cents(l.amount) }))
      const total = cents(lines.reduce((a, l) => a + l.amount, 0))
      outputs = { loanAmount: cents(loan), monthlyTotal: total, totalInterestOverTerm: cents(Math.max(0, pi * months - loan)), paymentsCount: months }
      headline = { label: "Estimated monthly payment", value: total, unit: "usd" }
      disclaimers.push(DISCLAIMERS.notPreapproval)
      if (!has(values, "mortgageInsuranceMonthly")) notes.push("Mortgage insurance is not included — ask your lender whether your loan requires it.")
      break
    }
    case "affordability_range": {
      const income = num(values, "grossMonthlyIncome"), months = Math.round(num(values, "termYears") * 12)
      if (months < 1) { extraRefused.push({ key: "termYears", label: "Loan term", reason: "must be at least one month" }); break }
      const housingBudget = (income * num(values, "housingRatioPct")) / 100
      const debtBudget = (income * num(values, "totalDebtRatioPct")) / 100 - num(values, "monthlyDebts")
      const down = num(values, "downPayment")
      const fixed = num(values, "annualInsurance") / 12 + num(values, "hoaMonthly") + (has(values, "annualPropertyTax") ? num(values, "annualPropertyTax") / 12 : 0)
      const tr = has(values, "annualPropertyTax") ? 0 : num(values, "propertyTaxRatePct") / 100 / 12
      const f = monthlyPrincipalInterest(1, num(values, "ratePct"), months)
      const priceFor = (budget: number): number => {
        const room = budget - fixed
        if (!(room > 0)) return 0
        const p = (room + f * down) / (f + tr)
        if (p >= down) return p
        return tr > 0 ? Math.min(down, room / tr) : down
      }
      const a = priceFor(housingBudget), b = priceFor(debtBudget)
      outputs = {
        housingBudgetMonthly: cents(Math.max(0, housingBudget)), totalDebtBudgetMonthly: cents(Math.max(0, debtBudget)),
        priceWithinBothLimits: cents(Math.min(a, b)), rangeLow: cents(Math.min(a, b)), rangeHigh: cents(Math.max(a, b)),
      }
      headline = { label: "Price where both of your limits hold", value: cents(Math.min(a, b)), unit: "usd" }
      notes.push("The range runs from the price where BOTH limits you entered hold to the price where only the looser one does.")
      disclaimers.push(DISCLAIMERS.notPreapproval)
      break
    }
    case "buy_vs_rent": {
      const price = num(values, "homePrice"), down = num(values, "downPayment")
      if (down > price) { extraRefused.push({ key: "downPayment", label: "Down payment", reason: "cannot exceed the home price" }); break }
      const months = Math.round(num(values, "termYears") * 12), years = Math.round(num(values, "years"))
      if (months < 1) { extraRefused.push({ key: "termYears", label: "Loan term", reason: "must be at least one month" }); break }
      if (years < 1) { extraRefused.push({ key: "years", label: "Years you plan to stay", reason: "must be at least one year" }); break }
      const loan = price - down, rate = num(values, "ratePct")
      const pi = monthlyPrincipalInterest(loan, rate, months)
      const carryMonthly = taxMonthlyFor(price) + num(values, "annualInsurance") / 12 + num(values, "annualMaintenance") / 12 + num(values, "hoaMonthly")
      const g = num(values, "rentIncreasePct") / 100, a = num(values, "appreciationPct") / 100, sell = num(values, "sellingCostPct") / 100
      const inv = has(values, "investmentReturnPct") ? num(values, "investmentReturnPct") / 100 : null
      const upfront = down + num(values, "buyingClosingCosts")
      let rentTotal = 0, ownOutlay = upfront, breakEvenYear: number | null = null
      let ownNet = 0, rentNet = 0, equity = 0
      for (let y = 1; y <= years; y++) {
        rentTotal += num(values, "monthlyRent") * 12 * Math.pow(1 + g, y - 1)
        const piMonths = Math.max(0, Math.min(12, months - (y - 1) * 12))
        ownOutlay += pi * piMonths + carryMonthly * 12
        const value = price * Math.pow(1 + a, y)
        equity = value - balanceAfter(loan, rate, months, y * 12) - value * sell
        ownNet = ownOutlay - equity
        rentNet = rentTotal - (inv === null ? 0 : upfront * (Math.pow(1 + inv, y) - 1))
        if (breakEvenYear === null && ownNet <= rentNet) breakEvenYear = y
      }
      outputs = {
        netCostOfRenting: cents(rentNet), netCostOfOwning: cents(ownNet), ownerEquityAtEnd: cents(equity),
        totalRentPaid: cents(rentTotal), ownerCashOutlay: cents(ownOutlay), breakEvenYear,
        cheaperOption: ownNet <= rentNet ? "buying" : "renting",
      }
      headline = { label: `Lower net cost over ${years} year${years === 1 ? "" : "s"}`, value: ownNet <= rentNet ? "buying" : "renting", unit: "text" }
      notes.push("Property tax, insurance, maintenance and HOA are held at the figures you entered for every year; they are not inflated.")
      if (inv === null) notes.push("The return on cash a renter could invest instead is not included (you did not enter one).")
      disclaimers.push(DISCLAIMERS.notPreapproval)
      break
    }
    case "refinance_break_even": {
      const bal = num(values, "currentBalance")
      const cur = monthlyPrincipalInterest(bal, num(values, "currentRatePct"), num(values, "remainingMonths"))
      const nw = monthlyPrincipalInterest(bal, num(values, "newRatePct"), num(values, "newTermMonths"))
      const savings = cur - nw, costs = num(values, "refinanceCosts")
      const breakEven = savings > 0 ? Math.ceil(costs / savings) : null
      outputs = {
        currentPayment: cents(cur), newPayment: cents(nw), monthlySavings: cents(savings), breakEvenMonths: breakEven,
        remainingPaymentsCurrent: cents(cur * num(values, "remainingMonths")), remainingPaymentsNew: cents(nw * num(values, "newTermMonths") + costs),
      }
      headline = { label: "Months to recover the refinance costs", value: breakEven, unit: "months" }
      if (breakEven === null) notes.push("The new payment is not lower, so the costs are never recovered from monthly savings.")
      if (num(values, "newTermMonths") > num(values, "remainingMonths")) notes.push("The new term is longer than the time left on your loan: compare total remaining payments, not only the monthly figure.")
      disclaimers.push(DISCLAIMERS.notPreapproval)
      break
    }
    case "equity_proceeds": {
      const value = num(values, "estimatedValue")
      const liens = num(values, "mortgageBalance") + num(values, "otherLiens")
      const selling = has(values, "sellingCostAmount") ? num(values, "sellingCostAmount") : (value * num(values, "sellingCostPct")) / 100
      outputs = { equity: cents(value - liens), sellingCosts: cents(selling), estimatedProceeds: cents(value - liens - selling) }
      lines = [{ key: "liens", label: "Mortgage and liens", amount: cents(liens) }, { key: "sellingCosts", label: "Cost to sell", amount: cents(selling) }]
      headline = { label: "Estimated proceeds", value: cents(value - liens - selling), unit: "usd" }
      notes.push("The value is your own estimate, not an appraisal or a market valuation.")
      break
    }
    case "closing_cost_estimate": {
      const price = num(values, "price")
      const keys = ["lenderFees", "titleInsurance", "settlementFees", "recordingFees", "prepaidsEscrows", "inspections", "otherCosts"]
      const tt = transferTax(values, ctx, price)
      if (tt && "missing" in tt) { extraMissing.push(tt.missing); break }
      if (!keys.some((k) => has(values, k)) && !tt) { extraMissing.push({ key: "costs", label: "Closing costs", message: "Enter a value: at least one closing cost from your quotes or Loan Estimate" }); break }
      if (tt) assumptions.push(tt.assumption)
      const spec2 = CALCULATOR_SPECS.closing_cost_estimate
      lines = keys.filter((k) => has(values, k)).map((k) => ({ key: k, label: spec2.fields.find((f) => f.key === k)!.label.replace(/\s*\(.*\)$/, ""), amount: cents(num(values, k)) }))
      if (tt) lines.push({ key: "transferTax", label: "Transfer tax", amount: tt.amount })
      const total = cents(lines.reduce((s, l) => s + l.amount, 0))
      outputs = { side: String(values.side), total, shareOfPricePct: price > 0 ? cents((total / price) * 100) : null }
      headline = { label: "Estimated closing costs", value: total, unit: "usd" }
      if (values.side === "buyer") disclaimers.push(DISCLAIMERS.notPreapproval)
      break
    }
    case "exchange_1031_timeline": {
      const s = citedSourceFor("exchange_1031_deadlines", "US")
      if (!s || s.rule.kind !== "statutory_days") { extraRefused.push({ key: "source", label: "Statute", reason: "the cited statute is unavailable" }); break }
      const t = String(values.relinquishedTransferDate)
      const ident = addDaysIso(t, s.rule.days.identification)
      const d180 = addDaysIso(t, s.rule.days.receipt)
      const due = typeof values.returnDueDate === "string" ? values.returnDueDate : null
      if (due && due < t) { extraRefused.push({ key: "returnDueDate", label: "Return due date", reason: "is before the transfer date" }); break }
      const receipt = due && due < d180 ? due : d180
      outputs = { identificationDeadline: ident, receiptDeadline: receipt, receiptDeadlineReason: due && due < d180 ? "your return due date comes first" : "180 days after the transfer" }
      assumptions.push({ key: "statute", label: s.label, display: `${s.rule.days.identification} and ${s.rule.days.receipt} days`, basis: "cited_source", source: sourceOf(s) })
      headline = { label: "Identify replacement property by", value: ident, unit: "date" }
      if (!due) notes.push("If your tax return (with extensions) is due before the 180th day, that earlier date is the deadline — enter it to see.")
      disclaimers.push(DISCLAIMERS.legalTax)
      break
    }
    case "investor_cash_flow": {
      const price = num(values, "purchasePrice"), down = num(values, "downPayment")
      if (down > price) { extraRefused.push({ key: "downPayment", label: "Down payment", reason: "cannot exceed the purchase price" }); break }
      const months = Math.round(num(values, "termYears") * 12)
      if (months < 1) { extraRefused.push({ key: "termYears", label: "Loan term", reason: "must be at least one month" }); break }
      const rent = num(values, "monthlyRent")
      const effectiveRent = rent * 12 * (1 - num(values, "vacancyPct") / 100)
      const maint = has(values, "maintenanceMonthly") ? num(values, "maintenanceMonthly") * 12 : (rent * 12 * num(values, "maintenancePctOfRent")) / 100
      const mgmt = (effectiveRent * num(values, "managementPctOfRent")) / 100
      const opex = taxMonthlyFor(price) * 12 + num(values, "annualInsurance") + num(values, "hoaMonthly") * 12 + maint + mgmt + num(values, "otherMonthly") * 12
      const noi = effectiveRent - opex
      const debt = monthlyPrincipalInterest(price - down, num(values, "ratePct"), months) * 12
      const cash = down + num(values, "closingCosts")
      outputs = {
        effectiveRentAnnual: cents(effectiveRent), operatingExpensesAnnual: cents(opex), netOperatingIncome: cents(noi),
        capRatePct: price > 0 ? cents((noi / price) * 100) : null, debtServiceAnnual: cents(debt),
        cashFlowAnnual: cents(noi - debt), cashFlowMonthly: cents((noi - debt) / 12),
        cashOnCashPct: cash > 0 ? cents(((noi - debt) / cash) * 100) : null,
      }
      headline = { label: "Cash flow per month", value: cents((noi - debt) / 12), unit: "usd" }
      disclaimers.push(DISCLAIMERS.investment)
      break
    }
    case "marketing_roi": {
      const spend = num(values, "spend"), leads = num(values, "leads")
      const closings = has(values, "closings") ? num(values, "closings") : (leads * num(values, "conversionPct")) / 100
      if (has(values, "closings") && closings > leads) { extraRefused.push({ key: "closings", label: "Closings", reason: "cannot exceed the leads generated" }); break }
      const revenue = closings * num(values, "revenuePerClosing")
      outputs = {
        closings: cents(closings), revenue: cents(revenue), netReturn: cents(revenue - spend),
        roiPct: spend > 0 ? cents(((revenue - spend) / spend) * 100) : null,
        costPerLead: leads > 0 ? cents(spend / leads) : null, costPerClosing: closings > 0 ? cents(spend / closings) : null,
      }
      headline = { label: "Return on marketing spend", value: spend > 0 ? cents(((revenue - spend) / spend) * 100) : null, unit: "percent" }
      if (!(spend > 0)) notes.push("With no spend entered there is no return ratio to compute.")
      break
    }
    case "relocation_budget": {
      const items: Array<[string, string, number]> = [
        ["movers", "Movers or truck", num(values, "movers")], ["packing", "Packing supplies", num(values, "packing")], ["travel", "Travel", num(values, "travel")],
        ["temporaryHousing", "Temporary housing", num(values, "temporaryHousingMonthly") * num(values, "temporaryHousingMonths")],
        ["storage", "Storage", num(values, "storageMonthly") * num(values, "storageMonths")],
        ["deposits", "Deposits", num(values, "deposits")], ["utilitiesSetup", "Utility connections", num(values, "utilitiesSetup")], ["otherCosts", "Other", num(values, "otherCosts")],
      ]
      const entered = CALCULATOR_SPECS.relocation_budget.fields.some((f) => has(values, f.key))
      if (!entered) { extraMissing.push({ key: "costs", label: "Relocation costs", message: "Enter a value: at least one moving cost from your quotes" }); break }
      if (has(values, "temporaryHousingMonthly") !== has(values, "temporaryHousingMonths")) { extraMissing.push({ key: "temporaryHousing", label: "Temporary housing", message: "Enter a value: both the monthly cost and the number of months of temporary housing" }); break }
      if (has(values, "storageMonthly") !== has(values, "storageMonths")) { extraMissing.push({ key: "storage", label: "Storage", message: "Enter a value: both the monthly cost and the number of months of storage" }); break }
      lines = items.map(([key, label, amount]) => ({ key, label, amount: cents(amount) }))
      const total = cents(lines.reduce((s, l) => s + l.amount, 0))
      outputs = { total }
      headline = { label: "Relocation budget", value: total, unit: "usd" }
      break
    }
    case "carry_cost": {
      const m = num(values, "months")
      if (m < 1) { extraRefused.push({ key: "months", label: "Months", reason: "must be at least one month" }); break }
      lines = [
        { key: "propertyTax", label: "Property tax", amount: num(values, "annualPropertyTax") / 12 },
        { key: "insurance", label: "Insurance", amount: num(values, "annualInsurance") / 12 },
        { key: "hoa", label: "HOA", amount: num(values, "hoaMonthly") },
        { key: "utilities", label: "Utilities", amount: num(values, "utilitiesMonthly") },
        { key: "maintenance", label: "Maintenance", amount: num(values, "maintenanceMonthly") },
        { key: "mortgage", label: "Mortgage payment", amount: num(values, "mortgagePaymentMonthly") },
      ].map((l) => ({ ...l, amount: cents(l.amount) }))
      const monthly = cents(lines.reduce((s, l) => s + l.amount, 0))
      outputs = { monthlyCarry: monthly, totalCarry: cents(monthly * m), months: m }
      headline = { label: `Carry cost over ${m} month${m === 1 ? "" : "s"}`, value: cents(monthly * m), unit: "usd" }
      break
    }
  }
  if (extraMissing.length || extraRefused.length) return refusal(kind, extraMissing, extraRefused)
  const bad = finiteOr(outputs, lines)
  if (bad) return refusal(kind, [], [{ key: bad, label: bad, reason: "the result is outside the range this calculator can represent — check the inputs" }])
  if (audience === "public") disclaimers.push(DISCLAIMERS.equalHousing)
  return {
    ok: true, kind: spec.kind, title: spec.title, audience, period: spec.period, headline,
    outputs, lines, assumptions, notes, disclaimers, engineVersion: CALCULATOR_ENGINE_VERSION,
  }
}

/** PURE. The calculator spec for a kind, or null. */
export function calculatorSpec(kind: string): CalculatorSpec | null {
  return (CALCULATOR_KINDS as readonly string[]).includes(kind) ? CALCULATOR_SPECS[kind as CalculatorKind] : null
}
