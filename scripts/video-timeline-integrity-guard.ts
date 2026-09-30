#!/usr/bin/env tsx
/**
 * scripts/video-timeline-integrity-guard.ts  (npm run test:video-timeline-integrity) — pure, no DB, no network.
 *
 * WAVE 90 (lane 90E) — THE ASSEMBLED TIMELINE OF EVERY FORMAT, FROM THE REAL
 * PLANNERS. Owner (verbatim): "our avatar videos and automated videos themselves
 * are one of the most important capabilities … make sure that all remotion
 * videos and with avatar are created correctly by using the skills.
 * broll/images/music/intro/outro/branding are all correctly calculated in the
 * complete videos using voiceover or an avatar." Skills: remotion-best-practices
 * (remotion-markup sequencing.md — a Series has no overlap; audio.md "Delaying";
 * calculate-metadata.md — the duration is computed from the props;
 * remotion-captions display-captions.md — cues alongside the media), and the
 * eval-first loop of agentic-engineering (six real renders ran before and after
 * the fixes — lane90E-notes.md).
 *
 * WHAT IS ALREADY PROVEN ELSEWHERE (reused, not restated): the per-composition
 * Sequence chains tile the registered geometry (test:video-assembly §sums,
 * test:video-type-matrix [sum]), narration starts (test:video-timing-audit
 * §start), the stitch arithmetic (test:video-stitching), the hook window and the
 * disclosure derivation (test:video-hook-window), the caption arithmetic
 * (test:captions), the body-visual rules (test:body-visual-model).
 *
 * WHAT THIS ADDS — for EVERY registered moving composition × every purpose it
 * serves, on its own host, the COMPLETE assembled timeline is computed from the
 * real planners (planCompositionDuration → stageBodyVisualPlan → the stitch plan
 * → the music graph) and held to these rules, each with a positive control:
 *   §timeline   intro + every body segment + outro tile [0, durationInFrames)
 *               exactly — no gap, no overlap — at the plan's own length AND after
 *               a re-fit to a measured render; captions and the music duck cover
 *               exactly the narration window; the narrated stretch lies inside
 *               the purpose's duration model and the cap can carry it.
 *   §broll      the b-roll windows are exactly the segments the plan cut to
 *               footage; each window's slots (brollSlots ← selectBrollPlan)
 *               tile it with no slot past a clip's own end; a no-b-roll purpose
 *               gets NO window even with clips staged, and the dispatch gate
 *               refuses a plan that smuggles one in.
 *   §music      the bed spans the WHOLE finished cut — fade-in from its first
 *               frame, fade-out ending on its last (stock bookends counted at
 *               their stitched length) — and sidechain-ducks under the speech
 *               track; a music:false finish is still mastered.
 *   §bookends   a brand intro is stitched in front ONLY where the purpose is
 *               seated; every scroll format's first spoken word lands inside
 *               HOOK_ON_COVER_MAX_SECONDS of the FINISHED film; the brand closes
 *               every film (a logo outro, an outro tile or the shared EndCard).
 *   §disclosure no typed sub-safe corner remains in any moving composition
 *               (89F's published census, now zero and asserted) — the slides'
 *               footer, nameplate and caption band stack above the safe inset
 *               through ONE derivation (cinemaSlideFooterStack).
 *   §avatar     the body-visual segments a D-ID render lands on are the SCRIPT's
 *               segments (word-weighted) within one frame after the re-fit to
 *               D-ID's measured clip, and an avatar clip that mounts AFTER a
 *               composition's cover keeps its whole length (the plan no longer
 *               subtracts the cover it never played under).
 *   §script     every derived spoken writer's prompt carries the persona/
 *               audience, the purpose, a fair-housing block, a hook-first
 *               ordering and a non-salesy close.
 *   §render91   (wave 91, lane 91E — the real renders of the 20 formats 90E had
 *               not rendered, $S/l91e/harness) each defect those renders found,
 *               held as a RULE with its control: style-object corners read
 *               whole and in every mounted component; the brokerage name read
 *               by every tenant film; no "Photo placeholder" panel; the sold
 *               price above the caption band; centred end-card copy out of the
 *               QR badge's column; the plan's b-roll verdict obeyed; footage
 *               never re-shuttered; panels positioned over the SegmentBackdrop
 *               (the equity / market-update figures were invisible); the ONE
 *               lower-third above the caption band by default; the bottom
 *               context-cue row above captions + disclosure, out of the badges.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { blankStrings, stripComments } from "./strip-comments"
import { VIDEO_COMPOSITION_FILES } from "./composition-segments"
import {
  COMPOSITION_DURATION_RULES, HOOK_ON_COVER_MAX_SECONDS, PURPOSE_DURATION_RULES, SEATED_PURPOSES,
  compositionBookends, compositionPurposes, movingCompositionIds, narrationStartFrame, planCompositionDuration, planDurationForProps,
  purposeOpensOnHook, requiredCapFrames, hostWordsPerMinute, spokenSecondsForWords,
  type VideoPurpose,
} from "../lib/video/duration-model"
import {
  PURPOSE_BODY_VISUAL_RULES, fitBodyVisualPlan, gateVisualPlanForDispatch, safeInsets, segmentUsesBroll, stageBodyVisualPlan,
  type BodyVisualAssets, type BodyVisualPlan,
} from "../lib/video/body-visual-model"
import { weightedShotSlots } from "../lib/video/assembly-timeline"
import { spokenWords } from "../lib/video/script-structure"
import { brollSlots, clipFrames, type BrollClip } from "../remotion/_BrollLayer"
import { finishForVideo, REEL_USE_FINISH } from "../lib/video/finish-spec"
import { buildStitchPlan, JOIN_DISSOLVE_SECONDS } from "../lib/video/stitch-graph"
import { buildMusicDuckFilterGraph, buildMusicTrackFilter } from "../lib/remotion/music-filter-graph"
import { MAX_BRAND_BOOKEND_SECONDS, MUSIC_DUCK_VOLUME_PCT, MUSIC_SIDECHAIN_DUCK_SETTINGS } from "../lib/video/realism-profile"
import { stitchedIntroCategory } from "../lib/remotion/render-decision"
import { geometryFor } from "../lib/remotion/composition-geometry"
import { consumesVoiceover, stagesChapteredSpeech, stagesSpeech } from "../lib/remotion/content-contract"
import {
  BLUR_VISIBLE_STREAK_PX, CINEMA_MOTION_BLUR, cinemaBadgeSlot, cinemaCameraStreakPx, cinemaEndCardSideInset, cinemaFrame, cinemaLowerThirdPlacement, qrOutroBadgeWidth, cinemaCaptionStyle, cinemaDisclosureStyle, cinemaMotionBlurWindows, cinemaMusicFades, cinemaSlideFooterStack, DISCLOSURE_GLYPH_EM, SLIDE_PRESENTER_PIP, slideDisclosureText,
} from "../lib/video/cinema-finish"
import { memoryChapterSegments, chapterDurationFrames } from "../lib/video/memory-video-composition"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel: string) => readFileSync(join(root, rel), "utf8")
const code = (rel: string) => blankStrings(stripComments(read(rel)))

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const note = (s: string) => console.log(`  · ${s}`)

// ─── fixtures ───────────────────────────────────────────────────────────────
const SCRIPT_BANK = [
  "Three days on market, two offers already.", "The kitchen was redone last spring with quartz counters.", "It opens right onto the deck.",
  "Buyers are responding fast this week.", "The roof was replaced last year too.", "Walkable to two parks and a coffee shop.",
  "Rates ticked down again this month.", "Inventory is up eleven percent on this side of town.", "If you want a private showing, just text me back.",
]
/** A script of about `seconds` at the host's pace, ending on an ask. */
function scriptFor(seconds: number, host: "voiceover" | "avatar" | "silent"): string {
  const words = Math.max(6, Math.round((seconds / 60) * hostWordsPerMinute(host === "silent" ? "voiceover" : host)))
  const out: string[] = []
  let n = 0, i = 0
  while (n < words - 8) { const s = SCRIPT_BANK[i % (SCRIPT_BANK.length - 1)]; out.push(s); n += spokenWords(s).length; i++ }
  out.push(SCRIPT_BANK[SCRIPT_BANK.length - 1])
  return out.join(" ")
}
/** A generous inventory — the purpose's VERDICT decides what is admitted, never the inventory. */
const INVENTORY: BodyVisualAssets = { avatarClip: true, brollClips: 3, brollSource: "own", propertyPhotos: 6, screenshots: 3, statCards: 3, clientFootage: 2, chartData: true }
const BROLL_FIXTURE: BrollClip[] = [
  { url: "https://example.com/a.mp4", durationSeconds: 4 }, { url: "https://example.com/b.mp4", durationSeconds: 6.4 }, { url: "https://example.com/c.mp4", durationSeconds: 5 },
]
const MEMORY_CHAPTERS = [
  { id: "arrival", title: "How did you find it?", sellerWords: "We found it on a rainy Sunday in 1979. The kitchen window looked over the maple.", voiceoverUrl: "https://x/a.mp3", videoUrl: null, durationFrames: chapterDurationFrames(8, 30) },
  { id: "the_people", title: "Who grew up here?", sellerWords: "All three kids learned to ride a bike on that driveway.", voiceoverUrl: "https://x/b.mp3", videoUrl: null, durationFrames: chapterDurationFrames(6, 30) },
]

