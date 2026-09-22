#!/usr/bin/env tsx
/**
 * scripts/video-type-matrix-simulator.ts   (npm run test:video-type-matrix)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PER-TYPE MATRIX. Owner (wave 77, verbatim): "make sure that all remotion
 * videos and with avatar are created correctly by using the skills. broll/
 * images/music/intro/outro/branding are all correctly calculated in the complete
 * videos using voiceover or an avatar."
 *
 * Wave 76D proved the asset math for the two HOST KINDS on a handful of
 * representative compositions (remotion-asset-math 436, video-assembly 341,
 * avatar-pipeline-hardening 314). This advances it to every automated video
 * TYPE the OS produces — the owner's own list (welcome, anniversary/equity,
 * just-listed/just-sold promo, CMA reel, market update, seller update,
 * education/explainer, product video, memory video, partners-meeting reel, lead
 * reel, geo reel, newsletter video, photo walkthrough, listing promo hybrid
 * composite) plus every other registered video composition a producer stages —
 * and EXECUTES, per type, through the REAL pure survivors:
 *
 *   sum        the composition's own intro+body+outro tile its registered
 *              duration_frames exactly (scripts/composition-segments.ts — the
 *              ONE extractor video-assembly shares), and the COMPLETE video =
 *              composition + stock bookends capped at MAX_BRAND_BOOKEND_SECONDS
 *              each (what render-coordinator's `compositionSeconds +
 *              bookendSeconds` and concatIntroOutro's trim actually produce)
 *   window     the NARRATION WINDOW the composition declares on its own
 *              <CaptionLayer visibleFromFrame/hiddenFromFrame>, resolved through
 *              the same scope as the segments — and, for avatar hosts, proven
 *              equal to lib/video/narration-window.ts's table
 *   broll      b-roll slots (brollSlots ← selectBrollPlan) tile the b-roll
 *              window exactly and never exceed a clip's own length; the
 *              composition's <BrollLayer totalFrames> resolves inside the reel
 *   music      the sidechain duck graph (MUSIC_SIDECHAIN_DUCK_SETTINGS) keys off
 *              [0:a] and its fade-out ENDS at the last frame of the complete
 *              video (st + d == videoSeconds), never past it
 *   branding   the producer(s) resolve brand through the ONE tenant cascade
 *              (resolveReelBrand / resolveBrandContext, or the Director's
 *              director-content which does) and never import the PLATFORM
 *              product brand — except the platform's own ProductPromoReel
 *   captions   the cues carry EXACTLY the fitted narration's words, every cue
 *              inside the narration window (alignment path AND even path), and
 *              every cue's kinetic word track (lane 77D) is inside its cue
 *   avatar     for avatar hosts: the word budget is derived from the WINDOW the
 *              D-ID track is cropped to (narrationWindowBudget), so a script at
 *              budget read at average pace ends INSIDE the crop; avatarFadeOut-
 *              Frame stays inside the window; the voiceover pad never fires on
 *              a fitted voiceover script
 *   slots      image slots (evenShotSlots / kenBurnsPlan) tile the body for 1,
 *              3 and 8 photos
 *   budget     narrationBudget is positive and never exceeds the runtime
 *   gate       the Director gate — withSpokenScriptStandards + scanForAiTells —
 *              is on EVERY writer, DERIVED by scanning for model calls with a
 *              spoken sink rather than from a hand roster, so a writer added
 *              after this proof cannot hide from it
 *   tts        every video lane's narration goes through prepareReelVoiceover
 *              (v3 via the one selector, cached) — no bare synthesizeSpeech
 *
 * SKILLS USED: .claude/skills/remotion-best-practices (router) →
 * remotion-markup/transitions.md ("Duration calculation" — why SceneFade is an
 * overlay, not a TransitionSeries), remotion-captions/display-captions.md
 * ("Word highlighting" — the kinetic caption track this file's §captions
 * proves), remotion-markup/audio.md + voiceover.md (fade/volume/duration
 * semantics the music + narration checks encode), remotion-markup/timing.md
 * (clamped interpolate — every new component here is scanned by
 * test:remotion-setup's clamp sweep).
 *
 * METHOD (§2): every source scan reads STRIPPED source (a tombstone naming a
 * survivor is not a call site); every absence assertion carries a POSITIVE
 * CONTROL; every exclusion is PUBLISHED beside the count. PURE — no ffmpeg, no
 * network, no Remotion render, no database.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments, blankStrings } from "./strip-comments"
import {
  VIDEO_COMPOSITION_FILES, NON_CHAIN_COMPOSITIONS, buildScope, tileChain, narrationWindow, safeEval, tileSegments, type Segment,
} from "./composition-segments"
import { COMPOSITION_GEOMETRY, compositionSeconds, geometryFor } from "../lib/remotion/composition-geometry"
import { finishForVideo, VIDEO_FINISH_SPEC } from "../lib/video/finish-spec"
import { computeAssemblyTimeline, evenShotSlots } from "../lib/video/assembly-timeline"
import { kenBurnsPlan } from "../lib/video/ken-burns-plan"
import { brollSlots, clipFrames, type BrollClip } from "../remotion/_BrollLayer"
import {
  buildMusicTrackFilter, buildMusicDuckFilterGraph, DEFAULT_MUSIC_FADE_OUT_SECONDS,
} from "../lib/remotion/music-filter-graph"
import {
  MUSIC_DUCK_VOLUME_PCT, MUSIC_SIDECHAIN_DUCK_SETTINGS, MAX_BRAND_BOOKEND_SECONDS,
} from "../lib/video/realism-profile"
import {
  WORDS_PER_MINUTE, narrationBudget, fitNarrationToBudget, spokenWords, estimateDurationSeconds,
  avatarFadeOutFrame, avatarDurationOverrunSeconds,
} from "../lib/video/script-structure"
import { narrationWindowBudget, narrationWindowSeconds } from "../lib/video/narration-window"
// WAVE 78 — the window is DERIVED (lib/video/duration-model.ts), not a table:
// NARRATION_WINDOW_FRAMES is tombstoned in narration-window.ts; every check
// that mirrored it now reads narrationWindowFrames / planCompositionDuration.
import {
  COMPOSITION_DURATION_RULES, PURPOSE_DURATION_RULES, narrationWindowFrames, planCompositionDuration, purposeBudgetFor,
} from "../lib/video/duration-model"
import {
  MEMORY_VIDEO_COMPOSITION_ID, MEMORY_VIDEO_COVER_SECONDS, MEMORY_VIDEO_MAX_SECONDS, MEMORY_VIDEO_OUTRO_SECONDS, MEMORY_VIDEO_PURPOSE,
  memoryVideoChapterLayout, memoryVideoDurationFrames, splitForSynthesis,
} from "../lib/video/memory-video-composition"
import {
  buildCaptionPlan, shiftCaptionCues, clipCaptionCuesFromFrame, clipCaptionCuesBeforeFrame,
  activeWordIndex, evenWordFrames, type CaptionCue, type CharacterAlignment,
} from "../lib/video/caption-plan"
import { paddingSecondsFor } from "../lib/remotion/voiceover-mixer"
import { VIDEO_FINISHED_STATUSES } from "../lib/video/video-status"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const readStripped = (rel: string): string => stripComments(readFileSync(join(root, rel), "utf8"))
/** Stripped AND string-blanked — for token scans where a fixture, a specimen
 *  or a log line could otherwise read as a live call (§2). */
const readCode = (rel: string): string => blankStrings(readStripped(rel))

let passed = 0, failed = 0
const failures: string[] = []
const check = (name: string, cond: boolean, detail?: string) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const skipNote = (name: string, why: string) => console.log(`  ⊘ ${name} — ${why}`)

// ═══════════════════════════════════════════════════════════════════════════
// § THE MATRIX — every automated video type, its producer(s), composition(s)
//   and host kind. Owner types are keyed so the completeness check below can
//   name a missing one.
// ═══════════════════════════════════════════════════════════════════════════

type Host = "avatar" | "voiceover" | "hybrid" | "silent" | "surface"
interface VideoType {
  /** Owner's own name for the type where it is one of the fifteen. */
  ownerKey?: string
  type: string
  producers: string[]
  compositions: string[]
  host: Host
  brand: "tenant" | "platform"
  /** Published exclusion / caveat, printed beside the row. */
  note?: string
}

