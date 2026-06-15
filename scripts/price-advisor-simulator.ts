#!/usr/bin/env tsx
/**
 * scripts/price-advisor-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the PRICE-DROP PRE-EMPTOR delta — the recommendation engine on top of the EXISTING stale-
 * listing detection. Recommends a comp-anchored reduction when a stale listing's data supports it,
 * scales by DOM + showing velocity, never drops below comps, and HONESTLY declines when price isn't
 * the problem. Pure (caller passes the already-computed DOM/showings/comp signals).
 *
 * Run: npx tsx scripts/price-advisor-simulator.ts   (npm run test:price-advisor)
 */
import { computePriceDropRecommendation } from "../lib/kernel/listing-price-advisor"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Price-drop pre-emptor verified — comp-anchored, honest, never below comps.")
  console.log(" PRICE_ADVISOR_PASS")
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Price-drop pre-emptor simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Recommendation engine]")
  // Stale + over comps + cooling showings → recommend a comp-anchored cut.
  const stale = computePriceDropRecommendation({ listPrice: 600000, daysOnMarket: 70, showingsRecent: 1, showingsPrior: 5, compMedian: 540000 })
  check("stale + over comps → recommends a reduction", stale.recommend === true && (stale.recommendedPrice ?? 0) < 600000)
  check("never recommends below the comp median (floor)", (stale.recommendedPrice ?? 0) >= 540000)
  check("high confidence with comps + DOM≥60", stale.confidence === "high")
  check("justification cites DOM + cooling velocity + comp gap", stale.justification.length === 3 && /cooling|low/i.test(stale.justification[1]))

  // Not stale yet → hold.
  const fresh = computePriceDropRecommendation({ listPrice: 600000, daysOnMarket: 12, showingsRecent: 0, showingsPrior: 0, compMedian: 540000 })
  check("fresh listing (DOM<30) → no recommendation (hold)", fresh.recommend === false && /not stale/i.test(fresh.reason))

  // Stale but priced in line with comps → honest 'not a price problem'.
  const priced = computePriceDropRecommendation({ listPrice: 545000, daysOnMarket: 80, showingsRecent: 0, showingsPrior: 1, compMedian: 540000 })
  check("stale but priced at comps → declines (exposure/condition, not price)", priced.recommend === false && /exposure or condition/i.test(priced.reason))

  // No comps → DOM/velocity-based, lower confidence, still anchored to a sensible cut.
  const noComps = computePriceDropRecommendation({ listPrice: 600000, daysOnMarket: 95, showingsRecent: 1, showingsPrior: 2 })
  check("no comp median → still recommends (DOM-based), low confidence", noComps.recommend === true && noComps.confidence === "low")
  check("a longer DOM drives a bigger cut", (noComps.dropPct ?? 0) > (computePriceDropRecommendation({ listPrice: 600000, daysOnMarket: 35, showingsRecent: 3, showingsPrior: 3 }).dropPct ?? 0))

  report()
}

main()
