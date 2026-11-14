#!/usr/bin/env tsx
/**
 * scripts/tax-planning-simulator.ts   (npm run test:tax-planning)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves THE ONE estimated-tax estimator (lib/finance/tax-planning.ts) and its doors.
 *
 * WAVE 153 (lane 153A) — owner ruling, verbatim: "make sure estimate quarterly taxes work (if we cant determine their tax
 * percentages, then the user can enter that in)". This proof now asserts the RULES of that ruling, behaviorally:
 *   · unknown rate → explicit input required; NO reserve is quoted and no default rate exists;
 *   · a manual rate carries its source, period, last-updated and version; out-of-range is refused, never clamped;
 *   · varying quarterly profit, losses and refunds; split commission earned (accrual) vs paid (cash);
 *   · changed assumptions reforecast the quarters ahead WITHOUT rewriting recorded payments;
 *   · accountant-supplied quarterly targets; per-person state rates (multistate tenant — never derived from an office);
 *   · due dates per tax year with the Pub 505 weekend / legal-holiday roll (checked against IRS-published dates) and
 *     fiscal years; a reserve is labelled a reserve, not the amount legally due.
 * PURE layer drives the real exported functions; SOURCE layer reads stripped source (with positive controls) for the
 * doors that need a Next session; the TENANT OPTION layer drives the real resolver. LIVE layer is credentials-gated.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { stripComments, blankStrings } from "./strip-comments"
import * as engine from "../lib/finance/tax-planning"
import {
  computeSelfEmploymentTax,
  computeNetSelfEmploymentIncome,
  sumDeductibleExpenses,
  quarterlyDueDates,
  parseTaxAssumptions,
  applyAssumptionChange,
  recognizeCommissionIncome,
  buildTaxPlan,
  taxYearWindow,
} from "../lib/finance/tax-planning"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: unknown) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
const r2 = (n: number) => Math.round(n * 100) / 100

const NOW = "2026-11-14T12:00:00Z"
/** Build assumptions exactly as the writer stores them (through the real applyAssumptionChange). */
function assume(changes: Array<[engine.AssumptionChange, "self_entered" | "accountant_supplied"]>, taxYear = 2026) {
  let stored: Record<string, unknown> = {}
  for (const [c, source] of changes) {
    const r = applyAssumptionChange(stored, c, { source, taxYear, userId: "u-1", now: NOW })
    if (!r.ok) throw new Error(r.error)
    stored = r.next
  }
  return { stored, parsed: parseTaxAssumptions(stored) }
}
const RATES = assume([[{ key: "federalRate", value: 0.22 }, "self_entered"], [{ key: "stateRate", value: 0.05 }, "self_entered"]]).parsed
const NO_EXP = { recorded: 0, confirmedDeductible: 0, unconfirmed: 0, unconfirmedCategories: [] as string[] }
const inc = (n: number) => ({ recognized: n, earnedNotPaid: 0, disputedExcluded: 0 })

function statutoryLayer() {
  console.log("\n[self-employment tax · pure — the statutory formula stays computed (12.4% SS capped + 2.9% Medicare on 92.35%)]")
  const se = computeSelfEmploymentTax({ netSelfEmploymentIncome: 100000 })
  check("taxable base = net × 0.9235 (92,350)", se.taxableBase === 92350)
  check("total SE tax on 100k = 14,129.55", se.total === 14129.55)
  const capped = computeSelfEmploymentTax({ netSelfEmploymentIncome: 200000, socialSecurityWageBase: 170000 })
  check("SS is CAPPED at the wage base (170,000 × 12.4% = 21,080)", capped.socialSecurity === 21080)
  check("net SE income never negative", computeNetSelfEmploymentIncome(10000, 25000) === 0)
}

