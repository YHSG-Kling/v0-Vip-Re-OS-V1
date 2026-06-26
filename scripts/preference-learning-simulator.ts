#!/usr/bin/env tsx
/**
 * scripts/preference-learning-simulator.ts   (npm run test:preference-learning)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE BUYER GRAPH LOOP — proves a buyer's portal action maps to the right learning signal so
 * favoriting teaches "want", dismissing teaches "don't want", and logistics actions never skew
 * the profile. Pure: no I/O.
 */
import { interestLevelToLearningSignal } from "../lib/behavior-learning/signal-mapping"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[Portal action → learning signal]")
  check("saved → saved (+5)", interestLevelToLearningSignal("saved") === "saved")
  check("favorited → love_it (strongest want, +10)", interestLevelToLearningSignal("favorited") === "love_it")
  check("love_it (tour feedback) → love_it", interestLevelToLearningSignal("love_it") === "love_it")
  check("like_it → like_it", interestLevelToLearningSignal("like_it") === "like_it")
  check("maybe → maybe", interestLevelToLearningSignal("maybe") === "maybe")
  check("dismissed → dismissed (-3)", interestLevelToLearningSignal("dismissed") === "dismissed")
  check("not_interested → not_for_us (strongest don't-want, -5)", interestLevelToLearningSignal("not_interested") === "not_for_us")

  console.log("\n[Logistics actions never skew taste]")
  check("tour_requested → null (logistics, not taste)", interestLevelToLearningSignal("tour_requested") === null)
  check("offer_requested → null (logistics)", interestLevelToLearningSignal("offer_requested") === null)
  check("unknown → null (safe)", interestLevelToLearningSignal("something_else") === null)
  check("null input → null", interestLevelToLearningSignal(null) === null)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ PREFERENCE_LEARNING_FAIL"); process.exit(1) }
  console.log(" ✅ PREFERENCE_LEARNING_PASS — the buyer's portal favorites/dismisses now teach the system + adjust their criteria")
}

main()
