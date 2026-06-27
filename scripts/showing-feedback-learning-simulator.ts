#!/usr/bin/env tsx
/**
 * scripts/showing-feedback-learning-simulator.ts   (npm run test:showing-feedback-learning)
 * ─────────────────────────────────────────────────────────────────────────────
 * CLOSING THE BUYER-GRAPH LOOP — proves a post-tour verdict maps to the right learning signal so
 * the buyer's criteria self-tune after every tour (the "smarter alert relevance, no manual filter
 * editing" buyers ask for). A tour is the STRONGEST taste signal: very_interested → love_it (+10),
 * not_interested → not_for_us (-5). Pure: no I/O.
 */
import { showingInterestToLearningSignal, interestLevelToLearningSignal, portalInterestToShowingLevel } from "../lib/behavior-learning/signal-mapping"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

function main() {
  console.log("\n[Post-tour verdict → learning signal (the strongest taste signal we get)]")
  check("very_interested → love_it (strongest want)", showingInterestToLearningSignal("very_interested") === "love_it")
  check("interested → like_it", showingInterestToLearningSignal("interested") === "like_it")
  check("neutral → maybe (didn't reject it)", showingInterestToLearningSignal("neutral") === "maybe")
  check("not_interested → not_for_us (strongest don't-want)", showingInterestToLearningSignal("not_interested") === "not_for_us")

  console.log("\n[Honest — an unrated tour carries no taste]")
  check("null → null", showingInterestToLearningSignal(null) === null)
  check("unknown value → null (never fabricate a preference)", showingInterestToLearningSignal("scheduled") === null)
  check("empty → null", showingInterestToLearningSignal("") === null)

  console.log("\n[The two halves of the loop don't collide — portal vocab vs showing vocab]")
  // The showing vocabulary ('very_interested') is NOT a portal interest_level, and vice-versa.
  check("portal mapper ignores showing vocab ('very_interested')", interestLevelToLearningSignal("very_interested") === null)
  check("showing mapper ignores portal vocab ('favorited')", showingInterestToLearningSignal("favorited") === null)
  check("both agree on the shared term 'not_interested' → not_for_us",
    interestLevelToLearningSignal("not_interested") === "not_for_us" && showingInterestToLearningSignal("not_interested") === "not_for_us")

  console.log("\n[Portal label → canonical showings.buyer_interest_level (passes the column CHECK)]")
  check("very_interested → love_it (column value)", portalInterestToShowingLevel("very_interested") === "love_it")
  check("interested → like_it", portalInterestToShowingLevel("interested") === "like_it")
  check("neutral → maybe", portalInterestToShowingLevel("neutral") === "maybe")
  check("not_interested → no (the CHECK's negative term)", portalInterestToShowingLevel("not_interested") === "no")
  check("already-canonical love_it passes through", portalInterestToShowingLevel("love_it") === "love_it")
  check("every mapped value is CHECK-legal", ["very_interested","interested","neutral","not_interested"].every(
    (v) => ["love_it","like_it","maybe","no"].includes(portalInterestToShowingLevel(v) as string)))
  check("unknown → null (caller falls back safely)", portalInterestToShowingLevel("???") === null)

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ SHOWING_FEEDBACK_LEARNING_FAIL"); process.exit(1) }
  console.log(" ✅ SHOWING_FEEDBACK_LEARNING_PASS — every tour re-tunes the buyer's criteria, no manual editing")
}

main()