const OWNER_TYPES = [
  "welcome", "anniversary_equity", "listing_promo", "cma", "market_update", "seller_update", "explainer",
  "product", "memory", "partners_meeting", "lead_reel", "geo_reel", "newsletter", "photo_walkthrough", "hybrid_composite",
] as const

const MATRIX: VideoType[] = [
  { ownerKey: "welcome", type: "welcome (personal avatar, at conversion)", producers: ["lib/video/intro-video-reactor.ts", "lib/contact-promotion/welcome-avatar-video.ts"], compositions: ["AgentTalkingHeadReel"], host: "avatar", brand: "tenant" },
  { ownerKey: "anniversary_equity", type: "home anniversary / equity report", producers: ["lib/video/intro-video-reactor.ts", "lib/video/anniversary-script.ts"], compositions: ["EquityReportReel"], host: "avatar", brand: "tenant" },
  { ownerKey: "listing_promo", type: "listing promo (just listed / just sold / open house / coming soon / price drop)", producers: ["lib/video/listing-promo-reactor.ts", "app/api/internal/remotion/render-just-listed/route.ts", "lib/video/promo-composition.ts"], compositions: ["JustListedReel", "JustSoldReelSquare", "OpenHouseAnnounceReel", "ComingSoonReel"], host: "voiceover", brand: "tenant" },
  { type: "Director paid listing cuts", producers: ["lib/video/video-director.ts", "lib/video/director-content.ts"], compositions: ["JustListedReelSquare", "JustListedReelHorizontal"], host: "voiceover", brand: "tenant" },
  { ownerKey: "cma", type: "CMA reel (charts)", producers: ["lib/video/cma-reel-orchestrator.ts", "lib/video/director-content.ts"], compositions: ["CMAReel"], host: "silent", brand: "tenant", note: "captions:false by finish-spec — a genuinely silent data reel (no script passes through)" },
  { ownerKey: "market_update", type: "market update (circle-PIP avatar over stat cards)", producers: ["lib/video/video-plays.ts", "lib/video/director-content.ts"], compositions: ["MarketUpdateReel"], host: "avatar", brand: "tenant" },
  { ownerKey: "seller_update", type: "seller weekly update", producers: ["lib/agents/seller-update-reel-producer.ts"], compositions: ["AgentTalkingHeadReel"], host: "avatar", brand: "tenant" },
  { ownerKey: "explainer", type: "education / explainer (agent + teammate)", producers: ["lib/video/avatar-explainer.ts", "lib/video/chapter-video-generator.ts"], compositions: ["AgentExplainerReel", "TeammateExplainerReel"], host: "avatar", brand: "tenant" },
  { type: "concept animation explainer", producers: ["lib/video/video-director.ts", "lib/video/director-content.ts"], compositions: ["ExplainerAnimReel"], host: "avatar", brand: "tenant" },
  { ownerKey: "product", type: "platform product video (self-marketing)", producers: ["lib/platform/product-content.ts"], compositions: ["ProductPromoReel"], host: "voiceover", brand: "platform" },
  { ownerKey: "memory", type: "memory video (seller-dictated family history)", producers: ["lib/video/memory-video.ts", "lib/video/memory-video-gate.ts", "lib/video/video-render-hold.ts", "lib/video/memory-video-render.ts"], compositions: ["MemoryVideoReel"], host: "voiceover", brand: "tenant", note: "lane 78D: chaptered voiceover host, no avatar; the length is COMPUTED from the narration (Root.tsx calculateMetadata → memoryVideoDurationFrames), the registered 36000 frames is the cap — see §memory" },
  { ownerKey: "partners_meeting", type: "partners-meeting show / board packet / listing pitch / deal room", producers: ["lib/intelligence/partners-meeting.ts", "lib/kernel/board-packet-reel.ts", "lib/video/listing-pitch-reel.ts", "lib/kernel/deal-room-reel.ts"], compositions: ["PartnersMeetingReel"], host: "voiceover", brand: "tenant" },
  { ownerKey: "lead_reel", type: "lead reel (1:1 intro, email-embedded)", producers: ["lib/ai-isa/lead-reel-brief.ts", "lib/video/video-director.ts"], compositions: ["AgentExplainerReel"], host: "avatar", brand: "tenant" },
  { ownerKey: "geo_reel", type: "geo reel (auto-published AI-search landing page)", producers: ["app/api/cron/geo-reel-autopublish/route.ts", "lib/geo/publish-video-landing.ts"], compositions: [], host: "surface", brand: "tenant", note: "a PUBLICATION surface over finished reels of any type, not a composition — its gate is proven in §surfaces" },
  { ownerKey: "newsletter", type: "newsletter digest video", producers: ["app/api/internal/remotion/render-newsletter-video/route.ts"], compositions: ["NewsletterDigestVideo"], host: "voiceover", brand: "tenant" },
  { ownerKey: "photo_walkthrough", type: "photo walkthrough (Ken Burns)", producers: ["lib/video/video-plays.ts", "lib/video/director-content.ts"], compositions: ["PhotoWalkthroughReel"], host: "voiceover", brand: "tenant" },
  { ownerKey: "hybrid_composite", type: "listing promo hybrid composite (D-ID bookends + Remotion middle)", producers: ["app/api/cron/listing-promo-hybrid-composite/route.ts", "lib/video/composite-attribution.ts"], compositions: ["JustListedReel"], host: "hybrid", brand: "tenant" },
  { type: "neighborhood spotlight", producers: ["lib/video/video-director.ts", "lib/video/director-content.ts"], compositions: ["NeighborhoodSpotlightReel"], host: "voiceover", brand: "tenant" },
  { type: "testimonial", producers: ["lib/video/video-plays.ts", "lib/video/director-content.ts"], compositions: ["TestimonialReel"], host: "voiceover", brand: "tenant" },
  { type: "buyer match reel", producers: ["lib/agents/buyer-match-reel-producer.ts"], compositions: ["AffordabilitySnapshotReel"], host: "silent", brand: "tenant", note: "captions:false by finish-spec — on-screen copy, no generated script" },
  { type: "listing presentation narrated sections", producers: ["lib/listing-presentation/section-render.ts", "lib/listing-presentation/section-narration-orchestrator.ts"], compositions: ["ListingSectionReel"], host: "voiceover", brand: "tenant" },
]

/** Fixture scripts at the one speaking pace (never a second constant). */
function fixtureScript(words: number): string {
  const bank = [
    "Three days on market, two offers already.",
    "The kitchen's been redone, quartz counters, new appliances.",
    "It opens right onto the deck.",
    "Buyers are responding fast this week.",
    "The roof was replaced last year too.",
    "Walkable to two parks and a coffee shop.",
    "If you want a private showing, just text me back.",
    "Rates ticked down again this month.",
  ]
  const out: string[] = []
  let count = 0, i = 0
  while (count < words) { const s = bank[i % bank.length]; out.push(s); count += spokenWords(s).length; i++ }
  return out.join(" ")
}
const FIXTURE_45S = fixtureScript(Math.round((45 / 60) * WORDS_PER_MINUTE))

/** A synthetic ElevenLabs-shaped alignment for `script` at WORDS_PER_MINUTE —
 *  one character per entry, words evenly paced, so the alignment path can be
 *  exercised with REAL per-character timing without a vendor call. */
function alignmentFor(script: string, startSeconds = 0): CharacterAlignment {
  const words = spokenWords(script)
  const secondsPerWord = 60 / WORDS_PER_MINUTE
  const characters: string[] = [], starts: number[] = [], ends: number[] = []
  let t = startSeconds
  words.forEach((w, wi) => {
    const perChar = secondsPerWord / (w.length + 1)
    for (const ch of w) { characters.push(ch); starts.push(t); ends.push(t + perChar); t += perChar }
    if (wi < words.length - 1) { characters.push(" "); starts.push(t); ends.push(t + perChar); t += perChar }
  })
  return { characters, character_start_times_seconds: starts, character_end_times_seconds: ends }
}

