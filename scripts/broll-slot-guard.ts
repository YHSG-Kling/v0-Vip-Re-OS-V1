#!/usr/bin/env tsx
/**
 * scripts/broll-slot-guard.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * A B-ROLL CLIP IS NEVER ASKED TO PLAY PAST ITS OWN END.
 *
 * THE DEFECT THIS CLOSES (2026-09-05, lane BROLL). It is the BLIND SPOT that
 * `scripts/broll-window-guard.ts` published beside its own number on 2026-09-04,
 * verbatim:
 *
 *   "This guard proves WHERE a clip's playback starts. It does NOT prove the
 *    clip is LONG ENOUGH for its slot: _BrollLayer divides the window EVENLY
 *    while lib/video/broll-picker.ts already computes a per-clip plan from each
 *    clip's measured duration (selectBrollPlan → BrollPlanEntry) and the Video
 *    Director drops that plan on the floor. A clip shorter than its even slot
 *    still freezes on its last frame."
 *
 * That is §1's exact shape: a WRITER WITH NO READER (`selectBrollPlan` measured
 * real per-clip durations that `video-director.ts` discarded — `picked.plan` had
 * no reader) and a READER THAT INVENTED ITS OWN ANSWER (`_BrollLayer` divided
 * its frame window by the only number it had, the clip COUNT). An even slot is
 * bounded by nothing the footage can deliver: three 4-second cutaways over
 * NeighborhoodSpotlightReel's 480-frame window get 5.33-second slots, so each
 * one plays 1.33 seconds past its own end — and past its end a `<Video>` HOLDS
 * ITS LAST FRAME. Frozen still, motion promised, render reports success.
 *
 * THE FIX, and why it is a wire and not a patch:
 *   · lib/video/broll-plan.ts — `selectBrollPlan` moved here (tombstone in
 *     broll-picker.ts) so the layer can import the math WITHOUT dragging
 *     `@/lib/supabase/service` into the Remotion bundle. One implementation,
 *     two callers (§6) — the alternative was a second spelling of "how a B-roll
 *     window is divided", which is what produced the disagreement.
 *   · lib/video/broll-picker.ts — the MEASUREMENT now rides the clip
 *     (`PickedBrollClip.durationSeconds`), on the existing `brollClips` prop
 *     wire. No new composition prop, so no content-contract classification
 *     moves.
 *   · remotion/_BrollLayer.tsx — `brollSlots` re-runs that same plan in the
 *     FRAME domain against the window the layer actually owns, and `brollDrawAt`
 *     returns the whole render decision as data so this file judges the REAL
 *     arithmetic rather than a copy of it.
 *
 * WHY THE DIRECTOR CANNOT JUST FORWARD `picked.plan`: the B-roll window is a
 * constant inside each composition (ComingSoonReel TOTAL=360,
 * NeighborhoodSpotlightReel TOTAL=480, AgentTalkingHeadReel BODY=300 where
 * BODY ≠ TOTAL=420). The Director does not know it and must not learn a second
 * table of it. Sequencing therefore happens where the window is known — in the
 * layer — using the picker's own function. See §5 below, which asserts the
 * measurement really does travel end to end.
 *
 * MEASUREMENT DISCIPLINE (§2):
 *   · The RULE is asserted and every number DERIVED from the layer's own
 *     exported functions and from lib/remotion/composition-geometry.ts. No
 *     frame count, window length or composition name is typed here as a
 *     waypoint.
 *   · Every absence claim carries a POSITIVE CONTROL that re-creates the
 *     pre-fix even division and proves the finder still fails it.
 *   · Source scans read stripComments()+blankStrings(), so this file's prose and
 *     the tombstones in the files it judges are not call sites.
 *   · Blind spots are printed beside the count.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { stripComments, blankStrings } from "./strip-comments"
import {
  brollSlots,
  brollDrawAt,
  brollWindowAt,
  clipFrames,
  type BrollClip,
  type BrollWindow,
} from "../remotion/_BrollLayer"
import { COMPOSITION_GEOMETRY } from "../lib/remotion/composition-geometry"

let passed = 0
let failed = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; failures.push(label + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}

const LAYER  = "remotion/_BrollLayer.tsx"
const PICKER = "lib/video/broll-picker.ts"
const PLAN   = "lib/video/broll-plan.ts"

const readStripped = (p: string): string | null =>
  existsSync(p) ? blankStrings(stripComments(readFileSync(p, "utf8"))) : null

// ─────────────────────────────────────────────────────────────────────────────
console.log("═══ 0. Fail closed: every file this guard judges must be readable ═══")
{
  let allReadable = true
  for (const f of [LAYER, PICKER, PLAN]) {
    const bytes = existsSync(f) ? readFileSync(f, "utf8").length : 0
    ok(`${f} exists and was read (${bytes} bytes)`, bytes > 0)
    if (bytes === 0) allReadable = false
  }
  if (!allReadable) {
    console.log("\n B-ROLL SLOT — cannot judge files it cannot read; refusing rather than passing.")
    process.exit(1)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WHICH WINDOWS ARE REAL. Derived, not typed: find the compositions that mount
// <BrollLayer> and take their REGISTERED frame counts. A composition renamed,
// retired or re-timed moves these numbers instead of aging this file into a lie.
console.log("\n═══ 1. The windows under test are the REGISTERED ones, derived ═══")
const consumers: Array<{ file: string; id: string; totalFrames: number; fps: number }> = []
{
  const files = readdirSync("remotion").filter((n) => /\.tsx$/.test(n))
  const mounts: string[] = []
  for (const n of files) {
    const src = readStripped(`remotion/${n}`)
    if (!src || !/<BrollLayer\b/.test(src)) continue
    mounts.push(n)
    const id = n.replace(/\.tsx$/, "")
    const g = COMPOSITION_GEOMETRY[id]
    if (g) consumers.push({ file: `remotion/${n}`, id, totalFrames: g.duration_frames, fps: g.fps })
  }
  ok(`found the compositions that mount <BrollLayer> by scanning STRIPPED source (${mounts.length}: ${mounts.join(", ")})`,
    mounts.length > 0)
  ok(`...and every one of them is in COMPOSITION_GEOMETRY, so its window is derived (${consumers.map((c) => `${c.id}=${c.totalFrames}f@${c.fps}`).join(", ")})`,
    consumers.length === mounts.length,
    `${mounts.length} mount the layer, ${consumers.length} have registered geometry`)
  // POSITIVE CONTROL (§2): a scanner that finds nothing and a repo with no
  // consumers both report zero.
  ok("the mount scanner recognises a mount, and reads STRIPPED source so a\n    tombstone naming <BrollLayer> is not a mount",
    /<BrollLayer\b/.test(blankStrings(stripComments(`<BrollLayer clips={c} totalFrames={T} />`)))
    && !/<BrollLayer\b/.test(blankStrings(stripComments(`// see <BrollLayer clips={c} />\nconst s = "<BrollLayer/>"`))))
  console.log("    NOTE, so the number is not overclaimed: a composition's B-roll window is not")
  console.log("    always its whole registered duration — AgentTalkingHeadReel mounts the layer")
  console.log("    inside its BODY sequence, which is SHORTER than duration_frames. The rule")
  console.log("    below is universal in totalFrames, so a registered total is a valid (and")
  console.log("    harsher) window; it is a stress case, not a claim about that reel's cut.")
}

// The libraries. Realistic stock-cutaway lengths (broll-picker measures 4-8s
// typically) plus the adversarial cases: clips far shorter than any even slot,
// wildly mixed lengths, and a single clip.
const LIBRARIES: Array<{ name: string; secs: number[] }> = [
  { name: "three 4s cutaways",            secs: [4, 4, 4] },
  { name: "mixed 8/3/6/4s",               secs: [8, 3, 6, 4] },
  { name: "five short 2s clips",          secs: [2, 2, 2, 2, 2] },
  { name: "one 5s clip",                  secs: [5] },
  { name: "one very short 1.2s clip",     secs: [1.2] },
  { name: "long+short 30/1.5s",           secs: [30, 1.5] },
  { name: "seven 4.5s clips",             secs: [4.5, 4.5, 4.5, 4.5, 4.5, 4.5, 4.5] },
]
const lib = (secs: number[]): BrollClip[] =>
  secs.map((s, i) => ({ url: `https://stock.example/clip${i}.mp4`, durationSeconds: s }))

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n═══ 2. THE RULE: no clip's media window exceeds the clip's own length ═══")
{
  /**
   * Walk every frame of every (window × library) pair and judge EVERY
   * `<ClipFrame>` the layer will mount there — the incoming clip and, during a
   * crossfade, the outgoing one. `brollDrawAt` is the layer's own render
   * decision, so this is the shipped arithmetic and not a re-derivation.
   */
  const violate = (
    draws: (clips: BrollClip[], total: number, fps: number, frame: number) => Array<{ index: number; spanFrames: number }>,
  ) => {
    const wrong: string[] = []
    let framesWalked = 0
    for (const w of consumers) {
      for (const L of LIBRARIES) {
        const clips = lib(L.secs)
        for (let frame = 0; frame < w.totalFrames; frame++) {
          framesWalked++
          for (const d of draws(clips, w.totalFrames, w.fps, frame)) {
            const own = clipFrames(clips[d.index], w.fps)
            if (own === null) continue
            if (d.spanFrames > own) {
              wrong.push(`${w.id}(${w.totalFrames}f) ${L.name} f${frame} clip#${d.index}: asked for ${d.spanFrames}f of a ${own}f clip (+${((d.spanFrames - own) / w.fps).toFixed(2)}s past its end)`)
            }
          }
        }
      }
    }
    return { wrong, framesWalked }
  }

  const after = violate((clips, total, fps, frame) => brollDrawAt(clips, total, fps, undefined, frame, true))
  ok(`across ${after.framesWalked} frames (${consumers.length} registered windows × ${LIBRARIES.length} libraries),\n    NO clip is ever given a media window longer than the clip itself`,
    after.wrong.length === 0, `${after.wrong.length} violations, first: ${after.wrong[0] ?? "-"}`)

  // POSITIVE CONTROL (§2) — the pre-fix even division must FAIL this same rule,
  // or the rule is measuring nothing. This re-creates it exactly: slots from
  // `brollWindowAt` (the count-only deriver, still exported and still correct
  // for what it does), a clip's span = its whole even slot.
  const preFix = violate((clips, total, _fps, frame) => {
    const w = brollWindowAt(clips.length, total, frame % total)
    return w ? [{ index: w.index, spanFrames: w.durationFrames }] : []
  })
  const worstSeconds = Math.max(
    0,
    ...preFix.wrong.map((s) => Number(s.match(/\+([\d.]+)s past/)?.[1] ?? 0)),
  )
  ok(`POSITIVE CONTROL: the pre-fix EVEN DIVISION fails the same rule on ${preFix.wrong.length} frames,\n    asking clips for up to ${worstSeconds.toFixed(2)}s of footage they do not contain — that\n    overshoot is what rendered as a FROZEN LAST FRAME`,
    preFix.wrong.length > 0 && worstSeconds > 0.5,
    `${preFix.wrong.length} violations, worst +${worstSeconds.toFixed(2)}s`)

  // ...and the control is not VACUOUS. It must fail exactly where the footage is
  // too short for an even slot and nowhere else — derived from the same rule, so
  // this cannot be satisfied by a control that simply fails everything.
  {
    const mismatched: string[] = []
    for (const w of consumers) {
      for (const L of LIBRARIES) {
        const clips = lib(L.secs)
        const evenSlot = Math.max(1, Math.floor(w.totalFrames / clips.length))
        // The last slot absorbs the remainder, so it is the widest.
        const widest = clips.length === 1
          ? w.totalFrames
          : Math.max(evenSlot, w.totalFrames - (clips.length - 1) * evenSlot)
        const shouldFail = clips.some((c, i) => {
          const own = clipFrames(c, w.fps)!
          const slot = i === clips.length - 1 ? widest : evenSlot
          return slot > own
        })
        const didFail = preFix.wrong.some((s) => s.startsWith(`${w.id}(${w.totalFrames}f) ${L.name} `))
        if (shouldFail !== didFail) mismatched.push(`${w.id} ${L.name}: predicted ${shouldFail}, observed ${didFail}`)
      }
    }
    ok("...and the control is not vacuous: it fails on exactly the (window × library)\n    pairs where an even slot is WIDER than the footage, and on no others — the clip\n    length decides, not the guard",
      mismatched.length === 0, mismatched.slice(0, 3).join(" | "))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n═══ 3. The slots still TILE the window — bounding must not open a gap ═══")
{
  // A slot shorter than its clip is only correct if something else covers the
  // rest of the window. A gap renders the composition background: black-ish, and
  // exactly the kind of "successful render of the wrong thing" being closed.
  const gaps: string[] = []
  const overlaps: string[] = []
  const short: string[] = []
  let cadences = 0
  for (const w of consumers) {
    for (const L of LIBRARIES) {
      cadences++
      const slots: BrollWindow[] = brollSlots(lib(L.secs), w.totalFrames, w.fps, 10)
      let expect = 0
      for (const s of slots) {
        if (s.from !== expect) (s.from > expect ? gaps : overlaps).push(`${w.id} ${L.name}: slot starts at ${s.from}, previous ended at ${expect}`)
        expect = s.from + s.durationFrames
      }
      if (expect !== w.totalFrames) short.push(`${w.id} ${L.name}: slots cover ${expect}f of ${w.totalFrames}f`)
    }
  }
  ok(`every slot starts where the previous one ended — no unpainted gap (${cadences} cadences)`,
    gaps.length === 0, gaps.slice(0, 2).join(" | "))
  ok("...and none overlap, so two clips are never both 'the' clip",
    overlaps.length === 0, overlaps.slice(0, 2).join(" | "))
  ok("...and together they cover the WHOLE window exactly",
    short.length === 0, short.slice(0, 2).join(" | "))

  // POSITIVE CONTROLS (§2) — a deriver that returns nothing passes all three above.
  const sample = brollSlots(lib([4, 4, 4]), 480, 30, 10)
  ok(`the deriver actually produces slots and LOOPS the library to fill a window\n    longer than the footage (three 4s clips over 480f ⇒ ${sample.length} slots, not 3)`,
    sample.length > 3 && sample.reduce((s, x) => s + x.durationFrames, 0) === 480)
  ok("...and it is bounded by the FOOTAGE, not the count: the same three clips in a\n    240f window need fewer slots than in a 480f one",
    brollSlots(lib([4, 4, 4]), 240, 30, 10).length < sample.length)
  ok("...and a degenerate input returns [] rather than a guess (no clips, no window)",
    brollSlots([], 480, 30, 10).length === 0 && brollSlots(lib([4]), 0, 30, 10).length === 0)
  ok("...and an impossible fps (0) makes every clip UNMEASURABLE, so it falls back to\n    the even division rather than inventing a slot length",
    JSON.stringify(brollSlots(lib([4, 4, 4]), 480, 0, 10))
    === JSON.stringify(Array.from({ length: 3 }, (_, i) => brollWindowAt(3, 480, i * 160)!)))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n═══ 4. The UNMEASURED fallback is honest, and counted rather than hidden ═══")
{
  // Not every producer measures. When ANY clip lacks a duration there is nothing
  // to bound a slot BY, so the even division stands — today's behaviour exactly.
  // That is a real blind spot, so it is asserted as a BEHAVIOUR, not hidden.
  const bare: BrollClip[] = [{ url: "a.mp4" }, { url: "b.mp4" }, { url: "c.mp4" }]
  const evenSlots = brollSlots(bare, 480, 30, 10)
  const derivedEven = Array.from({ length: 3 }, (_, i) => brollWindowAt(3, 480, i * 160)!)
  ok("clips with NO measured duration fall back to the even division, byte-for-byte\n    the pre-2026-09-05 behaviour (no silent change to reels nobody measured)",
    JSON.stringify(evenSlots) === JSON.stringify(derivedEven), JSON.stringify(evenSlots))
  ok("...and a PARTIALLY measured library also falls back — one unmeasured clip\n    makes the whole plan unprovable, so it is not claimed",
    JSON.stringify(brollSlots([{ url: "a.mp4", durationSeconds: 4 }, { url: "b.mp4" }], 480, 30, 10))
    === JSON.stringify(Array.from({ length: 2 }, (_, i) => brollWindowAt(2, 480, i * 240)!)))
  ok("...and a measured library does NOT fall back — the two paths are really different",
    JSON.stringify(brollSlots(lib([4, 4, 4]), 480, 30, 10)) !== JSON.stringify(derivedEven))

  // CENSUS of the producers, with the denominator published (§2). Heuristic and
  // labelled as one: a file that names brollClips and also names durationSeconds
  // is treated as measuring.
  const walk = (dir: string, depth = 0, out: string[] = []): string[] => {
    if (depth > 4) return out
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue
      const full = `${dir}/${e.name}`
      if (e.isDirectory()) walk(full, depth + 1, out)
      else if (/\.tsx?$/.test(e.name)) out.push(full)
    }
    return out
  }
  // Three ways a producer's clips can carry a measurement, in order of
  // directness. Stated as a HEURISTIC over stripped source, with the
  // denominator printed — not as a proof of any individual file.
  const producers: Array<{ file: string; how: string }> = []
  for (const f of [...walk("lib"), ...walk("app")]) {
    const src = readStripped(f)
    if (!src || !/\bbrollClips\b/.test(src)) continue
    const how =
      /\bdurationSeconds\b/.test(src)         ? "sets durationSeconds"
      : /\bpickBrollClips\b/.test(src)        ? "via pickBrollClips (measured upstream)"
      : /brollClips\s*[:=]\s*\[\s*\]/.test(src) ? "stages an EMPTY list (supplies no clips)"
      : "UNMEASURED — bare URLs, layer falls back to even division"
    producers.push({ file: f, how })
  }
  const unmeasured = producers.filter((p) => p.how.startsWith("UNMEASURED"))
  ok(`census: ${producers.length} file(s) under lib/ + app/ name brollClips; ${unmeasured.length} supply\n    clips with no measurement at all (each named below — that is the uncovered set)`,
    producers.length > 0)
  for (const p of producers) console.log(`    ${p.file} — ${p.how}`)
  // POSITIVE CONTROL (§2): the classifier must still recognise the bare-URL shape.
  ok("the census classifier still recognises a bare-URL producer",
    !/\bdurationSeconds\b/.test(blankStrings(stripComments(`props.brollClips = urls.map((url) => ({ url }))`))))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n═══ 5. THE WIRE: the measurement really travels picker → prop → layer ═══")
{
  const picker = readStripped(PICKER)!
  const layer  = readStripped(LAYER)!
  const plan   = readStripped(PLAN)!
  // An import SPECIFIER is a string literal, so blankStrings() erases exactly
  // the thing these three scans must read. Comments are still stripped — a
  // tombstone naming ./broll-plan is not an import — but the quoted paths
  // survive. §2's rule is "strip before you scan for code tokens", and this is
  // the `stripComments`-only case it names.
  const pickerImports = stripComments(readFileSync(PICKER, "utf8"))
  const layerImports  = stripComments(readFileSync(LAYER, "utf8"))

  ok(`${PLAN} exports selectBrollPlan — the ONE implementation both sides call (§6)`,
    /export function selectBrollPlan\b/.test(plan))
  ok(`...and ${PICKER} re-exports it rather than keeping a second copy, so its\n    existing importers are unchanged and no second spelling exists`,
    /export\s*\{[^}]*\bselectBrollPlan\b[^}]*\}\s*from\s*["'][^"']*broll-plan["']/s.test(pickerImports)
    && !/export function selectBrollPlan\b/.test(picker))
  ok(`...and ${LAYER} imports it from the pure module, NOT from the picker (which\n    dynamic-imports a server-only Supabase client the Remotion bundler would follow)`,
    /import\s*\{[^}]*\bselectBrollPlan\b[^}]*\}\s*from\s*["'][^"']*broll-plan["']/s.test(layerImports)
    && !/from\s*["'][^"']*broll-picker["']/.test(layerImports))
  ok(`${PICKER} writes the measurement onto the composition-facing clip\n    (PickedBrollClip.durationSeconds), so it rides the EXISTING brollClips prop`,
    /durationSeconds\??:\s*number/.test(picker) && /durationSeconds:\s*c\.durationSeconds/.test(picker))
  ok(`${LAYER} READS it — the half that did not exist before`,
    /durationSeconds/.test(layer) && /clip\?\.durationSeconds|clip\.durationSeconds/.test(layer))
  ok("...and the markup carries no arithmetic of its own: the <ClipFrame> spans come\n    from brollDrawAt, which is what §2 above walked",
    /brollDrawAt\(/.test(layer) && /spanFrames=\{d\.spanFrames\}/.test(layer) && /from=\{startFrame\}/.test(layer))

  // POSITIVE CONTROLS (§2) — every one of the six scans above must still fail on
  // the shape it was written to reject.
  ok("the wire scans recognise the PRE-FIX shapes (a picker that drops the\n    measurement, a layer that never reads one, markup that does its own maths)",
    !/durationSeconds:\s*c\.durationSeconds/.test(blankStrings(stripComments(`clips.push({ url: c.url, caption: c.caption })`)))
    && !/durationSeconds/.test(blankStrings(stripComments(`export interface BrollClip { url: string; caption?: string }`)))
    && !/brollDrawAt\(/.test(blankStrings(stripComments(`const perClip = Math.floor(totalFrames / clips.length)`)))
    && !/export function selectBrollPlan\b/.test(blankStrings(stripComments(`// export function selectBrollPlan() {}`))))
  ok("...and the import scans reject a TOMBSTONE naming ./broll-plan while accepting\n    a real import — the §2 trap that turned five guards red in one wave",
    !/import\s*\{[^}]*\bselectBrollPlan\b[^}]*\}\s*from\s*["'][^"']*broll-plan["']/s
      .test(stripComments(`// moved to ./broll-plan: import { selectBrollPlan } from "./broll-plan"`))
    && /import\s*\{[^}]*\bselectBrollPlan\b[^}]*\}\s*from\s*["'][^"']*broll-plan["']/s
      .test(stripComments(`import { selectBrollPlan } from "../lib/video/broll-plan"`)))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n═══ 6. Crossfades come out of real footage, never a frozen frame ═══")
{
  // The old layer extended the OUTGOING clip by the crossfade — past its slot,
  // and with it past the clip's end. Now the fade is capped by the tail
  // brollSlots reserved from that clip's own length; where there is none, the
  // boundary is a hard CUT rather than a dissolve from a still.
  let fades = 0
  let overruns = 0
  for (const w of consumers) {
    for (const L of LIBRARIES) {
      const clips = lib(L.secs)
      for (let frame = 0; frame < w.totalFrames; frame++) {
        const draws = brollDrawAt(clips, w.totalFrames, w.fps, undefined, frame, true)
        const out = draws.find((d) => d.outgoing)
        if (!out) continue
        fades++
        const own = clipFrames(clips[out.index], w.fps)
        if (own !== null && out.spanFrames > own) overruns++
      }
    }
  }
  ok(`crossfades still happen (${fades} frames across the sweep show an outgoing clip)`, fades > 0)
  ok("...and not one of them asks the outgoing clip for footage past its end",
    overruns === 0, `${overruns} overrunning fade frames`)
  // The reserve is what makes both true at once. Prove it is really being SPENT:
  // an outgoing clip must at some point be drawn for LONGER than its own slot
  // (that extra is the reserved tail), and still within its own length.
  {
    const clips = lib([4, 4, 4])
    const slots = brollSlots(clips, 480, 30, 10)
    let spentTail = false
    for (let frame = 0; frame < 480; frame++) {
      for (const d of brollDrawAt(clips, 480, 30, 10, frame, true)) {
        if (!d.outgoing) continue
        const slot = slots.find((s) => s.index === d.index && s.from === d.startFrame)
        if (slot && d.spanFrames > slot.durationFrames) spentTail = true
      }
    }
    ok("...and the fade is spending REAL reserved footage, not dissolving from a still:\n    an outgoing clip is drawn past its slot but never past its own end",
      spentTail && overruns === 0)
  }
}

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log(" BLIND SPOTS, published beside the number (§2):")
console.log("   · This proves a clip is never asked for footage it does not have, GIVEN the")
console.log("     duration it was handed. It cannot prove the duration is TRUE: it comes from")
console.log("     a Mediabunny probe, else the stored video_assets.duration_seconds, else")
console.log("     DEFAULT_CLIP_SECONDS. A stored duration LONGER than the file still freezes,")
console.log("     and nothing here reads the live table (this lane may not query the database).")
console.log("   · Clips with NO measured duration keep the even division and are therefore")
console.log("     NOT covered by the rule. §4 counts those producers by name; today")
console.log("     lib/agents/seller-update-reel-producer.ts builds brollClips from bare URLs")
console.log("     and is out of this lane's file ownership. That is a FINDING, not a pass.")
console.log("   · The loop=false playhead PAST totalFrames still clamps to the last clip and")
console.log("     holds its final frame. No current call site passes loop={false}, so the")
console.log("     sweep above walks [0, totalFrames) only.")
console.log("   · No frame is rendered. This is arithmetic + markup, not pixels; a browser")
console.log("     regression in @remotion/media's own from/durationInFrames handling would")
console.log("     not be caught. scripts/broll-window-guard.ts carries the same limit.")
console.log("   · Only compositions under remotion/ that mount <BrollLayer> and are in")
console.log("     COMPOSITION_GEOMETRY are swept. A B-roll layer built elsewhere is invisible.")
if (failed > 0) {
  console.log(" ✗ Failures:")
  for (const f of failures) console.log(`   - ${f}`)
  process.exit(1)
}
console.log(" ✅ No B-roll clip is ever asked to play past its own end.")
console.log(" BROLL_SLOT_PASS")
process.exit(0)
