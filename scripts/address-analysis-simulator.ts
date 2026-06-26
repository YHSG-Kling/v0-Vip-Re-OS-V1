#!/usr/bin/env tsx
/**
 * scripts/address-analysis-simulator.ts   (npm run test:address-analysis)
 * ─────────────────────────────────────────────────────────────────────────────
 * ADDRESS-DRIVEN TOOLKIT — proves the combiner that turns a free spec lookup + AVM into the
 * buyer-facing analysis the affordability tool runs on. Honest about confidence, never fabricated.
 */
import { buildAddressAnalysis } from "../lib/buyer-offers/address-analysis"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[Full data → usable analysis]")
  const a = buildAddressAnalysis(
    { beds: 3, baths: 2, sqft: 2000, propertyType: "single_family", dataConfidence: "high" },
    { value: 525000, confidence: 0.8, source: "rentcast" },
  )
  check("estimated value carried + rounded", a.estimatedValue === 525000)
  check("specs carried", a.beds === 3 && a.baths === 2 && a.sqft === 2000)
  check("hasUsableValue true (affordability can run)", a.hasUsableValue === true)
  check("high-confidence note is confident (not 'rough')", !/rough/.test(a.estimateNote) && /estimate/.test(a.estimateNote))

  console.log("\n[Low confidence → softened estimate note]")
  const low = buildAddressAnalysis({ beds: 3, baths: 2, sqft: null, propertyType: null, dataConfidence: "low" }, { value: 400000, confidence: 0.4, source: "osint" })
  check("low confidence → 'rough estimate' framing", /rough estimate/.test(low.estimateNote))
  check("still usable (has a value)", low.hasUsableValue === true)

  console.log("\n[No AVM → no usable value, honest (no fabrication)]")
  const noAvm = buildAddressAnalysis({ beds: 4, baths: 3, sqft: 2400, propertyType: "single_family", dataConfidence: "high" }, null)
  check("no value → hasUsableValue false", noAvm.hasUsableValue === false && noAvm.estimatedValue === null)
  check("note routes to the agent for the real numbers", /agent/.test(noAvm.estimateNote))
  check("specs still shown without a value", noAvm.beds === 4 && noAvm.sqft === 2400)

  console.log("\n[Junk AVM ignored]")
  check("zero/negative value → not usable", buildAddressAnalysis(null, { value: 0, confidence: 0.9, source: "rentcast" }).hasUsableValue === false)
  check("null lookup → degrades, never crashes", buildAddressAnalysis(null, { value: 500000, confidence: 0.7, source: "cached" }).estimatedValue === 500000)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ ADDRESS_ANALYSIS_FAIL"); process.exit(1) }
  console.log(" ✅ ADDRESS_ANALYSIS_PASS — any address → estimated value + specs + affordability, honestly framed")
}

main()