/** Every cue's kinetic word track satisfies the CaptionCue contract. */
function wordTrackHolds(cues: CaptionCue[]): { ok: boolean; why: string } {
  for (const c of cues) {
    if (!c.words || c.words.length === 0) return { ok: false, why: `cue "${c.text}" carries no word track` }
    if (c.words.map((w) => w.text).join(" ") !== c.text) return { ok: false, why: `words.join(" ") !== text for "${c.text}"` }
    if (c.words[0].fromFrame !== c.fromFrame) return { ok: false, why: `first word of "${c.text}" starts at ${c.words[0].fromFrame}, cue at ${c.fromFrame}` }
    const end = c.fromFrame + c.durationFrames
    for (let i = 0; i < c.words.length; i++) {
      const f = c.words[i].fromFrame
      if (f < c.fromFrame || f >= end) return { ok: false, why: `word "${c.words[i].text}" at ${f} is outside [${c.fromFrame}, ${end})` }
      if (i > 0 && f < c.words[i - 1].fromFrame) return { ok: false, why: `word frames not monotonic in "${c.text}"` }
    }
  }
  return { ok: true, why: "" }
}

const BROLL_FIXTURE: BrollClip[] = [
  { url: "https://example.com/a.mp4", durationSeconds: 4 },
  { url: "https://example.com/b.mp4", durationSeconds: 6.4 },
  { url: "https://example.com/c.mp4", durationSeconds: 5 },
]

// ═══════════════════════════════════════════════════════════════════════════
// § per-composition execution
// ═══════════════════════════════════════════════════════════════════════════

interface Resolved {
  id: string
  total: number
  fps: number
  scope: Record<string, number>
  source: string
  window: { from: number; to: number; declared: boolean }
}

function resolveComposition(id: string): Resolved | null {
  const geo = geometryFor(id)
  const file = VIDEO_COMPOSITION_FILES[id]
  if (!geo || !file) return null
  const source = readStripped(file)
  const scope = buildScope(source, geo, id)
  let window = narrationWindow(source, scope, geo.duration_frames)
  if (id === "PhotoWalkthroughReel") {
    // Derived split: `outroStart` is a destructured runtime variable the
    // evaluator cannot see; re-derive it through the SAME helper the
    // composition calls.
    const t = computeAssemblyTimeline({ durationInFrames: geo.duration_frames, introFrames: scope.COVER_FRAMES, outroFrames: scope.OUTRO_FRAMES })
    window = { from: 0, to: t.outro.from, declared: window.declared }
  }
  return { id, total: geo.duration_frames, fps: geo.fps, scope, source, window }
}