function noDefaultLayer() {
  console.log("\n[NO DEFAULT RATE — unknown rate → explicit input required, nothing quoted]")
  check("the engine exports no default income-tax rate any more", !("DEFAULT_EFFECTIVE_INCOME_RATE" in engine))
  check("PC: the export probe does see a real export", "SE_NET_FACTOR" in engine)
  const blank = parseTaxAssumptions({})
  const plan = buildTaxPlan({ taxYear: 2026, today: "2026-05-20", assumptions: blank, income: inc(60000), expenses: NO_EXP, recorded: [] })
  check("no rates entered → inputs.status 'needs_input', missing federal + state", plan.inputs.status === "needs_input" && JSON.stringify(plan.inputs.missing) === JSON.stringify(["federal_rate", "state_rate"]))
  check("no reserve and no remaining suggestion is quoted from a rate nobody entered", plan.reserve === null && plan.remainingSuggestedReserve === null)
  check("every quarter still ahead says 'needs_input' with no amount; quarters already past are history", plan.quarterly.filter((q) => q.dueDate >= "2026-05-20").every((q) => q.status === "needs_input" && q.suggested === null) && plan.quarterly[0].suggested === null)
  check("the plan tells the person to enter their rates (or their accountant's amounts) and that it never guesses", plan.flags.some((f) => /Enter your federal and state estimated tax rates/.test(f) && /never guesses/.test(f)))
  check("only the state rate missing → still needs input (no half-estimate)", buildTaxPlan({ taxYear: 2026, today: "2026-05-20", assumptions: assume([[{ key: "federalRate", value: 0.22 }, "self_entered"]]).parsed, income: inc(60000), expenses: NO_EXP, recorded: [] }).reserve === null)
  const zeroState = assume([[{ key: "federalRate", value: 0.12 }, "self_entered"], [{ key: "stateRate", value: 0 }, "self_entered"]]).parsed
  check("a state rate of 0 is a REAL entry (a state with no income tax) and completes the inputs", buildTaxPlan({ taxYear: 2026, today: "2026-05-20", assumptions: zeroState, income: inc(60000), expenses: NO_EXP, recorded: [] }).inputs.status === "ready")
  check("malformed stored values parse as ABSENT, never as a usable rate (out of range, unknown source, no version)",
    parseTaxAssumptions({ federalRate: { value: 0.9, source: "self_entered", period: "2026", updatedAt: NOW, version: 1 } }).federalRate === null
    && parseTaxAssumptions({ federalRate: { value: 0.2, source: "platform_default", period: "2026", updatedAt: NOW, version: 1 } }).federalRate === null
    && parseTaxAssumptions({ federalRate: { value: 0.2, source: "self_entered", period: "2026", updatedAt: NOW } }).federalRate === null)
  check("PC: a well-formed stored rate DOES parse", parseTaxAssumptions({ federalRate: { value: 0.2, source: "self_entered", period: "2026", updatedAt: NOW, version: 1 } }).federalRate?.value === 0.2)
}

function provenanceLayer() {
  console.log("\n[a manual rate carries source / period / last-updated / version; history is appended]")
  const first = applyAssumptionChange({}, { key: "federalRate", value: 0.2 }, { source: "self_entered", taxYear: 2026, userId: "u-1", now: "2026-02-01T00:00:00Z" })
  const second = first.ok ? applyAssumptionChange(first.next, { key: "federalRate", value: 0.24 }, { source: "accountant_supplied", taxYear: 2026, userId: "u-1", now: "2026-06-01T00:00:00Z", note: "per CPA letter" }) : first
  const parsed = second.ok ? parseTaxAssumptions(second.next).federalRate : null
  check("the saved rate records value, source, period, updatedAt, updatedBy and version", !!parsed && parsed.value === 0.24 && parsed.source === "accountant_supplied" && parsed.period === "2026" && parsed.updatedAt === "2026-06-01T00:00:00Z" && parsed.updatedBy === "u-1" && parsed.version === 2 && parsed.note === "per CPA letter", parsed)
  check("the replaced value is returned for the append-only history (first change replaces nothing)", first.ok && first.replaced === null && second.ok && (second.replaced as any)?.prior?.value === 0.2 && (second.replaced as any)?.prior?.version === 1)
  const tooHigh = applyAssumptionChange({}, { key: "federalRate", value: 0.75 }, { source: "self_entered", taxYear: 2026, userId: "u-1", now: NOW })
  check("ADVERSE: an out-of-range rate is REFUSED, never clamped into a number nobody entered", !tooHigh.ok)
  const noSource = applyAssumptionChange({}, { key: "stateRate", value: 0.05 }, { source: "guess", taxYear: 2026, userId: "u-1", now: NOW })
  check("ADVERSE: a rate without a recognised source is refused", !noSource.ok)
  const target = applyAssumptionChange({}, { key: "accountantTarget", quarter: 3, value: 4200 }, { source: "accountant_supplied", taxYear: 2026, userId: "u-1", now: NOW })
  check("an accountant's quarterly target is stored for that quarter with period 2026-Q3", target.ok && parseTaxAssumptions(target.next).accountantTargets[3]?.value === 4200 && parseTaxAssumptions(target.next).accountantTargets[3]?.period === "2026-Q3")
  const cleared = second.ok ? applyAssumptionChange(second.next, { key: "federalRate", value: null }, { source: "self_entered", taxYear: 2026, userId: "u-1", now: NOW }) : second
  check("clearing a rate puts the plan back to 'needs input' (and the cleared value goes to history)", cleared.ok && parseTaxAssumptions(cleared.next).federalRate === null && (cleared.replaced as any)?.prior?.value === 0.24)
}

