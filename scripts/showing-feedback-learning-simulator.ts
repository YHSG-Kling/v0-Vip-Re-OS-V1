#!/usr/bin/env tsx
/**
 * scripts/showing-feedback-learning-simulator.ts   (npm run test:showing-feedback-learning)
 * ─────────────────────────────────────────────────────────────────────────────
 * CLOSING THE BUYER-GRAPH LOOP — proves a post-tour verdict maps to the right learning signal so
 * the buyer's criteria self-tune after every tour (the "smarter alert relevance, no manual filter
 * editing" buyers ask for). A tour is the STRONGEST taste signal: very_interested → love_it (+10),
 * not_interested → not_for_us (-5). Pure: no I/O.
 */
import { showingInterestToLearningSignal, interestLevelToLearningSignal, portalInterestToShowingLevel, tourInterestToRating } from "../lib/behavior-learning/signal-mapping"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { blankComments } from "./strip-comments"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { tourRecapBrief, pickStandout } from "../lib/kernel/client-story-drafts"

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

  // ── THE TOUR-RECAP HALF (orphan doctrine §1.1, merged onto the survivor) ──
  //
  // lib/kernel/client-story-drafts.ts:runTourRecaps read tour_stops.rating and
  // tour_stops.feedback. NOTHING writes either — no code, and (verified live on
  // hrvaqgvukzxfskkcrwbt) no trigger, no routine and no column DEFAULT. So every stop
  // came back {rating: null, feedback: null}, tourRecapBrief returned null on its
  // "never narrate a day the OS didn't see" guard, and not one tour recap — nor the
  // offer-readiness bridge task behind it — had ever fired. The reader was repointed to
  // the SURVIVORS, buyer_interest_level / buyer_note, which app/actions/tour-planner.ts
  // actually writes, and translated through tourInterestToRating.
  console.log("\n[Tour verdict → the 1-5 rating the recap brief speaks]")
  check("love_it → 5 (top of the ladder)", tourInterestToRating("love_it") === 5)
  check("like_it → 4 (still a standout under pickStandout's ≥4)", tourInterestToRating("like_it") === 4)
  check("maybe → 3", tourInterestToRating("maybe") === 3)
  check("no → 1 (the CHECK's negative term)", tourInterestToRating("no") === 1)
  check("not_for_us → 1 (the learning-signal spelling of the same rung)", tourInterestToRating("not_for_us") === 1)

  console.log("\n[Honest — an unrated stop is not a 1/5]")
  check("null → null, never 0 and never 1", tourInterestToRating(null) === null)
  check("unknown → null (a value we cannot read is not a bad reaction)", tourInterestToRating("scheduled") === null)

  // THE RULE, NOT A WAYPOINT: the ladder is DERIVED from the live CHECK on
  // tour_stops.buyer_interest_level via the generated vocabulary cache, so a widened
  // CHECK makes this fail instead of silently leaving a new value unmapped.
  const tourVocab = CHECK_VOCABULARIES["tour_stops"]?.buyer_interest_level ?? []
  check("the vocabulary cache is NOT empty (a blind cache passes everything)", tourVocab.length > 0)
  check("every live CHECK value maps to a rating — no value falls through to null",
    tourVocab.every((v) => typeof tourInterestToRating(v) === "number"))

  console.log("\n[End to end — a rated tour now PRODUCES a recap, which is the half that was dead]")
  const facts = [
    { address: "1 Oak Ct", rating: tourInterestToRating("love_it"), feedback: "the kitchen sold them" },
    { address: "2 Elm St", rating: tourInterestToRating("maybe"), feedback: null },
  ]
  check("a tour of rated stops yields a brief (it used to yield null)", tourRecapBrief({ buyerFirstName: "Sam", stops: facts }) !== null)
  check("the standout is the love_it stop", pickStandout(facts)?.address === "1 Oak Ct")
  // NEGATIVE CONTROL, in the exact shape of the bug: the OLD columns are always NULL,
  // so the old read path still produces nothing. If this ever goes green the mapper is
  // fabricating a reaction out of an empty column.
  const oldPath = [{ address: "1 Oak Ct", rating: null, feedback: null }, { address: "2 Elm St", rating: null, feedback: null }]
  check("NEGATIVE CONTROL — the writerless columns still yield NO brief", tourRecapBrief({ buyerFirstName: "Sam", stops: oldPath }) === null)

  // POSITIVE CONTROL ON THE ABSENCE CLAIM: the read site must name the SURVIVOR columns
  // and must not have drifted back. Source is read comment-STRIPPED — the tombstone at
  // that call site QUOTES the retired `.select("property_address, rating, feedback")`,
  // and a raw-source scan would read the tombstone as the live defect and fail forever.
  const draftsRaw = readFileSync(join(process.cwd(), "lib/kernel/client-story-drafts.ts"), "utf8")
  const draftsCode = blankComments(draftsRaw)
  // ASSERT THE RULE, DERIVE THE LIST (CLAUDE.md §2 — "do not pin an assertion to a
  // WAYPOINT"). This pair used to compare the select against the FROZEN LITERAL
  // '"property_address, buyer_interest_level, buyer_note"', which made the
  // assertion true of one exact moment rather than of the invariant. It went red
  // the first time the read legitimately GREW — wave BA added time_spent_minutes,
  // the day-of check-in column whose writer it had just built — i.e. it failed
  // because the work finished, which is precisely the failure mode §2 names. The
  // rule is: the survivor columns are all present and the writerless pair is
  // absent. The column list is now PARSED out of the call, so the read may gain
  // columns without breaking, and may not quietly lose one.
  const tourStopSelect = /from\("tour_stops"\)\.select\("([^"]*)"\)/.exec(draftsCode)?.[1] ?? ""
  const selectedCols = tourStopSelect.split(",").map((s) => s.trim()).filter(Boolean)
  check("the recap read names the WRITTEN columns",
    ["property_address", "buyer_interest_level", "buyer_note"].every((c) => selectedCols.includes(c)),
    tourStopSelect || "NO tour_stops select found")
  check("the recap read no longer names the writerless pair",
    selectedCols.length > 0 && !selectedCols.includes("rating") && !selectedCols.includes("feedback"),
    tourStopSelect)
  check("BLINDNESS CONTROL — the retired select IS still present in the RAW file (the tombstone), so the stripper is what makes the check above true",
    draftsRaw.includes('"property_address, rating, feedback"'))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ SHOWING_FEEDBACK_LEARNING_FAIL"); process.exit(1) }
  console.log(" ✅ SHOWING_FEEDBACK_LEARNING_PASS — every tour re-tunes the buyer's criteria, no manual editing")
}

main()
