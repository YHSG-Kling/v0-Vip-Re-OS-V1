#!/usr/bin/env tsx
/**
 * scripts/cinema-finish-guard.ts  (npm run test:cinema-finish) — pure, no network, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CINEMA FINISH IS ONE LAYER, INHERITED BY REGISTRATION, DERIVED BY RULE.
 *
 * OWNER (2026-09-25): "the videos need to be a completely finished and very
 * smooth cinema quality production as the end product."
 *
 * Asserted (the RULE, numbers derived — CLAUDE.md §2):
 *   §inherit   every composition registered in remotion/Root.tsx goes through the
 *              local `Composition` that wraps its component in withCinemaFinish —
 *              no composition file mounts the finish by hand (+ negative control).
 *   §scope     the finish is ON exactly for the moving compositions and OFF for
 *              finish-spec STILLs (denominator printed, positive control).
 *   §look      every grade stays within MAX_GRADE_DEPARTURE of identity; screens
 *              (product_demo) are true colour; the keepsake (memory) is warm.
 *   §cuts      cut points come from the staged plan (segment boundaries, J/L flag
 *              from the narration window) else the registered bookends; the dip
 *              is a symmetric eased bell, lighter under the voice; cut lengths sit
 *              in the researched 6-18 frame band at 30 fps.
 *   §edges     head/tail fade through the BRAND colour, never black; no CSS
 *              transitions/animations; the timeline is untouched (no Sequence /
 *              TransitionSeries / duration writes in the finish) (+ positive controls).
 *   §type      one modular scale from the short side; safe areas = the ONE survivor.
 *   §audio     the master stage (-14 LUFS / -1 dBTP / 48 kHz) ends the music graph
 *              (both the duck and the constant path), a master-only pass covers
 *              voice-without-music renders, and the bed fades are derived from the
 *              composition's own bookends.
 *   §broadcast the BROADCAST_CHANNELS duplicate is merged onto lib/campaigns/channels.ts.
 *
 * BLIND SPOTS (published): the grade/dip are proven as numbers and source shape,
 * not as rendered pixels (no Chromium here); loudness is proven as the ffmpeg
 * graph string, not a measured LUFS of a real file. Motion blur IS applied
 * (@remotion/motion-blur, wave 83B); this guard proves it by rule and source
 * shape — the rendered-pixel check (a real @remotion/renderer render: blurred
 * edges, static colour identical, audio identical, 5.2× render time at 5
 * samples) is the lane-84A notes' harness, not re-run here (no Chromium in CI).
 */
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments, blankStrings } from "./strip-comments"
import {
  CINEMA_EASING, CINEMA_LOOKS, CINEMA_MOTION_BLUR, MAX_GRADE_DEPARTURE, cinemaCutPoints, cinemaFinishFor, cinemaFrame, cinemaMotionBlurFor,
  cinemaMusicFades, cinemaTypeScale, dipOpacityAt, easeInOut, edgeFadeFrames, gradeFilter, isStillFinish,
} from "../lib/video/cinema-finish"
import { finishForVideo } from "../lib/video/finish-spec"
import { compositionBookends, compositionPurposes } from "../lib/video/duration-model"
import { COMPOSITION_TREATMENTS, safeInsets, type BodyVisualPlan } from "../lib/video/body-visual-model"
import {
  MASTER_LOUDNESS, buildMasterLoudnessStage, buildMusicDuckFilterGraph, buildMusicMixFilterGraph, withMasterLoudness,
} from "../lib/remotion/music-filter-graph"
import { BROADCAST_CHANNELS, BROADCAST_PLATFORMS } from "../lib/campaigns/channels"
import { isRepurposableVideo } from "../lib/video/repurpose-planner"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel: string): string => readFileSync(join(root, rel), "utf8")
const readStripped = (rel: string): string => stripComments(read(rel))