function incomeLayer() {
  console.log("\n[income as configured — split commission earned (accrual) vs paid (cash); disputed excluded]")
  const rows = [
    { agent_commission: 9000, close_date: "2026-03-10", paid_at: "2026-03-20T15:00:00Z", status: "paid" },
    { agent_commission: 6000, close_date: "2026-12-18", paid_at: "2027-01-08T15:00:00Z", status: "paid" },
    { agent_commission: 4000, close_date: "2025-12-20", paid_at: "2026-01-05T10:00:00Z", status: "paid" },
    { agent_commission: 2500, close_date: "2026-06-01", paid_at: null, status: "disputed" },
    { agent_commission: 1500, close_date: "2026-10-01", paid_at: null, status: "approved" },
  ]
  const W = { from: "2026-01-01", to: "2026-12-31" }
  const cash = recognizeCommissionIncome(rows, "cash", W), accrual = recognizeCommissionIncome(rows, "accrual", W)
  check("cash basis 2026 = paid in 2026 (9,000 + 4,000 from a 2025 closing) = 13,000", cash.recognized === 13000, cash)
  check("accrual basis 2026 = closed in 2026, not disputed (9,000 + 6,000 + 1,500) = 16,500", accrual.recognized === 16500, accrual)
  check("the December closing paid in January is 'earned, not yet paid' for 2026 (6,000 + 1,500 unpaid)", cash.earnedNotPaid === 7500)
  check("a disputed commission is excluded and reported (2,500)", cash.disputedExcluded === 2500 && accrual.disputedExcluded === 2500)
  const plan = buildTaxPlan({ taxYear: 2026, today: "2026-12-31", assumptions: RATES, income: cash, expenses: NO_EXP, recorded: [] })
  check("the plan says income is counted on the cash basis (unchosen → flagged, never silent)", plan.basis.value === "cash" && !plan.basis.chosen && plan.flags.some((f) => /cash basis/.test(f)))
}

function expensesLayer() {
  console.log("\n[expenses — deductibility never assumed; refunds net]")
  const rows = [{ amount: 1200, category: "marketing" }, { amount: 300, category: "office" }, { amount: -200, category: "marketing" }, { amount: 90, category: "transportation" }]
  const none = sumDeductibleExpenses(rows, null)
  check("nothing confirmed → 0 deductible; 1,390 recorded shown as unconfirmed with its categories", none.confirmedDeductible === 0 && none.recorded === 1390 && none.unconfirmed === 1390 && JSON.stringify(none.unconfirmedCategories) === JSON.stringify(["marketing", "office", "transportation"]), none)
  const some = sumDeductibleExpenses(rows, ["marketing"])
  check("marketing confirmed → its refund nets inside it (1,200 − 200 = 1,000); the rest stays unconfirmed (390)", some.confirmedDeductible === 1000 && some.unconfirmed === 390, some)
  const plan = buildTaxPlan({ taxYear: 2026, today: "2026-06-30", assumptions: RATES, income: inc(50000), expenses: none, recorded: [] })
  check("an unconfirmed expense does not reduce the estimate and is flagged with its amount", plan.periodToDate.net === 50000 && plan.flags.some((f) => /not yet confirmed deductible/.test(f) && /\$1,390/.test(f)))
}

