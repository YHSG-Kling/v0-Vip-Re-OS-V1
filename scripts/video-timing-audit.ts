#!/usr/bin/env tsx
/**
 * scripts/video-timing-audit.ts  (npm run test:video-timing-audit) — pure, no DB, no network.
 *
 * LANE 85E — THE COMPLETE-VIDEO TIMING AUDIT. Owner: "videos/avatar are the
 * most important capability: b-roll/images/music/intro/outro/branding correctly
 * calculated in the complete video with voiceover or avatar." Skills used:
 * remotion-best-practices (remotion-markup: calculate-metadata.md, voiceover.md,
 * audio.md "Delaying" and "the value of f starts at 0 when the audio begins",
 * sequencing.md; remotion-render for the real render), and the eval-first loop
 * of agentic-engineering (every rule below was run against the defect first).
 *
 * WHAT IS ALREADY PROVEN ELSEWHERE (reused, not restated): the purpose-driven
 * length rule and every composition's bookend/body derivation
 * (test:video-duration-model), per-type tiling and caption windows
 * (test:video-type-matrix), b-roll windows (test:broll-window), the duck graph's
 * ffmpeg ranges (test:remotion-asset-math), the cinema finish (test:cinema-finish).
 *
 * WHAT THIS ADDS — the defects those proofs could not see, each found by a REAL
 * render (Chromium, chromeMode "chrome-for-testing") or a REAL ffmpeg mix, and
 * each asserted here as a RULE with a positive control:
 *   §bundle    the production Remotion bundle (bundle({entryPoint:
 *              remotion/index.ts}), lib/remotion/bundle-cache.ts) FAILED TO
 *              COMPILE — two "@/" imports reachable from the entry, which webpack
 *              cannot resolve. Every production render failed at getBundle.
 *   §start     where each composition's narration audio STARTS, derived from its
 *              source, must equal the model's narrationStartFrame — and a
 *              composition's in-frame audio must agree with its own captions.
 *   §plan      a measured voice ends exactly one settle before the outro tile —
 *              never a cover's worth of dead air (the model appended a frame-0
 *              narration AFTER the cover it already played under).
 *   §trust     D-ID's MEASURED clip length beats a staged ESTIMATE.
 *   §bookends  the stock bookends count at their TRIMMED length, so the music
 *              fade-out ends at the file's real end.
 *   §duck      the music ducks under a PRESENTER'S voice, not only a voiceover.
 *   §mux       the snake-key narration mux lands at the composition's narration
 *              start (after any applied stock intro), not at t=0.
 *   §slides    no fade envelope can throw inside interpolate() at a short slot.
 *   §safe      the full-frame presenter sits inside the frame's safe area.
 */