interface Staged { id: string; purpose: VideoPurpose; host: "voiceover" | "avatar" | "silent"; props: Record<string, unknown>; plan: BodyVisualPlan; script: string | null; spokenSeconds: number | null }

/** Stage a composition for one of its purposes at the purpose IDEAL, through the REAL stagers. */
function stage(id: string, purpose: VideoPurpose): Staged | { error: string } {
  const spec = COMPOSITION_DURATION_RULES[id]
  const rule = PURPOSE_DURATION_RULES[purpose]
  const props: Record<string, unknown> = { videoPurpose: purpose }
  let script: string | null = null
  let spokenSeconds: number | null = null
  if (id === "MemoryVideoReel") {
    props.chapters = MEMORY_CHAPTERS; props.mode = "seller_audio_photos"; props.photoUrls = ["https://x/1.jpg", "https://x/2.jpg", "https://x/3.jpg"]
    const staged = stageBodyVisualPlan({ compositionId: id, props, purpose, segments: memoryChapterSegments(MEMORY_CHAPTERS) })
    if (!staged.ok) return { error: staged.reason }
    return { id, purpose, host: spec.host, props, plan: staged.plan, script: null, spokenSeconds: null }
  }
  if (spec.bodyMode === "narration") {
    // The IDEAL narrated stretch: for a from-frame-0 narration the cover is part of it.
    script = scriptFor(rule.idealSeconds, spec.host)
    spokenSeconds = rule.idealSeconds
    props.narrationScript = script; props.spokenSeconds = spokenSeconds; props.spokenSecondsSource = "measured"
    // The narration rides where THIS composition plays it: the presenter clip, the in-frame
    // <Audio voiceoverUrl>, or the coordinator's snake-key mux (voiceover_url) after the render.
    if (spec.host === "avatar") props.avatarVideoUrl = "https://x/avatar.mp4"
    else if (consumesVoiceover(id)) props.voiceoverUrl = "https://x/vo.mp3"
    else props.voiceover_url = "https://x/vo.mp3"
  }
  const staged = stageBodyVisualPlan({ compositionId: id, props, purpose, avatarClip: spec.host === "avatar", script, assets: INVENTORY })
  if (!staged.ok) return { error: staged.reason }
  return { id, purpose, host: spec.host, props, plan: staged.plan, script, spokenSeconds }
}

/** intro + segments + outro tile [0, total) exactly. */
function tiles(plan: BodyVisualPlan): { ok: boolean; why: string } {
  const segs = [...plan.segments].sort((a, b) => a.from - b.from)
  if (plan.intro.from !== 0) return { ok: false, why: `intro starts at ${plan.intro.from}` }
  if (plan.body.from !== plan.intro.durationInFrames) return { ok: false, why: `body starts at ${plan.body.from}, intro ends at ${plan.intro.durationInFrames}` }
  let cursor = plan.body.from
  for (const s of segs) {
    if (s.durationInFrames < 1) return { ok: false, why: `segment ${s.index} has ${s.durationInFrames} frames` }
    if (s.from !== cursor) return { ok: false, why: s.from > cursor ? `GAP of ${s.from - cursor} before segment ${s.index}` : `OVERLAP of ${cursor - s.from} at segment ${s.index}` }
    cursor += s.durationInFrames
  }
  if (cursor !== plan.outro.from) return { ok: false, why: `segments end at ${cursor}, outro starts at ${plan.outro.from}` }
  if (plan.outro.from + plan.outro.durationInFrames !== plan.durationInFrames) return { ok: false, why: `outro ends at ${plan.outro.from + plan.outro.durationInFrames} ≠ ${plan.durationInFrames}` }
  return { ok: true, why: "" }
}

