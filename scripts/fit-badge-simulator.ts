#!/usr/bin/env tsx
/**
 * scripts/fit-badge-simulator.ts   (npm run test:fit-badge)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FIT BADGE — the buyer's compatibility score, shown WHILE BROWSING. Proves the framing is
 * warm and NEVER scary: a low fit is "Some tradeoffs" (neutral slate), never a red "bad" verdict.
 * Pure: no I/O.
 */
import { fitBadgeStyle } from "../app/components/portal/FitBadge"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[Warm, confidence-building labels]")
  check("90 → Great fit", fitBadgeStyle(90).label === "Great fit")
  check("70 → Good fit", fitBadgeStyle(70).label === "Good fit")
  check("50 → Worth a look", fitBadgeStyle(50).label === "Worth a look")
  check("20 → Some tradeoffs (never 'bad')", fitBadgeStyle(20).label === "Some tradeoffs")

  console.log("\n[Never scary — a low fit is an invitation, not a red warning]")
  check("low score uses neutral slate, NOT red", !/red/.test(fitBadgeStyle(20).cls) && /slate/.test(fitBadgeStyle(20).cls))
  check("no band ever uses an alarming red class", [10, 30, 50, 70, 95].every((s) => !/red|rose|destructive/.test(fitBadgeStyle(s).cls)))
  check("high fit is celebratory green/emerald", /emerald|green/.test(fitBadgeStyle(90).cls))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ FIT_BADGE_FAIL"); process.exit(1) }
  console.log(" ✅ FIT_BADGE_PASS — match score is visible while browsing, warm and never scary")
}

main()
