#!/usr/bin/env tsx
/**
 * scripts/photo-walkthrough-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PURE harness for the CINEMATIC photo→walkthrough motion planner
 * (lib/video/ken-burns-plan.ts → kenBurnsPlan). NO mocks, NO DB, NO React, NO
 * Remotion render — it asserts the deterministic clip plan the
 * remotion/PhotoWalkthroughReel.tsx composition renders verbatim:
 *
 *   · Windows TILE the body timeline — consecutive clips overlap by EXACTLY
 *     crossfadeFrames (the cross-fade), no gaps and no other overlap; the first
 *     clip starts at frame 0 and the last clip ends EXACTLY at totalFrames.
 *   · Pan directions ALTERNATE for cinematic variety (no two consecutive clips
 *     share a pan vector).
 *   · An oversized photo set is CAPPED to a sane clip count (no 60-photo
 *     slideshow); a small set is used as-is (no loop-padding).
 *   · Scale/pan bounds are SANE — scale in [1.0, 1.12] (no extreme zoom), pan
 *     offsets are a small % of frame (|pan| <= 4%, never off-screen).
 *   · HONEST empty — no photos (or blank/whitespace urls) → [] so the Video
 *     Director won't pick this format and the composition shows its fallback.
 *
 * Run: npx tsx scripts/photo-walkthrough-simulator.ts  (npm run test:photo-walkthrough)
 * Exit: 0 = all checks pass, 1 = any failure (CI gate).
 */
import { kenBurnsPlan, type KenBurnsClip } from "../lib/video/ken-burns-plan"

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name + (detail ? ` — ${detail}` : ""))
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`)
  }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    console.log("\nPHOTO_WALKTHROUGH_FAIL")
    process.exit(1)
  }
  console.log(" ✅ Ken Burns photo-walkthrough plan verified — tiled windows, alternating pans, sane bounds, capped + honest-empty")
  console.log("\nPHOTO_WALKTHROUGH_PASS")
}

const urls = (n: number) => Array.from({ length: n }, (_, i) => `https://cdn/photo-${i}.jpg`)
const panKey = (c: KenBurnsClip) => `${c.panFromXY.join(",")}->${c.panToXY.join(",")}`

// ── 1. Honest empty ───────────────────────────────────────────────────────────
console.log("\n[1] Honest empty — no photos → []")
check("null photos → []", kenBurnsPlan(null, 600).length === 0)
check("undefined photos → []", kenBurnsPlan(undefined, 600).length === 0)
check("[] photos → []", kenBurnsPlan([], 600).length === 0)
check("all-blank photos → []", kenBurnsPlan(["", "   ", null, undefined], 600).length === 0)
check("photos but non-positive totalFrames → []", kenBurnsPlan(urls(5), 0).length === 0)
check("photos but negative totalFrames → []", kenBurnsPlan(urls(5), -100).length === 0)
check("photos but NaN totalFrames → []", kenBurnsPlan(urls(5), Number.NaN).length === 0)

// ── 2. Window tiling (no gaps / no overlap beyond crossfade) ───────────────────
console.log("\n[2] Windows tile the timeline — no gaps, overlap == crossfade only")
{
  const TOTAL = 540
  const clips = kenBurnsPlan(urls(6), TOTAL)
  check("6 photos → 6 clips", clips.length === 6, `got ${clips.length}`)
  check("first clip starts at frame 0", clips[0].fromFrame === 0, `got ${clips[0].fromFrame}`)
  const last = clips[clips.length - 1]
  check(
    "last clip ends exactly at totalFrames",
    last.fromFrame + last.durationFrames === TOTAL,
    `got ${last.fromFrame + last.durationFrames} != ${TOTAL}`,
  )
  // Between consecutive clips: the overlap is EXACTLY the crossfade. clip[i]
  // ends at fromFrame+duration; clip[i+1] starts at fromFrame. Overlap =
  // (clip[i].end - clip[i+1].start) should equal clip[i].crossfadeFrames
  // (±1 frame from integer rounding of the stride).
  let tilingOk = true
  let tilingDetail = ""
  for (let i = 0; i < clips.length - 1; i++) {
    const end = clips[i].fromFrame + clips[i].durationFrames
    const nextStart = clips[i + 1].fromFrame
    const overlap = end - nextStart
    const xfade = clips[i].crossfadeFrames
    if (Math.abs(overlap - xfade) > 1) {
      tilingOk = false
      tilingDetail = `clip ${i}: overlap=${overlap} xfade=${xfade}`
      break
    }
    // No clip should start before the previous one (monotonic).
    if (nextStart < clips[i].fromFrame) {
      tilingOk = false
      tilingDetail = `clip ${i + 1} starts before clip ${i}`
      break
    }
  }
  check("consecutive overlap == crossfadeFrames (±1)", tilingOk, tilingDetail)
  check("final clip crossfadeFrames == 0", last.crossfadeFrames === 0, `got ${last.crossfadeFrames}`)
  check("all clips have positive duration", clips.every((c) => c.durationFrames > 0))
  check("crossfade < per-clip duration (never swallows a clip)", clips.every((c) => c.crossfadeFrames < c.durationFrames))
}

