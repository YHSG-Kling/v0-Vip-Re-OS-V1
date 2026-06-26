#!/usr/bin/env tsx
/**
 * scripts/comps-animation-simulator.ts   (npm run test:comps-animation)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE COMPS-ANIMATION BRAIN — proves the bar rows + fair-value read the CMAReel "this home vs
 * recent sales" animation and the agent's offer plan both depend on. Pure: no I/O, no fabrication.
 */
import { buildCompsAnimationSpec } from "../lib/video/comps-animation-spec"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

const comps = [
  { label: "10 Oak", soldPrice: 500000 },
  { label: "12 Elm", soldPrice: 520000 },
  { label: "8 Pine", soldPrice: 540000 },
]

function main() {
  console.log("\n[Rows — subject highlighted, every comp present]")
  const spec = buildCompsAnimationSpec({ subjectLabel: "9 Birch", subjectPrice: 500000, comps })
  check("subject is the first row + flagged", spec.rows[0].isSubject === true && spec.rows[0].label === "This home")
  check("all comps become rows", spec.rows.length === 4)
  check("comp median computed (520k)", spec.compMedian === 520000)

  console.log("\n[Fair-value read — grounded in the comp median]")
  check("subject ~4% below median → below_market (a deal)", buildCompsAnimationSpec({ subjectLabel: "x", subjectPrice: 500000, comps }).fairValue === "below_market")
  check("subject == median → at_market", buildCompsAnimationSpec({ subjectLabel: "x", subjectPrice: 520000, comps }).fairValue === "at_market")
  check("subject 10% above median → above_market", buildCompsAnimationSpec({ subjectLabel: "x", subjectPrice: 572000, comps }).fairValue === "above_market")
  check("within ±3% band → at_market", buildCompsAnimationSpec({ subjectLabel: "x", subjectPrice: 533000, comps }).fairValue === "at_market")
  check("below-market agent read names the median + the edge", /BELOW the comp median/.test(buildCompsAnimationSpec({ subjectLabel: "x", subjectPrice: 500000, comps }).agentRead))
  check("deltaPct signed (negative = below)", (buildCompsAnimationSpec({ subjectLabel: "x", subjectPrice: 500000, comps }).deltaPct ?? 0) < 0)

  console.log("\n[Honest — no comps, no fabrication]")
  const none = buildCompsAnimationSpec({ subjectLabel: "x", subjectPrice: 500000, comps: [] })
  check("no comps → unknown fair value", none.fairValue === "unknown")
  check("no comps → null median + null delta", none.compMedian === null && none.deltaPct === null)
  check("no comps → honest agent read (no fabricated number)", /Not enough recent comps/.test(none.agentRead))
  check("zero-priced comps ignored", buildCompsAnimationSpec({ subjectLabel: "x", subjectPrice: 500000, comps: [{ label: "bad", soldPrice: 0 }] }).fairValue === "unknown")
  check("subject price 0 → unknown (no divide-by-zero)", buildCompsAnimationSpec({ subjectLabel: "x", subjectPrice: 0, comps }).fairValue === "unknown")

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ COMPS_ANIMATION_FAIL"); process.exit(1) }
  console.log(" ✅ COMPS_ANIMATION_PASS — the 'this home vs recent sales' rows + fair-value read hold")
}

main()
