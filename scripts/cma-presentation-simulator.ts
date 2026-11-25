#!/usr/bin/env tsx
/**
 * scripts/cma-presentation-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure-core simulator for the CMA & Listing Presentation engine
 * (app/actions/cma-presentation). The only genuinely PURE, side-effect-free
 * logic in that engine is the per-scenario net-sheet arithmetic. It was
 * extracted to lib/cma/net-sheet-math.ts (computeNetSheetScenario); wave 156
 * (lane 156H, round 4) retired that second seller net onto the ONE engine —
 * lib/calculators/engine.ts sellerNetScenario → runCalculator("seller_net_sheet")
 * — which the server action `calculateScenario` now calls.
 *
 * Everything else in the engine is DB/AI I/O (generateCMA → generateAICMA,
 * activities inserts, presentation-assembler, video project creation) and is
 * NOT unit-simulatable without mocks — so this harness asserts ONLY the pure
 * math, with real assertions, no mocks, no DB. Rates are PERCENTS a person
 * entered; a figure nobody entered is ASKED for, never defaulted.
 *
 * Run:  npx tsx scripts/cma-presentation-simulator.ts
 */

import { sellerNetScenario, scenarioPrice } from "../lib/calculators/engine"

let passed = 0
let failed = 0

function assert(cond: boolean, label: string) {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.error(`  ✗ ${label}`)
  }
}

const near = (a: number | null, b: number) => a != null && Math.abs(a - b) < 0.01
const internal = { audience: "internal" as const }

console.log("CMA Presentation — net-sheet scenarios through the one engine\n")

console.log("Scenario 1: $500k, 3% listing, 3% buyer-broker, $10,000 closing quote, $200k payoff")
{
  const s = sellerNetScenario("Primary", { salePrice: 500_000, listingCommissionPct: 3, buyerBrokerCompPct: 3, closingCosts: 10_000, mortgagePayoff: 200_000 }, internal)
  assert(near(s.breakdown.listingCommission, 15_000), "listing commission = 3% = $15,000")
  assert(near(s.breakdown.buyerCommission, 15_000), "buyer-broker compensation = 3% = $15,000")
  assert(near(s.breakdown.closingCosts, 10_000), "closing costs = the $10,000 quote")
  assert(near(s.totalCosts, 240_000), "total costs = $240,000")
  assert(near(s.netProceeds, 260_000), "net proceeds = $260,000")
  assert(s.grossProceeds === s.salePrice && s.missing.length === 0, "grossProceeds equals salePrice; nothing missing")
}

console.log("\nScenario 2: MISSING title / settlement quote → asked for, no net")
{
  const s = sellerNetScenario("No quote", { salePrice: 400_000, listingCommissionPct: 2.5, mortgagePayoff: 0 }, internal)
  assert(s.netProceeds === null && s.totalCosts === null, "no closing figure → net is null (no percent of price is assumed)")
  assert(s.missing.some((m) => /title, escrow/i.test(m)), `the title / settlement figure is asked for (${s.missing.join("; ")})`)
}

console.log("\nScenario 3: ZERO commission and $0 closing are honored, not treated as missing")
{
  const s = sellerNetScenario("Zero", { salePrice: 300_000, listingCommissionPct: 0, closingCosts: 0, mortgagePayoff: 0 }, internal)
  assert(near(s.breakdown.listingCommission, 0) && near(s.breakdown.closingCosts, 0), "0% commission and $0 closing honored")
  assert(near(s.netProceeds, 300_000), "net proceeds = full sale price")
}

console.log("\nScenario 4: MISSING commission → asked for (no house rate)")
{
  const s = sellerNetScenario("No commission", { salePrice: 300_000, closingCosts: 3_000, mortgagePayoff: 0 }, internal)
  assert(s.netProceeds === null && s.missing.some((m) => /commission/i.test(m)), `the listing commission is asked for (${s.missing.join("; ")})`)
}

console.log("\nScenario 5: every cost line is summed; a PRORATION CREDIT adds to the net")
{
  const s = sellerNetScenario("Full", {
    salePrice: 600_000, listingCommissionPct: 3, buyerBrokerCompPct: 3, closingCosts: 1_000, mortgagePayoff: 100_000,
    propertyTaxes: 2_000, hoaFees: 500, repairCredits: 3_000, sellerConcessions: 4_000, transactionFee: 395, creditsToSeller: 1_200,
  }, internal)
  const expectedTotal = 18_000 + 18_000 + 1_000 + 100_000 + 2_000 + 500 + 3_000 + 4_000 + 395
  assert(near(s.totalCosts, expectedTotal), `total costs = $${expectedTotal.toLocaleString()}`)
  assert(near(s.totalCredits, 1_200) && near(s.breakdown.creditsToSeller, 1_200), "the proration credit is its own credit line")
  assert(near(s.netProceeds, 600_000 - expectedTotal + 1_200), "net = sale − costs + credits")
}

console.log("\nScenario 6: conservative (−5%) vs optimistic (+5%) — whole-percent offsets; fixed dollars stay fixed")
{
  const lo = scenarioPrice(500_000, -5), hi = scenarioPrice(500_000, 5)
  assert(lo === 475_000 && hi === 525_000, "scenario prices 475,000 / 525,000")
  const c = sellerNetScenario("Cons", { salePrice: lo, listingCommissionPct: 3, buyerBrokerCompPct: 3, closingCosts: 10_000, mortgagePayoff: 0 }, internal)
  const o = sellerNetScenario("Opt", { salePrice: hi, listingCommissionPct: 3, buyerBrokerCompPct: 3, closingCosts: 10_000, mortgagePayoff: 0 }, internal)
  assert(near(c.netProceeds, 475_000 - 28_500 - 10_000), "conservative net = 436,500")
  assert(near(o.netProceeds, 525_000 - 31_500 - 10_000), "optimistic net = 483,500")
}

console.log("\nScenario 7: the brokerage's agreed term (internal seat) prices the commission; a public estimate refuses it")
{
  const agreed = { listingRatePct: null, flatAmount: 4_995, label: "Flat fee per listing agreement" }
  const s = sellerNetScenario("Flat", { salePrice: 500_000, closingCosts: 5_000, mortgagePayoff: 0 }, { audience: "internal", agreedCommission: agreed })
  assert(near(s.breakdown.listingCommission, 4_995) && near(s.netProceeds, 500_000 - 4_995 - 5_000), "flat agreed fee charged as-is")
  assert(s.assumptions.some((a) => a.basis === "brokerage_agreement"), "labeled as the brokerage agreement")
  const pub = sellerNetScenario("Flat", { salePrice: 500_000, closingCosts: 5_000, mortgagePayoff: 0 }, { audience: "public", agreedCommission: agreed })
  assert(pub.netProceeds === null, "internal commission terms never enter a public estimate")
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
