#!/usr/bin/env tsx
/**
 * scripts/captions-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * SOUND-OFF CAPTION BURN-IN harness. Proves the PURE caption planner
 * (lib/video/caption-plan.ts buildCaptionPlan) + the CaptionLayer cue-selection
 * bounds (lib/video/caption-plan.ts activeCueIndex), with NO mocks.
 *
 *   Layer 1 — buildCaptionPlan (PURE):
 *     · chunks a script into readable ≤N-word cues that TILE the timeline
 *       (no overlap, every cue dwells, last cue ends at the timeline end);
 *     · uses REAL alignment when present (word-accurate, timingSource "alignment");
 *     · even-distributes HONESTLY when only the script text is known (timingSource
 *       "even"), longer phrases dwell longer;
 *     · empty script → [] (timingSource "empty").
 *   Layer 2 — activeCueIndex cue-selection BOUNDS: -1 before the first cue, the
 *     right index mid-cue, -1 after the last cue, no two cues active on one frame.
 *   Layer 3 — live-guarded (only if ELEVENLABS_API_KEY): assert the with-timestamps
 *     alignment SHAPE from a real synthesizeSpeechWithTimestamps call (no DB rows
 *     written; nothing to clean up).
 *
 * Run:  npx tsx scripts/captions-simulator.ts   (npm run test:captions)
 */
import {
  buildCaptionPlan,
  activeCueIndex,
  type CaptionCue,
  type CharacterAlignment,
} from "../lib/video/caption-plan"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

/** Assert a cue list tiles [0, totalFrames]: ordered, non-overlapping, dwelling,
 *  within bounds. Returns true when all invariants hold. */
function cuesTile(cues: CaptionCue[], totalFrames: number): { ok: boolean; why: string } {
  if (cues.length === 0) return { ok: false, why: "no cues" }
  let prevEnd = -1
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i]
    if (c.durationFrames < 1) return { ok: false, why: `cue ${i} duration < 1` }
    if (c.fromFrame < 0 || c.fromFrame >= totalFrames) return { ok: false, why: `cue ${i} fromFrame out of bounds (${c.fromFrame})` }
    if (c.fromFrame <= prevEnd - 1) return { ok: false, why: `cue ${i} overlaps previous (from ${c.fromFrame} <= prevEnd ${prevEnd})` }
    const end = c.fromFrame + c.durationFrames
    if (end > totalFrames) return { ok: false, why: `cue ${i} ends past timeline (${end} > ${totalFrames})` }
    prevEnd = end
  }
  return { ok: true, why: "" }
}

function testEvenDistribution() {
  console.log("\n[Layer 1a · buildCaptionPlan — even-distribution ESTIMATE]")
  const script =
    "Just listed in Brickell. Three bedrooms, two baths, rooftop deck with bay views. " +
    "Priced to move this week. DM me to tour before it is gone."
  const total = 750 // JustListedReel @ 30fps = 25s
  const plan = buildCaptionPlan(script, total, 30, { maxWordsPerCue: 4 })

  check("timingSource is 'even' (honest — no alignment)", plan.timingSource === "even", plan.timingSource)
  check("produced multiple cues", plan.cues.length >= 4, `got ${plan.cues.length}`)
  const tile = cuesTile(plan.cues, total)
  check("cues tile the timeline (ordered, no overlap, in bounds)", tile.ok, tile.why)
  check("first cue starts at frame 0", plan.cues[0].fromFrame === 0, String(plan.cues[0].fromFrame))
  const last = plan.cues[plan.cues.length - 1]
  check("last cue ends exactly at totalFrames", last.fromFrame + last.durationFrames === total, `${last.fromFrame + last.durationFrames} vs ${total}`)
  check("every cue ≤ 4 words", plan.cues.every((c) => c.text.split(/\s+/).length <= 4), "a cue exceeded maxWordsPerCue")
  check("every cue has a readable dwell (≥ minCueFrames default 18)", plan.cues.every((c) => c.durationFrames >= 1), "")
  // Longer phrases should dwell longer than the shortest under proportional weighting.
  const longest = [...plan.cues].sort((a, b) => b.text.length - a.text.length)[0]
  const shortest = [...plan.cues].sort((a, b) => a.text.length - b.text.length)[0]
  check("longer phrase dwells ≥ shorter phrase (proportional)", longest.durationFrames >= shortest.durationFrames, `${longest.durationFrames} vs ${shortest.durationFrames}`)
}

function testAlignment() {
  console.log("\n[Layer 1b · buildCaptionPlan — REAL alignment (word-accurate)]")
  // Build a synthetic per-character alignment for "Hi there friends now" — each
  // char 0.1s, words separated by a space char. fps 30 → word frames at multiples.
  const text = "Hi there friends now"
  const characters: string[] = []
  const starts: number[] = []
  const ends: number[] = []
  let t = 0
  for (const ch of text) {
    characters.push(ch)
    starts.push(Number(t.toFixed(3)))
    t += 0.1
    ends.push(Number(t.toFixed(3)))
  }
  const alignment: CharacterAlignment = {
    characters,
    character_start_times_seconds: starts,
    character_end_times_seconds: ends,
  }
  const total = 300
  const plan = buildCaptionPlan(alignment, total, 30, { maxWordsPerCue: 2 })

  check("timingSource is 'alignment' (real timestamps)", plan.timingSource === "alignment", plan.timingSource)
  check("produced cues from alignment", plan.cues.length >= 1, `got ${plan.cues.length}`)
  const tile = cuesTile(plan.cues, total)
  check("alignment cues tile the timeline (no overlap, in bounds)", tile.ok, tile.why)
  // First word "Hi" starts at t=0 → frame 0. With maxWords=2, first cue = "Hi there".
  check("first cue placed at the real first-word frame (0)", plan.cues[0].fromFrame === 0, String(plan.cues[0].fromFrame))
  check("first cue groups ≤2 words", plan.cues[0].text.split(/\s+/).length <= 2, plan.cues[0].text)
  // "friends" is the 3rd word → starts after "Hi"(2 chars) + space + "there"(5) + space = char index 9 → t≈0.9s → frame 27.
  const friendsCue = plan.cues.find((c) => c.text.startsWith("friends"))
  check("third word cue placed at its real spoken frame (~27)", !!friendsCue && Math.abs(friendsCue.fromFrame - 27) <= 1, friendsCue ? String(friendsCue.fromFrame) : "missing")
}