function quartersLayer() {
  console.log("\n[quarters — varying profit, losses, reforecast without rewriting history, accountant targets]")
  // Q2 view: 30k so far, nothing recorded.
  const q2 = buildTaxPlan({ taxYear: 2026, today: "2026-05-20", assumptions: RATES, income: inc(30000), expenses: NO_EXP, recorded: [{ quarter: 1, amount: 2500, kind: "payment" }] })
  check("a reserve is computed only from entered rates: projected annual reserve > 0 and labelled not-legally-due", !!q2.reserve && q2.reserve.projectedAnnualReserve > 0 && /not the amount legally due/.test(q2.disclaimer))
  check("Q1 is history: its recorded 2,500 stands and no suggestion is recomputed for it", q2.quarterly[0].recorded === 2500 && q2.quarterly[0].suggested === null && q2.quarterly[0].status === "recorded")
  check("already set aside / paid (2,500) and remaining suggested reserve are SEPARATE quantities and add up", q2.alreadySetAsideOrPaid === 2500 && q2.remainingSuggestedReserve === r2(Math.max(0, q2.reserve!.projectedAnnualReserve - 2500)))
  check("the remaining reserve is spread over the quarters still ahead (Q2, Q3, Q4)", q2.quarterly.slice(1).every((q) => q.suggested === r2(q2.remainingSuggestedReserve! / 3)))
  // Q3 view after a BIG summer: profit varies, the plan reforecasts.
  const q3 = buildTaxPlan({ taxYear: 2026, today: "2026-08-20", assumptions: RATES, income: inc(90000), expenses: NO_EXP, recorded: [{ quarter: 1, amount: 2500, kind: "payment" }, { quarter: 2, amount: 3000, kind: "payment" }] })
  check("varying quarterly profit: a strong summer raises the remaining suggestion for Q3/Q4 (reforecast), Q1/Q2 recorded amounts unchanged", q3.quarterly[0].recorded === 2500 && q3.quarterly[1].recorded === 3000 && q3.quarterly[2].suggested! > q2.quarterly[2].suggested!)
  // Changed assumptions reforecast but never mutate recorded payments.
  const higher = assume([[{ key: "federalRate", value: 0.32 }, "accountant_supplied"], [{ key: "stateRate", value: 0.05 }, "self_entered"]]).parsed
  const recorded = [{ quarter: 1, amount: 2500, kind: "payment" as const }, { quarter: 2, amount: 3000, kind: "payment" as const }]
  const frozen = JSON.stringify(recorded)
  const q3b = buildTaxPlan({ taxYear: 2026, today: "2026-08-20", assumptions: higher, income: inc(90000), expenses: NO_EXP, recorded })
  check("a changed rate reforecasts the quarters ahead and leaves every recorded payment exactly as it was", q3b.remainingSuggestedReserve! > q3.remainingSuggestedReserve! && q3b.quarterly[0].recorded === 2500 && q3b.quarterly[1].recorded === 3000 && JSON.stringify(recorded) === frozen)
  // Loss.
  const loss = buildTaxPlan({ taxYear: 2026, today: "2026-08-20", assumptions: RATES, income: inc(8000), expenses: { recorded: 12000, confirmedDeductible: 12000, unconfirmed: 0, unconfirmedCategories: [] }, recorded: [] })
  check("a loss so far → isLoss, no reserve suggested (0), and a plain note to ask a tax professional", loss.periodToDate.isLoss && loss.reserve?.projectedAnnualReserve === 0 && loss.remainingSuggestedReserve === 0 && loss.flags.some((f) => /exceed your income/.test(f)))
  // Refund lowers the estimate.
  const before = buildTaxPlan({ taxYear: 2026, today: "2026-08-20", assumptions: RATES, income: inc(60000), expenses: sumDeductibleExpenses([{ amount: 5000, category: "marketing" }], ["marketing"]), recorded: [] })
  const after = buildTaxPlan({ taxYear: 2026, today: "2026-08-20", assumptions: RATES, income: inc(60000), expenses: sumDeductibleExpenses([{ amount: 5000, category: "marketing" }, { amount: -1000, category: "marketing" }], ["marketing"]), recorded: [] })
  check("a refund of a deductible expense raises net income and the reserve (no double deduction)", after.periodToDate.net === before.periodToDate.net + 1000 && after.reserve!.projectedAnnualReserve > before.reserve!.projectedAnnualReserve)
  // Accountant targets with NO rates entered.
  const acct = assume([[{ key: "accountantTarget", quarter: 3, value: 4200 }, "accountant_supplied"], [{ key: "accountantTarget", quarter: 4, value: 3900 }, "accountant_supplied"]]).parsed
  const viaAcct = buildTaxPlan({ taxYear: 2026, today: "2026-08-20", assumptions: acct, income: inc(70000), expenses: NO_EXP, recorded: [{ quarter: 3, amount: 1000, kind: "set_aside" }] })
  check("accountant's amounts for every remaining quarter → ready without rates; Q3 = 4,200 − 1,000 set aside, Q4 = 3,900, source 'accountant'", viaAcct.inputs.status === "ready" && viaAcct.reserve === null && viaAcct.quarterly[2].suggested === 3200 && viaAcct.quarterly[3].suggested === 3900 && viaAcct.quarterly[2].suggestedSource === "accountant" && viaAcct.remainingSuggestedReserve === 7100, viaAcct.quarterly)
  // Multistate tenant: two people in the same tenant, different state rates — each plan uses its own entry.
  const tx = assume([[{ key: "federalRate", value: 0.22 }, "self_entered"], [{ key: "stateRate", value: 0 }, "self_entered"], [{ key: "stateCodes", value: ["TX"] }, "self_entered"]]).parsed
  const ca = assume([[{ key: "federalRate", value: 0.22 }, "self_entered"], [{ key: "stateRate", value: 0.093 }, "accountant_supplied"], [{ key: "stateCodes", value: ["CA", "NV"] }, "accountant_supplied"]]).parsed
  const pTx = buildTaxPlan({ taxYear: 2026, today: "2026-08-20", assumptions: tx, income: inc(80000), expenses: NO_EXP, recorded: [] })
  const pCa = buildTaxPlan({ taxYear: 2026, today: "2026-08-20", assumptions: ca, income: inc(80000), expenses: NO_EXP, recorded: [] })
  check("multistate tenant: same income, different entered state rates → different reserves; the states covered are the person's own list", pCa.reserve!.incomeTaxReserve > pTx.reserve!.incomeTaxReserve && JSON.stringify(pCa.inputs.assumptions.stateCodes?.value) === JSON.stringify(["CA", "NV"]))
  // User-entered due date wins over the rule for that quarter.
  const custom = assume([[{ key: "federalRate", value: 0.22 }, "self_entered"], [{ key: "stateRate", value: 0.05 }, "self_entered"], [{ key: "dueDateOverride", quarter: 3, value: "2026-10-15" }, "accountant_supplied"]]).parsed
  const pc = buildTaxPlan({ taxYear: 2026, today: "2026-08-20", assumptions: custom, income: inc(50000), expenses: NO_EXP, recorded: [] })
  check("a user-entered due date replaces the rule for that quarter and is marked 'your_schedule'", pc.quarterly[2].dueDate === "2026-10-15" && pc.quarterly[2].dueDateSource === "your_schedule" && pc.quarterly[1].dueDateSource === "irs_rule")
}

