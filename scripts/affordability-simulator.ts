#!/usr/bin/env tsx
/**
 * scripts/affordability-simulator.ts   (npm run test:affordability)
 * ─────────────────────────────────────────────────────────────────────────────
 * BUYER SELF-SERVE AFFORDABILITY — proves the exact mortgage math + the honest verdict the
 * portal tool shows a buyer on a property they like. Pure: no I/O, deterministic.
 */
import { estimateMonthlyPayment, affordabilityRead } from "../lib/buyer-offers/affordability"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol

function main() {
  console.log("\n[Monthly payment — exact amortization]")
  // $500k, 20% down ($100k), 6.5%/30yr → P&I on $400k ≈ $2,528.27
  const m = estimateMonthlyPayment({ price: 500000, downPaymentPercent: 20, annualInterestRatePct: 6.5, loanTermYears: 30, propertyTaxRatePct: 1.1, annualInsuranceRatePct: 0.35, hoaMonthly: 0 })
  check("loan amount = price − down", m.loanAmount === 400000 && m.downPayment === 100000)
  check("P&I matches the amortization formula (~$2,528)", near(m.principalInterest, 2528.27, 1))
  check("property tax monthly = price·1.1%/12 (~$458)", near(m.propertyTax, 458.33, 1))
  check("insurance monthly = price·0.35%/12 (~$146)", near(m.insurance, 145.83, 1))
  check("no PMI at 20% down", m.pmi === 0)
  check("total = PITI sum", near(m.total, m.principalInterest + m.propertyTax + m.insurance + m.hoa, 0.5))

  console.log("\n[PMI kicks in under 20% down]")
  const lowDown = estimateMonthlyPayment({ price: 500000, downPaymentPercent: 10, annualInterestRatePct: 6.5 })
  check("PMI > 0 when down < 20%", lowDown.pmi > 0)

  console.log("\n[Edge cases — honest, no NaN]")
  check("0% rate degrades to P/n (no divide-by-zero)", estimateMonthlyPayment({ price: 360000, downPaymentPercent: 0, annualInterestRatePct: 0, loanTermYears: 30 }).principalInterest === 1000)
  check("cash (100% down) → no loan, no P&I", estimateMonthlyPayment({ price: 500000, downPaymentPercent: 100 }).principalInterest === 0)
  check("price 0 → all zeros (no NaN)", estimateMonthlyPayment({ price: 0 }).total === 0)

  console.log("\n[Affordability verdict — honest against pre-approval + budget]")
  check("price over pre-approval → over_budget", affordabilityRead({ price: 550000, monthlyTotal: 3500, preApprovalAmount: 500000 }).verdict === "over_budget")
  check("within pre-approval, no budget → within_budget", affordabilityRead({ price: 480000, monthlyTotal: 3000, preApprovalAmount: 500000 }).verdict === "within_budget")
  check("headroom to pre-approval computed", affordabilityRead({ price: 480000, monthlyTotal: 3000, preApprovalAmount: 500000 }).headroomToPreApproval === 20000)
  check("monthly within budget → within_budget", affordabilityRead({ price: 480000, monthlyTotal: 2800, preApprovalAmount: 500000, maxMonthlyBudget: 3000 }).verdict === "within_budget")
  check("monthly ≤10% over budget → stretch", affordabilityRead({ price: 480000, monthlyTotal: 3200, preApprovalAmount: 500000, maxMonthlyBudget: 3000 }).verdict === "stretch")
  check("monthly far over budget → over_budget", affordabilityRead({ price: 480000, monthlyTotal: 4000, preApprovalAmount: 500000, maxMonthlyBudget: 3000 }).verdict === "over_budget")
  check("no pre-approval + no budget → unknown (honest)", affordabilityRead({ price: 480000, monthlyTotal: 3000 }).verdict === "unknown")

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ AFFORDABILITY_FAIL"); process.exit(1) }
  console.log(" ✅ AFFORDABILITY_PASS — the buyer's self-serve affordability math + honest verdict hold")
}

main()