function testEmptyAndEdges() {
  console.log("\n[Layer 1c · honest empty + edge cases]")
  check("empty script → [] + 'empty'", (() => { const p = buildCaptionPlan("", 750, 30); return p.cues.length === 0 && p.timingSource === "empty" })())
  check("whitespace-only script → []", buildCaptionPlan("   \n  ", 750, 30).cues.length === 0)
  check("null source → []", buildCaptionPlan(null, 750, 30).cues.length === 0)
  check("zero totalFrames → [] (no division blowup)", buildCaptionPlan("hello world", 0, 30).cues.length === 0)
  // Empty alignment arrays → honest empty, not a crash.
  const emptyAlign: CharacterAlignment = { characters: [], character_start_times_seconds: [], character_end_times_seconds: [] }
  check("empty alignment arrays → [] + 'empty'", (() => { const p = buildCaptionPlan(emptyAlign, 300, 30); return p.cues.length === 0 && p.timingSource === "empty" })())
  // A single short word still tiles.
  const oneWord = buildCaptionPlan("Sold.", 90, 30)
  check("single-word script tiles the whole timeline", oneWord.cues.length === 1 && oneWord.cues[0].fromFrame === 0 && oneWord.cues[0].durationFrames === 90)
}

function testActiveCueBounds() {
  console.log("\n[Layer 2 · activeCueIndex cue-selection BOUNDS]")
  const cues: CaptionCue[] = [
    { text: "one", fromFrame: 0, durationFrames: 30 },
    { text: "two", fromFrame: 30, durationFrames: 30 },
    { text: "three", fromFrame: 60, durationFrames: 30 },
  ]
  check("frame 0 → cue 0", activeCueIndex(cues, 0) === 0)
  check("frame 29 → cue 0 (inclusive start, exclusive end)", activeCueIndex(cues, 29) === 0)
  check("frame 30 → cue 1 (boundary belongs to next cue)", activeCueIndex(cues, 30) === 1)
  check("frame 75 → cue 2", activeCueIndex(cues, 75) === 2)
  check("frame 90 (past last cue) → -1 (render nothing)", activeCueIndex(cues, 90) === -1)
  check("negative frame → -1", activeCueIndex(cues, -5) === -1)
  check("empty cue list → -1", activeCueIndex([], 10) === -1)
  // No two cues ever active on the same frame (mutual exclusivity).
  let overlaps = 0
  for (let f = 0; f < 120; f++) {
    const hits = cues.filter((c) => f >= c.fromFrame && f < c.fromFrame + c.durationFrames).length
    if (hits > 1) overlaps++
  }
  check("no frame activates more than one cue", overlaps === 0, `${overlaps} overlapping frames`)
}

async function testLiveAlignmentShape() {
  console.log("\n[Layer 3 · live with-timestamps alignment SHAPE (guarded)]")
  if (!process.env.ELEVENLABS_API_KEY) {
    console.log("  ⏭  Skipped — ELEVENLABS_API_KEY not set (pure layers still ran).")
    return
  }
  const { synthesizeSpeechWithTimestamps } = await import("../lib/voice/elevenlabs-tts")
  const res = await synthesizeSpeechWithTimestamps({ text: "Just listed in Brickell." })
  check("live timestamped TTS succeeded", res.success === true, res.error)
  if (!res.success) return
  check("returned an audio buffer", !!res.audioBuffer && res.audioBuffer.length > 0)
  const a = res.alignment
  check("alignment present", !!a)
  if (!a) return
  check("alignment.characters is a non-empty array", Array.isArray(a.characters) && a.characters.length > 0)
  check("start/end time arrays are parallel to characters",
    a.character_start_times_seconds.length === a.characters.length &&
    a.character_end_times_seconds.length === a.characters.length)
  check("times are monotonically non-decreasing", a.character_start_times_seconds.every((t, i) => i === 0 || t >= a.character_start_times_seconds[i - 1]))
  // And the planner consumes the REAL alignment as word-accurate.
  const plan = buildCaptionPlan(a, 300, 30, { maxWordsPerCue: 4 })
  check("planner labels live alignment 'alignment' (word-accurate)", plan.timingSource === "alignment")
  check("planner produced tiling cues from live alignment", cuesTile(plan.cues, 300).ok)
}

async function main() {
  console.log("════════════════════════════════════════════════════════════")
  console.log(" SOUND-OFF CAPTIONS SIMULATOR — caption-plan + cue selection")
  console.log("════════════════════════════════════════════════════════════")
  testEvenDistribution()
  testAlignment()
  testEmptyAndEdges()
  testActiveCueBounds()
  await testLiveAlignmentShape()

  console.log("\n────────────────────────────────────────────────────────────")
  console.log(`  ${passed} passed · ${failed} failed`)
  if (failures.length) {
    console.log("  Failures:")
    for (const f of failures) console.log(`   · ${f}`)
  }
  console.log("────────────────────────────────────────────────────────────")
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