// ── 3. Alternating pan directions ──────────────────────────────────────────────
console.log("\n[3] Pan directions alternate for variety")
{
  const clips = kenBurnsPlan(urls(8), 720)
  let alt = true
  for (let i = 1; i < clips.length; i++) {
    if (panKey(clips[i]) === panKey(clips[i - 1])) {
      alt = false
      break
    }
  }
  check("no two consecutive clips share a pan vector", alt)
  // The plan also alternates zoom polarity (push-in vs pull-out).
  let zoomAlt = true
  for (let i = 1; i < clips.length; i++) {
    const prevPush = clips[i - 1].endScale > clips[i - 1].startScale
    const curPush = clips[i].endScale > clips[i].startScale
    if (prevPush === curPush) {
      zoomAlt = false
      break
    }
  }
  check("zoom polarity alternates (push-in ↔ pull-out)", zoomAlt)
}

// ── 4. Cap an oversized set ─────────────────────────────────────────────────────
console.log("\n[4] Oversized set capped to a watchable clip count")
{
  const clips = kenBurnsPlan(urls(60), 900)
  check("60 photos capped to default maxClips=10", clips.length === 10, `got ${clips.length}`)
  check("capped clips still tile to totalFrames", clips[clips.length - 1].fromFrame + clips[clips.length - 1].durationFrames === 900)
  // Custom cap respected.
  const capped5 = kenBurnsPlan(urls(60), 900, { maxClips: 5 })
  check("custom maxClips=5 respected", capped5.length === 5, `got ${capped5.length}`)
  // A small set is used as-is (no loop-padding to fill the cap).
  const small = kenBurnsPlan(urls(3), 600)
  check("3 photos → 3 clips (no loop-padding)", small.length === 3, `got ${small.length}`)
  const one = kenBurnsPlan(urls(1), 300)
  check("1 photo → 1 clip", one.length === 1, `got ${one.length}`)
  check("single clip has no crossfade", one[0]?.crossfadeFrames === 0)
  check("single clip fills the whole window", one[0]?.fromFrame === 0 && one[0]?.durationFrames === 300)
}

// ── 5. Sane scale / pan bounds (no extreme zoom, no off-screen pan) ────────────
console.log("\n[5] Scale + pan bounds are sane")
{
  const clips = kenBurnsPlan(urls(10), 900)
  const scaleOk = clips.every(
    (c) => c.startScale >= 1.0 && c.startScale <= 1.12 && c.endScale >= 1.0 && c.endScale <= 1.12,
  )
  check("all scales in [1.0, 1.12] (cover never letterboxes, no extreme zoom)", scaleOk)
  const panOk = clips.every(
    (c) =>
      Math.abs(c.panFromXY[0]) <= 4 &&
      Math.abs(c.panFromXY[1]) <= 4 &&
      Math.abs(c.panToXY[0]) <= 4 &&
      Math.abs(c.panToXY[1]) <= 4,
  )
  check("all pan offsets |x|,|y| <= 4% (subject stays on-screen)", panOk)
  // maxZoom option is honored and clamped to a sane ceiling.
  const bigZoom = kenBurnsPlan(urls(4), 600, { maxZoom: 0.5 })
  check("maxZoom=0.5 still clamps scale <= 1.12", bigZoom.every((c) => c.startScale <= 1.12 && c.endScale <= 1.12))
}

// ── 6. Caption / room-label contract ───────────────────────────────────────────
console.log("\n[6] Captions — caller override wins, else generic tour beat")
{
  const clips = kenBurnsPlan(urls(4), 600, {
    captions: ["Living Room", null, "  ", "Backyard"],
  })
  check("caller caption used when present", clips[0].roomLabel === "Living Room")
  check("blank/whitespace caption falls back to a tour beat", !!clips[2].roomLabel && clips[2].roomLabel.trim().length > 0 && clips[2].roomLabel !== "  ")
  check("missing caption (null) falls back to a tour beat", !!clips[1].roomLabel && clips[1].roomLabel.trim().length > 0)
  check("last caller caption used", clips[3].roomLabel === "Backyard")
  // Every clip always has a non-empty label (the composition pins it).
  const allLabeled = kenBurnsPlan(urls(7), 700).every((c) => !!c.roomLabel && c.roomLabel.trim().length > 0)
  check("every clip has a non-empty room label", allLabeled)
}

// ── 7. Determinism ──────────────────────────────────────────────────────────────
console.log("\n[7] Deterministic — same inputs → identical plan")
{
  const a = JSON.stringify(kenBurnsPlan(urls(6), 540))
  const b = JSON.stringify(kenBurnsPlan(urls(6), 540))
  check("identical inputs produce identical output", a === b)
}

report()
