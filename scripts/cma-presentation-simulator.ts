#!/usr/bin/env tsx
/**
 * scripts/cma-presentation-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure-core simulator for the CMA & Listing Presentation engine
 * (app/actions/cma-presentation). The only genuinely PURE, side-effect-free
 * logic in that engine is the per-scenario net-sheet arithmetic, which was
 * extracted to lib/cma/net-sheet-math.ts (computeNetSheetScenario). The server
 * action `calculateScenario` now delegates to it verbatim.
 *
 * Everything else in the engine is DB/AI I/O (generateCMA → generateAICMA,
 * activities inserts, presentation-assembler, video project creation) and is
 * NOT unit-simulatable without mocks — so this harness asserts ONLY the pure
 * math, with real assertions, no mocks, no DB.
 *
 * Run:  npx tsx scripts/cma-presentation-simulator.ts
 */

import { computeNetSheetScenario } from "../lib/cma/net-sheet-math"

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

function approx(a: number, b: number, eps = 1e-6) {
  return Math.abs(a - b) < eps
}

console.log("CMA Presentation — pure net-sheet math simulator\n")

// ── Scenario 1: canonical 3% / 3% / 2% on a $500k sale, $200k payoff ─────────
console.log("Scenario 1: $500k, 3% listing, 3% buyer, 2% closing, $200k payoff")
{
  const s = computeNetSheetScenario(
    "Primary",
    500_000,
    { mortgageBalance: 200_000 },
    0.03,
    0.03,
    0.02,
  )
  assert(approx(s.breakdown.listingCommission, 15_000), "listing commission = 3% = $15,000")
  assert(approx(s.breakdown.buyerCommission, 15_000), "buyer commission = 3% = $15,000")
  assert(approx(s.breakdown.closingCosts, 10_000), "closing costs = 2% = $10,000")
  assert(approx(s.breakdown.mortgagePayoff, 200_000), "mortgage payoff = $200,000")
  // total costs = 15k + 15k + 10k + 200k = 240k
  assert(approx(s.totalCosts, 240_000), "total costs = $240,000")
  // net = 500k - 240k = 260k
  assert(approx(s.netProceeds, 260_000), "net proceeds = $260,000")
  assert(s.grossProceeds === s.salePrice, "grossProceeds equals salePrice")
}

// ── Scenario 2: fixed-dollar closing costs override the percent ──────────────
console.log("\nScenario 2: fixed closingCosts override the percent")
{
  const s = computeNetSheetScenario(
    "Fixed closing",
    400_000,
    { closingCosts: 5_000 },
    0.025,
    0.025,
    0.02, // would be 8,000 if used — must be ignored
  )
  assert(approx(s.breakdown.closingCosts, 5_000), "fixed $5,000 used, percent ignored")
  assert(approx(s.breakdown.listingCommission, 10_000), "listing commission = 2.5% = $10,000")
  assert(approx(s.breakdown.buyerCommission, 10_000), "buyer commission = 2.5% = $10,000")
  // total = 10k + 10k + 5k = 25k ; net = 375k
  assert(approx(s.totalCosts, 25_000), "total costs = $25,000")
  assert(approx(s.netProceeds, 375_000), "net proceeds = $375,000")
}

// ── Scenario 3: zero closingCosts ($0) is honored, not treated as missing ────
console.log("\nScenario 3: explicit $0 closing costs is honored (??, not ||)")
{
  const s = computeNetSheetScenario(
    "Zero closing",
    300_000,
    { closingCosts: 0 },
    0,
    0,
    0.02, // 6,000 if it leaked through
  )
  assert(approx(s.breakdown.closingCosts, 0), "explicit $0 closing costs honored (not $6,000)")
  assert(approx(s.totalCosts, 0), "total costs = $0 with no other costs")
  assert(approx(s.netProceeds, 300_000), "net proceeds = full sale price")
}

// ── Scenario 4: mortgagePayoffAmount takes precedence over mortgageBalance ────
console.log("\nScenario 4: mortgagePayoffAmount precedence over mortgageBalance")
{
  const s = computeNetSheetScenario(
    "Payoff precedence",
    500_000,
    { mortgagePayoffAmount: 123_456, mortgageBalance: 999_999 },
    0,
    0,
    0,
  )
  assert(approx(s.breakdown.mortgagePayoff, 123_456), "payoffAmount wins over balance")
}

// ── Scenario 5: all cost lines roll into totalCosts and net ──────────────────
console.log("\nScenario 5: every cost line is summed")
{
  const s = computeNetSheetScenario(
    "Full costs",
    600_000,
    {
      closingCosts: 1_000,
      mortgageBalance: 100_000,
      propertyTaxes: 2_000,
      hoaFees: 500,
      repairCredits: 3_000,
      sellerConcessions: 4_000,
    },
    0.03, // 18,000
    0.03, // 18,000
    0.02,
  )
  const expectedTotal =
    18_000 + 18_000 + 1_000 + 100_000 + 2_000 + 500 + 3_000 + 4_000
  assert(approx(s.totalCosts, expectedTotal), `total costs = $${expectedTotal.toLocaleString()}`)
  assert(approx(s.netProceeds, 600_000 - expectedTotal), "net proceeds = sale - total costs")
  assert(s.breakdown.otherCosts === 0, "otherCosts is always 0 (reserved)")
}

// ── Scenario 6: conservative/optimistic price swings (the -5% / +5% the action runs) ─
console.log("\nScenario 6: conservative (-5%) vs optimistic (+5%) net swing")
{
  const base = 500_000
  const conservative = computeNetSheetScenario("Cons", base * 0.95, {}, 0.03, 0.03, 0.02)
  const optimistic = computeNetSheetScenario("Opt", base * 1.05, {}, 0.03, 0.03, 0.02)
  // net at price p with 8% total cost rate = p * 0.92
  assert(approx(conservative.netProceeds, base * 0.95 * 0.92), "conservative net = price*0.92")
  assert(approx(optimistic.netProceeds, base * 1.05 * 0.92), "optimistic net = price*0.92")
  assert(optimistic.netProceeds > conservative.netProceeds, "higher price yields higher net")
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