import { readFileSync, existsSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { blankComments, stripComments } from "./strip-comments"
import { VIDEO_COMPOSITION_FILES } from "./composition-segments"
import {
  COMPOSITION_DURATION_RULES, NARRATION_SETTLE_SECONDS, narrationStartFrame, narrationWindowFrames,
  narrationLengthFromProps, planCompositionDuration, planDurationForProps,
} from "../lib/video/duration-model"
import { geometryFor } from "../lib/remotion/composition-geometry"
import { appliedBookendSeconds, MAX_BRAND_BOOKEND_SECONDS } from "../lib/video/realism-profile"
import { buildMusicTrackFilter } from "../lib/remotion/music-filter-graph"
import { cinemaMusicFades } from "../lib/video/cinema-finish"
import { stagesSpeech, stagesVoiceover } from "../lib/remotion/content-contract"
import { narrationDelayStage, paddingSecondsFor } from "../lib/remotion/voiceover-mixer"
import { slideFadeRange } from "../lib/video/assembly-timeline"
import { fullPresenterBox, insideSafeArea } from "../lib/video/body-visual-model"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel: string) => readFileSync(join(root, rel), "utf8")
const code = (rel: string) => blankComments(read(rel))

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §bundle · the Remotion bundle graph resolves no tsconfig alias ──")
{
  const SPEC = /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g
  const specifiers = (src: string) => { const out: string[] = []; let m: RegExpExecArray | null; const re = new RegExp(SPEC.source, "g"); while ((m = re.exec(src))) out.push(m[1] ?? m[2]); return out }
  const seen = new Set<string>(), aliased: string[] = []
  const queue = [join(root, "remotion/index.ts")]
  while (queue.length) {
    const f = queue.pop()!
    if (seen.has(f)) continue
    seen.add(f)
    for (const spec of specifiers(blankComments(readFileSync(f, "utf8")))) {
      if (spec.startsWith("@/")) { aliased.push(`${relative(root, f)} → ${spec}`); continue }
      if (!spec.startsWith(".")) continue
      const base = join(dirname(f), spec)
      const hit = [base + ".ts", base + ".tsx", join(base, "index.ts"), join(base, "index.tsx"), base].find((c) => /\.(ts|tsx)$/.test(c) && existsSync(c))
      if (hit) queue.push(hit)
    }
  }
  const reached = [...seen].map((f) => relative(root, f))
  console.log(`  denominator: ${reached.length} files reachable from remotion/index.ts through relative imports`)
  check("the walker reaches into lib/ (it follows the edges the bundle follows)",
    reached.includes("lib/video/duration-model.ts") && reached.includes("lib/video/render-cut.ts") && reached.includes("lib/charts/geometry.ts"))
  check("NO \"@/\" specifier anywhere in the Remotion bundle graph (bundle() has no webpackOverride — lib/remotion/bundle-cache.ts)",
    aliased.length === 0, aliased.join("; "))
  check("CONTROL: the finder sees the two lines that broke the production bundle before lane 85E",
    specifiers(`import { CONTENT_CONTRACT } from "@/lib/remotion/content-contract"`).some((s) => s.startsWith("@/"))
    && specifiers(`import { clamp } from "@/lib/format/math"`).some((s) => s.startsWith("@/")))
  check("CONTROL: a specifier inside a comment is not an edge (a tombstone that names the old \"@/\" line stays green)",
    specifiers(blankComments(`// was: import { clamp } from "@/lib/format/math"\nimport { clamp } from "../format/math"`)).every((s) => !s.startsWith("@/")))
  check("bundle-cache still bundles with NO webpackOverride — the reason the rule exists (re-derive it if that changes)",
    /bundle\(\{\s*entryPoint\s*\}\)/.test(code("lib/remotion/bundle-cache.ts")))
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §start · where the narration audio starts, derived from each composition's source ──")
/** The in-frame voiceover <Audio> and whether it sits inside an open <Sequence from=…>. */
function audioPlacement(src: string): "root" | "nested" | null {
  const m = /<Audio\b[^>]*\bsrc=\{[^}]*voiceoverUrl[^}]*\}/.exec(src)
  if (!m) return null
  const before = src.slice(0, m.index)
  const opens = (before.match(/<Sequence\b[^>]*\bfrom=\{/g) ?? []).length
  const closes = (before.match(/<\/Sequence>/g) ?? []).length
  return opens > closes ? "nested" : "root"
}
function captionStartsAfterCover(src: string): boolean | null {
  const tag = /<CaptionLayer\b([\s\S]*?)\/>/.exec(src)
  if (!tag) return null
  return /visibleFromFrame=\{/.test(tag[1])
}
{
  let derivedCount = 0
  for (const [id, file] of Object.entries(VIDEO_COMPOSITION_FILES)) {
    const spec = COMPOSITION_DURATION_RULES[id]
    if (!spec || spec.bodyMode !== "narration" || !existsSync(join(root, file))) continue
    if (spec.durationFromProps) {
      console.log(`  · ${id}: per-chapter narration laid out by its own planner (durationFromProps; one <Audio> per chapter scene) — held by test:memory-video-modes, published exclusion`)
      continue
    }
    const src = code(file)
    const audio = audioPlacement(src)
    const caption = captionStartsAfterCover(src)
    const start = narrationStartFrame(id)
    if (audio !== null) {
      derivedCount++
      check(`${id}: in-frame voiceover is ${audio === "root" ? "at the ROOT (plays from frame 0)" : "DELAYED in a <Sequence from=…>"} → narrationStartFrame ${start} = ${audio === "root" ? 0 : spec.introFrames}`,
        start === (audio === "root" ? 0 : spec.introFrames))
      if (caption !== null) {
        check(`${id}: its own captions agree with its audio (${audio === "root" ? "no" : "a"} visibleFromFrame)`, (audio === "nested") === caption || spec.introFrames === 0)
      }
    } else if (caption !== null) {
      derivedCount++
      check(`${id}: no in-frame voiceover; its captions ${caption ? "start after the cover" : "run from frame 0"} → narrationStartFrame ${start}`,
        start === (caption ? spec.introFrames : 0) || spec.introFrames === 0)
    } else {
      console.log(`  · ${id}: no in-frame voiceover and no CaptionLayer — narration start not derivable from source (published)`)
    }
  }
  check(`the derivation covered ${derivedCount} narration compositions (a sweep that covers none is blind)`, derivedCount >= 15)
  // Avatar hosts that ALSO play a separate voiceover must mute the presenter's own voice.
  for (const [id, file] of Object.entries(VIDEO_COMPOSITION_FILES)) {
    const spec = COMPOSITION_DURATION_RULES[id]
    if (!spec || spec.host !== "avatar" || !existsSync(join(root, file))) continue
    const src = code(file)
    if (audioPlacement(src) === null) continue
    const videos = [...src.matchAll(/<Video\b[^>]*?src=\{avatarVideoUrl\}[^>]*?\/>/g)].map((m) => m[0])
    check(`${id}: plays a separate voiceover AND the avatar clip — every avatar <Video> is muted while the voiceover plays`,
      videos.length > 0 && videos.every((v) => /muted=\{!!voiceoverUrl\}/.test(v)))
  }
  const PRE = `{voiceoverUrl && <Audio src={voiceoverUrl} />}\n<Sequence from={COVER}><Video src={avatarVideoUrl} trimBefore={0} /></Sequence>\n<CaptionLayer cues={c} visibleFromFrame={COVER} />`
  check("CONTROL: the pre-85E AgentTalkingHeadReel shape (root voiceover, captions after the cover) is a DISAGREEMENT the rule catches",
    audioPlacement(PRE) === "root" && captionStartsAfterCover(PRE) === true)
  check("CONTROL: the fixed shape (voiceover delayed to COVER) reads as nested",
    audioPlacement(`<Sequence from={COVER} layout="none"><Audio src={voiceoverUrl} /></Sequence>`) === "nested")
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §plan · a measured voice ends one settle before the outro — never dead air ──")
{
  const S = 12.3
  for (const [id, spec] of Object.entries(COMPOSITION_DURATION_RULES)) {
    if (spec.bodyMode !== "narration" || spec.durationFromProps) continue
    const geo = geometryFor(id)
    if (!geo) continue
    const plan = planCompositionDuration({ compositionId: id, spokenSeconds: S, spokenSecondsSource: "measured" })
    if (plan.clampedToCap) { console.log(`  · ${id}: clamped at ${S}s — covered by test:video-duration-model`); continue }
    const voiceEnd = narrationStartFrame(id) / geo.fps + S
    const outroAt = (plan.introFrames + plan.bodyFrames) / geo.fps
    check(`${id}: voice ${narrationStartFrame(id) / geo.fps}s→${voiceEnd.toFixed(2)}s, outro tile at ${outroAt.toFixed(2)}s (gap ${(outroAt - voiceEnd).toFixed(2)}s = the ${NARRATION_SETTLE_SECONDS}s settle)`,
      Math.abs(outroAt - voiceEnd - NARRATION_SETTLE_SECONDS) <= 1 / geo.fps + 1e-9)
  }
  // POSITIVE CONTROL — the pre-85E arithmetic (the whole span appended after the cover).
  const jl = COMPOSITION_DURATION_RULES.JustListedReel
  const preFixOutro = (jl.introFrames + Math.round((S + NARRATION_SETTLE_SECONDS) * 30)) / 30
  check(`CONTROL: the pre-85E plan put JustListedReel's outro at ${preFixOutro.toFixed(2)}s — ${(preFixOutro - S).toFixed(2)}s after a frame-0 voice ended (${(preFixOutro - S - NARRATION_SETTLE_SECONDS).toFixed(2)}s of dead air)`,
    preFixOutro - S - NARRATION_SETTLE_SECONDS >= jl.introFrames / 30 - 1e-9 && jl.narrationFrom === "cover")
  check("the plan's narration window starts where the audio does (0 for a cover narration, the intro otherwise)",
    planCompositionDuration({ compositionId: "JustListedReel", spokenSeconds: S, spokenSecondsSource: "measured" }).narrationWindow.from === 0
    && planCompositionDuration({ compositionId: "MarketUpdateReel", spokenSeconds: S, spokenSecondsSource: "measured" }).narrationWindow.from === COMPOSITION_DURATION_RULES.MarketUpdateReel.introFrames
    && narrationWindowFrames("JustListedReel", 600).from === 0)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §trust · the clip that will actually play is measured, not guessed ──")
{
  const merged = { spokenSeconds: 20, spokenSecondsSource: "estimated", avatarDurationSeconds: 31.4 }
  check("an ESTIMATED staged length loses to D-ID's MEASURED avatarDurationSeconds", narrationLengthFromProps("AgentTalkingHeadReel", merged)?.spokenSeconds === 31.4)
  check("two measurements take the longer (neither track is cut)",
    narrationLengthFromProps("PartnersMeetingReel", { spokenSeconds: 20, spokenSecondsSource: "measured", avatarDurationSeconds: 24 })?.spokenSeconds === 24)
  const bodyWith = planDurationForProps("AgentTalkingHeadReel", merged).bodySeconds
  const bodyGuess = planCompositionDuration({ compositionId: "AgentTalkingHeadReel", spokenSeconds: 20, spokenSecondsSource: "estimated" }).bodySeconds
  check(`CONTROL: the guess would have planned a ${bodyGuess}s body for a 31.4 s clip; the measurement plans ${bodyWith}s — the clip fits`,
    bodyGuess < 31.4 && bodyWith >= 31.4)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §bookends · the music fade-out ends at the file's real end ──")
{
  const fadeOutEnd = (graph: string) => { const m = /afade=t=out:st=([\d.]+):d=([\d.]+)/.exec(graph); return m ? Number(m[1]) + Number(m[2]) : null }
  for (const recorded of [10, 1.2, null]) {
    const main = 20
    const applied = main + appliedBookendSeconds(null, recorded) * 2
    const fades = cinemaMusicFades("JustListedReel", 30)
    const graph = buildMusicTrackFilter({ loop: true, volume: 0.12, videoSeconds: applied, ...fades })
    const realEnd = main + 2 * Math.min(MAX_BRAND_BOOKEND_SECONDS, recorded ?? MAX_BRAND_BOOKEND_SECONDS)
    check(`bookends recorded ${recorded ?? "unknown"}s → counted ${appliedBookendSeconds(null, recorded)}s each; the fade-out ends at ${fadeOutEnd(graph)}s = the file's end ${realEnd}s`,
      fadeOutEnd(graph) !== null && Math.abs((fadeOutEnd(graph) as number) - realEnd) < 0.011)
  }
  const pre = buildMusicTrackFilter({ loop: true, volume: 0.12, videoSeconds: 20 + 10 + 10, ...cinemaMusicFades("JustListedReel", 30) })
  check(`CONTROL: the pre-85E sum (recorded 10 s stings) faded out at ${fadeOutEnd(pre)}s — ${(fadeOutEnd(pre) as number) - 25}s past a 25 s file (the bed never faded)`,
    (fadeOutEnd(pre) as number) > 25 + 10)
  const coord = code("lib/remotion/render-coordinator.ts")
  check("the coordinator counts what the concat APPLIED (concat.introSeconds / outroSeconds, then appliedBookendSeconds)",
    /concat\.introSeconds\s*\?\?\s*appliedBookendSeconds\(/.test(coord) && /concat\.outroSeconds\s*\?\?\s*appliedBookendSeconds\(/.test(coord))
  check("concatIntroOutro measures each bookend it stitched and reports the trimmed length",
    /introSeconds:\s*introPath\s*\?\s*appliedBookendSeconds\(introProbe\)/.test(code("lib/video/composite-attribution.ts")))
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §duck · the bed ducks under a presenter's voice too ──")
{
  const avatarHosts = Object.entries(COMPOSITION_DURATION_RULES).filter(([, s]) => s.host === "avatar" && s.bodyMode === "narration").map(([id]) => id)
  check(`every avatar-hosted composition (${avatarHosts.length}) with a staged presenter clip carries speech`,
    avatarHosts.length >= 5 && avatarHosts.every((id) => stagesSpeech(id, { avatarVideoUrl: "https://x/a.mp4" })))
  check("CONTROL: the voiceover question (the pre-85E duck key) says NO speech for those same renders",
    avatarHosts.every((id) => !stagesVoiceover(id, { avatarVideoUrl: "https://x/a.mp4" })))
  check("a silent render carries no speech (the bed stays at its constant level)", !stagesSpeech("CMAReel", {}))
  const coord = code("lib/remotion/render-coordinator.ts")
  check("the coordinator ducks and masters on SPEECH (carriesSpeech), not the voiceover ledger alone",
    /duckToNarration:\s*carriesSpeech\s*\|\|\s*usedVoiceover/.test(coord) && /usedVoiceover \|\| carriesSpeech/.test(coord))
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §mux · the finish-mux narration lands at the composition's narration start ──")
{
  check("narrationDelayStage: 2.5 s → adelay 2500 ms on every channel; 0 → nothing",
    narrationDelayStage(2.5) === "adelay=2500:all=1," && narrationDelayStage(0) === "" && narrationDelayStage(null) === "")
  check("a delayed narration that overruns is padded by start + length − video (5 + 6 − 10 = 1 s)", paddingSecondsFor(5 + 6, 10) === 1)
  const coord = code("lib/remotion/render-coordinator.ts")
  check("the coordinator passes startSeconds = the applied stock intro + the composition's narrationWindowFrames(...).from",
    /const startSeconds = introClipSeconds\s*\+\s*narrationWindowFrames\(composition\.composition_id, mainPlan\.durationInFrames\)\.from/.test(coord)
    && /mixNarrationVoiceover\(\{[^}]*startSeconds/.test(coord))
  const mixer = code("lib/remotion/voiceover-mixer.ts")
  check("the mixer delays the voice in BOTH ffmpeg attempts and pads by start + length",
    (mixer.match(/\$\{delay\}|delay\.replace/g) ?? []).length >= 2 && /input\.narrationSeconds \+ start/.test(mixer))
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §slides · no fade envelope can throw inside interpolate() ──")
{
  let bad = 0
  for (let slot = 0; slot <= 400; slot++) for (const fade of [1, 4, 8, 10, 12, 20]) {
    const r = slideFadeRange(slot, fade)
    if (r && !(r[0] < r[1] && r[1] < r[2] && r[2] < r[3])) bad++
    if (!r && slot >= 3) bad++
  }
  check("slideFadeRange is strictly increasing for every slot 0-400 × fade 1-20 (null only under 3 frames)", bad === 0)
  // The [0, N, X − N, X] literal shape, anywhere under remotion/.
  const SHAPE = /interpolate\([^,]+,\s*\[\s*0\s*,\s*(\d+)\s*,\s*([A-Za-z_$][\w$.]*)\s*-\s*\1\s*,\s*\2\s*\]/
  const offenders = Object.values(VIDEO_COMPOSITION_FILES).concat(["remotion/components/KenBurnsPhoto.tsx", "remotion/_BrollLayer.tsx"])
    .filter((f) => existsSync(join(root, f)) && SHAPE.test(stripComments(read(f))))
  check("no composition fades a computed slot with a literal [0, N, slot − N, slot] (it throws once the slot is under 2N + 1)", offenders.length === 0, offenders.join(", "))
  check("CONTROL: the finder sees the pre-85E JustListedReel line — which threw \"[0,8,7,15]\" in a real render",
    SHAPE.test(`const opacity = interpolate(localFrame, [0, 8, slideFrames - 8, slideFrames], [0, 1, 1, 0], {`))
  check("CONTROL: that literal really is non-monotonic at a 15-frame slot", !(8 < 15 - 8))
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §safe · the full-frame presenter sits inside the safe area ──")
{
  const geo = geometryFor("AgentTalkingHeadReel")!
  const box = fullPresenterBox(geo.width, geo.height)
  check(`fullPresenterBox on the registered ${geo.width}×${geo.height} frame is inside the safe area (${JSON.stringify(box)})`, insideSafeArea(geo.width, geo.height, box))
  check("CONTROL: the typed pre-85E box { top: 90, left: 90, 900² } is OUTSIDE the safe area on that frame",
    !insideSafeArea(geo.width, geo.height, { top: 90, left: 90, width: 900, height: 900 }))
  check("the reel lays its full presenter out through fullPresenterBox", /fullPresenterBox\(width, height\)/.test(code("remotion/AgentTalkingHeadReel.tsx")))
}

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log("\n Failures:")
  for (const f of failures) console.log(`   - ${f}`)
  process.exit(1)
}
console.log(" ✅ VIDEO_TIMING_AUDIT_PASS — the bundle compiles, every narration starts where its captions and")
console.log("    the model say, a measured voice ends one settle before the outro, bookends count trimmed,")
console.log("    the bed ducks under any speech and fades at the file's end, and no slide fade can throw.")
