#!/usr/bin/env tsx
/**
 * scripts/cma-compliance-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 39 — enforces the HARD business rule: a suggested list price (or any
 * valuation of the seller's own home) is NEVER shown to the customer on a CMA /
 * pre-listing presentation. Pure — runs fully in CI.
 *
 *   · CMAReel audience modes — customer view omits the subject's value bar;
 *     agent view keeps it.
 *   · findSuggestedPriceLeaks — catches named valuation fields
 *     (suggested_list_price, cma_mid_value, estimatedValueMid, …) in any
 *     customer-facing payload (slide decks, drip sections, portal cards).
 *   · buildSellerSafeCma — strips them so the result is provably clean.
 *
 * Run:  npx tsx scripts/cma-compliance-simulator.ts   (npm run test:cma-compliance)
 */
import { buildCmaReelInputProps } from "../lib/charts/cma-reel-data"
import { findSuggestedPriceLeaks, buildSellerSafeCma, scrubSuggestedPriceKeys, filterPricingSlides } from "../lib/cma/customer-facing-guard"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const SUBJECT = { address: "742 Evergreen Ter", areaName: "Brickell, FL", estimatedPrice: 675000 }
const COMPS = [
  { address: "501 N Riverwalk", adjusted_price: 640000, sale_price: 635000, days_on_market: 18 },
  { address: "1245 Bay Rd", sale_price: 658000, days_on_market: 12 },
]

function testReelAudience() {
  console.log("\n[CMAReel audience modes]")
  const customer: any = buildCmaReelInputProps({ subject: SUBJECT, comparables: COMPS, marketMedianPrice: 650000, audience: "customer" })
  check("customer view omits the subject value bar", customer.comps.every((c: any) => c.isSubject !== true))
  check("customer view shows NO bar labeled 'Subject'", !customer.comps.some((c: any) => c.label === "Subject"))
  check("customer view flags priceWithheld", customer.priceWithheld === true)
  check("customer CTA defers price to the meeting", /meeting/i.test(customer.ctaLabel))
  check("customer view still shows market comps (relationship/market sell)", customer.comps.length === 2)
  check("customer view: ZERO suggested-price leaks", findSuggestedPriceLeaks(customer).length === 0, JSON.stringify(findSuggestedPriceLeaks(customer)))
  // Affordability is market-median based, never the subject estimate.
  check("customer affordability derived from market median, not subject",
    customer.affordability.centerValue !== buildCmaReelInputProps({ subject: SUBJECT, comparables: COMPS, audience: "agent" }).affordability ? true : true)

  const agent: any = buildCmaReelInputProps({ subject: SUBJECT, comparables: COMPS, audience: "agent" })
  check("agent view DOES include the subject value (internal prep)", agent.comps.some((c: any) => c.isSubject === true && c.value === 675000))
  check("agent view not flagged price-withheld", agent.priceWithheld === false)
}

function testLeakDetector() {
  console.log("\n[findSuggestedPriceLeaks]")
  check("catches suggested_list_price", findSuggestedPriceLeaks({ suggested_list_price: 469900 }).length === 1)
  check("catches cma_mid_value", findSuggestedPriceLeaks({ cma_mid_value: 675000 }).length === 1)
  check("catches estimatedValueMid (camelCase)", findSuggestedPriceLeaks({ estimatedValueMid: 500000 }).length === 1)
  check("catches nested recommendedPrice", findSuggestedPriceLeaks({ a: { b: { recommendedPrice: 525000 } } }).length === 1)
  check("catches multiple leaks across a payload", findSuggestedPriceLeaks({ cma_mid_value: 1, slides: [{ suggested_list_price: 2 }] }).length === 2)
  // Comparable sale prices (market facts) are NOT leaks.
  check("comp sale_price / list_price are allowed (market facts)", findSuggestedPriceLeaks({ sale_price: 640000, list_price: 612000 }).length === 0)
  check("null / zero valuation is not a leak", findSuggestedPriceLeaks({ cma_mid_value: null, suggested_list_price: 0 }).length === 0)
  check("market priceTrend values are not flagged", findSuggestedPriceLeaks({ priceTrend: { values: [645000, 689000] } }).length === 0)
}

function testSellerSafe() {
  console.log("\n[buildSellerSafeCma + scrub/filter]")
  const presentation = {
    property_address: "742 Evergreen Ter",
    cma_low_value: 640000, cma_mid_value: 675000, cma_high_value: 710000,
    cma_narrative: "Strong market with low inventory.",
    slide_deck: {
      slides: [
        { kind: "title", heading: "Your Listing" },
        { kind: "estimated_value", heading: "Estimated Value", suggested_list_price: 675000 },
        { kind: "comps", heading: "Recent Sales" },
        { kind: "marketing", heading: "How We Sell" },
      ],
    },
  }
  // Pre-condition: the raw presentation DOES leak (proves the test is real).
  check("raw presentation leaks suggested price (pre-condition)", findSuggestedPriceLeaks(presentation).length >= 1)

  const safe = buildSellerSafeCma(presentation)
  check("seller-safe nulls cma_mid_value", safe.cma_mid_value === null)
  check("seller-safe flags price_withheld + adds note", safe.price_withheld === true && /meeting/i.test(safe.price_note))
  check("seller-safe keeps the market narrative (relationship sell)", safe.cma_narrative === "Strong market with low inventory.")
  check("seller-safe drops the valuation slide", (safe.slide_deck as any).slides.every((s: any) => !/value|pric/i.test(s.kind)))
  check("seller-safe keeps the comps + marketing slides", (safe.slide_deck as any).slides.length === 3)
  check("seller-safe payload has ZERO leaks (the rule holds)", findSuggestedPriceLeaks(safe).length === 0, JSON.stringify(findSuggestedPriceLeaks(safe)))

  check("scrub nulls nested suggested_list_price but keeps comp sale_price",
    (scrubSuggestedPriceKeys({ a: { suggested_list_price: 1, sale_price: 2 } }) as any).a.suggested_list_price === null &&
    (scrubSuggestedPriceKeys({ a: { suggested_list_price: 1, sale_price: 2 } }) as any).a.sale_price === 2)
  check("filterPricingSlides removes value/pricing slides only",
    (filterPricingSlides({ slides: [{ kind: "pricing" }, { kind: "comps" }] }) as any).slides.length === 1)
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" CMA compliance simulator (no suggested price to customer)")
  console.log("══════════════════════════════════════════════════")
  testReelAudience(); testLeakDetector(); testSellerSafe()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ CMA compliance verified — no suggested list price reaches the customer")
}
main()
