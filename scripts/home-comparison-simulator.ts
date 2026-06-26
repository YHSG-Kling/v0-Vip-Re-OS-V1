#!/usr/bin/env tsx
/**
 * scripts/home-comparison-simulator.ts   (npm run test:home-comparison)
 * ─────────────────────────────────────────────────────────────────────────────
 * SIDE-BY-SIDE HOME COMPARISON — proves the decision tool buyers use to weigh their finalists in
 * OUR app: monthly payment + $/sqft + space + match, with the BEST in each row flagged (them-first
 * strengths, never a "worst"). Pure: no I/O, deterministic.
 */
import { compareHomes } from "../lib/buyer-offers/home-comparison"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

const homes = [
  { id: "a", address: "9 Oak", price: 480000, bedrooms: 3, bathrooms: 2, sqft: 2000, matchScore: 82 },
  { id: "b", address: "12 Elm", price: 525000, bedrooms: 4, bathrooms: 3, sqft: 2600, matchScore: 90 },
  { id: "c", address: "8 Pine", price: 500000, bedrooms: 3, bathrooms: 2, sqft: 1900, matchScore: 75 },
]

function main() {
  const cmp = compareHomes(homes, { downPaymentPercent: 20, annualInterestRatePct: 6.5 })

  console.log("\n[Computes the per-home numbers]")
  check("compares all three homes", cmp.count === 3 && cmp.homes.length === 3)
  check("monthly payment computed per home (>0)", cmp.homes.every((h) => h.monthlyPayment > 0))
  check("$/sqft computed (480k/2000 = $240)", cmp.homes.find((h) => h.id === "a")?.pricePerSqft === 240)
  check("caps at 4 homes", compareHomes([...homes, ...homes], {}).count === 4)

  console.log("\n[Flags the BEST in each dimension — them-first strengths]")
  const byId = (id: string) => cmp.homes.find((h) => h.id === id)!
  check("lowest price → lowest payment flagged (9 Oak)", byId("a").highlights.includes("Lowest payment"))
  check("best value per sqft flagged (12 Elm, $202/sqft is lowest)", byId("b").highlights.includes("Best value per sq ft"))
  check("most space flagged (12 Elm, 2600 sqft)", byId("b").highlights.includes("Most space"))
  check("best fit flagged (12 Elm, match 90)", byId("b").highlights.includes("Best fit for you"))
  check("no home is ever labeled 'worst' (only strengths)", cmp.homes.every((h) => h.highlights.every((x) => !/worst|bad|overpriced/i.test(x))))

  console.log("\n[Honest edges]")
  check("a TIE crowns no winner (don't pick arbitrarily)", (() => {
    const tied = compareHomes([{ id: "x", address: "X", price: 500000, sqft: 2000 }, { id: "y", address: "Y", price: 500000, sqft: 2000 }], {})
    return tied.homes.every((h) => !h.highlights.includes("Lowest payment"))
  })())
  check("missing sqft → null $/sqft (no fabrication)", compareHomes([{ id: "z", address: "Z", price: 500000 }, { id: "w", address: "W", price: 400000 }], {}).homes[0].pricePerSqft === null)
  check("under 2 homes → nothing flagged", compareHomes([homes[0]], {}).homes[0].highlights.length === 0)
  check("drops price-less/invalid homes", compareHomes([{ id: "bad", address: "B", price: 0 }, homes[0]], {}).count === 1)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ HOME_COMPARISON_FAIL"); process.exit(1) }
  console.log(" ✅ HOME_COMPARISON_PASS — buyers weigh their finalists by the numbers, in our app, them-first")
}

main()
