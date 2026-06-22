/**
 * scripts/video-script-simulator.ts
 *
 * Pure simulator for the video-script generation core extracted to
 * lib/video/script-structure.ts. Exercises the deterministic helpers used by the
 * "use server" action app/actions/video/generate-script.ts with REAL assertions —
 * no mocks, no stubs, no DB, no LLM.
 *
 * Run:  npx tsx scripts/video-script-simulator.ts
 */

import {
  TONE_INSTRUCTIONS,
  WORDS_PER_MINUTE,
  targetWordCount,
  estimateDurationSeconds,
  videoTypeToContactType,
  type VideoScriptType,
  type VideoScriptTone,
} from "../lib/video/script-structure"

let passed = 0
let failed = 0

function assert(name: string, cond: boolean) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.error(`  ✗ ${name}`)
  }
}

function assertEq<T>(name: string, actual: T, expected: T) {
  assert(`${name} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`, actual === expected)
}

console.log("video-script-simulator: pure core for generateVideoScript\n")

// ── targetWordCount: duration → words at 150 wpm ─────────────────────────────
console.log("targetWordCount(durationSeconds)")
assertEq("60s → 150 words", targetWordCount(60), 150)
assertEq("30s → 75 words", targetWordCount(30), 75)
assertEq("15s → 38 words (rounds)", targetWordCount(15), 38) // 37.5 → 38
assertEq("90s → 225 words", targetWordCount(90), 225)
assertEq("0s → 0 words", targetWordCount(0), 0)
assert("monotonic: longer duration never fewer words", targetWordCount(90) > targetWordCount(60))

// ── estimateDurationSeconds: words → duration (inverse) ──────────────────────
console.log("\nestimateDurationSeconds(wordCount)")
assertEq("150 words → 60s", estimateDurationSeconds(150), 60)
assertEq("75 words → 30s", estimateDurationSeconds(75), 30)
assertEq("0 words → 0s", estimateDurationSeconds(0), 0)

// Round-trip: a clean multiple of WORDS_PER_MINUTE survives both directions.
console.log("\nround-trip targetWordCount ∘ estimateDurationSeconds")
for (const seconds of [60, 120, 600]) {
  assertEq(`${seconds}s round-trips`, estimateDurationSeconds(targetWordCount(seconds)), seconds)
}
assertEq("WORDS_PER_MINUTE is 150", WORDS_PER_MINUTE, 150)

// ── videoTypeToContactType: audience routing for the compliance gate ─────────
console.log("\nvideoTypeToContactType(videoType)")
const sellerFacing: VideoScriptType[] = ["seller_update", "listing_presentation"]
const buyerFacing: VideoScriptType[] = [
  "property_tour",
  "market_update",
  "agent_intro",
  "buyer_education",
  "testimonial",
  "tips",
  "custom",
]
for (const t of sellerFacing) assertEq(`${t} → seller`, videoTypeToContactType(t), "seller")
for (const t of buyerFacing) assertEq(`${t} → buyer`, videoTypeToContactType(t), "buyer")

// Total coverage: every canonical type maps to exactly one of two audiences.
const allTypes: VideoScriptType[] = [...sellerFacing, ...buyerFacing]
assertEq("all 9 canonical types covered", allTypes.length, 9)
assert(
  "every type resolves to buyer|seller",
  allTypes.every((t) => ["buyer", "seller"].includes(videoTypeToContactType(t)))
)

// ── TONE_INSTRUCTIONS: every tone has a non-empty directive ──────────────────
console.log("\nTONE_INSTRUCTIONS")
const tones: VideoScriptTone[] = ["professional", "friendly", "luxury", "educational"]
for (const tone of tones) {
  assert(`${tone} has a non-empty directive`, (TONE_INSTRUCTIONS[tone]?.trim().length ?? 0) > 10)
}
assertEq("exactly 4 tones defined", Object.keys(TONE_INSTRUCTIONS).length, 4)

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