let passed = 0, failed = 0
const failures: string[] = []
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ── the registry as Root.tsx declares it ─────────────────────────────────────
const rootSrc = readStripped("remotion/Root.tsx")
const ids = Array.from(rootSrc.matchAll(/<Composition\s+id="([A-Za-z0-9_]+)"/g)).map((m) => m[1])

/** The detector: does a Root source register through a local wrapper that applies withCinemaFinish? */
function rootInheritsFinish(src: string): boolean {
  const importsRaw = /import\s*\{\s*Composition\s+as\s+RemotionComposition\s*\}\s*from\s*"remotion"/.test(src)
  const localWrapper = /const\s+Composition\s*=\s*\(\([\s\S]{0,400}withCinemaFinish\(/.test(src)
  const noBareRemotionUse = !/<RemotionComposition\s+id=/.test(src)
  return importsRaw && localWrapper && noBareRemotionUse
}

console.log("\n── §inherit · every registration goes through the finish ──")
{
  check(`Root.tsx registers ${ids.length} compositions (denominator)`, ids.length >= 30, `found ${ids.length}`)
  check("Root.tsx: `Composition` is the LOCAL wrapper around remotion's Composition, applying withCinemaFinish(component, id)", rootInheritsFinish(rootSrc))
  check("NEGATIVE CONTROL: a Root that imports Composition straight from remotion is NOT inheriting",
    !rootInheritsFinish('import { Composition } from "remotion"\nexport const R = () => <Composition id="X" component={X} />'))
  check("Root.tsx: the wrapper forwards every prop untouched ({...props}) and keys the finish on props.id",
    /<RegisteredComposition\s*\{\.\.\.props\}\s*component=\{withCinemaFinish\([^)]*String\(props\.id\)\)\}/.test(rootSrc))
  const handWired = readdirSync(join(root, "remotion")).filter((f) => f.endsWith(".tsx") && f !== "Root.tsx")
    .filter((f) => /CinemaFinish/.test(readStripped(`remotion/${f}`)))
  check("no composition file mounts the finish by hand (the registry is the only door)", handWired.length === 0, handWired.join(", "))
}

console.log("\n── §scope · on for moving video, off for stills ──")
{
  const moving = ids.filter((id) => !isStillFinish(finishForVideo(id)))
  const stills = ids.filter((id) => isStillFinish(finishForVideo(id)))
  console.log(`    denominator: ${ids.length} registered = ${moving.length} moving + ${stills.length} stills (${stills.join(", ")})`)
  check("every moving composition has the finish ENABLED", moving.every((id) => cinemaFinishFor(id).enabled), moving.filter((id) => !cinemaFinishFor(id).enabled).join(", "))
  check("every still (finish-spec STILL) has it DISABLED — a postcard is never graded or faded", stills.length > 0 && stills.every((id) => !cinemaFinishFor(id).enabled))
  check("POSITIVE CONTROL: PostcardFront4x6 is a still and ListingFlyer is a still", !cinemaFinishFor("PostcardFront4x6").enabled && !cinemaFinishFor("ListingFlyer").enabled)
  check("an UNREGISTERED id falls to finish-spec SAFE_DEFAULT (bookends+music) → enabled, never silently skipped", cinemaFinishFor("SomeFutureReel").enabled)
}

console.log("\n── §look · a grade, never an effect ──")
{
  for (const look of Object.values(CINEMA_LOOKS)) {
    const dev = Math.max(Math.abs(look.contrast - 1), Math.abs(look.saturate - 1), Math.abs(look.brightness - 1), look.warmth)
    check(`look ${look.id}: every channel within ±${MAX_GRADE_DEPARTURE} of identity (max ${dev.toFixed(3)}), vignette ≤ 0.25`, dev <= MAX_GRADE_DEPARTURE && look.vignette <= 0.25)
  }
  check("true_color renders the identity filter (\"none\")", gradeFilter(CINEMA_LOOKS.true_color) === "none")
  check("natural renders contrast/saturate/brightness only (no colour cast)", /contrast\(/.test(gradeFilter(CINEMA_LOOKS.natural)) && !/sepia/.test(gradeFilter(CINEMA_LOOKS.natural)))
  const screens = ids.filter((id) => compositionPurposes(id)[0] === "product_demo")
  check(`screens stay TRUE COLOUR (product_demo compositions: ${screens.join(", ") || "none"})`, screens.length > 0 && screens.every((id) => cinemaFinishFor(id).look.id === "true_color"))
  const keepsakes = ids.filter((id) => compositionPurposes(id)[0] === "memory")
  check(`the keepsake is WARM (memory compositions: ${keepsakes.join(", ") || "none"})`, keepsakes.length > 0 && keepsakes.every((id) => cinemaFinishFor(id).look.id === "warm"))
}

console.log("\n── §cuts · derived cut points, eased dips, J/L under the voice ──")
{
  const fixture = {
    compositionId: "AgentExplainerReel", durationInFrames: 240, fps: 30,
    intro: { from: 0, durationInFrames: 30, treatment: "brand_card" },
    outro: { from: 210, durationInFrames: 30, treatment: "brand_card" },
    segments: [{ from: 30 }, { from: 90 }, { from: 150 }],
    captionWindow: { from: 30, to: 200 },
  } as unknown as BodyVisualPlan
  const cuts = cinemaCutPoints("AgentExplainerReel", 240, fixture)
  check("plan cuts: intro end 30, segments 90/150, outro 210 — in order", cuts.map((c) => c.frame).join(",") === "30,90,150,210", cuts.map((c) => `${c.kind}@${c.frame}`).join(" "))
  check("J/L: segment cuts inside the narration window are underVoice; the outro cut after it is not",
    cuts.find((c) => c.frame === 90)?.underVoice === true && cuts.find((c) => c.frame === 150)?.underVoice === true && cuts.find((c) => c.frame === 210)?.underVoice === false)
  const spec = cinemaFinishFor("AgentExplainerReel")
  check("dip peaks AT the cut (fuller outside the voice, lighter under it)",
    Math.abs(dipOpacityAt(210, cuts, spec, 30) - spec.dipPeak) < 1e-9 && Math.abs(dipOpacityAt(90, cuts, spec, 30) - spec.dipPeakUnderVoice) < 1e-9 && spec.dipPeakUnderVoice < spec.dipPeak)
  check("dip is a SYMMETRIC bell (frame ±3 equal) and zero between cuts", Math.abs(dipOpacityAt(87, cuts, spec, 30) - dipOpacityAt(93, cuts, spec, 30)) < 1e-9 && dipOpacityAt(120, cuts, spec, 30) === 0)
  check("easeInOut is monotone 0→1 with a smooth midpoint", easeInOut(0) === 0 && easeInOut(1) === 1 && Math.abs(easeInOut(0.5) - 0.5) < 1e-9 && easeInOut(0.25) < easeInOut(0.75))
  const moving = ids.filter((id) => cinemaFinishFor(id).enabled)
  const out = moving.filter((id) => { const f = cinemaFinishFor(id).cutSeconds * 30; return f < 6 || f > 18 })
  check(`every moving composition's cut is 6-18 frames at 30 fps (peachgum 2026-04 "6-12 frames"; the keepsake breathes to 18) — ${moving.length} checked`, out.length === 0, out.join(", "))
  const fallback = cinemaCutPoints("JustListedReel", 900, null)
  const { introFrames, outroFrames } = compositionBookends("JustListedReel")
  check(`no plan → the registered bookends are the cuts (JustListedReel intro ${introFrames} / outro ${outroFrames})`,
    fallback.map((c) => c.frame).join(",") === [introFrames, 900 - outroFrames].filter((f) => f > 0 && f < 900).join(","))
  check("a plan fitted to a different duration is NOT trusted (falls back to bookends)", cinemaCutPoints("AgentExplainerReel", 300, fixture).every((c) => c.kind !== "segment"))
  const e = edgeFadeFrames(spec, 30, 240)
  check("edge fades are short (head ≈ 0.35 s, tail ≈ 0.5 s) and capped at a quarter of the video", e.head === 11 && e.tail === 15 && edgeFadeFrames(spec, 30, 20).tail <= 5)
}

console.log("\n── §edges · brand colour, never black; timeline untouched ──")
{
  const cf = readStripped("remotion/components/CinemaFinish.tsx")
  const cfCode = blankStrings(cf)
  check("CinemaFinish paints its veil in the BRAND colour (brandColor(inputProps))", /backgroundColor:\s*brandColor\(inputProps\)/.test(cf))
  const blackVeil = (s: string) => /backgroundColor:\s*["'](#000(000)?|black)["']/.test(s)
  check("no veil is painted black (no hard cut on black)", !blackVeil(cf))
  check("POSITIVE CONTROL: a black veil specimen is caught", blackVeil(`<AbsoluteFill style={{ backgroundColor: "#000" }} />`))
  check("head fades FROM the veil (1 → 0) and tail fades TO it (0 → 1), both clamped with CINEMA_EASING beziers",
    /interpolate\(frame,\s*\[0,\s*edges\.head\],\s*\[1,\s*0\][\s\S]{0,160}Easing\.bezier\(\.\.\.CINEMA_EASING\.enter\)/.test(cf) &&
    /interpolate\(frame,\s*\[durationInFrames - edges\.tail,[^\]]*\],\s*\[0,\s*1\][\s\S]{0,160}Easing\.bezier\(\.\.\.CINEMA_EASING\.exit\)/.test(cf))
  const cssMotion = (s: string) => /\b(transition|animation)\s*:/.test(s)
  check("no CSS transition/animation in CinemaFinish or SceneFade (remotion renders frame by frame)", !cssMotion(cfCode) && !cssMotion(blankStrings(readStripped("remotion/components/SceneFade.tsx"))))
  check("POSITIVE CONTROL: a CSS transition specimen is caught", cssMotion(`style={{ transition: "opacity 1s" }}`))
  check("the finish never touches the timeline (no Sequence / TransitionSeries / durationInFrames prop)", !/<Sequence\b|TransitionSeries|durationInFrames=\{/.test(cf))
  check("SceneFade's cut ramps use the SAME curves (CINEMA_EASING enter/exit)", /Easing\.bezier\(\.\.\.CINEMA_EASING\.enter\)/.test(readStripped("remotion/components/SceneFade.tsx")) && /Easing\.bezier\(\.\.\.CINEMA_EASING\.exit\)/.test(readStripped("remotion/components/SceneFade.tsx")))
  check("CINEMA_EASING.enter is the skill's decelerate curve (0.16, 1, 0.3, 1)", CINEMA_EASING.enter.join(",") === "0.16,1,0.3,1")
  check("withCinemaFinish memoises per id (a stable component identity across renders)", /FINISHED\.get\(key\)/.test(cf) && /FINISHED\.set\(key,/.test(cf))
}

console.log("\n── §type · one modular scale, one safe-area survivor ──")
{
  const v = cinemaTypeScale(1080, 1920), h = cinemaTypeScale(1920, 1080), sq = cinemaTypeScale(1080, 1080)
  check("1080 short side → 40 px body on vertical, horizontal and square alike", v.body === 40 && h.body === 40 && sq.body === 40)
  check("scale is monotone caption < body < title < display (major third ≈ 1.25)", v.caption < v.body && v.body < v.title && v.title < v.display && Math.abs(v.title / v.body - 1.5625) < 0.03)
  check("a 4K vertical frame scales the type with it (80 px body)", cinemaTypeScale(2160, 3840).body === 80)
  const f = cinemaFrame(1080, 1920)
  check("safe insets are the body-visual-model survivor's, unchanged", JSON.stringify(f.safe) === JSON.stringify(safeInsets(1080, 1920)))
}

console.log("\n── §audio · master, fades derived, both paths ──")
{
  const stage = buildMasterLoudnessStage()
  check(`master stage = loudnorm I=${MASTER_LOUDNESS.integratedLufs} TP=${MASTER_LOUDNESS.truePeakDbtp} LRA=${MASTER_LOUDNESS.loudnessRange} then aresample ${MASTER_LOUDNESS.sampleRate}`,
    stage === "[premaster]loudnorm=I=-14:TP=-1:LRA=11,aresample=48000[aout]")
  const mix = withMasterLoudness(buildMusicMixFilterGraph({ loop: true, volume: 0.12, videoSeconds: 30 }))
  const duck = withMasterLoudness(buildMusicDuckFilterGraph({ loop: true, volume: 0.12, videoSeconds: 30, duck: { thresholdDb: -30, ratio: 8, attackMs: 20, releaseMs: 400 } }))
  check("constant mix graph ends in the master, still labelled [aout] (the mixer's -map is unchanged)", mix.endsWith(stage) && mix.includes("[premaster];") && (mix.match(/\[aout\]/g) ?? []).length === 1)
  check("duck graph ends in the master too", duck.endsWith(stage) && duck.includes("sidechaincompress"))
  check("NEGATIVE CONTROL: a graph with no trailing [aout] is left unchanged", withMasterLoudness("[1:a]volume=0.5[a1]") === "[1:a]volume=0.5[a1]")
  const mixer = readStripped("lib/remotion/music-mixer.ts")
  check("music-mixer runs withMasterLoudness on BOTH the duck and the constant graph, falling back unmastered on refusal",
    /runMix\(withMasterLoudness\(duckFilter\)\)/.test(mixer) && /runMix\(withMasterLoudness\(constantFilter\)\)/.test(mixer) && /if \(!mastered\) await runMix\(constantFilter\)/.test(mixer))
  check("music-mixer exports masterAudioLoudness (the voice-without-music master) built from the SAME stage", /export async function masterAudioLoudness/.test(mixer) && /buildMasterLoudnessStage\("\[0:a\]", "\[aout\]"\)/.test(mixer))
  const coord = readStripped("lib/remotion/render-coordinator.ts")
  check("render-coordinator passes the DERIVED fades + master:true into the music pass", /\.\.\.cinemaMusicFades\(composition\.composition_id,/.test(coord) && /master:\s*true/.test(coord))
  check("render-coordinator masters a voiced render that got no music pass", /if \(!musicAssetId && usedVoiceover\)[\s\S]{0,200}masterAudioLoudness/.test(coord))
  const moving = ids.filter((id) => cinemaFinishFor(id).enabled)
  const wrong = moving.filter((id) => {
    const { introFrames, outroFrames } = compositionBookends(id)
    const f = cinemaMusicFades(id, 30)
    const inOk = introFrames > 0 ? Math.abs(f.fadeInSeconds - Math.min(2, Math.max(0.8, (introFrames / 30) * 0.8))) < 0.01 : true
    const outOk = outroFrames > 0 ? Math.abs(f.fadeOutSeconds - Math.min(3, Math.max(1.5, outroFrames / 30))) < 0.01 : true
    return !(inOk && outOk && f.fadeInSeconds >= 0.8 && f.fadeOutSeconds >= 1.5)
  })
  check(`music fades DERIVE from each composition's own intro/outro (${moving.length} moving compositions)`, wrong.length === 0, wrong.join(", "))
}

console.log("\n── §motion-blur · film-camera blur where the camera moves, never on a face or a screen (wave 83B) ──")
{
  const moving = ids.filter((id) => !isStillFinish(finishForVideo(id)))
  const blurred = moving.filter((id) => cinemaMotionBlurFor(id).enabled)
  console.log(`    denominator: ${moving.length} moving compositions → ${blurred.length} blurred (${blurred.join(", ")})`)
  for (const id of moving) console.log(`      ${id}: ${cinemaMotionBlurFor(id).reason}`)
  const person = (id: string) => (COMPOSITION_TREATMENTS[id] ?? []).some((t) => t === "full_avatar" || t === "avatar_pip")
  const moves = (id: string) => (COMPOSITION_TREATMENTS[id] ?? []).some((t) => t === "property_photos" || t === "broll")
  check("RULE: blurred ⇔ a moving composition whose picture moves as a camera (Ken Burns photos / b-roll), with no person on screen and a graded (not true-colour) look",
    moving.every((id) => cinemaMotionBlurFor(id).enabled === (moves(id) && !person(id) && cinemaFinishFor(id).look.id !== "true_color")))
  check("at least one camera-move composition is blurred (the finder still finds; PhotoWalkthroughReel is the Ken Burns reel)", blurred.length > 0 && blurred.includes("PhotoWalkthroughReel"))
  check("NO talking head is blurred (every avatar/PiP composition stays crisp)", moving.filter(person).every((id) => !cinemaMotionBlurFor(id).enabled), moving.filter((id) => person(id) && cinemaMotionBlurFor(id).enabled).join(", "))
  check("POSITIVE CONTROL: the talking-head reel is recognised as a person on screen", person("AgentTalkingHeadReel") && !cinemaMotionBlurFor("AgentTalkingHeadReel").enabled)
  check("no still and no screen is blurred (PostcardFront4x6, ProductPromoReel)", !cinemaMotionBlurFor("PostcardFront4x6").enabled && !cinemaMotionBlurFor("ProductPromoReel").enabled)
  check(`the docs' values: shutterAngle ${CINEMA_MOTION_BLUR.shutterAngle}° (film standard at 24-60 fps), samples ${CINEMA_MOTION_BLUR.samples} (docs 5-10; lowest kept — colour-destructive)`,
    CINEMA_MOTION_BLUR.shutterAngle === 180 && CINEMA_MOTION_BLUR.samples >= 5 && CINEMA_MOTION_BLUR.samples <= 10 && blurred.every((id) => cinemaMotionBlurFor(id).samples === CINEMA_MOTION_BLUR.samples))
  const layer = readStripped("remotion/components/CinemaFinish.tsx")
  check("the finish layer mounts CameraMotionBlur from @remotion/motion-blur, gated on the rule, around an AbsoluteFill (docs: children absolutely positioned)",
    /import\s*\{\s*CameraMotionBlur\s*\}\s*from\s*"@remotion\/motion-blur"/.test(layer) && /blur\.enabled\s*\?/.test(layer)
    && /<CameraMotionBlur shutterAngle=\{blur\.shutterAngle\} samples=\{blur\.samples\}>\s*<AbsoluteFill/.test(layer) && /cinemaMotionBlurFor\(compositionId\)/.test(layer))
  // WAVE 84A (owner: "chack on motion blur" — a real render, notes lane84A):
  // the grade is applied ONCE to the integrated exposure (film order: shutter,
  // then grade), so the filter wraps CameraMotionBlur and nothing inside the
  // blur carries a filter — not `samples` graded copies averaged.
  const gradeOutsideBlur = (src: string): boolean => {
    const open = src.indexOf("<CameraMotionBlur"), close = src.indexOf("</CameraMotionBlur>")
    const gradeAt = src.search(/<AbsoluteFill style=\{\{ filter \}\}>/)
    return open > 0 && close > open && gradeAt >= 0 && gradeAt < open && !/filter/.test(src.slice(open, close))
  }
  check("the grade WRAPS the blur (applied once, after the shutter) — no filter inside CameraMotionBlur", gradeOutsideBlur(layer))
  check("POSITIVE CONTROL: the pre-84A shape (the graded AbsoluteFill inside the blur) fails the same rule",
    !gradeOutsideBlur(`<AbsoluteFill><CameraMotionBlur shutterAngle={blur.shutterAngle} samples={blur.samples}>\n<AbsoluteFill style={{ filter }}>{children}</AbsoluteFill>\n</CameraMotionBlur></AbsoluteFill>`))
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> }
  check(`@remotion/motion-blur is a dependency pinned to the fleet's remotion version (${pkg.dependencies["@remotion/motion-blur"]} = remotion ${pkg.dependencies.remotion})`,
    pkg.dependencies["@remotion/motion-blur"] === pkg.dependencies.remotion && !!pkg.dependencies.remotion)
}

console.log("\n── §crossfade · documented, not faked (wave 83B) ──")
{
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string>; devDependencies?: Record<string, string> }
  const installed = !!(pkg.dependencies["@remotion/transitions"] ?? pkg.devDependencies?.["@remotion/transitions"])
  const doc = read("lib/video/cinema-finish.ts")
  check(`@remotion/transitions is ${installed ? "INSTALLED — the § CROSSFADE note must be revisited" : "not installed"}, and cinema-finish.ts § CROSSFADE says why the cut is still a dip`,
    !installed && /§ CROSSFADE — why the cut is still a dip/.test(doc) && /SHORTENS the timeline/.test(doc))
  const src = Array.from(readdirSync(join(root, "remotion"))).filter((f) => f.endsWith(".tsx")).map((f) => readStripped(`remotion/${f}`)).join("\n")
  check("no composition imports @remotion/transitions (it would shorten the registered timeline)", !/from\s*"@remotion\/transitions/.test(src))
}

console.log("\n── §broadcast · the duplicate is merged onto the survivor ──")
{
  const planner = readStripped("lib/video/repurpose-planner.ts")
  const privateCopy = (s: string) => /const\s+BROADCAST_CHANNELS\s*=\s*new Set\(\[/.test(s)
  check("repurpose-planner no longer keeps a private BROADCAST_CHANNELS Set", !privateCopy(planner))
  check("POSITIVE CONTROL: the old private Set is recognised", privateCopy(`const BROADCAST_CHANNELS = new Set(["tiktok"])`))
  check("repurpose-planner imports BROADCAST_PLATFORMS from lib/campaigns/channels", /import\s*\{\s*BROADCAST_PLATFORMS\s*\}\s*from\s*"@\/lib\/campaigns\/channels"/.test(planner))
  check("the tombstone names the survivor file:line", /lib\/campaigns\/channels\.ts:\d+ BROADCAST_PLATFORMS/.test(read("lib/video/repurpose-planner.ts")))
  check("BROADCAST_PLATFORMS is DERIVED from the broadcast channel specs (tiktok/instagram/youtube/facebook)",
    JSON.stringify([...BROADCAST_PLATFORMS].sort()) === JSON.stringify(Array.from(new Set(BROADCAST_CHANNELS.flatMap((c) => c.platforms ?? []))).sort()) && BROADCAST_PLATFORMS.length === 4)
  check("behaviour kept: a youtube reel is repurposable, an email-only piece is not",
    isRepurposableVideo({ directorKey: "director:x:1", targetChannels: ["YouTube"] }) && !isRepurposableVideo({ directorKey: "director:x:1", targetChannels: ["email"] }))
}

console.log("\n── §registered · package.json, ordering, MAINTENANCE_DOMAINS ──")
{
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
  const guard = pkg.scripts.guard ?? ""
  check("package.json: test:cinema-finish runs this file and sits in the guard chain after test:scrapers (ordering only)",
    pkg.scripts["test:cinema-finish"] === "tsx scripts/cinema-finish-guard.ts" && guard.indexOf("npm run test:cinema-finish") > guard.indexOf("npm run test:scrapers") && guard.indexOf("npm run test:scrapers") !== -1)
  const registry = readStripped("lib/kernel/manager-registry.ts")
  check("manager-registry: MAINTENANCE_DOMAINS.cinema_finish names asset_manager with co-owners", /cinema_finish:\s*\{ manager: "asset_manager", proof: "test:cinema-finish", coOwners: \[[^\]]+\]/.test(registry))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) { console.log("\nFAILURES:"); for (const f of failures) console.log(`  - ${f}`); process.exit(1) }
