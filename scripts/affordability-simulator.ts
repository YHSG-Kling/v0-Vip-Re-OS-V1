#!/usr/bin/env tsx
/**
 * scripts/affordability-simulator.ts   (npm run test:affordability)
 * ─────────────────────────────────────────────────────────────────────────────
 * BUYER SELF-SERVE AFFORDABILITY — proves the exact mortgage math + the honest verdict the
 * portal tool shows a buyer on a property they like. Pure: no I/O, deterministic.
 */
// Wave 156 (156H round 2): the payment math moved to the ONE engine (lib/calculators/buyer-payment.ts buyerPaymentFor over
// lib/calculators/engine.ts "buyer_payment"); estimateMonthlyPayment and AFFORDABILITY_DEFAULTS are tombstones. The same exact
// amortization is proven here on the buyer's OWN figures, plus the rule that a blank figure is asked for, never defaulted.
import { affordabilityRead, preApprovalStatus, clientAffordabilityFraming } from "../lib/buyer-offers/affordability"
import { buyerPaymentFor } from "../lib/calculators/buyer-payment"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol

function main() {
  console.log("\n[Monthly payment — exact amortization, on the buyer's own figures]")
  // $500k, 20% down ($100k), 6.5%/30yr → P&I on $400k ≈ $2,528.27; tax 1.1% of price; insurance $1,750/yr
  const r = buyerPaymentFor(500000, { downPaymentPct: 20, ratePct: 6.5, termYears: 30, propertyTaxRatePct: 1.1, annualInsurance: 1750 })
  const line = (o: any, k: string) => o.lines.find((l: any) => l.key === k)?.amount ?? NaN
  check("computes on complete figures", r.ok === true)
  const m = r as any
  check("loan amount = price − down", m.outputs.loanAmount === 400000)
  check("P&I matches the amortization formula (~$2,528)", near(line(m, "principalInterest"), 2528.27, 1))
  check("property tax monthly = price·1.1%/12 (~$458)", near(line(m, "propertyTax"), 458.33, 1))
  check("insurance monthly = $1,750/12 (~$146)", near(line(m, "insurance"), 145.83, 1))
  check("mortgage insurance is not included unless the buyer enters it (said in a note)", line(m, "mortgageInsurance") === 0 && m.notes.some((n: string) => /Mortgage insurance is not included/.test(n)))
  check("total = sum of the lines", near(m.outputs.monthlyTotal, m.lines.reduce((s: number, l: any) => s + l.amount, 0), 0.5))

  console.log("\n[No default — a blank figure is asked for]")
  const blank = buyerPaymentFor(500000, { downPaymentPct: 10 })
  check("blank rate / term / tax / insurance → 'Enter a value' for each, no payment", blank.ok === false && ["ratePct", "termYears", "property_tax", "annualInsurance"].every((k) => (blank as any).missing.some((x: any) => x.key === k)))

  console.log("\n[Edge cases — honest, no NaN]")
  check("0% rate degrades to P/n (no divide-by-zero)", line(buyerPaymentFor(360000, { downPaymentPct: 0, ratePct: 0, termYears: 30, propertyTaxRatePct: 0, annualInsurance: 0 }), "principalInterest") === 1000)
  check("cash (100% down) → no loan, no P&I", line(buyerPaymentFor(500000, { downPaymentPct: 100, ratePct: 6.5, termYears: 30, propertyTaxRatePct: 1, annualInsurance: 1200 }), "principalInterest") === 0)
  const zero = buyerPaymentFor(0, { downPaymentPct: 0, ratePct: 6.5, termYears: 30, propertyTaxRatePct: 1, annualInsurance: 0 }) as any
  check("price 0 → all zeros (no NaN)", zero.ok === true && zero.outputs.monthlyTotal === 0)

  console.log("\n[Affordability verdict — honest against pre-approval + budget]")
  check("price over pre-approval → over_budget", affordabilityRead({ price: 550000, monthlyTotal: 3500, preApprovalAmount: 500000 }).verdict === "over_budget")
  check("within pre-approval, no budget → within_budget", affordabilityRead({ price: 480000, monthlyTotal: 3000, preApprovalAmount: 500000 }).verdict === "within_budget")
  check("headroom to pre-approval computed", affordabilityRead({ price: 480000, monthlyTotal: 3000, preApprovalAmount: 500000 }).headroomToPreApproval === 20000)
  check("monthly within budget → within_budget", affordabilityRead({ price: 480000, monthlyTotal: 2800, preApprovalAmount: 500000, maxMonthlyBudget: 3000 }).verdict === "within_budget")
  check("over budget but within the buyer's OWN stretch figure → stretch (no invented 10% band)", affordabilityRead({ price: 480000, monthlyTotal: 3200, preApprovalAmount: 500000, maxMonthlyBudget: 3000, stretchMonthlyBudget: 3300 }).verdict === "stretch" && affordabilityRead({ price: 480000, monthlyTotal: 3200, preApprovalAmount: 500000, maxMonthlyBudget: 3000 }).verdict === "over_budget")
  check("monthly far over budget → over_budget", affordabilityRead({ price: 480000, monthlyTotal: 4000, preApprovalAmount: 500000, maxMonthlyBudget: 3000 }).verdict === "over_budget")
  check("no pre-approval + no budget → unknown (honest)", affordabilityRead({ price: 480000, monthlyTotal: 3000 }).verdict === "unknown")

  console.log("\n[Pre-approval status — an expired approval is not a real ceiling]")
  const NOW = new Date("2026-06-26T12:00:00Z")
  const inDays = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString()
  check("no amount → none", preApprovalStatus(null, null, NOW).state === "none")
  check("amount, no expiry → active (can't claim stale without a date)", preApprovalStatus(450000, null, NOW).state === "active")
  check("expires in 90d → active", preApprovalStatus(450000, inDays(90), NOW).state === "active")
  check("expires in 20d → expiring", preApprovalStatus(450000, inDays(20), NOW).state === "expiring")
  check("expired yesterday → expired", preApprovalStatus(450000, inDays(-1), NOW).state === "expired")
  check("expiring carries daysToExpiry", preApprovalStatus(450000, inDays(20), NOW).daysToExpiry === 20)

  console.log("\n[Client-safe framing — warm + agent-routing, NEVER a scary 'over budget' wall]")
  const over = clientAffordabilityFraming("over_budget")
  check("over_budget is NOT labeled 'over budget' to the client", !/over budget/i.test(over.label))
  check("over_budget tone is never an alarm (soft, not red)", over.tone === "soft")
  check("over_budget routes to the agent (conversation, not a dead end)", /agent/i.test(over.line))
  check("within_budget reads encouraging (good tone)", clientAffordabilityFraming("within_budget").tone === "good")
  check("stretch is 'worth a conversation', soft tone", clientAffordabilityFraming("stretch").tone === "soft" && /conversation/i.test(clientAffordabilityFraming("stretch").label))
  check("unknown nudges to get the real numbers with the agent", /agent/i.test(clientAffordabilityFraming("unknown").line))
  check("no framing line uses a scary word (can't afford / denied / rejected)", (["within_budget","stretch","over_budget","unknown"] as const).every((v) => !/can.?t afford|denied|rejected|too expensive/i.test(clientAffordabilityFraming(v).line)))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ AFFORDABILITY_FAIL"); process.exit(1) }
  console.log(" ✅ AFFORDABILITY_PASS — the buyer's self-serve affordability math + honest verdict hold")
}

main()