const moving = movingCompositionIds().filter((id) => !!COMPOSITION_DURATION_RULES[id])
const staged: Staged[] = []
const stageErrors: string[] = []
for (const id of moving) for (const purpose of compositionPurposes(id)) {
  const s = stage(id, purpose)
  if ("error" in s) stageErrors.push(`${id}/${purpose}: ${s.error}`); else staged.push(s)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n── §timeline · ${staged.length} composition×purpose timelines from the real planners (denominator ${moving.length} moving compositions) ──`)
{
  check(`every registered moving composition × purpose stages a plan (${stageErrors.length} refusals)`, stageErrors.length === 0, stageErrors.join("; "))
  check("the walk is not empty and covers both hosts and every purpose class", staged.length >= 25 && staged.some((s) => s.host === "avatar") && staged.some((s) => s.host === "voiceover") && staged.some((s) => s.host === "silent"))
  for (const s of staged) {
    const { plan } = s
    const t = tiles(plan)
    const geo = geometryFor(s.id)!
    check(`${s.id}/${s.purpose}: intro ${plan.intro.durationInFrames} + ${plan.segments.length} segments + outro ${plan.outro.durationInFrames} tile [0, ${plan.durationInFrames}) exactly`, t.ok, t.why)
    check(`${s.id}/${s.purpose}: captions and the music duck cover exactly the narration window [${plan.captionWindow.from}, ${plan.captionWindow.to})`,
      plan.captionWindow.from === plan.body.from && plan.captionWindow.to === plan.body.from + plan.body.durationInFrames
      && plan.musicDuck.from === plan.captionWindow.from && plan.musicDuck.to === plan.captionWindow.to)
    // Re-fit to a MEASURED render 20 % longer (D-ID's clip, a slower read): still tiles, treatments kept.
    const longer = Math.round(plan.durationInFrames * 1.2)
    const refit = fitBodyVisualPlan(plan, s.id, longer)
    check(`${s.id}/${s.purpose}: re-fitted to a ${longer}-frame measured render it still tiles and keeps every treatment`,
      !!refit && tiles(refit).ok && refit.segments.every((seg, i) => seg.treatment === plan.segments[i].treatment), refit ? tiles(refit).why : "no refit")
    // The narrated stretch against the purpose model; the cap can carry it.
    const dur = planDurationForProps(s.id, s.props, { purpose: s.purpose })
    const rule = PURPOSE_DURATION_RULES[s.purpose]
    if (dur.bodyMode === "narration" && s.spokenSeconds !== null) {
      const narrated = dur.bodySeconds + (COMPOSITION_DURATION_RULES[s.id].narrationFrom === "cover" ? dur.introFrames / geo.fps : 0)
      check(`${s.id}/${s.purpose}: the ideal script narrates ${narrated.toFixed(2)}s ∈ [${rule.minSeconds}, ${rule.maxSeconds}] and is not clamped by the cap`,
        narrated >= rule.minSeconds - 1e-6 && narrated <= rule.maxSeconds + 1e-6 && !dur.clampedToCap && !dur.capBelowPurpose, dur.notes.join(" | "))
    }
    const req = requiredCapFrames(s.id, geo.fps)
    check(`${s.id}: the registered cap ${geo.duration_frames}f carries the longest purpose it serves (needs ${req}f)`, req !== null && geo.duration_frames >= req)
  }
  // POSITIVE CONTROLS
  const p = staged[0].plan
  const gap = { ...p, segments: p.segments.map((s, i) => (i === 0 ? { ...s, from: s.from + 2 } : s)) }
  check("CONTROL: a planted 2-frame gap is caught by the tiler", !tiles(gap).ok && /GAP|OVERLAP/.test(tiles(gap).why))
  const over = { ...p, segments: p.segments.map((s, i) => (i === p.segments.length - 1 ? { ...s, durationInFrames: s.durationInFrames + 3 } : s)) }
  check("CONTROL: a planted 3-frame overrun into the outro is caught", !tiles(over).ok)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §broll · cue count == planned slots, no slot past its clip, none on a no-b-roll purpose ──")
{
  let withBroll = 0, without = 0
  for (const s of staged) {
    const rule = PURPOSE_BODY_VISUAL_RULES[s.purpose]
    const footage = s.plan.segments.filter((seg) => segmentUsesBroll(seg, s.id))
    check(`${s.id}/${s.purpose}: brollWindows (${s.plan.brollWindows.length}) are exactly the segments cut to footage (${footage.length}) — verdict ${rule.broll.verdict}`,
      s.plan.brollWindows.length === footage.length && s.plan.brollWindows.every((w, i) => w.from === footage[i].from && w.durationInFrames === footage[i].durationInFrames))
    if (rule.broll.verdict === "never") { without++; check(`${s.id}/${s.purpose}: a NEVER purpose has no b-roll window even with 3 own clips staged`, s.plan.brollWindows.length === 0) }
    for (const w of s.plan.brollWindows) {
      withBroll++
      const slots = brollSlots(BROLL_FIXTURE, w.durationInFrames, s.plan.fps, 10)
      const tile = slots.length > 0 && slots[0].from === 0 && slots.every((x, i) => i === 0 || x.from === slots[i - 1].from + slots[i - 1].durationFrames)
        && slots[slots.length - 1].from + slots[slots.length - 1].durationFrames === w.durationInFrames
      check(`${s.id}/${s.purpose}: window [${w.from}, ${w.from + w.durationInFrames}) → ${slots.length} slots tile it exactly, none past its clip`,
        tile && slots.every((x) => x.durationFrames <= (clipFrames(BROLL_FIXTURE[x.index], s.plan.fps) as number)))
    }
  }
  note(`${withBroll} b-roll windows across the walk; ${without} composition×purpose rows are no-b-roll formats`)
  check("both sides exist — the verdict is not a blanket either way", withBroll > 0 && without > 0)
  // CONTROL: a plan that smuggles a footage segment onto a NEVER purpose is refused by the ONE gate.
  const never = staged.find((s) => PURPOSE_BODY_VISUAL_RULES[s.purpose].broll.verdict === "never" && s.host !== "silent")!
  const smuggled: BodyVisualPlan = { ...never.plan, segments: never.plan.segments.map((seg, i) => (i === 0 ? { ...seg, treatment: "broll", assetIndex: 0 } : seg)) }
  const verdict = gateVisualPlanForDispatch(smuggled, INVENTORY)
  check(`CONTROL: the dispatch gate refuses a broll segment on ${never.purpose} (broll_forbidden)`, !verdict.ok && verdict.missing.some((m) => m.startsWith("broll_forbidden")))
  check("CONTROL: an even split would put a 6.4 s clip in a 4 s slot — the measured tiler never does", brollSlots(BROLL_FIXTURE, 900, 30, 10).every((x) => x.durationFrames <= (clipFrames(BROLL_FIXTURE[x.index], 30) as number)))
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §music · the bed spans the whole finished cut and ducks under the speech ──")
/** The finished film's stitch plan on the coordinator's decision: intro only where the ONE decision keeps it; outro where the finish stitches bookends. */
function finishedFilm(id: string, mainSeconds: number, entityType?: string | null) {
  const finish = finishForVideo(id, entityType)
  const geo = geometryFor(id)!
  const introCategory = stitchedIntroCategory({ composition_id: id, stock_intro_category: "brand_intro" })
  if (!finish.bookends) return { total: mainSeconds, mainStart: 0, intro: false, outro: false, finish }
  const probe = (d: number) => ({ durationSeconds: d, width: geo.width, height: geo.height, fps: geo.fps, hasAudio: true, colorMatrix: null })
  const segments = [
    ...(introCategory ? [{ inputIndex: 0, role: "intro" as const, probe: probe(10), capSeconds: MAX_BRAND_BOOKEND_SECONDS }] : []),
    { inputIndex: 1, role: "main" as const, probe: probe(mainSeconds), capSeconds: null },
    { inputIndex: 2, role: "outro" as const, probe: probe(10), capSeconds: MAX_BRAND_BOOKEND_SECONDS },
  ]
  const plan = buildStitchPlan({ canvas: { width: geo.width, height: geo.height, fps: geo.fps }, segments })
  if (!plan.ok) throw new Error(plan.reason)
  return { total: plan.totalSeconds, mainStart: plan.mainStartSeconds, intro: !!introCategory, outro: true, finish }
}
{
  const fadeOutEnd = (g: string) => { const m = /afade=t=out:st=([\d.]+):d=([\d.]+)/.exec(g); return m ? Number(m[1]) + Number(m[2]) : null }
  const fadeInStart = (g: string) => { const m = /afade=t=in:st=([\d.]+):d=([\d.]+)/.exec(g); return m ? Number(m[1]) : null }
  let mastered = 0
  for (const s of staged) {
    const geo = geometryFor(s.id)!
    const main = s.plan.durationInFrames / geo.fps
    const film = finishedFilm(s.id, main)
    if (!film.finish.music) {
      mastered++
      note(`${s.id}/${s.purpose}: finish music:false — no bed (the voice is not fought); the coordinator masters the speech instead`)
      continue
    }
    const fades = cinemaMusicFades(s.id, geo.fps)
    const graph = buildMusicTrackFilter({ loop: true, volume: MUSIC_DUCK_VOLUME_PCT / 100, videoSeconds: film.total, ...fades })
    const duck = buildMusicDuckFilterGraph({ loop: true, volume: MUSIC_DUCK_VOLUME_PCT / 100, videoSeconds: film.total, duck: MUSIC_SIDECHAIN_DUCK_SETTINGS, ...fades })
    check(`${s.id}/${s.purpose}: bed fades in at 0 and its fade-out ends at ${film.total}s — the finished film (${film.intro ? "intro+" : ""}main${film.outro ? "+outro" : ""})`,
      fadeInStart(graph) === 0 && fadeOutEnd(graph) !== null && Math.abs((fadeOutEnd(graph) as number) - film.total) < 0.011)
    // What the coordinator ducks on: speech in the frames (stagesSpeech — the presenter clip, the
    // in-frame voiceover, the memory film's chaptered recordings) OR the snake-key mux it just landed.
    const speech = s.host !== "silent"
    const coordinatorDucks = stagesSpeech(s.id, s.props) || typeof s.props.voiceover_url === "string"
    check(`${s.id}/${s.purpose}: ${speech ? "carries speech → the duck graph keys sidechaincompress off [0:a]" : "silent → the constant bed level, no phantom sidechain"}`,
      speech ? (coordinatorDucks && duck.includes("[a1][0:a]sidechaincompress")) : !coordinatorDucks)
  }
  check("CONTROL: the pre-90E speech question said NO speech for the memory film's chaptered recordings (the bed ran unducked through the family's story)",
    !stagesSpeech("MemoryVideoReel", { chapters: [] }) && stagesSpeech("MemoryVideoReel", { chapters: MEMORY_CHAPTERS })
    && !stagesChapteredSpeech({ chapters: [{ voiceoverUrl: null, videoUrl: null }] }) && stagesChapteredSpeech({ chapters: [{ voiceoverUrl: null, videoUrl: "https://x/walk.mp4" }] }))
  const coord = code("lib/remotion/render-coordinator.ts")
  check(`the ${mastered} music:false rows are still levelled — the coordinator masters any render with speech and no bed`, mastered > 0 && /masterAudioLoudness\(\{ videoBuffer: working \}\)/.test(coord) && /if \(!musicAssetId && \(usedVoiceover \|\| carriesSpeech\)\)/.test(coord))
  check("CONTROL: a graph timed against the MAIN cut alone fades out short of a bookended film",
    (() => { const s = staged.find((x) => finishForVideo(x.id).bookends && finishForVideo(x.id).music)!; const geo = geometryFor(s.id)!; const main = s.plan.durationInFrames / geo.fps; const film = finishedFilm(s.id, main); return (fadeOutEnd(buildMusicTrackFilter({ loop: true, volume: 0.12, videoSeconds: main, ...cinemaMusicFades(s.id) })) as number) < film.total - 1 })())
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n── §bookends · a brand intro only where the purpose is seated; the first word inside ${HOOK_ON_COVER_MAX_SECONDS}s of the FINISHED scroll film; the brand closes every film ──`)
{
  let scroll = 0, seated = 0
  for (const s of staged) {
    const geo = geometryFor(s.id)!
    const spec = COMPOSITION_DURATION_RULES[s.id]
    const main = s.plan.durationInFrames / geo.fps
    const film = finishedFilm(s.id, main)
    const isSeated = SEATED_PURPOSES.has(s.purpose)
    check(`${s.id}/${s.purpose}: brand intro ${film.intro ? "KEPT" : "dropped"} in front — ${isSeated ? "seated" : "scroll"} purpose`,
      film.intro === (isSeated && !spec.hookFirst && film.finish.bookends))
    if (s.host === "silent") continue
    // The first spoken word in the FINISHED film: after the stitched intro (if any), at the composition's narration start.
    const firstWord = film.mainStart + narrationStartFrame(s.id) / geo.fps
    if (isSeated) { seated++; note(`${s.id}/${s.purpose}: seated — first word at ${firstWord.toFixed(2)}s of the finished film (the programme may open on its sting)`) }
    else { scroll++; check(`${s.id}/${s.purpose}: first spoken word at ${firstWord.toFixed(2)}s of the FINISHED film ≤ ${HOOK_ON_COVER_MAX_SECONDS}s`, firstWord <= HOOK_ON_COVER_MAX_SECONDS + 1e-9) }
  }
  check(`both classes walked (${scroll} scroll, ${seated} seated)`, scroll > 0 && seated > 0)
  // The brand closes every film: a logo outro is stitched (finish.bookends), or the composition's own outro tile / EndCard carries the brand.
  for (const id of moving) {
    const finish = finishForVideo(id)
    const src = stripComments(read(VIDEO_COMPOSITION_FILES[id]))
    const ownClose = compositionBookends(id).outroFrames > 0 || /<EndCard\b/.test(src) || /<QrOutroBadge\b/.test(src)
    check(`${id}: the brand closes the film (${finish.bookends ? "logo outro stitched" : "no stock bookends"}${ownClose ? " + own outro/end card" : ""})`, finish.bookends || ownClose)
  }
  check("CONTROL: a scroll composition that kept a 2.5 s sting + dissolve would put its first word past the window",
    (() => { const s = staged.find((x) => purposeOpensOnHook(x.purpose) && narrationStartFrame(x.id) === 0)!; return MAX_BRAND_BOOKEND_SECONDS + JOIN_DISSOLVE_SECONDS + 0 > HOOK_ON_COVER_MAX_SECONDS })())
  check("CONTROL: the ONE decision keeps a seated purpose's intro (PartnersMeetingReel) and drops a scroll one (JustListedReel)",
    stitchedIntroCategory({ composition_id: "PartnersMeetingReel", stock_intro_category: "brand_intro" }) === "brand_intro" && stitchedIntroCategory({ composition_id: "JustListedReel", stock_intro_category: "brand_intro" }) === null)
  // The pitch-reel use of the partners composition still carries captions + a QR (client-facing finish).
  check("the client-facing uses of PartnersMeetingReel (pitch, deal room) carry captions + the tracked QR; the internal ones carry neither", REEL_USE_FINISH.listing_pitch_reel.captions && REEL_USE_FINISH.listing_pitch_reel.qr && !REEL_USE_FINISH.partners_meeting_reel.captions && !REEL_USE_FINISH.partners_meeting_reel.qr)
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §disclosure · no typed sub-safe corner remains; the slides stack footer / nameplate / captions above the safe inset ──")
{
  // 89F's census (video-hook-window §census), now ASSERTED at zero. Same finder, same denominator.
  const corners: string[] = []
  for (const [id, f] of Object.entries(VIDEO_COMPOSITION_FILES)) {
    const geo = geometryFor(id); if (!geo) continue
    const s = safeInsets(geo.width, geo.height)
    stripComments(read(f)).split("\n").forEach((line, i) => {
      const m = /position: "absolute", (top|bottom): (\d+), (left|right): (\d+)/.exec(line)
      if (!m) return
      const v = Number(m[2]), hz = Number(m[4])
      const vInset = m[1] === "top" ? s.top : s.bottom, hInset = m[3] === "left" ? s.left : s.right
      if ((v > 0 && v < vInset) || (hz > 0 && hz < hInset)) corners.push(`${f}:${i + 1} ${m[0]}`)
    })
  }
  check(`no moving composition types a corner inside a platform UI band (${Object.keys(VIDEO_COMPOSITION_FILES).length} files walked)`, corners.length === 0, corners.join("; "))
  check("CONTROL: the finder still sees the pre-90E MemoryVideoReel logo corner", /position: "absolute", (top|bottom): (\d+), (left|right): (\d+)/.test(`style={{ position: "absolute", bottom: 48, right: 100, height: 44 }}`) && 48 < safeInsets(1920, 1080).bottom)
  // The slides: footer text ON the safe inset, nameplate above it, caption band above both, body clear of all three — ONE derivation.
  for (const [w, h] of [[1920, 1080], [1080, 1080], [1080, 1920]] as Array<[number, number]>) {
    const st = cinemaSlideFooterStack(w, h), d = cinemaDisclosureStyle(w, h), cap = cinemaCaptionStyle(w, h), safe = safeInsets(w, h)
    const line = Math.ceil(d.fontSize * d.lineHeight)
    check(`${w}×${h}: footer bottom ${st.disclosureBottom} = safe ${safe.bottom}; nameplate ${st.nameplateBottom} above the footer line; caption band ${st.captionBandBottom} above the nameplate; body clears the stack (${st.bodyBottom})`,
      st.disclosureBottom === safe.bottom && st.nameplateBottom >= st.disclosureBottom + line && st.captionBandBottom >= st.nameplateBottom + line
      && st.bodyBottom >= st.captionBandBottom + Math.ceil(cap.fontSize * cap.lineHeight * 2 + cap.padY * 2))
  }
  for (const f of ["remotion/ListingPresentationSlide.tsx", "remotion/BuyerConsultationSlide.tsx"]) {
    const c = code(f)
    check(`${f}: footer, nameplate and body read cinemaSlideFooterStack, laid out for the disclosure text the slide renders; no typed bottom: 0 / 32 / 120 remains`,
      /const disclosure = slideDisclosureText\(brand\)/.test(c) && /cinemaSlideFooterStack\(width, height, disclosure\)/.test(c) && /\{disclosure\}/.test(c)
      && /bottom: stack\.disclosureBottom/.test(c) && /bottom: stack\.nameplateBottom/.test(c) && /bottom: stack\.bodyBottom/.test(c)
      && !/bottom: 0, left: 0, right: 0, height: 40/.test(c) && !/bottom: 32, left: 56/.test(c) && !/bottom: 120,/.test(c))
  }
  check("BuyerConsultationSlide and ListingSectionReel raise their caption band onto the stack (CaptionLayer bandBottom)",
    /bandBottom=\{stack\.captionBandBottom\}/.test(code("remotion/BuyerConsultationSlide.tsx")) && /bandBottom=\{stack\.captionBandBottom\}/.test(code("remotion/ListingSectionReel.tsx")))
  check("CaptionLayer honours bandBottom (the band's bottom edge, px) and keeps the safe inset as its default", /bandBottom\?: number/.test(code("remotion/components/CaptionLayer.tsx")) && /props\.bandBottom \?\? cs\.bandBottom/.test(code("remotion/components/CaptionLayer.tsx")))
  check("CONTROL: the pre-90E slide footer (bottom: 0, 40 px bar, 12 px type) sat inside the unsafe band on the 16:9 frame", 0 < safeInsets(1920, 1080).bottom && 40 < safeInsets(1920, 1080).bottom)
  // THE PRESENTER COLUMN (the lane's AFTER renders of the same two slides): the ring stands on the safe
  // inset and rises above all three text rows, so each row keeps its column clear — a long brokerage +
  // licence line was centred across the whole safe width and ran UNDER the agent's face.
  {
    const w = 1920, h = 1080
    const st = cinemaSlideFooterStack(w, h), safe = safeInsets(w, h)
    const ringLeft = w - safe.right - SLIDE_PRESENTER_PIP.size - SLIDE_PRESENTER_PIP.ringWidth
    check(`1920×1080: the ring's band (${safe.bottom}..${st.presenterTop} px from the bottom) holds the disclosure (${st.disclosureBottom}), the nameplate (${st.nameplateBottom}) and the caption band (${st.captionBandBottom}) — all three must dodge it`,
      st.presenterTop > st.captionBandBottom && st.presenterTop > st.nameplateBottom && st.presenterTop > st.disclosureBottom)
    check(`1920×1080: the rows' right edge (${w - st.presenterRight}) is left of the ring's left edge (${ringLeft}); the column is derived from SLIDE_PRESENTER_PIP, not typed`,
      w - st.presenterRight < ringLeft && st.presenterRight >= safe.right + SLIDE_PRESENTER_PIP.size + SLIDE_PRESENTER_PIP.ringWidth)
    check("CONTROL: the pre-fix disclosure box (the whole safe width) reached under the ring", w - safe.right > ringLeft)
    for (const f of ["remotion/ListingPresentationSlide.tsx", "remotion/BuyerConsultationSlide.tsx"]) {
      const c = code(f)
      check(`${f}: the disclosure keeps the presenter column (right: stack.presenterRight); the ring reads SLIDE_PRESENTER_PIP, no typed size={280}`,
        /bottom: stack\.disclosureBottom, right: stack\.presenterRight/.test(c) && /size=\{SLIDE_PRESENTER_PIP\.size\}/.test(c) && /ringWidth=\{SLIDE_PRESENTER_PIP\.ringWidth\}/.test(c) && !/size=\{280\}/.test(c))
    }
    check("BuyerConsultationSlide and ListingSectionReel keep their caption band out of the presenter column (CaptionLayer bandRight)",
      /bandRight=\{stack\.presenterRight\}/.test(code("remotion/BuyerConsultationSlide.tsx")) && /bandRight=\{stack\.presenterRight\}/.test(code("remotion/ListingSectionReel.tsx")))
    check("CaptionLayer honours bandRight and spans the frame by default", /bandRight\?: number/.test(code("remotion/components/CaptionLayer.tsx")) && /right: props\.bandRight \?\? 0/.test(code("remotion/components/CaptionLayer.tsx")))
    // THE DISCLOSURE'S OWN HEIGHT: a real-length line wraps beside the ring; the rows above stand on all of its lines.
    const shortLine = slideDisclosureText({ brokerageName: "Demo Realty", showEhoMark: true, licenseLine: "Lic. #DEMO-0000" })
    const longLine = slideDisclosureText({ brokerageName: "Demo Realty of Greater Miami and the Keys", showEhoMark: true, licenseLine: "Lic. #BK-DEMO-0000123" })
    const one = cinemaSlideFooterStack(w, h, shortLine), two = cinemaSlideFooterStack(w, h, longLine), bare = cinemaSlideFooterStack(w, h)
    const line = Math.ceil(cinemaDisclosureStyle(w, h).fontSize * cinemaDisclosureStyle(w, h).lineHeight)
    check(`1920×1080: "${shortLine}" (${shortLine.length} ch) lays out on 1 line; "${longLine.slice(0, 28)}…" (${longLine.length} ch) on ${two.disclosureLines} — the nameplate rises by a line (${one.nameplateBottom} → ${two.nameplateBottom}) and the body with it (${one.bodyBottom} → ${two.bodyBottom})`,
      one.disclosureLines === 1 && two.disclosureLines === 2 && two.nameplateBottom === one.nameplateBottom + line && two.bodyBottom === one.bodyBottom + line && bare.disclosureLines === 1)
    check("1920×1080: the two-line stack still lies inside the ring's band (the rows keep dodging the presenter)", two.presenterTop > two.captionBandBottom)
    check("the glyph estimate (DISCLOSURE_GLYPH_EM) is not under the advance the lane measured on its render (0.53 em: 82 glyphs across 1400 px at 32 px, letter-spacing 1)", DISCLOSURE_GLYPH_EM >= 0.53)
    check("CONTROL: the one-line stack put the nameplate inside the long line's second row (the overprint in after2-ListingSectionReel-mid.png)", one.nameplateBottom < one.disclosureBottom + 2 * line)
    check("ListingSectionReel lays its caption band out for the SAME disclosure text the slide inside it renders", /cinemaSlideFooterStack\(width, height, slideDisclosureText\(props\.brand\)\)/.test(code("remotion/ListingSectionReel.tsx")))
    check("CONTROL: the composer still spells the Equal Housing mark and drops it only when the brand opts out", /Equal Housing Opportunity/.test(shortLine) && !/Equal Housing/.test(slideDisclosureText({ brokerageName: "X", showEhoMark: false })))
    // THE SEARCH CARDS (after-BuyerConsultationSlide-bodyEnd.png): a flex row with min-height auto grew to its
    // photos (554 px in a 349 px row) and ran under the caption band and the nameplate. Strings matter here
    // (the flex basis, the absolute image), so this reads the comment-stripped source, not the blanked one.
    const buyer = stripComments(read("remotion/BuyerConsultationSlide.tsx"))
    check("BuyerConsultationSlide's search cards cannot outgrow the body region: minHeight 0 down the flex chain, the photo box a flex basis with the image ABSOLUTE inside it, no percentage-height photo box",
      /flex: 1, minHeight: 0, display: "flex", gap: 20/.test(buyer) && /flex: 1, minHeight: 0, borderRadius: 12, overflow: "hidden"/.test(buyer)
      && /flex: "0 0 55%", minHeight: 0, position: "relative", overflow: "hidden"/.test(buyer) && /position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover"/.test(buyer)
      && !/height: "55%"/.test(buyer))
    check("CONTROL: the finder still sees the pre-fix percentage-height photo box", /height: "55%"/.test(`<div style={{ height: "55%", backgroundColor: "#E5E7EB" }}>`))
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §avatar · D-ID segment boundaries match the script; an after-cover clip keeps its whole length ──")
{
  let maxDrift = 0, walked = 0
  for (const s of staged.filter((x) => x.host === "avatar" && x.script)) {
    walked++
    const words = spokenWords(s.script as string)
    // D-ID measured the clip 12 % longer than the estimate → the composition re-fits.
    const geo = geometryFor(s.id)!
    const measured = Number(((s.spokenSeconds as number) * 1.12).toFixed(3))
    const props = { ...s.props, avatarDurationSeconds: measured }
    const dur = planDurationForProps(s.id, props, { purpose: s.purpose })
    const refit = fitBodyVisualPlan(s.plan, s.id, dur.durationInFrames)!
    // The SCRIPT's segments: each plan segment's words tile the body by weight.
    const expected = weightedShotSlots(refit.body.durationInFrames, refit.segments.map((seg) => Math.max(1, seg.words)))
    const drift = Math.max(...refit.segments.map((seg, i) => Math.abs(seg.from - (refit.body.from + expected[i].from))))
    maxDrift = Math.max(maxDrift, drift)
    check(`${s.id}/${s.purpose}: after the re-fit to D-ID's ${measured}s clip, every segment opens within 1 frame of its script segment (drift ${drift}f, ${words.length} words → ${refit.segments.length} segments)`, drift <= 1)
    check(`${s.id}/${s.purpose}: the re-fitted plan's length is the render's (${dur.durationInFrames}f) and the presenter window holds the whole clip`,
      refit.durationInFrames === dur.durationInFrames && (dur.narrationWindow.to - dur.narrationWindow.from) / geo.fps >= measured - 1e-6)
  }
  check(`the avatar walk is not empty (${walked} rows, max drift ${maxDrift}f)`, walked >= 5)
  // THE AFTER-COVER CLIP (found by this lane's real render of PartnersMeetingReel on the avatar path): a
  // composition whose VOICEOVER plays from frame 0 under its cover (narrationFrom "cover") mounts its
  // AVATAR clip only after the cover. The plan subtracted the cover from the clip's span as if it had
  // played under it, so the presenter window was 2.5 s shorter than the clip and the outro cut the last
  // words. The measured clip is the narration, so the lead applies only to a from-frame-0 source.
  const clip = 10.5
  const withAvatar = planDurationForProps("PartnersMeetingReel", { cards: [{}], avatarVideoUrl: "https://x/a.mp4", avatarDurationSeconds: clip })
  const window = (withAvatar.narrationWindow.to - withAvatar.narrationWindow.from) / withAvatar.fps
  check(`PartnersMeetingReel with a ${clip}s avatar clip and no voiceover: the narration window starts at the cover's end (${withAvatar.narrationWindow.from}f) and holds the clip (${window.toFixed(2)}s ≥ ${clip}s + settle)`,
    withAvatar.narrationWindow.from === COMPOSITION_DURATION_RULES.PartnersMeetingReel.introFrames && window >= clip + 0.5 - 1 / withAvatar.fps)
  const withVoice = planDurationForProps("PartnersMeetingReel", { cards: [{}], voiceover_url: "https://x/vo.mp3", spokenSeconds: 8, spokenSecondsSource: "measured" })
  check("…while the same composition with a measured VOICEOVER still narrates from frame 0 and carries only the remainder after the cover (85E's rule intact)",
    withVoice.narrationWindow.from === 0 && Math.abs(withVoice.bodySeconds - (8 + 0.5 - COMPOSITION_DURATION_RULES.PartnersMeetingReel.introFrames / 30)) < 1 / 30 + 1e-9)
  // The clip mounts at COVER, so its window is the BODY (the pre-fix span carried the cover the clip never played under).
  const preFix = planCompositionDuration({ compositionId: "PartnersMeetingReel", spokenSeconds: clip, spokenSecondsSource: "measured" })
  const preWindow = (preFix.narrationWindow.to - COMPOSITION_DURATION_RULES.PartnersMeetingReel.introFrames) / 30
  check(`CONTROL: the pre-90E arithmetic gave that clip a ${preWindow.toFixed(2)}s presenter window — ${(COMPOSITION_DURATION_RULES.PartnersMeetingReel.introFrames / 30).toFixed(1)}s short of the ${clip}s it speaks`,
    preWindow < clip)
  // ONE VOICE, NOT TWO: the partners' show never stages a separate mp3 beside a D-ID clip that already narrates.
  // (stripComments only — the predicate reads a typeof literal.)
  const pm = stripComments(read("lib/intelligence/partners-meeting.ts"))
  check("partners-meeting stages the assistant's mp3 ONLY when no avatar clip narrates the show (the D-ID clip is the voice — D-ID first)",
    /const narratesByAvatar = typeof props\.avatarVideoUrl === "string"/.test(pm) && /narratesByAvatar \? null : await prepareReelVoiceover\(/.test(pm))
  check("CONTROL: the finder recognises the pre-90E shape (voiceover synthesized unconditionally)", !/narratesByAvatar/.test(`const vo = await prepareReelVoiceover({ brokerageId })\nif (vo) props.voiceover_url = vo.url`))
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §blur · the memory film's photo push is MEASURED, so the blur ceiling is not paid on every frame ──")
{
  // Found by the lane's real render: MemoryVideoReel (706 frames) took 40 minutes because
  // cinemaCameraStreakPx read `imageUrls` only — the memory film stages `photoUrls` — so every
  // photo frame paid the 4-sample ceiling ("camera move of unmeasured speed"). Measured, the
  // typical Ken Burns push sits under BLUR_VISIBLE_STREAK_PX and costs nothing (86B's rule).
  const memory = staged.find((s) => s.id === "MemoryVideoReel")!
  const geo = geometryFor("MemoryVideoReel")!
  const total = memory.plan.durationInFrames
  const windows = cinemaMotionBlurWindows("MemoryVideoReel", total, memory.plan, { width: geo.width, height: geo.height, fps: geo.fps, props: memory.props })
  const streak = cinemaCameraStreakPx(memory.props, Math.min(...memory.plan.photoSlots.map((w) => w.durationInFrames)), memory.plan.photoSlots.length, { width: geo.width, height: geo.height, fps: geo.fps })
  check(`the memory film's push is measured from photoUrls (${streak}px, under the ${BLUR_VISIBLE_STREAK_PX}px floor) → no blur window, ${total} frame renders for ${total} frames`,
    streak !== null && streak < BLUR_VISIBLE_STREAK_PX && windows.length === 0)
  const unread = { ...memory.props, photoUrls: undefined, pics: memory.props.photoUrls }
  const ceiling = cinemaMotionBlurWindows("MemoryVideoReel", total, memory.plan, { width: geo.width, height: geo.height, fps: geo.fps, props: unread })
  check(`CONTROL: the same photos under a key nobody reads → the ceiling on every photo segment (${ceiling.length} windows × ${CINEMA_MOTION_BLUR.samples} samples = ${ceiling.reduce((a, w) => a + (w.to - w.from) * w.samples, 0)} extra frame renders)`,
    ceiling.length === memory.plan.photoSlots.length && ceiling.every((w) => w.samples === CINEMA_MOTION_BLUR.samples && w.streakPx === null))
  check("cinemaCameraStreakPx reads the four photo keys assetsFromProps reads (imageUrls / images / photos / photoUrls)",
    /\["imageUrls", "images", "photos", "photoUrls"\]/.test(stripComments(read("lib/video/cinema-finish.ts"))))
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §render91 · what the wave-91 real renders of the remaining formats found (lane 91E) ──")
{
  // (a) THE CORNER FINDER WAS BLIND TO MULTI-LINE STYLE OBJECTS AND TO SHARED COMPONENTS.
  //     §disclosure above reads one line at a time and only the composition files, so a
  //     `style={{\n position: "absolute",\n bottom: 56,\n left: 56 }}` in remotion/components/
  //     KenBurnsPhoto.tsx — the walkthrough's room label, under every caption cue on the real
  //     render — counted as zero. This finder reads each style OBJECT whole, in every
  //     composition AND every component / layer it imports, against that composition's frame.
  //     Exempt: an absolute child of a `position: "relative"` box (its insets are the box's,
  //     not the frame's) — published below as the finder's blind spot.
  const STYLE_OBJ = /style=\{\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}\}/g
  const typedSubSafe = (text: string, s: { top: number; bottom: number; left: number; right: number }): string[] => {
    const out: string[] = []
    for (const m of text.matchAll(STYLE_OBJ)) {
      const body = m[1]
      if (!/position:\s*"absolute"/.test(body)) continue
      if (/position:\s*"relative"/.test(text.slice(Math.max(0, (m.index ?? 0) - 600), m.index))) continue
      for (const side of ["top", "bottom", "left", "right"] as const) {
        const v = new RegExp(`(?:^|[\\s,{])${side}:\\s*(\\d+)\\b`).exec(body)
        if (v && Number(v[1]) > 0 && Number(v[1]) < s[side]) out.push(`${side}: ${v[1]} (safe ${s[side]})`)
      }
    }
    return out
  }
  const hits: string[] = []
  let walked = 0
  for (const [id, f] of Object.entries(VIDEO_COMPOSITION_FILES)) {
    const geo = geometryFor(id); if (!geo) continue
    const s = safeInsets(geo.width, geo.height)
    const src = stripComments(read(f))
    const files = [f, ...[...src.matchAll(/from\s+"\.\/(components\/[A-Za-z]+|_[A-Za-z]+)"/g)].map((m) => `remotion/${m[1]}.tsx`)]
    for (const file of files) { walked++; for (const h of typedSubSafe(stripComments(read(file)), s)) hits.push(`${id} ← ${file} ${h}`) }
  }
  check(`no moving composition — nor any component it mounts — types a style-object corner inside a platform UI band (${walked} composition×file reads)`, hits.length === 0, [...new Set(hits)].join("; "))
  const KB_PRE91 = `<div\n  style={{\n    position: "absolute",\n    bottom: 56,\n    left: 56,\n    opacity: captionOpacity,\n  }}\n>`
  check("CONTROL: the pre-91 KenBurnsPhoto room label (a MULTI-LINE style object) is caught here — and the one-line finder above cannot see it",
    typedSubSafe(KB_PRE91, safeInsets(1080, 1080)).some((h) => h.startsWith("bottom: 56")) && !/position: "absolute", (top|bottom): (\d+), (left|right): (\d+)/.test(KB_PRE91))
  check("CONTROL: an absolute child of a position:relative box is its box's business, not the frame's (the exemption, published)",
    typedSubSafe(`<div style={{ flex: 1, position: "relative" }}>\n<div style={{\n position: "absolute", top: "50%", left: 32, right: 32 }} />`, safeInsets(1920, 1080)).length === 0)
  note("blind spot: a text strip anchored bottom: 0 whose TEXT is lifted by padding (the pre-91 JustSold price strip) is not a typed corner — the diff-mask render finder ($S/l91e/harness) is what caught it")

  // (b) THE BROKERAGE NAME ON EVERY TENANT FILM. Producers stage brand.brokerageName on every
  //     listing reel (render-just-listed brandFor, director-content brandBlock); four listing
  //     compositions never read it, so the ad carried "Equal Housing Opportunity" and no
  //     brokerage anywhere (state licence law: the brokerage's name on the ad —
  //     lib/kernel/marketing/real-estate-compliance-gate.ts). Derived over the whole fleet.
  const BROKERAGE_EXCLUSIONS: Record<string, string> = {
    ProductPromoReel: "PLATFORM self-marketing (tier_access {platform}) — its brand is the product's own, no tenant brokerage exists on it",
  }
  // A READ, not a type declaration: `.brokerageName` off the brand, or the composed line from the whole brand.
  const READS_NAME = /\.brokerageName\b|slideDisclosureText\((props\.)?brand\)/
  const noName = Object.entries(VIDEO_COMPOSITION_FILES).filter(([id, f]) => !BROKERAGE_EXCLUSIONS[id] && !READS_NAME.test(code(f)))
  check(`every tenant film reads the brokerage name it is staged with (${Object.keys(VIDEO_COMPOSITION_FILES).length - Object.keys(BROKERAGE_EXCLUSIONS).length} compositions; ${Object.keys(BROKERAGE_EXCLUSIONS).length} published exclusion)`, noName.length === 0, noName.map(([id]) => id).join(", "))
  for (const [id, why] of Object.entries(BROKERAGE_EXCLUSIONS)) note(`⊘ ${id} — ${why}`)
  const JL_PRE91 = `brand: {\n primaryColor: string\n accentColor: string\n logoUrl?: string\n agentName?: string\n agentPhone?: string\n showEhoMark?: boolean\n }`
  check("CONTROL: a brand block that DECLARES brokerageName but never reads it fails the reader rule", !READS_NAME.test(JL_PRE91 + "\n brokerageName?: string") && READS_NAME.test("{brand.brokerageName}"))
  check("the ONE disclosure composer: a named brokerage reads exactly as before; no brokerage degrades to the mark alone (never a dangling '· Equal Housing')",
    slideDisclosureText({ brokerageName: "Demo Realty", showEhoMark: true, licenseLine: "Lic. #DEMO-0000" }) === "Demo Realty · Equal Housing Opportunity · Lic. #DEMO-0000"
    && slideDisclosureText({ brokerageName: null, showEhoMark: true }) === "Equal Housing Opportunity"
    && slideDisclosureText({ brokerageName: "Demo Realty", showEhoMark: false }) === "Demo Realty")
  const MLS_CLEAN = ["JustListedReelSquare", "JustSoldReelSquare", "JustListedReelHorizontal"]
  check("the MLS cut stays unbranded: the listing reels that compose the line drop the brokerage name and licence when mlsClean (lib/video/render-cut.ts)",
    MLS_CLEAN.every((id) => /brokerageName:\s*mlsClean\s*\?\s*null\s*:\s*brand\.brokerageName/.test(code(VIDEO_COMPOSITION_FILES[id]))))

  // (c) THE HERO-IMAGE SLIDE KINDS (ImageSlideBody / LoanSlideBody — first rendered here).
  const placeholderShips = Object.values(VIDEO_COMPOSITION_FILES).filter((f) => /Photo placeholder/.test(stripComments(read(f))))
  check("no slide body prints a 'Photo placeholder' panel to a client — no hero image means no photo box (the copy takes the width)", placeholderShips.length === 0, placeholderShips.join(", "))
  check("CONTROL: the pre-91 LoanSlideBody's fallback text is what the finder looks for", /Photo placeholder/.test(`}}>Photo placeholder</div>`))
  check("the buyer consultation's loan slide stages a hero: the first home THIS buyer saved (it was staged heroImageUrl: null, always)",
    /kind === "loan"[\s\S]{0,900}extra\.heroImageUrl = hero/.test(stripComments(read("lib/buyer-consultation/consultation-render.ts"))))

  // (d) THE SOLD PRICE UNDER THE CAPTIONS (JustSoldReelSquare — the real render's mid frame).
  const sold = stripComments(read("remotion/JustSoldReelSquare.tsx"))
  check("JustSoldReelSquare's price strip stands its TEXT in the badge slot above the caption band (it sat at the frame edge, under every cue)",
    /factsSlot = cinemaBadgeSlot\(width, height\)/.test(sold) && /\$\{factsSlot\.bottom\}px/.test(sold))
  check("JustListedReelSquare's price strip (the same strip, the same defect on its render) stands its TEXT in the badge slot",
    /\$\{cinemaBadgeSlot\(width, height\)\.bottom\}px/.test(stripComments(read("remotion/JustListedReelSquare.tsx"))))
  // Derived over the fleet: no moving composition keeps the edge-padded strip shape.
  const edgeStrips = Object.values(VIDEO_COMPOSITION_FILES).filter((f) => /padding: "32px 56px"/.test(stripComments(read(f))))
  check(`no moving composition keeps the pre-91 edge-padded strip (padding 32px 56px from the frame edge) — ${edgeStrips.length} found`, edgeStrips.length === 0, edgeStrips.join(", "))
  check("CONTROL: the strip finder still recognises the pre-91 shape", /padding: "32px 56px"/.test(`position: "absolute", bottom: 0, left: 0, right: 0,\n padding: "32px 56px",`))

  // (e) THE QR BADGE AND THE CENTRED END CARD (ComingSoonReel's real render: the CTA headline
  //     ran under the tracked QR). The badge's footprint is ONE spelling the badge itself
  //     reads, and a centred card padded by cinemaEndCardSideInset cannot reach its column.
  const badge = stripComments(read("remotion/components/QrOutroBadge.tsx"))
  check("QrOutroBadge draws its footprint from QR_OUTRO_BADGE (no typed 132 / 156 / 12 / 3)",
    /QR_OUTRO_BADGE\.code/.test(badge) && /QR_OUTRO_BADGE\.captionMaxWidth/.test(badge) && /QR_OUTRO_BADGE\.padding/.test(badge) && /QR_OUTRO_BADGE\.ring/.test(badge) && !/\b(132|156)\b/.test(badge))
  for (const [w, h] of [[1080, 1080], [1080, 1920], [1920, 1080]] as Array<[number, number]>) {
    const inset = cinemaEndCardSideInset(w, h)
    const badgeLeft = w - cinemaBadgeSlot(w, h).right - qrOutroBadgeWidth()
    check(`${w}×${h}: centred end-card copy padded by cinemaEndCardSideInset (${inset}) ends at ${w - inset}, left of the QR badge (${badgeLeft})`, w - inset < badgeLeft && inset < w / 2)
  }
  check("CONTROL: the pre-91 ComingSoon padding (64) lets centred copy reach the badge column on 9:16", 1080 - 64 > 1080 - cinemaBadgeSlot(1080, 1920).right - qrOutroBadgeWidth())
  const QR_CLEARANCE_READERS = ["ComingSoonReel"]
  check(`the end cards the real renders caught under the QR read the inset (${QR_CLEARANCE_READERS.join(", ")})`,
    QR_CLEARANCE_READERS.every((id) => /cinemaEndCardSideInset\(width, height\)/.test(code(VIDEO_COMPOSITION_FILES[id]))))

  // (f) THE PLAN'S B-ROLL VERDICT DECIDES WHETHER FOOTAGE PLAYS (ComingSoonReel).
  const csr = code("remotion/ComingSoonReel.tsx")
  check("ComingSoonReel plays staged b-roll only when the staged plan cut a b-roll segment (no plan → the pre-91 behaviour)",
    /fitBodyVisualPlan\(bodyVisualPlan, "ComingSoonReel", durationInFrames\)/.test(stripComments(read("remotion/ComingSoonReel.tsx"))) && /hasBroll = clips\.length > 0 && \(!plan \|\| plan\.segments\.some\(/.test(csr))
  {
    const photos = ["a", "b", "c", "d"].map((x) => `https://example.com/${x}.jpg`)
    const clips = [{ url: "https://example.com/b1.mp4", durationSeconds: 5 }, { url: "https://example.com/b2.mp4", durationSeconds: 4 }]
    const base: Record<string, unknown> = { imageUrls: photos, voiceoverUrl: "https://example.com/vo.mp3", spokenSeconds: 8, spokenSecondsSource: "measured" }
    const staged = stageBodyVisualPlan({ compositionId: "ComingSoonReel", props: { ...base, brollClips: clips }, avatarClip: false, script: scriptFor(8, "voiceover") })
    const plan = staged.ok ? staged.plan : null
    const D = plan?.durationInFrames ?? 0
    check("with four photos the listing_promo plan cuts NO b-roll segment (the house is the star) — so ComingSoonReel now lays no footage", !!plan && !plan.segments.some((s) => s.treatment === "broll"))
    // (g) FOOTAGE IS NEVER RE-SHUTTERED — a mixed plan (a photo push next to admitted footage).
    const mixed = plan ? { ...plan, segments: plan.segments.map((s, i) => (i === 1 ? { ...s, treatment: "broll" as const } : s)) } : null
    const withFootage = cinemaMotionBlurWindows("ComingSoonReel", D, mixed as BodyVisualPlan, { width: 1080, height: 1920, fps: 30, props: { ...base, brollClips: clips } })
    const noFootage = cinemaMotionBlurWindows("ComingSoonReel", D, mixed as BodyVisualPlan, { width: 1080, height: 1920, fps: 30, props: base })
    check("a film whose plan admits footage and stages clips gets no synthetic blur window (the blur re-extracted every clip once per sample)", withFootage.length === 0)
    check("CONTROL: the same plan with no clips staged still blurs its photo push (the rule is about footage, not about the reel)", noFootage.length > 0)
    const legacy = cinemaMotionBlurWindows("ComingSoonReel", D, null, { width: 1080, height: 1920, fps: 30, props: { ...base, brollClips: clips } })
    check("a plan-less render with staged clips (the composition's legacy footage underlay) is not blurred either", legacy.length === 0)
  }

  // (h) PAINT ORDER OVER THE SEGMENT BACKDROP (EquityReportReel / MarketUpdateReel real renders:
  //     the headline figures were INVISIBLE once their fade-in reached opacity 1). A positioned
  //     backdrop paints over every IN-FLOW sibling whatever the DOM order, so every panel mounted
  //     after <SegmentBackdrop> must itself be positioned. Derived: every file that mounts the
  //     backdrop, every raw <div> and every same-file component mounted after it in that layer.
  const firstStyle = (s: string): string => (new RegExp(STYLE_OBJ.source).exec(s) ?? [""])[0] ?? ""
  const inFlowAfterBackdrop = (src: string): string[] => {
    const out: string[] = []
    for (const m of src.matchAll(/<SegmentBackdrop\b[^>]*\/>([\s\S]*?)<\/AbsoluteFill>/g)) {
      // Only the backdrop's SIBLINGS (depth 0 in its layer) — a child of a positioned panel paints with it.
      let depth = 0
      for (const t of m[1].matchAll(/<(\/?)([A-Za-z][A-Za-z.]*)((?:[^>"]|"[^"]*")*?)(\/?)>/g)) {
        const [, closing, name, attrs, selfClosing] = t
        if (closing) { depth = Math.max(0, depth - 1); continue }
        if (depth === 0) {
          if (name === "div" && !/position:/.test(attrs)) out.push(`raw <div> (${attrs.trim().slice(0, 40)}…)`)
          if (/^[A-Z]/.test(name)) {
            // A same-file component: its ROOT's first style object. An imported one (AvatarPIP) is not read — published.
            const def = new RegExp(`const ${name}: React\\.FC[\\s\\S]*?(?=\\n(?:const|export|function) |$)`).exec(src)
            if (def && !/position:/.test(firstStyle(def[0]))) out.push(`<${name}> root`)
          }
        }
        if (!selfClosing) depth++
      }
    }
    return [...new Set(out)]
  }
  const backdropUsers = Object.values(VIDEO_COMPOSITION_FILES).filter((f) => /<SegmentBackdrop\b/.test(stripComments(read(f))))
  const hidden = backdropUsers.flatMap((f) => inFlowAfterBackdrop(stripComments(read(f))).map((h) => `${f}: ${h}`))
  check(`every panel mounted over a SegmentBackdrop is positioned, so it paints above it (${backdropUsers.length} compositions mount the backdrop)`, backdropUsers.length > 0 && hidden.length === 0, hidden.join("; "))
  const PRE91 = `<AbsoluteFill>\n<SegmentBackdrop plan={plan} />\n<StatCard value="x" />\n</AbsoluteFill>\nconst StatCard: React.FC<{ value: string }> = ({ value }) => {\n  return (\n    <div style={{\n      height: "100%", display: "flex",\n    }}>{value}</div>\n  )\n}`
  check("CONTROL: the pre-91 StatCard (an in-flow root after the backdrop) is caught", inFlowAfterBackdrop(PRE91).length === 1)

  // (i) THE ONE LOWER-THIRD STANDS ABOVE THE CAPTION BAND BY DEFAULT (TeammateExplainerReel's real
  //     render: its strap, parked at the typed default 168, ran under every caption cue).
  const lt = stripComments(read("remotion/components/LowerThird.tsx"))
  check("LowerThird's default height is cinemaLowerThirdPlacement (no typed default), its text on the safe side inset",
    /bottom \?\? cinemaLowerThirdPlacement\(width, height, fps\)\.bottom/.test(lt) && !/bottom = \d+/.test(lt) && /cinemaFrame\(width, height\)\.safe\.left/.test(lt))
  for (const [w, h] of [[1080, 1080], [1080, 1920], [1920, 1080]] as Array<[number, number]>) {
    const cap = cinemaCaptionStyle(w, h)
    const bandTop = cap.bandBottom + Math.ceil(cap.fontSize * cap.lineHeight * 2 + cap.padY * 2)
    check(`${w}×${h}: the default strap (${cinemaLowerThirdPlacement(w, h, 30).bottom}) sits above a two-line caption band (top ${bandTop})`, cinemaLowerThirdPlacement(w, h, 30).bottom >= bandTop)
  }
  // (k) THE NARRATION MUX KEEPS THE VOICE'S LEVEL (ProductPromoReel's real render: the bed sat
  //     13 dB under a muxed voice, 24 dB under every in-frame one). amix's default normalize=1
  //     halves each of its two inputs, so the sidechain duck keyed off a voice 6 dB too quiet.
  const vo = stripComments(read("lib/remotion/voiceover-mixer.ts"))
  const muxAmix = [...vo.matchAll(/\[0:a\]\[vo\]amix=([^\[`]*)\[aout\]/g)].map((m) => m[1])
  check(`the narration mux's amix does not normalize its inputs (${muxAmix.length} graph)`, muxAmix.length > 0 && muxAmix.every((g) => /normalize=0/.test(g)))
  check("CONTROL: the pre-91 graph (ffmpeg's default normalize) is what the finder refuses", !/normalize=0/.test("inputs=2:duration=${mixDuration}:dropout_transition=0"))

  // (l) CMAReel's persistent footer (a padded flex row 36 px from the edges in 18 px type — the
  //     brokerage bottom-left, the mark bottom-right, both inside the player's UI band).
  const cma = stripComments(read("remotion/CMAReel.tsx"))
  check("CMAReel's footer is the ONE disclosure line on the safe inset (cinemaDisclosureStyle + slideDisclosureText), not an edge-padded flex row",
    /\.\.\.cinemaDisclosureStyle\(width, height\)/.test(cma) && /slideDisclosureText\(\{ brokerageName: brand\.brokerageName/.test(cma) && !/justifyContent: "flex-end", padding: 36/.test(cma))
  check("CONTROL: the pre-91 footer shape is what the finder refuses", /justifyContent: "flex-end", padding: 36/.test(`<AbsoluteFill style={{ justifyContent: "flex-end", padding: 36, pointerEvents: "none" }}>`))

  // (n) AffordabilitySnapshotReel's rate assumption rides INSIDE the bottom-anchored disclosure
  //     block (it stood a fixed two lines above it; a real-length brokerage line wraps to three).
  const aff = stripComments(read("remotion/AffordabilitySnapshotReel.tsx"))
  check("AffordabilitySnapshotReel stacks the rate assumption inside the disclosure block — no fixed-line offset above a line that can wrap",
    /\.\.\.disclosure \}\}>\s*\{ratesAssumption &&/.test(aff) && !/bottom: disclosure\.bottom \+/.test(aff))
  check("CONTROL: the pre-91 fixed offset is what the finder refuses", /bottom: disclosure\.bottom \+/.test(`position: "absolute", bottom: disclosure.bottom + Math.round(disclosure.fontSize * disclosure.lineHeight * 2),`))

  // (m) PhotoWalkthroughReel's cover (the persistent EHO pill printed over the city line).
  check("PhotoWalkthroughReel's cover centres its title block ABOVE the badge slot the EHO pill stands in",
    /coverBottom = cinemaBadgeSlot\(width, height\)\.bottom \+ type\.caption \* 2/.test(stripComments(read("remotion/PhotoWalkthroughReel.tsx"))))

  // (j) THE CONTEXT-CUE ROW (OpenHouse / Testimonial real renders: the bottom row printed over the
  //     caption tick in the body and over the brokerage / licence line on the CTA tile).
  const cue = stripComments(read("remotion/_BrollLayer.tsx"))
  check("ContextCueRow's bottom row stands in the badge slot (above captions + disclosure) and out of both corner badges' columns",
    /bottom: pos === "bottom" \? cinemaBadgeSlot\(width, height\)\.bottom/.test(cue) && /pos === "bottom" \? cinemaEndCardSideInset\(width, height\)/.test(cue))
  check("in the BODY (captions below, the scene's title block in the badge slot) the cue rows stand on the safe top — ComingSoonReel, OpenHouseAnnounceReel",
    ["remotion/ComingSoonReel.tsx", "remotion/OpenHouseAnnounceReel.tsx"].every((f) => /<ContextCueRow[^>]*position="top"/.test(stripComments(read(f))) && !/<ContextCueRow[^>]*position="bottom"/.test(stripComments(read(f)))))
  check("CONTROL: the pre-91 bottom row (the safe bottom inset) is exactly the disclosure line's height — a collision by construction",
    cinemaFrame(1080, 1080).safe.bottom === cinemaDisclosureStyle(1080, 1080).bottom && cinemaBadgeSlot(1080, 1080).bottom > cinemaDisclosureStyle(1080, 1080).bottom)
  check("CONTROL: the pre-91 typed default (168) lies INSIDE the 1:1 caption band", (() => { const c = cinemaCaptionStyle(1080, 1080); return 168 > c.bandBottom && 168 < c.bandBottom + Math.ceil(c.fontSize * c.lineHeight * 2 + c.padY * 2) })())
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n── §script · every derived spoken writer's prompt carries persona, purpose, fair housing, hook-first and a non-salesy close ──")
{
  // The SAME derivation test:video-type-matrix §gate uses (a model call + a spoken sink), so a writer added later cannot hide.
  const WRITER_DIRS = ["lib/video", "lib/agents", "lib/contact-promotion", "lib/intelligence", "lib/listing-presentation", "lib/platform", "lib/kernel", "lib/ai-isa", "app/actions/video", "app/actions", "app/api/internal/remotion"]
  const MODEL_CALL = /generateTextRouted\(|generateObjectRouted\(|generateAIResponse\(|[^a-zA-Z.]generateText\(|[^a-zA-Z.]generateObject\(/
  const SPOKEN_SINK = /prepareReelVoiceover\(|dispatchVideo\(|script_content|captionScript|narrationScript|voiceoverUrl|fitNarrationToBudget\(/
  const EXCLUSIONS: Record<string, string> = {
    "lib/kernel/ai-copy.ts": "the HOOK engine — it writes the hook line itself (hook-first by definition) and carries the charter as an array",
    "lib/kernel/marketing.ts": "the model call is a blog post; the spoken text it stores is the agent's OWN typed script",
    "app/actions/video-repurposing.ts": "writes snippet titles / social captions (written, not spoken)",
    "lib/kernel/content-creators.ts": "the spoken output is a PODCAST script (a conversation, not a hook-first reel); fair housing rides its compliance blocks",
    "app/actions/custom-video.ts": "coaches the agent's OWN words (suggestPrompt: rewrites of what they typed); the guide's fair-housing / not-salesy floor is in lib/video/video-guide.ts",
    "app/actions/video/create-video-project.ts": "IMPROVES an existing script under the compliance blocks — the hook/CTA shape is the original writer's",
    "app/actions/link-to-video.ts": "a URL-to-voiceover draft; carries the compliance rule and required disclaimers — its hook/persona rules are the studio's follow-up (published)",
  }
  const walk = (dir: string, out: string[]) => {
    let entries: string[] = []
    try { entries = readdirSync(join(root, dir)) } catch { return }
    for (const e of entries) { const rel = `${dir}/${e}`; const st = statSync(join(root, rel)); if (st.isDirectory()) walk(rel, out); else if (/\.ts$/.test(e) && !/\.d\.ts$/.test(e)) out.push(rel) }
  }
  const files: string[] = []
  for (const d of WRITER_DIRS) walk(d, files)
  const writers = [...new Set(files)].filter((f) => { const s = code(f); return MODEL_CALL.test(s) && SPOKEN_SINK.test(s) })
  // The INGREDIENTS, read from the prompt TEXT (strings kept — stripComments only).
  const FAIR = /fair[- ]housing|protected characteristic|protected[- ]class/i
  const FAIR_CODE = /FAIR_HOUSING_WRITING_FLOOR|buildComplianceSystemBlocks|complianceBlocks?\b|complianceDirectives/
  const PERSONA = /persona|audience|firstName|contactName|for \$\{|speaking directly to|targeting/i
  const PURPOSE = /narrationLengthDirective\(|purpose|videoPurpose|videoType|explainer video|welcome|anniversary|listing presentation|newsletter|reel\b/i
  const HOOK = /shortFormStructureDirective\(|\bhook\b|open with|opens with|lead with|first spoken line/i
  const CLOSE = /shortFormStructureDirective\(|no[- ]pressure|not salesy|no pitch|sales pitch|no urgency|never urgency|pushy|act now|"link in bio"|one ask|single, specific next step|specific next step|next step|forward-look/i
  let gated = 0
  for (const f of writers) {
    if (EXCLUSIONS[f]) { note(`⊘ ${f} — ${EXCLUSIONS[f]}`); continue }
    const s = stripComments(read(f))
    const missing = [["persona", PERSONA], ["purpose", PURPOSE], ["hook-first", HOOK], ["non-salesy close", CLOSE]].filter(([, re]) => !(re as RegExp).test(s)).map(([n]) => n)
    if (!FAIR.test(s) && !FAIR_CODE.test(code(f))) missing.unshift("fair-housing")
    if (missing.length === 0) gated++
    check(`${f}: the writing prompt carries persona, purpose, fair housing, hook-first ordering and a non-salesy close`, missing.length === 0, `missing ${missing.join(", ")}`)
  }
  check(`the derived roster is not empty (${gated} complete writers of ${writers.length} rostered)`, gated >= 8)
  const specimen = `const prompt = withSpokenScriptStandards(\`Write a 75-word engaging voiceover script for a \${cat} video. Professional tone. Return ONLY the script.\`)\nconst { text } = await generateTextRouted({ prompt })\nrow.script_content = text`
  check("CONTROL: a writer with a model call + a spoken sink and a prompt with none of the ingredients is caught", MODEL_CALL.test(blankStrings(stripComments(specimen))) && SPOKEN_SINK.test(blankStrings(stripComments(specimen))) && !FAIR.test(specimen) && !FAIR_CODE.test(specimen) && !HOOK.test(specimen))
  // The two writers this lane extended keep their new lines (the RULE they now carry, asserted by function, not by line).
  check("avatar-explainer folds shortFormStructureDirective into the narration ask (hook ≤ 2 s, three beats, one no-pressure close)", /shortFormStructureDirective\(\{/.test(code("lib/video/avatar-explainer.ts")))
  check("chapter-video-generator closes on ONE no-pressure next step toward the appointment (never a pitch)", /no-pressure next step/i.test(stripComments(read("lib/video/chapter-video-generator.ts"))) && /never a pitch/i.test(stripComments(read("lib/video/chapter-video-generator.ts"))))
  check("the studio writer (video-generation) asks for a hook inside the short-form window and a no-pressure close, not a bare 'clear call-to-action'", /shortFormStructureDirective\(\{/.test(code("app/actions/video-generation.ts")))
  check("the just-listed and newsletter render routes close without urgency (their prompts say so)", /no urgency/i.test(stripComments(read("app/api/internal/remotion/render-just-listed/route.ts"))) && /no urgency/i.test(stripComments(read("app/api/internal/remotion/render-newsletter-video/route.ts"))))
}

console.log(`\nvideo-timeline-integrity: ${passed} passed, ${failed} failed (denominator ${passed + failed})`)
if (failed > 0) { console.log(failures.map((f) => `  ✗ ${f}`).join("\n")); process.exit(1) }