function checkSum(r: Resolved) {
  const label = `[sum] ${r.id}`
  if (!NON_CHAIN_COMPOSITIONS.has(r.id)) {
    const t = tileChain(r.source, r.scope, r.total)
    check(`${label}: intro+body+outro tile [0, ${r.total}) exactly${t.note}`, t.ok, t.ok ? undefined : t.reason)
  } else if (r.id === "PhotoWalkthroughReel") {
    const t = computeAssemblyTimeline({ durationInFrames: r.total, introFrames: r.scope.COVER_FRAMES, outroFrames: r.scope.OUTRO_FRAMES })
    check(`${label}: derived COVER(${r.scope.COVER_FRAMES})+body+OUTRO(${r.scope.OUTRO_FRAMES}) sums to ${r.total}`,
      t.totalFrames === r.total && t.intro.durationInFrames === r.scope.COVER_FRAMES && t.outro.durationInFrames === r.scope.OUTRO_FRAMES)
  } else if (r.id === "PartnersMeetingReel") {
    const s = r.scope
    check(`${label}: COVER + cardTotal + ASK + OUTRO === ${r.total} (nested ask Sequence, algebraic)`,
      ["COVER", "ASK", "OUTRO", "cardTotal"].every((k) => typeof s[k] === "number") && s.COVER + s.cardTotal + s.ASK + s.OUTRO === r.total)
  } else if (r.id === "MemoryVideoReel") {
    // Lane 78D — PROPS-DRIVEN timeline: the same pure helper the composition
    // lays out with, exercised on synthetic chapters. The RULE: cover + every
    // clip + outro tile the computed length exactly, and the computed length
    // never exceeds the registered cap.
    const fx = { chapters: [{ durationFrames: 900 }, { durationFrames: 1275 }, { durationFrames: 33 }] }
    const slots = memoryVideoChapterLayout(fx, r.fps)
    const total = memoryVideoDurationFrames(fx, r.fps)
    const cover = Math.round(MEMORY_VIDEO_COVER_SECONDS * r.fps), outro = Math.round(MEMORY_VIDEO_OUTRO_SECONDS * r.fps)
    const tiles = slots[0]?.from === cover && slots.every((s, i) => i === 0 || s.from === slots[i - 1].from + slots[i - 1].durationInFrames)
      && slots[slots.length - 1].from + slots[slots.length - 1].durationInFrames + outro === total
    check(`${label}: cover(${cover}) + Σ clips + outro(${outro}) === memoryVideoDurationFrames (${total}) — the film is exactly as long as the story`, tiles)
    check(`${label}: the computed length never exceeds the registered cap (${r.total})`,
      memoryVideoDurationFrames({ chapters: Array.from({ length: 200 }, () => ({ durationFrames: 9000 })) }, r.fps) === r.total && total < r.total)
    check(`${label}: the composition lays its chapters out with memoryVideoChapterLayout and the outro at the computed end (no frame const of its own)`,
      /memoryVideoChapterLayout\(/.test(r.source) && /memoryVideoDurationFrames\(/.test(r.source) && !/const\s+(COVER|BODY|OUTRO|TOTAL)\s*=/.test(r.source))
    check(`${label}: Root.tsx mounts the ONE durationMetadata, whose rule hook (COMPOSITION_DURATION_RULES.MemoryVideoReel.durationFromProps) computes durationInFrames from the props via memoryVideoDurationFrames`,
      /id="MemoryVideoReel"[\s\S]{0,600}calculateMetadata=\{durationMetadata\("MemoryVideoReel"\)\}/.test(readStripped("remotion/Root.tsx"))
      && /MemoryVideoReel:[^\n]*durationFromProps:\s*\(props, fps\) => memoryVideoDurationFrames\(/.test(readStripped("lib/video/duration-model.ts")))
  } else {
    check(`${label}: single continuous body (no <Sequence> chain of its own)`, !/<Sequence[\s>]/.test(r.source))
  }
  // THE COMPLETE VIDEO: composition + up to two stock bookends, each trimmed
  // to MAX_BRAND_BOOKEND_SECONDS by concatIntroOutro — the same number the
  // coordinator hands the narration pad and the music fade.
  const finish = finishForVideo(r.id)
  const complete = compositionSeconds(geometryFor(r.id)!) + (finish.bookends ? 2 * MAX_BRAND_BOOKEND_SECONDS : 0)
  check(`${label}: complete video = ${compositionSeconds(geometryFor(r.id)!)}s composition${finish.bookends ? ` + 2×${MAX_BRAND_BOOKEND_SECONDS}s bookends` : " (no bookends by finish-spec)"} = ${complete}s, bookends a minority of the runtime`,
    complete > 0 && (!finish.bookends || 2 * MAX_BRAND_BOOKEND_SECONDS < compositionSeconds(geometryFor(r.id)!)))
  return complete
}

function checkWindow(r: Resolved, host: Host) {
  const label = `[window] ${r.id}`
  check(`${label}: narration window [${r.window.from}, ${r.window.to}) lies inside [0, ${r.total}) and is non-empty`,
    r.window.from >= 0 && r.window.to <= r.total && r.window.to > r.window.from)
  if (host === "avatar") {
    check(`${label}: an avatar host declares its window on <CaptionLayer visibleFromFrame/hiddenFromFrame> (the one place the composition says where real audio plays)`,
      r.window.declared && r.window.from > 0)
    // WAVE 78 — DERIVED, not mirrored: [intro, total − outro) from the ONE
    // registry's bookends equals the composition's OWN window, at the cap AND
    // at a planned duration (a table could only ever say it at the cap).
    const derived = narrationWindowFrames(r.id, r.total)
    check(`${label}: narrationWindowFrames(id, cap) derives the composition's OWN window exactly ([${derived.from}, ${derived.to}) vs source [${r.window.from}, ${r.window.to}))`,
      derived.from === r.window.from && derived.to === r.window.to)
    const planned = planCompositionDuration({ compositionId: r.id, wordCount: purposeBudgetFor(r.id).idealWords })
    const plannedGeo = { ...geometryFor(r.id)!, duration_frames: planned.durationInFrames }
    const atPlan = narrationWindow(r.source, buildScope(r.source, plannedGeo, r.id), planned.durationInFrames)
    const derivedAtPlan = narrationWindowFrames(r.id, planned.durationInFrames)
    check(`${label}: …and at the PLANNED ${planned.durationInFrames}-frame render (ideal ${planned.purpose} script) the source window [${atPlan.from}, ${atPlan.to}) still equals the derived [${derivedAtPlan.from}, ${derivedAtPlan.to})`,
      atPlan.from === derivedAtPlan.from && atPlan.to === derivedAtPlan.to && planned.durationInFrames < r.total)
  }
}

function checkBroll(r: Resolved) {
  const finish = finishForVideo(r.id)
  const label = `[broll] ${r.id}`
  if (finish.broll === "none") { skipNote(label, "finish-spec broll:none — the content carries itself (published exclusion)"); return }
  // The window the layer is mounted in — the composition's own <BrollLayer
  // totalFrames={…}> when it mounts one, else the narration window.
  const m = /<BrollLayer\b[\s\S]*?totalFrames=\{([^}]+)\}/.exec(r.source)
  let windowFrames = r.window.to - r.window.from
  if (m) {
    try { windowFrames = safeEval(m[1], r.scope) } catch { /* unresolvable — fall back to the narration window */ }
    check(`${label}: <BrollLayer totalFrames={${m[1].trim()}}> resolves to ${windowFrames} ≤ the registered ${r.total} frames`, windowFrames > 0 && windowFrames <= r.total)
  }
  const slots = brollSlots(BROLL_FIXTURE, windowFrames, r.fps, 10)
  const tiles = slots.length > 0 && slots[0].from === 0 && slots.every((s, i) => i === 0 || s.from === slots[i - 1].from + slots[i - 1].durationFrames)
    && slots[slots.length - 1].from + slots[slots.length - 1].durationFrames === windowFrames
  check(`${label}: ${slots.length} b-roll slots tile the ${windowFrames}-frame window exactly (loop + truncate, no gap)`, tiles)
  check(`${label}: no slot is longer than its clip's own measured length (a <Video> past its end holds a frozen frame)`,
    slots.every((s) => s.durationFrames <= (clipFrames(BROLL_FIXTURE[s.index], r.fps) as number)))
}

function checkMusic(r: Resolved, completeSeconds: number) {
  const finish = finishForVideo(r.id)
  const label = `[music] ${r.id}`
  if (!finish.music) { skipNote(label, "finish-spec music:false — nothing may fight the voice (published exclusion)"); return }
  const volume = MUSIC_DUCK_VOLUME_PCT / 100
  const duck = buildMusicDuckFilterGraph({ loop: true, volume, videoSeconds: completeSeconds, duck: MUSIC_SIDECHAIN_DUCK_SETTINGS })
  check(`${label}: sidechain duck keys off [0:a] (the narration on the complete video)`, duck.includes("[a1][0:a]sidechaincompress"))
  const fade = /afade=t=out:st=([0-9.]+):d=([0-9.]+)/.exec(buildMusicTrackFilter({ loop: true, volume, videoSeconds: completeSeconds }))
  const st = fade ? Number(fade[1]) : NaN, d = fade ? Number(fade[2]) : NaN
  check(`${label}: fade-out ends AT the last frame of the ${completeSeconds}s complete video (st ${st} + d ${d}), never past it`,
    !!fade && st >= 0 && Math.abs(st + d - completeSeconds) < 0.011 && d === DEFAULT_MUSIC_FADE_OUT_SECONDS)
}

function checkCaptions(r: Resolved, host: Host) {
  const finish = finishForVideo(r.id)
  const label = `[captions] ${r.id}`
  if (!finish.captions) { skipNote(label, "finish-spec captions:false (silent reel or internal report show) — published exclusion"); return }
  const windowFrames = r.window.to - r.window.from
  // The budget the narration that plays INSIDE the window may claim: the
  // window budget for an avatar host, and for any composition whose audio
  // starts after frame 0 (TestimonialReel delays its voiceover to COVER); the
  // whole-composition budget when a root <Audio> narrates from frame 0.
  const budget = host === "avatar" || r.window.from > 0
    ? narrationBudget(r.id, windowFrames / r.fps)
    : narrationBudget(r.id, compositionSeconds(geometryFor(r.id)!))
  const fit = fitNarrationToBudget(FIXTURE_45S, budget)
  // EVEN PATH — planned against the window, re-anchored (what CaptionLayer does).
  const even = shiftCaptionCues(buildCaptionPlan(fit.script, windowFrames, r.fps).cues, r.window.from)
  const evenWords = even.flatMap((c) => spokenWords(c.text))
  check(`${label} even path: cues carry EXACTLY the fitted narration's ${evenWords.length} words, in order`, evenWords.join(" ") === spokenWords(fit.script).join(" "))
  check(`${label} even path: every cue inside the narration window [${r.window.from}, ${r.window.to})`,
    even.every((c) => c.fromFrame >= r.window.from && c.fromFrame + c.durationFrames <= r.window.to))
  const evenTrack = wordTrackHolds(even)
  check(`${label} even path: every cue's kinetic word track is inside its cue, monotonic, joins to the cue text`, evenTrack.ok, evenTrack.why)
  // ALIGNMENT PATH — real per-character timing, audio starting at the window's
  // own start; clipped both sides exactly as CaptionLayer clips precomputed cues.
  const aligned = clipCaptionCuesBeforeFrame(
    clipCaptionCuesFromFrame(buildCaptionPlan(alignmentFor(fit.script, r.window.from / r.fps), r.total, r.fps).cues, r.window.from),
    r.window.to,
  )
  const alignedWords = aligned.flatMap((c) => spokenWords(c.text))
  check(`${label} alignment path: cues carry EXACTLY the fitted narration's words`, alignedWords.join(" ") === spokenWords(fit.script).join(" "))
  check(`${label} alignment path: every cue inside the narration window`,
    aligned.every((c) => c.fromFrame >= r.window.from && c.fromFrame + c.durationFrames <= r.window.to))
  const alignedTrack = wordTrackHolds(aligned)
  check(`${label} alignment path: word track holds after clip/shift (real per-word frames survive)`, alignedTrack.ok, alignedTrack.why)
}

function checkAvatar(r: Resolved, host: Host) {
  const label = `[avatar] ${r.id}`
  if (host !== "avatar") {
    // Voiceover host: the snake-key mux pads the video for an overrun; a
    // FITTED script never needs the pad. (Audio delayed to the window start
    // claims only the window — same rule as §captions.)
    const budget = r.window.from > 0
      ? narrationBudget(r.id, (r.window.to - r.window.from) / r.fps)
      : narrationBudget(r.id, compositionSeconds(geometryFor(r.id)!))
    const fit = fitNarrationToBudget(FIXTURE_45S, budget)
    check(`[voiceover] ${r.id}: a fitted script (${fit.wordCount}w ≈ ${fit.estimatedSeconds}s) never triggers the m313 narration pad on the ${compositionSeconds(geometryFor(r.id)!)}s composition`,
      paddingSecondsFor(fit.estimatedSeconds, compositionSeconds(geometryFor(r.id)!)) === 0)
    return
  }
  const speakable = narrationWindowSeconds(r.id)
  const budget = narrationWindowBudget(r.id)
  const windowFrames = r.window.to - r.window.from
  check(`${label}: the WINDOW budget (${budget.budgetSeconds}s / ${budget.maxWords}w) never exceeds the ${speakable}s the D-ID track is cropped to`,
    budget.maxWords > 0 && budget.budgetSeconds <= speakable + 1e-9 && Math.abs(speakable - windowFrames / r.fps) < 1e-9)
  const wholeBudget = narrationBudget(r.id, compositionSeconds(geometryFor(r.id)!))
  check(`${label}: the whole-composition budget (${wholeBudget.budgetSeconds}s) WOULD overrun the crop or equal it — the window budget is the tighter, correct one`,
    wholeBudget.budgetSeconds >= budget.budgetSeconds)
  const fit = fitNarrationToBudget(FIXTURE_45S, budget)
  const measured = estimateDurationSeconds(fit.wordCount)
  check(`${label}: a script at budget read at average pace (${measured}s) ends INSIDE the window (${speakable}s) — avatarDurationOverrunSeconds is 0`,
    avatarDurationOverrunSeconds(measured, budget.budgetSeconds) === 0 && measured <= speakable + 1e-9)
  const fade = avatarFadeOutFrame(measured, windowFrames, r.fps)
  check(`${label}: avatarFadeOutFrame for that clip is null (fills the window) or inside [0, ${windowFrames})`, fade === null || (fade >= 0 && fade < windowFrames))
}

function checkSlots(r: Resolved) {
  const label = `[slots] ${r.id}`
  const body = r.window.to - r.window.from
  for (const n of [1, 3, 8]) {
    const slots = evenShotSlots(body, n)
    check(`${label}: ${n} image slot(s) tile the ${body}-frame body exactly`,
      slots.length === n && slots[0].from === 0 && slots[slots.length - 1].from + slots[slots.length - 1].durationInFrames === body)
  }
  const photos = Array.from({ length: 6 }, (_, i) => `https://example.com/p${i}.jpg`)
  const clips = kenBurnsPlan(photos, body, { fps: r.fps })
  check(`${label}: kenBurnsPlan tiles the body with 6 photos (last clip ends at ${body})`,
    clips.length === 6 && clips[clips.length - 1].fromFrame + clips[clips.length - 1].durationFrames === body)
}

function checkBudget(r: Resolved) {
  const secs = compositionSeconds(geometryFor(r.id)!)
  const b = narrationBudget(r.id, secs)
  check(`[budget] ${r.id}: narration budget ${b.maxWords}w / ${b.budgetSeconds}s is positive and ≤ the ${secs}s runtime`, b.maxWords > 0 && b.budgetSeconds <= secs)
}

// ═══════════════════════════════════════════════════════════════════════════
// § branding — the tenant cascade, never the platform brand
// ═══════════════════════════════════════════════════════════════════════════

const CASCADE_CALL = /resolveReelBrand\(|resolveBrandContext\(/
/** Producers that reach the cascade THROUGH the Director's content layer —
 *  commissionVideo → resolveDirectorContentProps, or brandBlock(identity) over
 *  resolveDirectorIdentity (director-content.ts:591 calls resolveReelBrand). */
const DIRECTOR_CALL = /commissionVideo\(|resolveDirectorContentProps\(|buildPromoProps\(|brandBlock\(|resolveDirectorIdentity\(/
const PRODUCT_BRAND_IMPORT = /from\s+["']@\/lib\/platform\/product-brand["']|from\s+["']\.\.?\/[^"']*product-brand["']/
const LITERAL_BRAND_COLOURS = /primaryColor:\s*"#0F172A",\s*accentColor:\s*"#F59E0B"/

function checkBranding(t: VideoType) {
  const label = `[branding] ${t.type}`
  const sources = t.producers.map((f) => [f, readCode(f)] as const)
  if (t.brand === "platform") {
    check(`${label}: the platform's own reel may carry the platform brand — and no TENANT cascade is dragged into it`,
      !sources.some(([, s]) => CASCADE_CALL.test(s)))
    return
  }
  const viaCascade = sources.filter(([, s]) => CASCADE_CALL.test(s)).map(([f]) => f)
  const viaDirector = sources.filter(([, s]) => DIRECTOR_CALL.test(s)).map(([f]) => f)
  const isSurfaceOrMemory = t.host === "surface" || t.compositions.length === 0
  if (isSurfaceOrMemory) {
    skipNote(label, "no composition is staged by this type — brand is applied by whichever reel it publishes/holds (published exclusion)")
  } else {
    check(`${label}: brand reaches the reel through the ONE tenant cascade (${viaCascade.length ? viaCascade.join(", ") : "via the Director: " + viaDirector.join(", ")})`,
      viaCascade.length > 0 || viaDirector.length > 0)
  }
  const leaks = sources.filter(([, s]) => PRODUCT_BRAND_IMPORT.test(s)).map(([f]) => f)
  check(`${label}: no producer imports the PLATFORM product brand`, leaks.length === 0, leaks.join(", "))
  const literals = sources.filter(([f, s]) => LITERAL_BRAND_COLOURS.test(readStripped(f)) && !/brand\?\.primaryColor/.test(readStripped(f))).map(([f]) => f)
  check(`${label}: no producer hardcodes the navy/amber platform defaults as the tenant's brand`, literals.length === 0, literals.join(", "))
}

// ═══════════════════════════════════════════════════════════════════════════
// § gate — the Director gate on EVERY writer, DERIVED not rostered
// ═══════════════════════════════════════════════════════════════════════════

const WRITER_DIRS = ["lib/video", "lib/agents", "lib/contact-promotion", "lib/intelligence", "lib/listing-presentation", "lib/platform", "lib/kernel", "lib/ai-isa", "app/actions/video", "app/actions", "app/api/internal/remotion"]
/** Every shape a model call takes in this tree — the routed lane (the rule),
 *  plus the two legacy shapes the wave-76D roster's writers still use
 *  (generateAIResponse in the studio wizard, bare generateText in the studio
 *  rewrite — frozen ai-spend-booked debt, still spoken). */
const MODEL_CALL = /generateTextRouted\(|generateObjectRouted\(|generateAIResponse\(|[^a-zA-Z.]generateText\(|[^a-zA-Z.]generateObject\(/
/** A file whose model output can be SPOKEN: it feeds narration, a D-ID
 *  submission, a script column, or a caption track. */
const SPOKEN_SINK = /prepareReelVoiceover\(|dispatchVideo\(|script_content|captionScript|narrationScript|voiceoverUrl|fitNarrationToBudget\(/
const HAS_STANDARDS = /withSpokenScriptStandards\(|SCRIPT_QUALITY_CHARTER,/
const HAS_TELL_SCAN = /scanForAiTells\(/
/** Files with a model call AND a sink token that are NOT spoken writers —
 *  each named with its reason (published exclusions, §2). */
const GATE_EXCLUSIONS: Record<string, string> = {
  "lib/kernel/ai-copy.ts": "generic copy engine; its ONLY spoken caller is the Director hook line, scanned at video-director.ts's own gate (asserted below)",
  "lib/kernel/marketing.ts": "the model call is createBlogPost (written, not spoken); the script_content it stores in createVideoProject is the agent's OWN typed text (input.scriptContent) — no model writes a spoken line here",
  "app/actions/video-repurposing.ts": "its two model calls write snippet timestamps/titles and SOCIAL CAPTION variations (written, not spoken); the script_content it touches is READ as the source clip's script, never written",
}

function walk(dir: string, out: string[]) {
  let entries: string[] = []
  try { entries = readdirSync(join(root, dir)) } catch { return }
  for (const e of entries) {
    const rel = `${dir}/${e}`
    const st = statSync(join(root, rel))
    if (st.isDirectory()) walk(rel, out)
    else if (/\.ts$/.test(e) && !/\.d\.ts$/.test(e)) out.push(rel)
  }
}

function gateSection() {
  console.log("\n── §gate — withSpokenScriptStandards + scanForAiTells on every DERIVED spoken writer ──")
  const files: string[] = []
  for (const d of WRITER_DIRS) walk(d, files)
  const writers = files.filter((f) => { const s = readCode(f); return MODEL_CALL.test(s) && SPOKEN_SINK.test(s) })
  console.log(`  scanned ${files.length} files under ${WRITER_DIRS.length} dirs; ${writers.length} call a routed model AND feed a spoken sink`)
  let gated = 0
  for (const f of writers) {
    if (GATE_EXCLUSIONS[f]) { skipNote(`[gate] ${f}`, GATE_EXCLUSIONS[f]); continue }
    const s = readCode(f)
    const ok = HAS_STANDARDS.test(s) && HAS_TELL_SCAN.test(s)
    if (ok) gated++
    check(`[gate] ${f}: withSpokenScriptStandards/CHARTER in the prompt AND scanForAiTells on the output`, ok)
  }
  check(`[gate] the derived roster is not empty (${gated} gated writers) — a scan that finds nothing is blind, not clean`, gated >= 8)
  const director = readCode("lib/video/video-director.ts")
  check("[gate] the Director hook line folds scanForAiTells into its one-redraft gate",
    /scanForAiTells\(s\)/.test(director) && /tells\.length === 0/.test(director))
  const aiCopy = readCode("lib/kernel/ai-copy.ts")
  check("[gate] ai-copy (the hook engine) carries the charter + directive as an array (its documented shape)",
    /SCRIPT_QUALITY_CHARTER,/.test(aiCopy) && /SPOKEN_REALISM_DIRECTIVE/.test(aiCopy))
  // POSITIVE CONTROLS
  const specimen = "const { text } = await generateTextRouted({ prompt, feature: \"x\" })\nconst fit = fitNarrationToBudget(text, budget)"
  check("CONTROL: a writer with a model call + a spoken sink and NO standards is caught by the finders",
    MODEL_CALL.test(specimen) && SPOKEN_SINK.test(specimen) && !HAS_STANDARDS.test(specimen) && !HAS_TELL_SCAN.test(specimen))
  const thumbHook = "const result = await generateTextRouted({ prompt })\nreturn hook // title overlay on a thumbnail"
  check("CONTROL: a model call with NO spoken sink (a thumbnail hook) is NOT rostered — the sink predicate is what separates spoken from written",
    MODEL_CALL.test(thumbHook) && !SPOKEN_SINK.test(thumbHook))
  check("CONTROL: a tombstone mentioning the sink in a COMMENT does not roster a file (stripped + blanked scan)",
    !SPOKEN_SINK.test(blankStrings(stripComments("// tombstone: prepareReelVoiceover( moved\nconst x = \"captionScript\""))))
}

// ═══════════════════════════════════════════════════════════════════════════
// § tts — every video lane on the one primitive
// ═══════════════════════════════════════════════════════════════════════════

const VIDEO_LANES_NARRATING = [
  "app/api/internal/remotion/render-just-listed/route.ts",
  "app/api/internal/remotion/render-newsletter-video/route.ts",
  "lib/listing-presentation/section-narration-orchestrator.ts",
  "lib/intelligence/partners-meeting.ts",
  "lib/kernel/board-packet-reel.ts",
  "lib/video/listing-pitch-reel.ts",
  "lib/kernel/deal-room-reel.ts",
]
function ttsSection() {
  console.log("\n── §tts — every video narration lane on prepareReelVoiceover (v3, cached, aligned) ──")
  const bare = /\bsynthesizeSpeech(?:WithTimestamps)?\s*\(/
  for (const f of VIDEO_LANES_NARRATING) {
    const s = readCode(f)
    check(`${f}: narrates through prepareReelVoiceover`, /prepareReelVoiceover\(/.test(s))
    check(`${f}: no bare synthesizeSpeech / synthesizeSpeechWithTimestamps (no second TTS path, no monolingual_v1 default)`, !bare.test(s))
  }
  const orch = readCode("lib/listing-presentation/section-narration-orchestrator.ts")
  check("section-narration-orchestrator stages captionsCues from the alignment the primitive returns (word-synced captions on the section reel)",
    /captionsCues: cues/.test(orch) && /buildCaptionPlan\(voiceover\.alignment/.test(orch))
  // The dispatcher's D-ID leg resolves its TTS model through the one selector.
  // (readStripped, not readCode: the lane NAME is a string literal.)
  const dispatch = readStripped("lib/providers/dispatch.ts")
  check("dispatchVideoViaDID resolves its ElevenLabs model through elevenLabsModelForLane(\"avatar_narration\")", /elevenLabsModelForLane\("avatar_narration"/.test(dispatch))
  // The two ffmpeg mixers load ffmpeg-static through createRequire, never a bare require.
  for (const f of ["lib/remotion/music-mixer.ts", "lib/remotion/voiceover-mixer.ts"]) {
    const s = readStripped(f)
    check(`${f}: ffmpeg-static is loaded via createRequire(import.meta.url) (no bare require under ESM)`, /createRequire\(import\.meta\.url\)\("ffmpeg-static"\)/.test(s) && !/[^.a-zA-Z]require\("ffmpeg-static"\)/.test(s))
  }
  check("CONTROL: the bare-synthesis finder recognises the retired call", bare.test('const tts = await synthesizeSpeech({ text: script, voiceId })'))
  check("CONTROL: the bare-require finder recognises the retired shape", /[^.a-zA-Z]require\("ffmpeg-static"\)/.test('  const ffmpegStatic = require("ffmpeg-static")'))
}

// ═══════════════════════════════════════════════════════════════════════════
// § surfaces + memory — the two owner types that are not compositions
// ═══════════════════════════════════════════════════════════════════════════

function surfacesSection() {
  console.log("\n── §surfaces — geo reel: a finished, compliant, broker-approved reel becomes a public page; nothing else does ──")
  const cron = readStripped("app/api/cron/geo-reel-autopublish/route.ts")
  check("geo-reel-autopublish filters is_published=false AND compliance_status='passed' AND approval_status='approved'",
    /\.eq\("is_published", false\)/.test(cron) && /\.eq\("compliance_status", "passed"\)/.test(cron) && /\.eq\("approval_status", "approved"\)/.test(cron))
  check(`geo-reel-autopublish reads VIDEO_FINISHED_STATUSES (${VIDEO_FINISHED_STATUSES.join("/")}) rather than a literal status list`,
    /VIDEO_FINISHED_STATUSES/.test(cron))
  check("the cron is registered in lib/kernel/cron-dispatch.ts (reachability proven, §1)", /geo-reel-autopublish/.test(readStripped("lib/kernel/cron-dispatch.ts")))
  const landing = readCode("lib/geo/publish-video-landing.ts")
  check("publishVideoProjectLanding re-checks isAutoPublishEligible per row (the gate is enforced twice, never trusted from the sweep)", /isAutoPublishEligible/.test(landing))

  console.log("\n── §memory — the memory video is seller-authored, held otherwise, and (lane 78D) has a composition sized by its narration ──")
  const hold = readStripped("lib/video/video-render-hold.ts")
  check("video-render-hold holds a memory_video whose script is not provably seller-authored (red flag, fail closed)",
    /isSellerAuthored\(row\.video_metadata\)/.test(hold) && /hold: true, state: "red_flag"/.test(hold))
  const gate = readCode("lib/video/memory-video-gate.ts")
  check("memory-video-gate publishes MODEL_MAY / MODEL_MAY_NOT (the authorship boundary is in the code)", /export const MODEL_MAY\b/.test(gate) && /export const MODEL_MAY_NOT\b/.test(gate))
  check("memory-video.ts calls NO routed model (the family's history is never generated)", !MODEL_CALL.test(readCode("lib/video/memory-video.ts")))
  const render = readCode("lib/video/memory-video-render.ts")
  check("memory-video-render.ts calls NO routed model either — TTS reads the seller's words VERBATIM, the gate's permitted arm", !MODEL_CALL.test(render))
  check("CONTROL: the model-call finder still fires on the reactor that does draft through the gateway", MODEL_CALL.test(readCode("lib/video/intro-video-reactor.ts")))
  const stagers = Object.keys(VIDEO_COMPOSITION_FILES).filter((id) => readStripped("lib/video/memory-video-render.ts").includes(id) || /MEMORY_VIDEO_COMPOSITION_ID/.test(render) && id === MEMORY_VIDEO_COMPOSITION_ID)
  check(`memory video stages exactly ONE composition (${stagers.join(",") || "none"}) — ${MEMORY_VIDEO_COMPOSITION_ID}, on the voiceover host`,
    stagers.length === 1 && stagers[0] === MEMORY_VIDEO_COMPOSITION_ID)
  check(`...whose window (${MEMORY_VIDEO_MAX_SECONDS}s cap, real length from the narration) is a VOICEOVER body, not an avatar body window, and the purpose cap agrees with the composition's own constant (one number, two readers)`,
    COMPOSITION_DURATION_RULES[MEMORY_VIDEO_COMPOSITION_ID]?.host === "voiceover" && COMPOSITION_DURATION_RULES[MEMORY_VIDEO_COMPOSITION_ID]?.purpose === "memory"
    && PURPOSE_DURATION_RULES.memory.maxSeconds === MEMORY_VIDEO_MAX_SECONDS && narrationWindowSeconds(MEMORY_VIDEO_COMPOSITION_ID) === MEMORY_VIDEO_MAX_SECONDS)
  check("the stager passes the render-hold gate (evaluateVideoRenderHold with the projectId) before anything is queued",
    /evaluateVideoRenderHold\(\{[\s\S]{0,300}projectId: project\.id/.test(readStripped("lib/video/memory-video-render.ts")) && /if \(hold\.hold\) return/.test(readStripped("lib/video/memory-video-render.ts")))
  check("the stager reads the chapters OFF THE CAPTURE ROW (video_metadata.dictation, last segment per prompt) and refuses when chapters are still unrecorded",
    /latestWordsByChapter\(meta\.dictation/.test(readStripped("lib/video/memory-video-render.ts")) && /chapters still unrecorded/.test(readStripped("lib/video/memory-video-render.ts")))
  check("every clip's frames come from the measured narration (prepareReelVoiceover durationSeconds → chapterDurationFrames), estimated at the fleet pace only when synthesis returned no length",
    /chapterDurationFrames\(seconds, geo\.fps\)/.test(readStripped("lib/video/memory-video-render.ts")) && /vo\?\.durationSeconds \?\? estimatedChapterSeconds\(words\)/.test(readStripped("lib/video/memory-video-render.ts")))
  check("a chapter longer than the synthesis cap is split on SENTENCE boundaries into its own clips (nothing past the cap is dropped)",
    /splitForSynthesis\(ch\.words, MAX_SCRIPT_CHARS\)/.test(readStripped("lib/video/memory-video-render.ts")))
  const split = splitForSynthesis("One. Two three four. Five six seven eight nine. Ten.", 20)
  check("CONTROL: splitForSynthesis keeps every character and never cuts inside a sentence", split.join(" ") === "One. Two three four. Five six seven eight nine. Ten." && split.every((p) => p.length <= 20 || !p.includes(". ")))
  check("purpose is the named constant, not a free string", MEMORY_VIDEO_PURPOSE === "memory" && /MEMORY_VIDEO_PURPOSE/.test(render))
  check("the finish spec is a keepsake's: voiceover host, no avatar, no bookends, no QR, captions off (the words are on screen verbatim)",
    (() => { const f = finishForVideo(MEMORY_VIDEO_COMPOSITION_ID); return f.presenter === "none" && !f.bookends && !f.qr && !f.captions && f.music })())
  check("the action + card mount the render (renderMemoryVideoAction ← memory-video-card)",
    /export async function renderMemoryVideoAction/.test(readStripped("app/actions/video/memory-video.ts")) && /renderMemoryVideoAction\(/.test(readStripped("app/crm/contacts/[contactId]/components/memory-video-card.tsx")))
}

// ═══════════════════════════════════════════════════════════════════════════
// § hybrid — D-ID bookends + Remotion middle
// ═══════════════════════════════════════════════════════════════════════════

function hybridSection() {
  console.log("\n── §hybrid — listing promo hybrid composite ──")
  const route = readCode("app/api/cron/listing-promo-hybrid-composite/route.ts")
  const concat = readCode("lib/video/composite-attribution.ts")
  check("the hybrid route stitches through the ONE concat helper (concatIntroOutro), never its own ffmpeg", /concatIntroOutro\(/.test(route) && !/spawn\(/.test(route))
  check(`concatIntroOutro trims EACH D-ID bookend to MAX_BRAND_BOOKEND_SECONDS (${MAX_BRAND_BOOKEND_SECONDS}s) before the concat`,
    /trim=duration=\$\{MAX_BRAND_BOOKEND_SECONDS\}/.test(readStripped("lib/video/composite-attribution.ts")) && /MAX_BRAND_BOOKEND_SECONDS/.test(concat))
  check("the hybrid route's middle is the rendered JustListedReel (voiceover baked in-frame) and brand comes through resolveReelBrand",
    /resolveReelBrand\(/.test(route))
  // WAVE 78 — the middle is COMPUTED from the promo narration (listing_promo
  // purpose), so the complete length is derived from a planned render, never
  // pinned to a remembered 30 (§2: assert the rule, derive the number).
  const g = geometryFor("JustListedReel")!
  const planned = planCompositionDuration({ compositionId: "JustListedReel", wordCount: purposeBudgetFor("JustListedReel").idealWords })
  const middle = planned.durationInFrames / g.fps
  const complete = middle + 2 * MAX_BRAND_BOOKEND_SECONDS
  const rule = PURPOSE_DURATION_RULES.listing_promo
  check(`hybrid complete video = ${middle}s planned middle (ideal listing_promo script, body ${planned.bodySeconds}s ∈ [${rule.minSeconds}, ${rule.maxSeconds}]) + 2×${MAX_BRAND_BOOKEND_SECONDS}s bookends = ${complete}s, under the ${compositionSeconds(g)}s cap + bookends`,
    planned.bodySeconds >= rule.minSeconds && planned.bodySeconds <= rule.maxSeconds && complete < compositionSeconds(g) + 2 * MAX_BRAND_BOOKEND_SECONDS && complete > 2 * MAX_BRAND_BOOKEND_SECONDS)
}

// ═══════════════════════════════════════════════════════════════════════════
// § advancements — the Remotion-only components this wave added
// ═══════════════════════════════════════════════════════════════════════════

function advancementsSection() {
  console.log("\n── §advancements — LowerThird survivor, SceneFade dissolves, kinetic captions ──")
  const files = readdirSync(join(root, "remotion")).filter((f) => f.endsWith(".tsx")).map((f) => `remotion/${f}`)
  const privateLowerThirds = files.filter((f) => /const LowerThird\b/.test(readStripped(f)))
  check("exactly ONE LowerThird definition, in remotion/components (no composition keeps a private copy)",
    privateLowerThirds.length === 0 && /export const LowerThird/.test(readStripped("remotion/components/LowerThird.tsx")), privateLowerThirds.join(", "))
  const mounts = files.filter((f) => /<LowerThird\b/.test(readStripped(f)))
  check(`the lower-third is mounted by the avatar-led personal reels (${mounts.map((f) => f.replace("remotion/", "")).join(", ")})`,
    mounts.includes("remotion/AgentTalkingHeadReel.tsx") && mounts.includes("remotion/TeammateExplainerReel.tsx"))
  const th = readStripped("remotion/AgentTalkingHeadReel.tsx")
  check("AgentTalkingHeadReel wraps COVER, BODY and OUTRO in <SceneFade> — a dissolve at every cut with the timeline untouched",
    (th.match(/<SceneFade>/g) ?? []).length === 3 && (th.match(/<\/SceneFade>/g) ?? []).length === 3)
  const fade = readStripped("remotion/components/SceneFade.tsx")
  check("SceneFade anchors its tail fade on useVideoConfig().durationInFrames (the enclosing Sequence's own length) and clamps both sides",
    /useVideoConfig\(\)/.test(fade) && (fade.match(/extrapolateLeft: "clamp", extrapolateRight: "clamp"/g) ?? []).length >= 2)
  const layer = readStripped("remotion/components/CaptionLayer.tsx")
  check("CaptionLayer highlights the active word (activeWordIndex) in the brand accent and falls back to the plain phrase when a cue has no word track",
    /activeWordIndex\(cue, frame\)/.test(layer) && /i === activeWord \? accent : "#FFFFFF"/.test(layer) && /: cue\.text\}/.test(layer))
  // Runtime: activeWordIndex + evenWordFrames behave.
  const words = evenWordFrames(["three", "days", "on", "market"], 100, 40)
  check("evenWordFrames: first word starts AT the cue frame, later words stay inside the cue, non-decreasing",
    words[0].fromFrame === 100 && words.every((w) => w.fromFrame >= 100 && w.fromFrame < 140) && words.every((w, i) => i === 0 || w.fromFrame >= words[i - 1].fromFrame))
  const cue: CaptionCue = { text: "three days on market", fromFrame: 100, durationFrames: 40, words }
  check("activeWordIndex: before the cue → -1; at the cue start → word 0; at the last frame → the last word",
    activeWordIndex(cue, 99) === -1 && activeWordIndex(cue, 100) === 0 && activeWordIndex(cue, 139) === words.length - 1)
  check("activeWordIndex: a cue with no word track → -1 (plain phrase renders)", activeWordIndex({ text: "x", fromFrame: 0, durationFrames: 10 }, 5) === -1)
  // CONTROL: a tampered word track is caught by wordTrackHolds.
  const tampered: CaptionCue = { ...cue, words: [{ text: "three", fromFrame: 100 }, { text: "days", fromFrame: 200 }] }
  check("CONTROL: a word outside its cue window IS caught by the word-track invariant", !wordTrackHolds([tampered]).ok)
  check("CONTROL: a word track that does not join to the cue text IS caught", !wordTrackHolds([{ ...cue, words: [{ text: "three", fromFrame: 100 }] }]).ok)
}

// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("══════════════════════════════════════════════════════════════")
  console.log(" Video type matrix — every automated video type, executed through the real survivors")
  console.log("══════════════════════════════════════════════════════════════")

  // Completeness — the owner's fifteen types all have a row; every video
  // composition a producer stages appears in some row.
  console.log("\n── §matrix — completeness ──")
  const keys = new Set(MATRIX.map((t) => t.ownerKey).filter(Boolean))
  const missing = OWNER_TYPES.filter((k) => !keys.has(k))
  check(`every one of the owner's ${OWNER_TYPES.length} video types has a matrix row`, missing.length === 0, missing.join(", "))
  const covered = new Set(MATRIX.flatMap((t) => t.compositions))
  const videoIds = Object.entries(COMPOSITION_GEOMETRY).filter(([, g]) => g.duration_frames > 1).map(([id]) => id)
  const SLIDE_COMPONENTS = new Set(["ListingPresentationSlide", "BuyerConsultationSlide"])
  const uncovered = videoIds.filter((id) => !covered.has(id) && !SLIDE_COMPONENTS.has(id))
  check(`every registered video composition (${videoIds.length}, minus the 2 slide components reused inside ListingSectionReel — published exclusion) is produced by some matrix row`, uncovered.length === 0, uncovered.join(", "))
  for (const id of covered) check(`${id} is registered in COMPOSITION_GEOMETRY and has a source file`, !!geometryFor(id) && !!VIDEO_COMPOSITION_FILES[id])
  for (const t of MATRIX) for (const f of t.producers) {
    let exists = false
    try { statSync(join(root, f)); exists = true } catch { /* missing */ }
    check(`producer ${f} exists (row: ${t.type})`, exists)
  }
  // A composition with captions:true in the finish spec but no caption support
  // in source, or vice versa, is a spec/source disagreement (published counts).
  const specSaysCaptions = videoIds.filter((id) => VIDEO_FINISH_SPEC[id]?.captions)
  check(`finish-spec declares captions on ${specSaysCaptions.length} video compositions and each mounts <CaptionLayer>`,
    specSaysCaptions.every((id) => /<CaptionLayer[\s>]/.test(readStripped(VIDEO_COMPOSITION_FILES[id]))))

  // Per type, per composition.
  const done = new Map<string, Host>()
  for (const t of MATRIX) {
    console.log(`\n── ${t.type} · host=${t.host} · brand=${t.brand}${t.note ? `\n   ⊘ ${t.note}` : ""} ──`)
    checkBranding(t)
    for (const id of t.compositions) {
      const seen = done.get(id)
      if (seen && seen === t.host) { console.log(`  (${id} already executed above as a ${seen} host)`); continue }
      const r = resolveComposition(id)
      check(`${id} resolves (geometry + source + scope)`, !!r)
      if (!r) continue
      const complete = checkSum(r)
      checkWindow(r, t.host === "hybrid" ? "voiceover" : t.host)
      checkBroll(r)
      checkMusic(r, complete)
      checkCaptions(r, t.host === "hybrid" ? "voiceover" : t.host)
      checkAvatar(r, t.host === "hybrid" ? "voiceover" : t.host)
      checkSlots(r)
      checkBudget(r)
      done.set(id, t.host)
    }
  }

  // POSITIVE CONTROLS on the sum/window checkers (the same functions the rows ran).
  console.log("\n── §controls ──")
  const gap: Segment[] = [
    { tag: "Sequence", from: 0, duration: 60, fromExpr: "0", durExpr: "COVER" },
    { tag: "Sequence", from: 70, duration: 200, fromExpr: "COVER + 10", durExpr: "BODY" },
    { tag: "Sequence", from: 270, duration: 90, fromExpr: "COVER + 10 + BODY", durExpr: "OUTRO" },
  ]
  check("CONTROL: a planted 10-frame gap is caught by tileSegments", !tileSegments(gap, 360).ok)
  const fakeWindow = narrationWindow("<CaptionLayer cues={c} visibleFromFrame={COVER} hiddenFromFrame={COVER + BODY} />", { COVER: 60, BODY: 300 }, 420)
  check("CONTROL: narrationWindow resolves visibleFromFrame/hiddenFromFrame through the scope ([60, 360))", fakeWindow.from === 60 && fakeWindow.to === 360 && fakeWindow.declared)
  const overBudget = narrationBudget("AgentTalkingHeadReel", compositionSeconds(geometryFor("AgentTalkingHeadReel")!))
  check(`CONTROL: the PRE-FIX whole-runtime budget for AgentTalkingHeadReel (${overBudget.budgetSeconds}s of the ${compositionSeconds(geometryFor("AgentTalkingHeadReel")!)}s cap) DOES exceed the purpose budget (${purposeBudgetFor("AgentTalkingHeadReel").budgetSeconds}s) — sizing to the whole runtime is the defect §avatar exists to catch`,
    overBudget.budgetSeconds > purposeBudgetFor("AgentTalkingHeadReel").budgetSeconds)
  check("CONTROL: avatarDurationOverrunSeconds reports a clip 5s past budget", avatarDurationOverrunSeconds(overBudget.budgetSeconds + 5, overBudget.budgetSeconds) > 0)
  check("CONTROL: paddingSecondsFor pads a 10s overrun on a voiceover host", paddingSecondsFor(35, 25) === 10)
  const badFade = /afade=t=out:st=([0-9.]+):d=([0-9.]+)/.exec(buildMusicTrackFilter({ loop: true, volume: 0.12, videoSeconds: 2 }))
  check("CONTROL: a 2s video (shorter than both fades) gets NO fade-out rather than a negative start", badFade === null)
  const draft = fixtureScript(200)
  const shortBudget = narrationWindowBudget("AgentTalkingHeadReel")
  const fromDraft = buildCaptionPlan(draft, 300, 30).cues.flatMap((c) => spokenWords(c.text))
  check("CONTROL: captioning the OVERRUN DRAFT carries more words than the window budget allows — the word-match check would catch a producer captioning the draft",
    fromDraft.length > shortBudget.maxWords)
  const evenSlots = brollSlots([{ url: "a.mp4" }, { url: "b.mp4" }] as BrollClip[], 300, 30, 10)
  check("CONTROL: unmeasured clips fall back to the even division (published fallback, counted by test:broll-slot)", evenSlots.length === 2 && evenSlots[0].durationFrames === 150)

  gateSection()
  ttsSection()
  surfacesSection()
  hybridSection()
  advancementsSection()

  console.log("\n────────────────────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(" ✅ Every automated video type's intro+body+outro, b-roll windows, music duck/fade,")
  console.log("    tenant branding, fitted-word captions (with kinetic word tracks), avatar window")
  console.log("    budget, image slots and narration budget hold; the Director gate is on every derived")
  console.log("    writer and every video lane narrates through the one cached v3 primitive.")
}
main().catch((e) => { console.error(e); process.exit(1) })
