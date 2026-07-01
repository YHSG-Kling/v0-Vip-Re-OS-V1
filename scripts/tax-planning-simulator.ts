#!/usr/bin/env tsx
/**
 * scripts/tax-planning-simulator.ts   (npm run test:tax-planning)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the self-employed (1099) agent TAX PLANNING engine — the solo-agent differentiator that was
 * missing (the set-aside calculator was UI-only, "Add to Tracking" was a toast with no persistence).
 * PURE layer: precise self-employment tax (12.4% SS capped at the wage base + 2.9% Medicare on 92.35%
 * of net), deductible-expense rollup, the four quarterly estimated-tax payments with IRS due dates,
 * and the full plan projecting YTD → annual. SOURCE scan: the actions + panel wiring persist it. LIVE:
 * upsert a real agent_tax_profile row, read it back, clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import {
  computeSelfEmploymentTax,
  computeNetSelfEmploymentIncome,
  sumDeductibleExpenses,
  computeQuarterlyEstimates,
  buildTaxPlan,
} from "../lib/finance/tax-planning"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[self-employment tax · pure — 12.4% SS + 2.9% Medicare on 92.35% of net]")
  const se = computeSelfEmploymentTax({ netSelfEmploymentIncome: 100000 })
  check("taxable base = net × 0.9235 (92,350)", se.taxableBase === 92350)
  check("Social Security = 92,350 × 12.4% (11,451.40)", se.socialSecurity === 11451.4)
  check("Medicare = 92,350 × 2.9% (2,678.15)", se.medicare === 2678.15)
  check("total SE tax = 14,129.55", se.total === 14129.55)
  const capped = computeSelfEmploymentTax({ netSelfEmploymentIncome: 200000, socialSecurityWageBase: 170000 })
  check("SS is CAPPED at the wage base (170,000 × 12.4% = 21,080)", capped.socialSecurity === 21080)
  check("Medicare is uncapped (200,000 × 0.9235 × 2.9%)", capped.medicare === Math.round(200000 * 0.9235 * 0.029 * 100) / 100)

  console.log("\n[net income + deductible expenses · pure]")
  check("net SE income = gross − deductible (100k − 20k = 80k)", computeNetSelfEmploymentIncome(100000, 20000) === 80000)
  check("never negative", computeNetSelfEmploymentIncome(10000, 25000) === 0)
  check("deductible rollup honors percent + flag", sumDeductibleExpenses([
    { amount: 1000 }, { amount: 500, deduction_percentage: 50 }, { amount: 200, is_deductible: false },
  ]) === 1250)

  console.log("\n[quarterly estimated-tax schedule · pure — the IRS due dates]")
  const q = computeQuarterlyEstimates({ projectedAnnualTaxLiability: 12000, taxYear: 2026, paidQuarters: [1] })
  check("four equal payments (12,000 / 4 = 3,000)", q.length === 4 && q.every((x) => x.amount === 3000))
  check("Q1 due Apr 15, Q2 Jun 15, Q3 Sep 15, Q4 Jan 15 of NEXT year", q[0].dueDate === "2026-04-15" && q[1].dueDate === "2026-06-15" && q[2].dueDate === "2026-09-15" && q[3].dueDate === "2027-01-15")
  check("a recorded payment flags its quarter paid", q[0].paid === true && q[1].paid === false)

  console.log("\n[the full plan · pure — projects YTD → annual, SE + income tax, set-aside]")
  const plan = buildTaxPlan({ taxYear: 2026, ytdGrossIncome: 60000, deductibleExpenses: 10000, setAsidePercent: 25, effectiveIncomeRate: 0.12, fractionOfYearElapsed: 0.5 })
  check("net YTD = 60k − 10k = 50k", plan.netSelfEmploymentIncome === 50000)
  check("projected annual net = 50k / 0.5 = 100k", plan.projectedAnnualNetIncome === 100000)
  check("SE tax computed on the PROJECTED annual net (14,129.55)", plan.selfEmploymentTax.total === 14129.55)
  check("income tax uses net of HALF the SE tax (deductible half)", plan.estimatedIncomeTax === Math.round((100000 - 14129.55 / 2) * 0.12 * 100) / 100)
  check("total liability = SE + income tax", plan.projectedAnnualTaxLiability === Math.round((plan.selfEmploymentTax.total + plan.estimatedIncomeTax) * 100) / 100)
  check("set-aside = net YTD × 25% (12,500)", plan.setAsideAmount === 12500)
  check("four quarterly payments derived from the liability", plan.quarterly.length === 4)
  check("no fabricated bracket — income rate is the agent's own (0.12)", plan.effectiveIncomeRate === 0.12)
}

function sourceLayer() {
  console.log("\n[persistence + wiring — the calculator now SAVES (no more toast-only)]")
  const actions = src("app/actions/tax-planning.ts")
  check("getTaxPlanAction computes from real agent_commissions + business_expenses", /agent_commissions/.test(actions) && /business_expenses/.test(actions) && /buildTaxPlan/.test(actions))
  check("saveTaxProfileAction upserts agent_tax_profile", /saveTaxProfileAction[\s\S]*?agent_tax_profile[\s\S]*?upsert/.test(actions))
  check("recordQuarterlyPaymentAction persists a quarterly payment", /recordQuarterlyPaymentAction[\s\S]*?quarterly_payments/.test(actions))

  const reg = src("lib/kernel/manager-registry.ts")
  check("agent_tax_profile is owned by the Finance Manager", /agent_tax_profile:\s*"finance_manager"/.test(reg))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] upsert an agent_tax_profile, read back, clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  const { data: agent } = await svc.from("agents").select("id").limit(1).maybeSingle()
  if (!brk || !agent) { console.log("  ⊘ no brokerage/agent — skipping live"); return }
  const agentId = (agent as any).id, brokerageId = (brk as any).id
  try {
    const { error } = await svc.from("agent_tax_profile").upsert({
      agent_id: agentId, brokerage_id: brokerageId, tax_year: 1999,
      set_aside_percent: 28, estimated_effective_rate: 0.14, filing_status: "single",
      quarterly_payments: [{ quarter: 1, amount: 1000, paid_at: new Date().toISOString() }],
    }, { onConflict: "agent_id,tax_year" })
    check("live: profile upsert succeeds", !error)
    const { data: back } = await svc.from("agent_tax_profile").select("set_aside_percent, quarterly_payments").eq("agent_id", agentId).eq("tax_year", 1999).maybeSingle()
    check("live: reads back the set-aside % + quarterly payment", Number((back as any)?.set_aside_percent) === 28 && ((back as any)?.quarterly_payments?.length ?? 0) === 1)
  } finally {
    await svc.from("agent_tax_profile").delete().eq("agent_id", agentId).eq("tax_year", 1999)
    const { count } = await svc.from("agent_tax_profile").select("id", { count: "exact", head: true }).eq("agent_id", agentId).eq("tax_year", 1999)
    check("live: cleanup count == 0", (count ?? 0) === 0)
  }
}

async function main() {
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ TAX_PLANNING_FAIL"); process.exit(1) }
  console.log(" ✅ TAX_PLANNING_PASS — persistent 1099 tax planning: precise SE tax, quarterly IRS schedule, deduction-aware, set-aside")
}
main()
