#!/usr/bin/env tsx
/**
 * scripts/broll-window-guard.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * EVERY B-ROLL CLIP PLAYS FROM ITS OWN FRAME 0.
 *
 * THE DEFECT THIS CLOSES (found 2026-09-04, lane REMO, auditing remotion/
 * against .claude/skills/remotion-best-practices). remotion/_BrollLayer.tsx
 * cuts through N cutaway clips across one frame window. It rendered each clip's
 * `<Video>` BARE — no `from`, no wrapping `<Sequence>` — so the media's playback
 * position was the ENCLOSING sequence's frame rather than the frame within that
 * clip's own slot.
 *
 * Clip #1 looked correct, because its slot starts at 0 and the two numbers
 * agree there. Every clip after it did not. With three clips over
 * NeighborhoodSpotlightReel's 480-frame window (perClip = 160 @ 30fps) the
 * layer asked clip #2 for source second 5.33 and clip #3 for source second
 * 10.67 — of stock cutaways that lib/video/broll-picker.ts measures (Mediabunny,
 * else video_assets.duration_seconds) and typically finds are 4-8 seconds long.
 * Past its end a `<Video>` holds its last frame, so the reel showed a FROZEN
 * STILL where it promised motion, the first seconds of each clip were skipped,
 * and the render reported success — the failure shape this repo keeps paying
 * for.
 *
 * THE SKILL SAYS SO DIRECTLY. remotion-markup/REFERENCE.md, "Delaying,
 * trimming" (lines 170-211): `from` is "When the element starts appearing in
 * the timelien [sic]", `durationInFrames` is "For how long the layer plays in
 * the timeline", and both are listed as supported on "`<Video>` and `<Audio>`
 * from `@remotion/media`". remotion/PhotoWalkthroughReel.tsx:197 already uses
 * exactly this shape to give each Ken Burns photo its own clock.
 *
 * MEASUREMENT DISCIPLINE (§2):
 *   · The rule is asserted, and the numbers DERIVED from it — no frame count is
 *     typed here that the layer's own arithmetic does not produce.
 *   · Every absence claim carries a POSITIVE CONTROL that re-creates the
 *     pre-fix markup and proves the finder still fails it.
 *   · Source scans read stripComments()+blankStrings() output, so this file's
 *     own prose (which names `from={`, `<Video`, `trimBefore`) is not a call
 *     site, and neither is the tombstone comment inside _BrollLayer.tsx.
 *   · Blind spots are printed beside the count.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { stripComments, blankStrings } from "./strip-comments"
import { brollWindowAt } from "../remotion/_BrollLayer"

let passed = 0
let failed = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; failures.push(label + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}

const LAYER = "remotion/_BrollLayer.tsx"
const layerRaw = existsSync(LAYER) ? readFileSync(LAYER, "utf8") : ""
// A tombstone is not a call site (§2), and a fixture inside a template literal
// is not markup — read both blanked, offsets preserved.
const layerSrc = blankStrings(stripComments(layerRaw))

console.log("═══ 0. Fail closed: the file this guard judges must be readable ═══")
ok(`${LAYER} exists and was read (${layerRaw.length} bytes)`, layerRaw.length > 0)
if (layerRaw.length === 0) {
  console.log("\n B-ROLL WINDOW — cannot judge a file it cannot read; refusing rather than passing.")
  process.exit(1)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n═══ 1. The window arithmetic: contiguous, complete, remainder-absorbing ═══")
{
  // Derived from the layer's OWN exported function, so a change to the cadence
  // moves these numbers rather than aging this file into a lie.
  const cases: Array<{ clips: number; total: number }> = [
    { clips: 3, total: 480 },  // NeighborhoodSpotlightReel window
    { clips: 4, total: 360 },  // ComingSoonReel window
    { clips: 5, total: 300 },  // AgentTalkingHeadReel BODY window
    { clips: 7, total: 480 },  // does not divide evenly — remainder case
    { clips: 1, total: 900 },
  ]
  const contiguityBreaks: string[] = []
  const coverageBreaks: string[] = []
  for (const c of cases) {
    const windows = Array.from({ length: c.clips }, (_, i) =>
      brollWindowAt(c.clips, c.total, i === 0 ? 0 : brollWindowAt(c.clips, c.total, 0)!.durationFrames * i))
    // Walk every frame instead of trusting the sample above: the window a frame
    // resolves to must be the window that contains it.
    let expectFrom = 0
    for (let i = 0; i < c.clips; i++) {
      const w = brollWindowAt(c.clips, c.total, expectFrom)!
      if (w.index !== i || w.from !== expectFrom) {
        contiguityBreaks.push(`${c.clips}x${c.total}: clip ${i} resolved to index ${w.index} at ${w.from}, expected ${i} at ${expectFrom}`)
        break
      }
      expectFrom += w.durationFrames
    }
    if (expectFrom !== c.total) coverageBreaks.push(`${c.clips}x${c.total}: windows cover ${expectFrom} frames, not ${c.total}`)
    void windows
  }
  ok(`every clip's window starts where the previous one ended (${cases.length} cadences)`,
    contiguityBreaks.length === 0, contiguityBreaks.join(" | "))
  ok("...and together they cover the WHOLE B-roll window — the last clip absorbs\n    the remainder, so an uneven division never leaves an unpainted tail",
    coverageBreaks.length === 0, coverageBreaks.join(" | "))

  // POSITIVE CONTROLS (§2): a broken deriver and a correct one both report zero above.
  ok("the deriver actually moves with its inputs (3 clips over 480f ⇒ slots at 0/160/320)",
    brollWindowAt(3, 480, 0)!.from === 0
    && brollWindowAt(3, 480, 200)!.from === 160
    && brollWindowAt(3, 480, 400)!.from === 320)
  ok("...and the uneven case really is uneven (7 clips over 480f ⇒ 68f slots, last runs 72f)",
    brollWindowAt(7, 480, 0)!.durationFrames === 68
    && brollWindowAt(7, 480, 479)!.durationFrames === 480 - 6 * 68)
  ok("...and a degenerate input returns null rather than a guess",
    brollWindowAt(0, 480, 0) === null && brollWindowAt(3, 0, 0) === null)
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n═══ 2. THE RULE: playback offset == frames since the clip's slot began ═══")
{
  const FPS = 30
  /**
   * The playback position a `<Video from={videoFrom}>` will be at when the
   * enclosing sequence is on `frame`. This is Remotion's own definition: `from`
   * places the element on the timeline and its internal clock starts at 0 there.
   */
  const playbackOffset = (frame: number, videoFrom: number) => frame - videoFrom

  /** What the layer renders TODAY: `from` = the clip's own slot start. */
  const fixedFrom = (clips: number, total: number, frame: number) =>
    brollWindowAt(clips, total, frame)!.from
  /** What the layer rendered BEFORE the fix: a bare <Video>, i.e. from = 0. */
  const preFixFrom = (_clips: number, _total: number, _frame: number) => 0

  const check = (from: typeof fixedFrom) => {
    const wrong: string[] = []
    for (const [clips, total] of [[3, 480], [4, 360], [5, 300], [7, 480]] as const) {
      for (let frame = 0; frame < total; frame++) {
        const w = brollWindowAt(clips, total, frame)!
        const want = frame - w.from
        const got = playbackOffset(frame, from(clips, total, frame))
        if (got !== want) wrong.push(`${clips}x${total} f${frame} clip#${w.index}: source frame ${got}, should be ${want}`)
      }
    }
    return wrong
  }

  const afterFix = check(fixedFrom)
  ok("every frame of every clip plays the SOURCE frame that many frames into that\n    clip — no clip is ever asked for footage from another clip's position",
    afterFix.length === 0, `${afterFix.length} wrong, first: ${afterFix[0] ?? "-"}`)

  // POSITIVE CONTROL (§2) — the pre-fix markup must FAIL this same rule, or the
  // rule is not measuring anything.
  const beforeFix = check(preFixFrom)
  const worstSeconds = Math.max(
    ...beforeFix.map((s) => Number(s.match(/source frame (\d+)/)?.[1] ?? 0) - Number(s.match(/should be (\d+)/)?.[1] ?? 0)),
  ) / FPS
  ok(`POSITIVE CONTROL: the pre-fix bare <Video> FAILS the same rule on ${beforeFix.length} frames,\n    overshooting by up to ${worstSeconds.toFixed(2)}s of source — a stock cutaway shorter than\n    that renders its frozen last frame`,
    beforeFix.length > 0 && worstSeconds > 1)
  ok("...and the control is not vacuous: the FIRST clip was always correct, which\n    is why this survived preview review",
    check(preFixFrom).every((s) => !/clip#0:/.test(s)))
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n═══ 3. The markup carries the props the rule needs ═══")
{
  // Balanced scan of the <Video …/> tag in the layer, on stripped+blanked source.
  const tagAt = (src: string): string | null => {
    const at = src.indexOf("<Video")
    if (at < 0) return null
    let depth = 0
    for (let i = at; i < src.length; i++) {
      const ch = src[i]
      if (ch === "{") depth++
      else if (ch === "}") depth--
      else if (ch === ">" && depth === 0) return src.slice(at, i + 1)
    }
    return null
  }
  const hasFrom = (tag: string | null) => !!tag && /\bfrom=\{/.test(tag)
  const hasDuration = (tag: string | null) => !!tag && /\bdurationInFrames=\{/.test(tag)

  // POSITIVE CONTROLS (§2) — a broken tag scanner and clean markup both pass.
  ok("the tag scanner recognises the PRE-FIX shape it was written for (bare <Video>)",
    !hasFrom(tagAt(`<Video objectFit="cover" src={clip.url} trimBefore={0} style={{ width: "100%" }} />`)))
  ok("...and the fixed shape passes it",
    hasFrom(tagAt(`<Video src={clip.url} from={startFrame} durationInFrames={span} />`))
    && hasDuration(tagAt(`<Video src={clip.url} from={startFrame} durationInFrames={span} />`)))
  ok("...and it read STRIPPED source, so a comment or a string naming from={ is not markup",
    tagAt(blankStrings(stripComments(`// <Video src={x} from={1} />\nconst s = "<Video from={2} />"`))) === null)

  const layerTag = tagAt(layerSrc)
  ok(`${LAYER} renders exactly one <Video> tag and it was parsed`, layerTag !== null)
  ok(`...and it carries \`from\` — without it the clip's clock is the enclosing\n    sequence's, which is the whole defect`,
    hasFrom(layerTag), layerTag ?? "")
  ok("...and `durationInFrames`, so the slot ends where the next clip begins",
    hasDuration(layerTag), layerTag ?? "")
  ok("...and no longer states `trimBefore={0}` — that was the DEFAULT dressed up as\n    a claim that the clip starts at its beginning, which is what did not happen",
    !/\btrimBefore=\{0\}/.test(layerTag ?? ""), layerTag ?? "")
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n═══ 4. `from`/`durationInFrames` are real props of the INSTALLED remotion ═══")
{
  // FAIL CLOSED (§4): a guard that cannot read the package it reasons from must
  // refuse, not pass. Derived from node_modules rather than pinned to a version
  // literal (§2: assert the rule, do not pin a waypoint).
  const decl = "node_modules/remotion/dist/cjs/Interactive.d.ts"
  const mediaProps = "node_modules/@remotion/media/dist/video/props.d.ts"
  const declOk = existsSync(decl)
  const mediaOk = existsSync(mediaProps)
  ok(`the installed remotion's Interactive declaration is readable (${decl})`, declOk)
  ok(`the installed @remotion/media video props are readable (${mediaProps})`, mediaOk)
  if (declOk && mediaOk) {
    const base = readFileSync(decl, "utf8").match(/InteractiveBaseProps\s*=\s*Pick<SequenceProps,\s*([^>]+)>/)?.[1] ?? ""
    ok(`InteractiveBaseProps still carries 'from' and 'durationInFrames' (${base.trim()})`,
      /'from'/.test(base) && /'durationInFrames'/.test(base), base)
    const vp = readFileSync(mediaProps, "utf8")
    ok("...and @remotion/media's VideoProps still mixes InteractiveBaseProps in, so\n    the props the fix uses are this package's API and not a hopeful guess",
      /VideoProps\s*=[^;]*InteractiveBaseProps/.test(vp))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n═══ 5. Census: which <Video> sites in remotion/ this rule reaches ═══")
{
  // Denominator, published beside the number (§2). A single-clip <Video> whose
  // slot IS its enclosing sequence needs no `from`; the rule above is about a
  // component that packs several clips into one window.
  const files: string[] = []
  const walk = (dir: string, depth = 0) => {
    if (depth > 3) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue
      const full = `${dir}/${e.name}`
      if (e.isDirectory()) walk(full, depth + 1)
      else if (/\.tsx?$/.test(e.name)) files.push(full)
    }
  }
  walk("remotion")
  let sites = 0
  const perFile: string[] = []
  for (const f of files) {
    const n = (blankStrings(stripComments(readFileSync(f, "utf8"))).match(/<Video\b/g) ?? []).length
    if (n > 0) { sites += n; perFile.push(`${f}(${n})`) }
  }
  ok(`scanned ${files.length} files under remotion/ and found ${sites} <Video> site(s)`, sites > 0)
  console.log(`    sites: ${perFile.join(", ")}`)
  console.log("    IN SCOPE for the slot rule: remotion/_BrollLayer.tsx — the ONE component that")
  console.log("    packs multiple clips into one window. Every other site renders a single")
  console.log("    avatar/testimonial clip whose slot IS its enclosing sequence, so its clock")
  console.log("    already starts at 0 and `from` would be a no-op.")
}

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log(" BLIND SPOTS, published beside the number (§2):")
console.log("   · This guard proves WHERE a clip's playback starts. It does NOT prove the")
console.log("     clip is LONG ENOUGH for its slot: _BrollLayer divides the window EVENLY")
console.log("     while lib/video/broll-picker.ts already computes a per-clip plan from each")
console.log("     clip's measured duration (selectBrollPlan → BrollPlanEntry) and the Video")
console.log("     Director drops that plan on the floor (video-director.ts:1032 keeps only")
console.log("     picked.clips). A clip shorter than its even slot still freezes on its last")
console.log("     frame. That is a §1/§6 finding written up in lane-REMO-report.md, not")
console.log("     something this guard can assert away.")
console.log("   · No frame is rendered here. This is arithmetic + markup, not pixels; a")
console.log("     browser-level regression in @remotion/media's own `from` handling would")
console.log("     not be caught.")
console.log("   · Only remotion/** is scanned. A B-roll layer built elsewhere is invisible.")
if (failed > 0) {
  console.log(" ✗ Failures:")
  for (const f of failures) console.log(`   - ${f}`)
  process.exit(1)
}
console.log(" ✅ Every B-roll clip plays from its own frame 0.")
console.log(" BROLL_WINDOW_PASS")
process.exit(0)