function dueDateLayer() {
  console.log("\n[due dates per tax year — Pub 505 schedule, weekend / legal-holiday roll, checked against IRS-published dates]")
  check("2026: Apr 15 / Jun 15 / Sep 15 / Jan 15 2027 (no roll needed)", JSON.stringify(quarterlyDueDates(2026)) === JSON.stringify(["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"]))
  check("Q4 2021 → Jan 18 2022 (Jan 15 a Saturday, Jan 17 Martin Luther King Jr. Day)", quarterlyDueDates(2021)[3] === "2022-01-18")
  check("Q1 2022 → Apr 18 2022 (Apr 15 = DC Emancipation Day observed)", quarterlyDueDates(2022)[0] === "2022-04-18")
  check("Q1 2023 → Apr 18 2023 (Apr 15 a Saturday, Apr 17 Emancipation Day observed)", quarterlyDueDates(2023)[0] === "2023-04-18")
  check("Q4 2022 → Jan 17 2023 and Q4 2023 → Jan 16 2024 (MLK Day rolls)", quarterlyDueDates(2022)[3] === "2023-01-17" && quarterlyDueDates(2023)[3] === "2024-01-16")
  check("Q2 2024 → Jun 17 2024, Q3 2024 → Sep 16 2024, Q2 2025 → Jun 16 2025 (weekends)", quarterlyDueDates(2024)[1] === "2024-06-17" && quarterlyDueDates(2024)[2] === "2024-09-16" && quarterlyDueDates(2025)[1] === "2025-06-16")
  check("a fiscal year starting July: Oct 15, Dec 15, Mar 15, Jul 15", JSON.stringify(quarterlyDueDates(2026, 7)) === JSON.stringify(["2026-10-15", "2026-12-15", "2027-03-15", "2027-07-15"]))
  const fyA = assume([[{ key: "fiscalYearStartMonth", value: 7 }, "accountant_supplied"]]).parsed
  check("the fiscal year sets the planning window too (Jul 1 2026 → Jun 30 2027)", JSON.stringify(taxYearWindow(2026, fyA, "2027-02-01")) === JSON.stringify({ from: "2026-07-01", to: "2027-02-01", yearEnd: "2027-06-30" }))
  check("no hardcoded evergreen dates remain in the estimator or the planning panels", !/["'`]\$\{?[^"'`]*-04-15/.test(stripComments(src("lib/finance/tax-planning.ts"))) && !/Apr 15, \$\{year\}/.test(stripComments(src("app/dashboard/financials/components/planning/tax-readiness-panel.tsx"))))
  check("PC: the evergreen-date scan catches the old literal", /Apr 15, \$\{year\}/.test("1: `Apr 15, ${year}`,"))
}

function sourceLayer() {
  console.log("\n[the doors (need a Next session) — stripped source, each absence with a positive control]")
  const actions = stripComments(src("app/actions/tax-planning.ts"))
  const code = blankStrings(actions)
  check("getTaxPlanAction computes from the session agent's own commissions + own book expenses through buildTaxPlan", /from\("agent_commissions"\)[\s\S]*?\.eq\("agent_id", c\.agentId\)/.test(actions) && /from\("business_expenses"\)[\s\S]*?\.eq\("agent_id", c\.agentId\)/.test(actions) && /buildTaxPlan\(/.test(actions))
  check("personal plans never read consolidated revenue (no brokerage/team earnings, no team_id/brokerage-wide expense read)", !/brokerage_earnings|team_earnings|brokerage_p_l/.test(actions) && !/\.eq\("team_id"/.test(actions))
  check("PC: the consolidated-revenue scan catches a brokerage_earnings read", /brokerage_earnings|team_earnings|brokerage_p_l/.test(`svc.from("brokerage_earnings")`))
  check("no action takes an agent, user or tenant id from its input (session only)", !/input\??\.(agentId|userId|brokerageId)/.test(actions))
  const legacyWrite = /(estimated_effective_rate|set_aside_percent)\s*:/
  check("the doors never WRITE the legacy default-rate columns", !legacyWrite.test(code.replace(/"[^"]*"/g, '""')) && !legacyWrite.test(actions))
  check("PC: the legacy-column scan catches a write", legacyWrite.test("estimated_effective_rate: 0.12,"))
  check("no rate default anywhere in the doors or the concierge (no 0.12 / 25 fallback)", !/\?\?\s*0\.12|\?\?\s*25\b/.test(actions) && !/\?\?\s*0\.12|\?\?\s*25\b/.test(stripComments(src("lib/finance/quarterly-tax-concierge.ts"))))
  check("PC: the fallback scan catches the old shape", /\?\?\s*0\.12/.test("Number(profile.estimated_effective_rate ?? 0.12)"))
  check("saveTaxAssumptionsAction applies the change through applyAssumptionChange and APPENDS the replaced value to assumption_history", /applyAssumptionChange\(/.test(actions) && /assumption_history: applied\.replaced \? \[\.\.\.history, applied\.replaced\] : history/.test(actions))
  check("recordQuarterlyPaymentAction APPENDS (never filters out the quarter's earlier payment)", /const next = \[\.\.\.existing, \{/.test(actions) && !/filter\(\(p\) => p\.quarter !== input\.quarter\)/.test(actions))
  check("PC: the old replace-the-quarter shape is recognised", /filter\(\(p\) => p\.quarter !== input\.quarter\)/.test("(profile.quarterly_payments ?? []).filter((p) => p.quarter !== input.quarter)"))
  const PAYS = /(irs\.gov\/payments|\bstripe\b|\bach\b|\bcreatePayment\b|\bdirectpay\b|\bpaymentIntents?\b)/i
  check("no payment is made anywhere (no payment provider / IRS call in the tax files)", !PAYS.test(blankStrings(stripComments(src("lib/finance/tax-planning.ts")) + stripComments(src("lib/finance/quarterly-tax-concierge.ts")) + actions)))
  check("PC: the payment scan catches a provider call, and does not trip on forEach", PAYS.test("await stripe.paymentIntents.create({})") && !PAYS.test("rows.forEach((r) => r)"))
  check("the estimator and the concierge never derive a state rule from an office (no locations read)", !/from\("locations"\)/.test(stripComments(src("lib/finance/tax-planning.ts")) + stripComments(src("lib/finance/quarterly-tax-concierge.ts")) + actions))
  check("no model name or id in the tax files", !["lib/finance/tax-planning.ts", "lib/finance/quarterly-tax-concierge.ts", "app/actions/tax-planning.ts", "app/dashboard/financials/components/planning/tax-setaside-panel.tsx"].some((p) => /\b(gpt-|claude-|gemini-|sonnet|haiku|opus)\b/i.test(stripComments(src(p)))))
  const panel = stripComments(src("app/dashboard/financials/components/planning/tax-setaside-panel.tsx"))
  check("the planner panel never pre-fills a rate (inputs start empty; values come only from the saved assumptions)", /useState\(""\)/.test(panel) && !/useState\(25\)|useState\(0\.12\)|Recommended: 25-30%/.test(panel))
  check("the panel shows source / period / updated / version beside each saved rate and the four separate quantities", /federalRate\.version/.test(panel) && /Already set aside \/ paid/.test(panel) && /Still suggested to set aside/.test(panel) && /Net so far/.test(panel) && /Projected \{plan\.taxYear\} reserve/.test(panel))
  const readiness = stripComments(src("app/dashboard/financials/components/planning/tax-readiness-panel.tsx"))
  check("the readiness panel no longer runs its own 25% engine — it reads the one plan", !/estimatedTaxRate\s*=\s*0\.25/.test(readiness) && /getTaxPlanAction\(/.test(readiness))
  check("the readiness panel's AI prompt forbids stating a rate or the amount legally owed", /Do NOT state or suggest a tax rate/.test(readiness))
  const summary = stripComments(src("app/dashboard/financials/components/planning/planning-ai-summary-panel.tsx"))
  check("the summary panel ignores the parent's invented liability and reads the one plan", !/netIncome - estimatedTaxLiability/.test(summary) && /getTaxPlanAction\(/.test(summary))
  const m901 = src("supabase/migrations/m901-tax-assumptions-user-entered-no-default-rate.sql")
  check("m901 line 1 is the charter's exact WRITTEN-NOT-APPLIED line", m901.split("\n")[0] === "-- WRITTEN, NOT APPLIED (wave 153, lane 153A) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN and storage.objects policies are owner SQL")
  check("m901 drops the database's invented defaults (0.12 / 25), makes them nullable, adds assumptions + append-only history, with a ROLLBACK note", /estimated_effective_rate DROP DEFAULT/.test(m901) && /set_aside_percent DROP DEFAULT/.test(m901) && /estimated_effective_rate DROP NOT NULL/.test(m901) && /ADD COLUMN IF NOT EXISTS assumptions jsonb/.test(m901) && /ADD COLUMN IF NOT EXISTS assumption_history jsonb/.test(m901) && /-- ROLLBACK:/.test(m901))
  const reg = src("lib/kernel/manager-registry.ts")
  check("agent_tax_profile is owned by the Finance Manager", /agent_tax_profile:\s*"finance_manager"/.test(reg))
}

/** TENANT OPTION (m574) — "tax assistance tech is an option for tenants built out." */
async function tenantOptionLayer() {
  console.log("\n[tenant option — tax assistance gated on brokerages.tax_assistance_enabled, fail-closed]")
  const { resolveTaxAssistanceEnabled } = await import("../lib/finance/tax-assistance")
  const stub = (row: unknown, error: unknown = null) => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error }) }) }) }),
  })
  const on = await resolveTaxAssistanceEnabled(stub({ tax_assistance_enabled: true }), "b1")
  check("enabled brokerage → enabled", on.enabled === true && on.reason === "enabled")
  const off = await resolveTaxAssistanceEnabled(stub({ tax_assistance_enabled: false }), "b1")
  check("disabled brokerage → refused (disabled_by_brokerage)", off.enabled === false && off.reason === "disabled_by_brokerage")
  const unset = await resolveTaxAssistanceEnabled(stub({}), "b1")
  check("UNSET column → refused, never defaulted to offered", unset.enabled === false)
  const errd = await resolveTaxAssistanceEnabled(stub(null, { message: "boom" }), "b1")
  check("FAIL-CLOSED — a read error refuses (read_failed), never passes", errd.enabled === false && errd.reason === "read_failed")
  const noB = await resolveTaxAssistanceEnabled(stub({ tax_assistance_enabled: true }), null)
  check("no brokerage → refused", noB.enabled === false && noB.reason === "no_brokerage")

  const actions = stripComments(src("app/actions/tax-planning.ts"))
  const exported = actions.match(/export async function \w+\(/g) ?? []
  const gateCalls = actions.match(/await resolveTaxAssistanceEnabled\(/g) ?? []
  check("EVERY exported tax action gates on the tenant option (one gate per action)", exported.length >= 4 && gateCalls.length === exported.length, { exported: exported.length, gates: gateCalls.length })
  check("a refused gate returns the disabled sentinel, not a silent pass", /TAX_ASSISTANCE_DISABLED_ERROR/.test(actions))
  const panel = src("app/dashboard/financials/components/planning/tax-setaside-panel.tsx")
  check("the set-aside panel explains a disabled tenant instead of rendering dead tools", /tax_assistance_disabled/.test(panel) && /disabledByBrokerage/.test(panel))
  const settings = src("app/actions/settings/revenue-share-setting.ts")
  check("the enablement is written from the ONE offerings settings home (tax_assistance → tax_assistance_enabled)", /tax_assistance:\s*"tax_assistance_enabled"/.test(settings))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] read the assumptions column the estimator depends on (m901) — read only")
  const { error } = await svc.from("agent_tax_profile").select("assumptions, assumption_history").limit(1)
  check("live: agent_tax_profile.assumptions + assumption_history are readable (m901 applied)", !error, error?.message)
}

async function main() {
  statutoryLayer()
  noDefaultLayer()
  provenanceLayer()
  incomeLayer()
  expensesLayer()
  quartersLayer()
  dueDateLayer()
  sourceLayer()
  await tenantOptionLayer()
  await liveLayer()
  console.log("\nBLIND SPOTS: SIMULATED — the server actions need a Next session, so their wiring is proved on stripped source and their arithmetic by driving the same exported functions they call (the concierge drives the full load path on the in-memory client: test:quarterly-tax-concierge); state tax law is never modelled (the person or their accountant enters a rate); the annualized-income installment method (Form 2210 Schedule AI) and prior-year safe-harbor amounts are not computed — the accountant-target input is the path for them; farmers/fishermen and disaster postponements are entered as the person's own due dates.")
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ TAX_PLANNING_FAIL"); process.exit(1) }
  console.log(" ✅ TAX_PLANNING_PASS — estimated quarterly taxes from entered rates only: sourced + versioned assumptions, real due dates, reserve ≠ legally due")
}
main()
