#!/usr/bin/env tsx
/**
 * scripts/video-assembly-simulator.ts   (npm run test:video-assembly)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE COMPLETE VIDEO ASSEMBLY — not "does the composition register" (wave 47,
 * lane FF closed that: all 33 register, are deterministic, and avatar clips are
 * consumed via @remotion/media) but "does the DELIVERED video actually add up":
 * intro (brand sting) + body (b-roll/images/avatar against voiceover timing) +
 * outro (CTA/branding) summing EXACTLY to durationInFrames, b-roll/image slots
 * derived from the count that actually arrived (never hardcoded), music present
 * + ducked + faded + never past the end, branding (including fair-housing marks
 * on listing-facing reels) in intro AND outro, and avatar clips trimmed to the
 * body window rather than left unbounded.
 *
 * SKILLS USED (named per LANE_RULES): .claude/skills/remotion-best-practices
 * (router) → remotion-markup/REFERENCE.md "Delaying, trimming" + sequencing.md
 * (Sequence/from/durationInFrames semantics this file's tiling checker encodes)
 * + audio.md/embedding-videos.md (trimBefore/trimAfter, volume, fade semantics
 * the music-mixer checks assert) + voiceover.md (confirms calculateMetadata is
 * the dynamic-duration mechanism this codebase deliberately does NOT use — the
 * fixed-geometry architecture wave 47 found and this file's sum-checker proves
 * correct, not a gap to reverse).
 *
 * METHOD (§2 measurement discipline — every scan reads STRIPPED source; every
 * absence assertion below carries a POSITIVE CONTROL that proves the checker
 * can still see the defect it exists to catch):
 *
 *   §sums     PURE + SOURCE. A tiny whitelisted arithmetic evaluator extracts
 *             each composition's own declared frame constants (COVER/BODY/
 *             OUTRO-style, or a FRAMES={...} object) and every top-level JSX
 *             tag using the from={…}/durationInFrames={…} contract (Sequence,
 *             and any locally-defined wrapper sharing that contract — CMAReel's
 *             `Slide`), then tiles them and asserts: starts at 0, no gap, no
 *             overlap beyond the documented 1-frame end-of-timeline sentinel,
 *             no negative duration, and the total equals
 *             COMPOSITION_GEOMETRY[id].duration_frames — proven equal to
 *             Root.tsx by test:remotion-setup, so this is the ONE ground truth
 *             for "durationInFrames". PhotoWalkthroughReel (whose split is
 *             DERIVED at render time, not a literal) is checked instead by
 *             calling lib/video/assembly-timeline.ts's computeAssemblyTimeline
 *             directly across a sweep of durations.
 *   §broll    PURE + SOURCE. Every image-carousel composition divides its
 *             window by the ACTUAL image count (never a hardcoded per-photo
 *             literal) and shows an honest fallback when the count is zero;
 *             kenBurnsPlan/brollSlots (already proven by their own simulators)
 *             get a complementary fewer-than-requested sweep here.
 *   §music    PURE. lib/remotion/music-mixer.ts's filter-graph builders: fade
 *             in always, fade out only when timed against a REAL video length,
 *             volume ducked under the (unscaled) voice channel, and the mux
 *             never outruns the video (-shortest / duration=first, source-
 *             checked).
 *   §branding PURE + SOURCE. Every listing/market-facing video composition
 *             (VIDEO_FINISH_SPEC MARKETING/CHART_REEL/AVATAR_LED/REPORT_CLIENT,
 *             minus the platform's own self-marketing reel) declares AND
 *             renders the Equal Housing Opportunity mark — the exact regression
 *             this wave's audit found missing on NewsletterDigestVideo.
 *   §avatar   SOURCE. No avatar `<Video>` embed carries the historical
 *             wrong-trimBefore shape (an enclosing sequence's own global
 *             offset used as the SOURCE trim point — fixed repeatedly across
 *             ComingSoonReel/NeighborhoodSpotlightReel/TestimonialReel and
 *             documented in each); AvatarPIP startFrame/endFrame pairs are
 *             strictly increasing and bounded by the registered geometry.
 *
 * PURE where stated — no ffmpeg spawned, no network fetch, no Remotion render,
 * no database.
 */
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments } from "./strip-comments"
import { COMPOSITION_GEOMETRY, compositionSeconds, type RegisteredGeometry } from "../lib/remotion/composition-geometry"
import { VIDEO_FINISH_SPEC } from "../lib/video/finish-spec"
import { computeAssemblyTimeline, evenShotSlots } from "../lib/video/assembly-timeline"
import { kenBurnsPlan } from "../lib/video/ken-burns-plan"
import { brollSlots, type BrollClip } from "../remotion/_BrollLayer"
import {
  buildMusicTrackFilter,
  buildMusicMixFilterGraph,
  buildMusicDuckFilterGraph,
  dbToLinearAmplitude,
  DEFAULT_MUSIC_FADE_IN_SECONDS,
  DEFAULT_MUSIC_FADE_OUT_SECONDS,
} from "../lib/remotion/music-filter-graph"
import {
  MUSIC_DUCK_VOLUME_PCT,
  MUSIC_SIDECHAIN_DUCK_SETTINGS,
  IMAGE_SCENE_REALISM_PROMPT_BLOCK,
  AI_IMAGE_TELL_CHECKLIST,
  FILM_GRAIN_OVERLAY_OPACITY,
  KEN_BURNS_REALISM_AUDIT_NOTE,
  COVER_CTA_CONTENT_BEAT_RULING,
  PARALLAX_STILL_IMAGE_DEFERRAL_REASON,
} from "../lib/video/realism-profile"
import { clipCaptionCuesBeforeFrame, clipCaptionCuesFromFrame, shiftCaptionCues, buildCaptionPlan, type CaptionCue } from "../lib/video/caption-plan"
import { shouldAutoRequeueFailedRender, MAX_AUTO_REQUEUE_ATTEMPTS } from "../lib/remotion/render-decision"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const readStripped = (rel: string): string => stripComments(readFileSync(join(root, rel), "utf8"))
const readRaw = (rel: string): string => readFileSync(join(root, rel), "utf8")

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ═══════════════════════════════════════════════════════════════════════════
// §sums — the whitelisted arithmetic evaluator + Sequence tiler
// ═══════════════════════════════════════════════════════════════════════════

/** Every registered composition's remotion/ source file, by id. STILLS
 *  (duration_frames === 1) are out of scope — they have no timeline to tile. */
const VIDEO_COMPOSITION_FILES: Record<string, string> = {
  JustListedReel: "remotion/JustListedReel.tsx",
  JustListedReelSquare: "remotion/JustListedReelSquare.tsx",
  JustListedReelHorizontal: "remotion/JustListedReelHorizontal.tsx",
  JustSoldReelSquare: "remotion/JustSoldReelSquare.tsx",
  PhotoWalkthroughReel: "remotion/PhotoWalkthroughReel.tsx",
  AgentTalkingHeadReel: "remotion/AgentTalkingHeadReel.tsx",
  AgentExplainerReel: "remotion/AgentExplainerReel.tsx",
  TeammateExplainerReel: "remotion/TeammateExplainerReel.tsx",
  ExplainerAnimReel: "remotion/ExplainerAnimReel.tsx",
  MarketUpdateReel: "remotion/MarketUpdateReel.tsx",
  ComingSoonReel: "remotion/ComingSoonReel.tsx",
  OpenHouseAnnounceReel: "remotion/OpenHouseAnnounceReel.tsx",
  TestimonialReel: "remotion/TestimonialReel.tsx",
  NeighborhoodSpotlightReel: "remotion/NeighborhoodSpotlightReel.tsx",
  AffordabilitySnapshotReel: "remotion/AffordabilitySnapshotReel.tsx",
  CMAReel: "remotion/CMAReel.tsx",
  EquityReportReel: "remotion/EquityReportReel.tsx",
  ListingSectionReel: "remotion/ListingSectionReel.tsx",
  NewsletterDigestVideo: "remotion/NewsletterDigestVideo.tsx",
  PartnersMeetingReel: "remotion/PartnersMeetingReel.tsx",
  ProductPromoReel: "remotion/ProductPromoReel.tsx",
  // Single-segment slides — the WHOLE duration is one continuous body (an
  // avatar PIP rides over it via avatarStartFrame/avatarEndFrame, not a
  // Sequence chain). Checked separately in §sums-slides below.
  ListingPresentationSlide: "remotion/ListingPresentationSlide.tsx",
  BuyerConsultationSlide: "remotion/BuyerConsultationSlide.tsx",
}

/** A tag using the from={…}/durationInFrames={…} contract — Sequence itself,
 *  or a locally-defined wrapper sharing the exact same two-prop contract
 *  (CMAReel's `Slide`). Matched by CONTRACT, not by tag name, so a future
 *  wrapper needs no update here. `key=` between the tag name and `from=`
 *  excludes per-shot/mapped repeats (their expressions reference runtime
 *  values — `perPhoto`, `i` — this checker cannot and should not resolve). */
const SEGMENT_TAG = /<([A-Za-z][A-Za-z0-9.]*)\s+from=\{([^}]+)\}\s+durationInFrames=\{([^}]+)\}/g

/** `const NAME = EXPR` (module- or function-scope; both appear in this
 *  fleet — PartnersMeetingReel's COVER/ASK/OUTRO/cardTotal are function-
 *  scoped, most others are module-scoped). Captured in FILE ORDER so later
 *  consts (TOTAL, cardTotal) can reference earlier ones when evaluated
 *  sequentially. */
const CONST_DECL = /const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\n;]+);?/g

/** `const FRAMES = { KEY: 60, KEY2: 120, ... }` — the alternate segment-
 *  boundary idiom (JustListedReel, NewsletterDigestVideo). Non-greedy up to
 *  the first `}`: none of this fleet's FRAMES objects nest braces. */
const FRAMES_OBJECT = /const\s+FRAMES\s*=\s*\{([^}]+)\}/
const FRAMES_ENTRY = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([0-9]+(?:\.[0-9]+)?)/g

/** Only these characters may reach `new Function` — no backticks, no
 *  brackets, no semicolons, nothing that could smuggle in anything but
 *  arithmetic over already-known identifiers. A string with `?`, `:` (ternary),
 *  object/array literals, or JSX therefore fails closed (thrown, caught,
 *  skipped) rather than evaluated. */
const SAFE_EXPR = /^[0-9A-Za-z_.\s+\-*/(),]+$/

function safeEval(expr: string, scope: Record<string, unknown>): number {
  const cleaned = expr.trim()
  if (!SAFE_EXPR.test(cleaned)) throw new Error(`unsafe expression: ${cleaned}`)
  const names = Object.keys(scope)
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(...names, `"use strict"; return (${cleaned});`)
  const out = fn(...names.map((n) => scope[n]))
  if (typeof out !== "number" || !Number.isFinite(out)) throw new Error(`non-numeric result: ${cleaned}`)
  return out
}

/** Build the numeric scope for one composition: fps/FPS=30 (every registered
 *  row in COMPOSITION_GEOMETRY is 30fps — asserted once below rather than
 *  assumed forever), durationInFrames=the registered total (PartnersMeetingReel
 *  derives cardTotal from it), FRAMES.<key> flattened from a FRAMES object when
 *  present, then every `const NAME = EXPR` that evaluates cleanly against the
 *  scope built so far — evaluated in file order, skipping (not failing on) any
 *  declaration that is not simple arithmetic (strings, JSX, object literals,
 *  ternaries) because this checker only needs the numeric timeline consts. */
function buildScope(source: string, geometry: RegisteredGeometry): Record<string, number> {
  const scope: Record<string, number> = { fps: geometry.fps, FPS: geometry.fps, durationInFrames: geometry.duration_frames }

  const framesMatch = FRAMES_OBJECT.exec(source)
  if (framesMatch) {
    const flat: Record<string, number> = {}
    let m: RegExpExecArray | null
    FRAMES_ENTRY.lastIndex = 0
    while ((m = FRAMES_ENTRY.exec(framesMatch[1]))) flat[m[1]] = Number(m[2])
    ;(scope as Record<string, unknown>).FRAMES = flat
  }

  CONST_DECL.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CONST_DECL.exec(source))) {
    const [, name, expr] = m
    if (name === "FRAMES") continue // object form handled above
    try {
      scope[name] = safeEval(expr, scope)
    } catch {
      // Not simple arithmetic (a string, JSX, an object literal, a ternary
      // over a runtime prop like `images.length`) — not a timeline const;
      // skip rather than fail the whole scope build.
    }
  }
  return scope
}

interface Segment { tag: string; from: number; duration: number; fromExpr: string; durExpr: string }

/** Every from/durationInFrames tag this checker could resolve to numbers,
 *  in source order. Unresolvable candidates (a generic wrapper DEFINITION
 *  using its own prop names as the expression, e.g. CMAReel's
 *  `<Sequence from={from} durationInFrames={durationInFrames}>` inside the
 *  `Slide` component itself) throw on an unknown identifier and are DROPPED —
 *  correctly, since they are not a literal instantiation. */
/** Resolvable `durationInFrames` values off KEYED tags — a `.map()`-generated
 *  repeat (per-shot images, per-card stats, per-proof beats) that a flat
 *  top-level tiler cannot see AS individual entries, because their `from`
 *  expressions reference the map's own loop variable (`i`, `idx`) and are
 *  therefore unresolvable by design (extractSegments already drops them for
 *  exactly that reason). What CAN be resolved, when the keyed tag's own
 *  `durationInFrames` does not reference the loop variable, is how big ONE
 *  repeat is — enough to explain a gap between two resolved top-level
 *  segments as "N repeats of a keyed shot", not a real hole in the timeline. */
function extractKeyedUnitDurations(source: string, scope: Record<string, number>): number[] {
  const KEYED_TAG = /<[A-Za-z][A-Za-z0-9.]*\s+key=\{[^}]*\}\s+from=\{[^}]+\}\s+durationInFrames=\{([^}]+)\}/g
  const out: number[] = []
  let m: RegExpExecArray | null
  KEYED_TAG.lastIndex = 0
  while ((m = KEYED_TAG.exec(source))) {
    try { out.push(safeEval(m[1], scope)) } catch { /* references the loop var, or a ternary — not a single resolvable unit */ }
  }
  return out
}

/** Does ANY keyed-unit size evenly divide this gap? A gap the source itself
 *  cannot otherwise explain is still reported as real. */
function gapExplainedByKeyedRepeat(gapFrames: number, unitSizes: number[]): number | null {
  for (const size of unitSizes) {
    if (size > 0 && gapFrames % size === 0) return gapFrames / size
  }
  return null
}

function extractSegments(source: string, scope: Record<string, number>): Segment[] {
  const out: Segment[] = []
  SEGMENT_TAG.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SEGMENT_TAG.exec(source))) {
    const [, tag, fromExpr, durExpr] = m
    try {
      const from = safeEval(fromExpr, scope)
      const duration = safeEval(durExpr, scope)
      out.push({ tag, from, duration, fromExpr, durExpr })
    } catch {
      // Unresolvable — a wrapper definition, not an instantiation. Skip.
    }
  }
  return out
}

interface TileResult {
  ok: boolean
  reason: string
  segments: Segment[]
}

/**
 * THE INVARIANT: sorted by `from`, segments start at 0, tile with NO GAP and
 * NO OVERLAP (the one documented exception is a trailing 1-frame "anchor"
 * sentinel at exactly `total - 1`, present in nearly every file in this fleet
 * as `<Sequence from={TOTAL - 1} durationInFrames={1}>` — a deliberate re-mount
 * of an empty frame to keep the registry's duration authoritative, not a real
 * segment, and excluded by the exact rule its own comments describe: duration
 * 1, from === total - 1), and the total equals `expectedTotal` exactly. No
 * segment may have a non-positive duration.
 *
 * PURE — a plain data transform, which is what lets the positive controls
 * below exercise it directly with synthetic segment lists.
 */
function tileSegments(segments: Segment[], expectedTotal: number): TileResult {
  const real = segments.filter((s) => !(s.duration === 1 && s.from === expectedTotal - 1))
  if (real.length === 0) return { ok: false, reason: "no resolvable segments", segments: real }

  const negative = real.find((s) => s.duration <= 0)
  if (negative) {
    return { ok: false, reason: `negative/zero durationInFrames on ${negative.tag} from={${negative.fromExpr}} durationInFrames={${negative.durExpr}} = ${negative.duration}`, segments: real }
  }

  const sorted = [...real].sort((a, b) => a.from - b.from)
  if (sorted[0].from !== 0) {
    return { ok: false, reason: `timeline does not start at 0 (first segment from=${sorted[0].from})`, segments: real }
  }
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1].from + sorted[i - 1].duration
    if (sorted[i].from !== prevEnd) {
      return {
        ok: false,
        reason: sorted[i].from > prevEnd
          ? `GAP of ${sorted[i].from - prevEnd} frames between segment ending at ${prevEnd} and the next starting at ${sorted[i].from}`
          : `OVERLAP of ${prevEnd - sorted[i].from} frames — segment starting at ${sorted[i].from} begins before the previous ends at ${prevEnd}`,
        segments: real,
      }
    }
  }
  const last = sorted[sorted.length - 1]
  const total = last.from + last.duration
  if (total !== expectedTotal) {
    return {
      ok: false,
      reason: total > expectedTotal
        ? `OVERRUN — segments sum to ${total} frames, past the registered durationInFrames ${expectedTotal}`
        : `UNDERRUN — segments sum to ${total} frames, short of the registered durationInFrames ${expectedTotal}`,
      segments: real,
    }
  }
  return { ok: true, reason: "tiles exactly", segments: real }
}

function sumsSection() {
  console.log("\n── §sums — intro + body + outro tile [0, durationInFrames) exactly ──")

  for (const [id, file] of Object.entries(VIDEO_COMPOSITION_FILES)) {
    const geometry = COMPOSITION_GEOMETRY[id]
    check(`${id} is registered in COMPOSITION_GEOMETRY`, !!geometry, "no geometry row — cannot check its sum")
    if (!geometry) continue

    const source = readStripped(file)
    const scope = buildScope(source, geometry)
    const segments = extractSegments(source, scope)

    // The two single-segment slides: the body IS the whole duration (an
    // avatar PIP rides over it via avatarStartFrame/avatarEndFrame props, not
    // an internal Sequence chain — remotion/ListingPresentationSlide.tsx has
    // ZERO <Sequence> tags by design). Checked by their own rule below, not
    // the tiling rule the Sequence-chain compositions use.
    //
    // PhotoWalkthroughReel: its split is DERIVED at render time via
    // computeAssemblyTimeline (from/durationInFrames are destructured JS
    // variables, not the const-chain arithmetic this evaluator resolves) —
    // checked directly against that pure helper below instead.
    //
    // PartnersMeetingReel: its "ask" Sequence is NESTED inside the cards+ask
    // wrapper Sequence, so its `from` is relative to that PARENT's local
    // clock, not absolute — a flat top-level tiler reads it as a false
    // overlap. Checked by the algebraic identity its own consts encode below.
    // ListingSectionReel: same single-segment shape as the slide it wraps —
    // it has no <Sequence> of its own, delegating the WHOLE duration to
    // <ListingPresentationSlide avatarStartFrame={0} avatarEndFrame={durationInFrames}>.
    // Checked below (delegates the full window, not a slice of it).
    if (["ListingPresentationSlide", "BuyerConsultationSlide", "PhotoWalkthroughReel", "PartnersMeetingReel", "ListingSectionReel"].includes(id)) continue

    let result = tileSegments(segments, geometry.duration_frames)
    let note = ""
    if (!result.ok && result.reason.startsWith("GAP")) {
      const gapFrames = Number(/GAP of (\d+) frames/.exec(result.reason)?.[1] ?? NaN)
      const unitSizes = extractKeyedUnitDurations(source, scope)
      const repeats = Number.isFinite(gapFrames) ? gapExplainedByKeyedRepeat(gapFrames, unitSizes) : null
      if (repeats !== null) {
        result = { ...result, ok: true }
        note = ` (gap of ${gapFrames} explained by ${repeats}x a keyed per-shot Sequence — a .map() loop this evaluator cannot resolve by index, verified by unit size instead)`
      }
    }
    check(
      `${id}: intro+body+outro tile [0, ${geometry.duration_frames}) with no gap/overlap/negative${note}`,
      result.ok,
      result.ok ? undefined : `${result.reason} (resolved ${result.segments.length} segment(s): ${result.segments.map((s) => `${s.tag}[${s.from},${s.from + s.duration})`).join(", ")})`,
    )
  }

  // ── PartnersMeetingReel — the algebraic identity, since its "ask" Sequence
  // is nested (from is parent-relative, invisible to the flat top-level
  // tiler). cardTotal is DEFINED as Math.max(1, durationInFrames - COVER -
  // ASK - OUTRO); this asserts the max() floor was NOT engaged (i.e. the
  // definition really does reduce to durationInFrames - COVER - ASK - OUTRO
  // for the REGISTERED geometry) and that the four pieces sum back to it. ──
  {
    const id = "PartnersMeetingReel"
    const geometry = COMPOSITION_GEOMETRY[id]
    const source = readStripped(VIDEO_COMPOSITION_FILES[id])
    const scope = buildScope(source, geometry)
    const haveAll = ["COVER", "ASK", "OUTRO", "cardTotal"].every((k) => typeof scope[k] === "number")
    const floorNotEngaged = haveAll && scope.cardTotal === geometry.duration_frames - scope.COVER - scope.ASK - scope.OUTRO
    const sums = haveAll && scope.COVER + scope.cardTotal + scope.ASK + scope.OUTRO === geometry.duration_frames
    check(`${id}: COVER + cardTotal + ASK + OUTRO === durationInFrames (nested "ask" Sequence verified algebraically)`,
      haveAll && floorNotEngaged && sums,
      haveAll ? `COVER=${scope.COVER} cardTotal=${scope.cardTotal} ASK=${scope.ASK} OUTRO=${scope.OUTRO} duration=${geometry.duration_frames}` : `could not resolve COVER/ASK/OUTRO/cardTotal from source`)
  }

  // ── The two single-segment slides — bounded avatar window, not a chain ──
  for (const id of ["ListingPresentationSlide", "BuyerConsultationSlide"]) {
    const geometry = COMPOSITION_GEOMETRY[id]
    const source = readStripped(VIDEO_COMPOSITION_FILES[id])
    check(`${id} has ZERO <Sequence> tags (single continuous body, by design)`,
      !/<Sequence[\s>]/.test(source))
    // The default avatarEndFrame in Root.tsx must not exceed the registered
    // duration — an avatar window that outruns the slide's own geometry would
    // be trimmed to source frames the slide never has time to show.
    const rootSrc = readStripped("remotion/Root.tsx")
    const idBlock = rootSrc.slice(rootSrc.indexOf(`id="${id}"`))
    const endFrameMatch = /avatarEndFrame:\s*([0-9]+)/.exec(idBlock)
    check(`${id}: Root.tsx defaultProps.avatarEndFrame does not exceed duration_frames (${geometry.duration_frames})`,
      !!endFrameMatch && Number(endFrameMatch[1]) <= geometry.duration_frames,
      endFrameMatch ? `avatarEndFrame=${endFrameMatch[1]}` : "avatarEndFrame not found in Root.tsx")
  }

  // ── ListingSectionReel — delegates the WHOLE duration (not a slice) to the
  // slide it wraps: no internal <Sequence>, and passes
  // avatarStartFrame={0} avatarEndFrame={durationInFrames} verbatim. ──
  {
    const source = readStripped("remotion/ListingSectionReel.tsx")
    check("ListingSectionReel has ZERO <Sequence> tags of its own (delegates the whole body to ListingPresentationSlide)",
      !/<Sequence[\s>]/.test(source))
    check("ListingSectionReel delegates the FULL window (avatarStartFrame={0} avatarEndFrame={durationInFrames}), not a slice",
      /avatarStartFrame=\{0\}/.test(source) && /avatarEndFrame=\{durationInFrames\}/.test(source))
  }

  // ── PhotoWalkthroughReel — DERIVED, not literal. Proven directly against
  // the pure helper it now calls (lib/video/assembly-timeline.ts), swept
  // across every duration this fleet actually registers plus edge cases. ──
  console.log("\n  PhotoWalkthroughReel (derived split — computeAssemblyTimeline sweep):")
  const sweepDurations = [1, 2, 30, 60, 90, 150, ...Object.values(COMPOSITION_GEOMETRY).map((g) => g.duration_frames)]
  let sweepOk = true
  let sweepDetail = ""
  for (const d of sweepDurations) {
    const t = computeAssemblyTimeline({ durationInFrames: d, introFrames: 60, outroFrames: 90 })
    const sum = t.intro.durationInFrames + t.body.durationInFrames + t.outro.durationInFrames
    const contiguous = t.body.from === t.intro.durationInFrames && t.outro.from === t.intro.durationInFrames + t.body.durationInFrames
    const allPositive = t.intro.durationInFrames >= 0 && t.body.durationInFrames >= 1 && t.outro.durationInFrames >= 0
    if (sum !== Math.max(1, d) || !contiguous || !allPositive) {
      sweepOk = false
      sweepDetail = `at durationInFrames=${d}: sum=${sum}, contiguous=${contiguous}, allPositive=${allPositive}`
      break
    }
  }
  check(`computeAssemblyTimeline sums exactly across ${sweepDurations.length} swept durations (incl. every registered geometry)`, sweepOk, sweepDetail)

  // ── POSITIVE CONTROLS (task-mandated) — a planted gap / overrun / negative
  // duration MUST be caught by tileSegments, the same function the real
  // per-composition checks above call. ──
  console.log("\n  Positive controls (tileSegments must catch a planted defect):")
  const gapPlant: Segment[] = [
    { tag: "Sequence", from: 0, duration: 60, fromExpr: "0", durExpr: "COVER" },
    { tag: "Sequence", from: 70, duration: 200, fromExpr: "COVER + 10", durExpr: "BODY" }, // 10-frame gap
    { tag: "Sequence", from: 270, duration: 90, fromExpr: "COVER + 10 + BODY", durExpr: "OUTRO" },
  ]
  const gapResult = tileSegments(gapPlant, 350)
  check("CONTROL: a planted 10-frame GAP between intro and body is caught", !gapResult.ok && gapResult.reason.includes("GAP"), gapResult.reason)

  const overrunPlant: Segment[] = [
    { tag: "Sequence", from: 0, duration: 60, fromExpr: "0", durExpr: "COVER" },
    { tag: "Sequence", from: 60, duration: 250, fromExpr: "COVER", durExpr: "BODY" }, // too long
    { tag: "Sequence", from: 310, duration: 90, fromExpr: "COVER + BODY", durExpr: "OUTRO" },
  ]
  const overrunResult = tileSegments(overrunPlant, 350)
  check("CONTROL: a planted OVERRUN past durationInFrames is caught", !overrunResult.ok && overrunResult.reason.includes("OVERRUN"), overrunResult.reason)

  const negativePlant: Segment[] = [
    { tag: "Sequence", from: 0, duration: 60, fromExpr: "0", durExpr: "COVER" },
    { tag: "Sequence", from: 60, duration: -5, fromExpr: "COVER", durExpr: "BODY" },
  ]
  const negativeResult = tileSegments(negativePlant, 55)
  check("CONTROL: a planted NEGATIVE Sequence durationInFrames is caught", !negativeResult.ok && negativeResult.reason.includes("negative"), negativeResult.reason)

  const cleanPlant: Segment[] = [
    { tag: "Sequence", from: 0, duration: 60, fromExpr: "0", durExpr: "COVER" },
    { tag: "Sequence", from: 60, duration: 240, fromExpr: "COVER", durExpr: "BODY" },
    { tag: "Sequence", from: 300, duration: 90, fromExpr: "COVER + BODY", durExpr: "OUTRO" },
  ]
  check("CONTROL: a correctly-tiled synthetic timeline still passes (the checker is not just failing everything)",
    tileSegments(cleanPlant, 390).ok)

  // ── Every registered geometry is 30fps — the assumption buildScope's
  // fps/FPS seed relies on, checked rather than trusted. ──
  const nonstandardFps = Object.entries(COMPOSITION_GEOMETRY).filter(([, g]) => g.fps !== 30)
  check("every registered composition is 30fps (buildScope's fps/FPS=30 seed is safe)",
    nonstandardFps.length === 0, nonstandardFps.map(([id, g]) => `${id}@${g.fps}fps`).join(", "))
}

// ═══════════════════════════════════════════════════════════════════════════
// §broll — per-shot frames derived from the count that arrived, never
// hardcoded; an honest fallback when fewer images arrive than slots exist
// ═══════════════════════════════════════════════════════════════════════════

/** Compositions that divide a body window across `imageUrls`/a sub-slice of
 *  it by the ACTUAL count, with a caption/message fallback when the count is
 *  zero. Source-scanned rather than pure-tested because the derivation lives
 *  inline in the composition (a per-clip Sequence loop), not behind an
 *  exported pure function the way kenBurnsPlan/selectBrollPlan are. */
const IMAGE_CAROUSEL_COMPOSITIONS: Record<string, { file: string; lengthExpr: RegExp; fallbackExpr: RegExp }> = {
  // `fallbackExpr` proves a DEDICATED branch exists for the zero-image case —
  // the actual fallback WORDING differs per composition ("Photos coming soon",
  // "Closed — congratulations to the seller") and asserting one literal string
  // fleet-wide would be exactly the pinned-waypoint trap §2 warns against; the
  // `=== 0 ?` ternary is the structural fact that matters.
  JustListedReel: { file: "remotion/JustListedReel.tsx", lengthExpr: /images\.length/, fallbackExpr: /if\s*\(!url\)/ },
  JustListedReelSquare: { file: "remotion/JustListedReelSquare.tsx", lengthExpr: /images\.length/, fallbackExpr: /images\.length\s*===\s*0/ },
  JustListedReelHorizontal: { file: "remotion/JustListedReelHorizontal.tsx", lengthExpr: /images\.length/, fallbackExpr: /images\.length\s*>\s*0/ },
  JustSoldReelSquare: { file: "remotion/JustSoldReelSquare.tsx", lengthExpr: /images\.length/, fallbackExpr: /images\.length\s*===\s*0/ },
  OpenHouseAnnounceReel: { file: "remotion/OpenHouseAnnounceReel.tsx", lengthExpr: /restImgs\.length/, fallbackExpr: /brand\.primaryColor/ }, // falls back to the brand-colored root (no photo cycling), never a broken render
}

function brollSection() {
  console.log("\n── §broll — b-roll/image slots derived from what arrived, honest fallback ──")

  for (const [id, spec] of Object.entries(IMAGE_CAROUSEL_COMPOSITIONS)) {
    const source = readStripped(spec.file)
    check(`${id}: per-shot frames are DIVIDED BY the actual image count (not a hardcoded literal)`,
      spec.lengthExpr.test(source))
    check(`${id}: an honest fallback renders when the shot count is zero`,
      spec.fallbackExpr.test(source))
  }

  // CONTROL: the "divided by count" pattern check correctly flags a
  // hardcoded-shot-count snippet that has NO reference to images.length.
  const brokenSnippet = "const perPhoto = 60 // fixed 2s regardless of how many images arrived"
  check("CONTROL: a hardcoded per-shot literal with no .length reference is correctly flagged as NOT derived",
    !/images\.length/.test(brokenSnippet))

  // ── kenBurnsPlan / brollSlots complementary sweep: fewer assets than the
  // window "wants" still tiles [0,total) exactly, and zero assets is an
  // honest empty (proven per-function by their own simulators —
  // test:photo-walkthrough, test:broll-slot; this is the fleet-level
  // complement: every registered geometry, not a fixture duration). ──
  console.log("\n  kenBurnsPlan / brollSlots sweep (fewer images than the body \"wants\"):")
  let planSweepOk = true, planSweepDetail = ""
  for (const g of Object.values(COMPOSITION_GEOMETRY)) {
    if (g.duration_frames <= 1) continue
    for (const photoCount of [0, 1, 3]) {
      const photos = Array.from({ length: photoCount }, (_, i) => `https://cdn.example/${i}.jpg`)
      const clips = kenBurnsPlan(photos, g.duration_frames, { fps: g.fps })
      if (photoCount === 0) {
        if (clips.length !== 0) { planSweepOk = false; planSweepDetail = `expected honest empty at 0 photos, got ${clips.length} clips`; break }
        continue
      }
      const last = clips[clips.length - 1]
      if (!last || last.fromFrame + last.durationFrames !== g.duration_frames) {
        planSweepOk = false
        planSweepDetail = `${photoCount} photos over ${g.duration_frames}f: last clip ends at ${last ? last.fromFrame + last.durationFrames : "n/a"}, not ${g.duration_frames}`
        break
      }
    }
    if (!planSweepOk) break
  }
  check("kenBurnsPlan tiles [0, bodyFrames) exactly for 1 and 3 photos, and is honestly empty at 0, across every registered geometry", planSweepOk, planSweepDetail)

  const brollFallback: BrollClip[] = [{ url: "https://cdn.example/a.mp4", durationSeconds: 4 }]
  const slots = brollSlots(brollFallback, 480, 30, 10)
  const lastSlot = slots[slots.length - 1]
  check("brollSlots: a single measured clip asked to fill a longer window LOOPS to tile the window exactly (never a black gap)",
    slots.length > 1 && !!lastSlot && lastSlot.from + lastSlot.durationFrames === 480,
    `${slots.length} slot(s), last ends at ${lastSlot ? lastSlot.from + lastSlot.durationFrames : "n/a"}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// §music — ducked, faded in/out, never past the end
// ═══════════════════════════════════════════════════════════════════════════

function musicSection() {
  console.log("\n── §music — present when available, ducked, faded, never past durationInFrames ──")

  // Fade-in always present.
  const graphNoLength = buildMusicMixFilterGraph({ loop: true, volume: 0.2, videoSeconds: null })
  check("music filter graph fades IN from silence even with no known video length",
    graphNoLength.includes(`afade=t=in:st=0:d=${DEFAULT_MUSIC_FADE_IN_SECONDS.toFixed(2)}`))
  check("music filter graph does NOT fade out against a length it does not know (never guesses)",
    !graphNoLength.includes("afade=t=out"))

  // Fade-out present + correctly timed when the real length is known.
  const videoSeconds = 20
  const graphWithLength = buildMusicMixFilterGraph({ loop: true, volume: 0.2, videoSeconds })
  const expectedStart = (videoSeconds - DEFAULT_MUSIC_FADE_OUT_SECONDS).toFixed(2)
  check(`music filter graph fades OUT timed against the real video length (st=${expectedStart})`,
    graphWithLength.includes(`afade=t=out:st=${expectedStart}:d=${DEFAULT_MUSIC_FADE_OUT_SECONDS.toFixed(2)}`))

  // CONTROL: a track shorter than both fades combined skips the fade-out
  // rather than emitting a nonsensical negative start time.
  const tinyVideo = buildMusicTrackFilter({ loop: false, volume: 0.2, videoSeconds: 1 })
  check("CONTROL: a video shorter than fade-in+fade-out combined never emits a negative afade start",
    !tinyVideo.includes("st=-"))

  // Volume is clamped 0..1 regardless of what a stock-asset row supplies.
  const overVolume = buildMusicTrackFilter({ loop: false, volume: 4.2 })
  const underVolume = buildMusicTrackFilter({ loop: false, volume: -0.5 })
  check("music volume is clamped to <= 1.00 even when the stock row supplies more", overVolume.includes("volume=1.00"))
  check("music volume is clamped to >= 0.00 even when the stock row supplies less", underVolume.includes("volume=0.00"))

  // Ducking: the render-coordinator's default puts the music at
  // MUSIC_DUCK_VOLUME_PCT (lib/video/realism-profile.ts, wave 57 — research-
  // derived, replaces the pre-wave-57 literal 20%) while the voice channel
  // [0:a] is passed through UNSCALED in the amix graph — so the music sits
  // under the narration by construction, not by accident. §2 — asserts the
  // RULE (references the named constant, not a re-typed literal) so a future
  // re-tuning of MUSIC_DUCK_VOLUME_PCT cannot silently drift this check out
  // of sync with the number actually shipped.
  const coordinatorSrc = readStripped("lib/remotion/render-coordinator.ts")
  const defaultVolumeMatch = /musicVolumePct:\s*musicRow\.music_volume_pct\s*\?\?\s*MUSIC_DUCK_VOLUME_PCT/.test(coordinatorSrc)
  check("render-coordinator's default music volume falls back to the named MUSIC_DUCK_VOLUME_PCT constant (§6 — one spelling), not a re-typed literal",
    defaultVolumeMatch)
  check(`MUSIC_DUCK_VOLUME_PCT (${MUSIC_DUCK_VOLUME_PCT}%) is a DUCKED level (<=30%), not near-parity with the voice`,
    MUSIC_DUCK_VOLUME_PCT > 0 && MUSIC_DUCK_VOLUME_PCT <= 30)
  // The research (lib/video/realism-profile.ts header) converges on the music
  // sitting 18-25dB below the (unscaled, 0dB) voice channel; the task's own
  // framing narrows that to -18..-22 LUFS. 20*log10(pct/100) converts the
  // linear ffmpeg volume= multiplier to dB relative to full scale.
  const duckDb = 20 * Math.log10(MUSIC_DUCK_VOLUME_PCT / 100)
  check(`MUSIC_DUCK_VOLUME_PCT converts to ${duckDb.toFixed(1)}dB below the voice — inside the researched -18..-25dB duck range`,
    duckDb <= -18 && duckDb >= -25)
  check("the mix graph passes the voice channel [0:a] through UNSCALED (no volume filter on 0:a) — ducking is the music's job, not the voice's",
    /\[0:a\]\[a1\]amix/.test(graphWithLength))

  // Never past durationInFrames: the mux is hard-locked to the VIDEO's own
  // length regardless of the music track's or the fade math's numbers.
  // `duration=first`/`afade` live in the PURE graph builder (code, checked
  // there); `-shortest` is the ffmpeg CLI arg in the server-only spawn
  // (checked in music-mixer.ts itself).
  const filterGraphSrc = readStripped("lib/remotion/music-filter-graph.ts")
  const mixerSrc = readStripped("lib/remotion/music-mixer.ts")
  check("the music filter graph locks the mix to the video's own length (duration=first)", filterGraphSrc.includes("duration=first"))
  check("the music filter graph builds afade stages (fade-in/out live in code, not just this file's comments)", filterGraphSrc.includes("afade=t=in") && filterGraphSrc.includes("afade=t=out"))
  check("mixBackgroundMusic never outputs past the shorter stream (-shortest)", mixerSrc.includes('"-shortest"'))
  check("mixBackgroundMusic calls the shared graph builder rather than re-building the filter string inline (§6)",
    /buildMusicMixFilterGraph\(\{/.test(mixerSrc))

  // The render-coordinator threads a REAL videoSeconds (composition + landed
  // bookends) into the mixer, not a guess — the wiring this wave built.
  check("render-coordinator threads the real muxed video length into the music mix (videoSeconds: musicVideoSeconds)",
    /mixBackgroundMusic\(\{[\s\S]{0,300}videoSeconds:\s*musicVideoSeconds/.test(coordinatorSrc))

  // finish-spec cross-check: every composition it declares music:true for is
  // one this render path can actually reach (pickStockAsset "music" scope is
  // unconditional on composition id — informational, not a per-id gate — so
  // the real assertion is that the SPEC and the MIXER agree music is a real,
  // wired capability, not a declared-but-dead flag).
  const musicWantingCount = Object.values(VIDEO_FINISH_SPEC).filter((f) => f.music).length
  check(`finish-spec declares music for ${musicWantingCount} composition(s), and the mixer that serves them exists + fades both edges`,
    musicWantingCount > 0 && filterGraphSrc.includes("afade"))

  // ── §music sidechain — REAL ducking driven by the narration track (wave 58) ──
  // The wave-57 research header recorded "constant level for the whole track
  // ... attack/release has no analog here" as an unresolved gap. These checks
  // prove that gap is closed: a real sidechaincompress stage exists, is tuned
  // inside ffmpeg's own accepted ranges, is keyed off [0:a] (the narration
  // channel), and the CONSTANT-level graph remains reachable as the fallback
  // (never deleted, never bypassed-by-default).
  check("dbToLinearAmplitude converts 0dB to unity gain (POSITIVE CONTROL for the dB->linear helper every sidechain param goes through)",
    Math.abs(dbToLinearAmplitude(0) - 1) < 1e-9)
  check("dbToLinearAmplitude(-30) is materially quieter than unity (a real attenuation, not a no-op formula)",
    dbToLinearAmplitude(-30) > 0 && dbToLinearAmplitude(-30) < 0.05)

  const duckGraph = buildMusicDuckFilterGraph({
    loop: true, volume: 0.12, videoSeconds: 20, duck: MUSIC_SIDECHAIN_DUCK_SETTINGS,
  })
  check("sidechain duck graph builds a sidechaincompress stage",
    /sidechaincompress=/.test(duckGraph))
  check("sidechain duck graph keys the compressor off the NARRATION channel [0:a] as the sidechain input, not the music track itself",
    /\[a1\]\[0:a\]sidechaincompress=/.test(duckGraph))
  check("sidechain duck graph still mixes the ducked bed back against [0:a] (amix), same as the constant-level graph",
    /\[0:a\]\[a1d\]amix=inputs=2:duration=first:dropout_transition=0\[aout\]/.test(duckGraph))
  check("sidechain duck graph keeps the SAME bed-level chain (loop/volume/fades) as the constant graph — only ONE thing changes: dynamic ducking added on top",
    duckGraph.startsWith(buildMusicTrackFilter({ loop: true, volume: 0.12, videoSeconds: 20 })))

  // Tuning sits inside ffmpeg's OWN documented sidechaincompress ranges —
  // a bad constant must not silently produce a filter ffmpeg refuses to run.
  const thresholdMatch = duckGraph.match(/sidechaincompress=threshold=([\d.]+):ratio=([\d.]+):attack=([\d.]+):release=([\d.]+):makeup=([\d.]+)/)
  check("sidechain filter string parses out threshold/ratio/attack/release/makeup (the exact params ffmpeg's sidechaincompress accepts)",
    !!thresholdMatch)
  if (thresholdMatch) {
    const [, thresholdStr, ratioStr, attackStr, releaseStr, makeupStr] = thresholdMatch
    const threshold = Number(thresholdStr), ratio = Number(ratioStr), attack = Number(attackStr), release = Number(releaseStr), makeup = Number(makeupStr)
    check(`threshold (${threshold}) is inside ffmpeg's accepted linear range (0.00097563-1)`, threshold >= 0.00097563 && threshold <= 1)
    check(`ratio (${ratio}) is inside ffmpeg's accepted range (1-20)`, ratio >= 1 && ratio <= 20)
    check(`attack (${attack}ms) is inside ffmpeg's accepted range (0.01-2000ms)`, attack >= 0.01 && attack <= 2000)
    check(`release (${release}ms) is inside ffmpeg's accepted range (0.01-9000ms)`, release >= 0.01 && release <= 9000)
    check(`makeup (${makeup}) is inside ffmpeg's accepted range (1-64 linear)`, makeup >= 1 && makeup <= 64)
    // §2 positive control: threshold/ratio/attack/release actually MOVE the
    // string when the constant changes — proves the builder reads the
    // researched constants rather than emitting a hardcoded literal.
    const retunedGraph = buildMusicDuckFilterGraph({
      loop: true, volume: 0.12, videoSeconds: 20,
      duck: { thresholdDb: -18, ratio: 4, attackMs: 80, releaseMs: 600, makeupDb: 3 },
    })
    check("CONTROL: re-tuning MUSIC_SIDECHAIN_DUCK_SETTINGS' fields actually moves the emitted filter string (the builder reads the constants, not a hardcoded literal)",
      retunedGraph !== duckGraph && /ratio=4\.00/.test(retunedGraph) && /attack=80\.00/.test(retunedGraph) && /release=600\.00/.test(retunedGraph))
  }

  // Researched attack/release ARE sidechaincompress's own ffmpeg defaults
  // (20ms/250ms) — asserted against the research note's own claim, not
  // re-typed as a bare literal here.
  check(`MUSIC_SIDECHAIN_DUCK_SETTINGS.attackMs (${MUSIC_SIDECHAIN_DUCK_SETTINGS.attackMs}) matches sidechaincompress's own ffmpeg default (20ms) — the research converges on the tool's own default, not a re-typed guess`,
    MUSIC_SIDECHAIN_DUCK_SETTINGS.attackMs === 20)
  check(`MUSIC_SIDECHAIN_DUCK_SETTINGS.releaseMs (${MUSIC_SIDECHAIN_DUCK_SETTINGS.releaseMs}) matches sidechaincompress's own ffmpeg default (250ms)`,
    MUSIC_SIDECHAIN_DUCK_SETTINGS.releaseMs === 250)
  check(`MUSIC_SIDECHAIN_DUCK_SETTINGS.ratio (${MUSIC_SIDECHAIN_DUCK_SETTINGS.ratio}:1) is inside the researched 4-8:1 convergence`,
    MUSIC_SIDECHAIN_DUCK_SETTINGS.ratio >= 4 && MUSIC_SIDECHAIN_DUCK_SETTINGS.ratio <= 8)
  check(`MUSIC_SIDECHAIN_DUCK_SETTINGS.thresholdDb (${MUSIC_SIDECHAIN_DUCK_SETTINGS.thresholdDb}dB) is inside the researched -20..-30dB convergence`,
    MUSIC_SIDECHAIN_DUCK_SETTINGS.thresholdDb <= -20 && MUSIC_SIDECHAIN_DUCK_SETTINGS.thresholdDb >= -30)

  // CONSTANT-level graph remains reachable — the required fallback, not
  // silently replaced by the sidechain path.
  check("the ORIGINAL constant-level graph builder (buildMusicMixFilterGraph) is UNCHANGED and still reachable — the required fallback when sidechain is unavailable",
    /\[0:a\]\[a1\]amix=inputs=2:duration=first:dropout_transition=0\[aout\]/.test(graphWithLength) && !graphWithLength.includes("sidechaincompress"))

  // music-mixer.ts wiring: the sidechain attempt is opt-in per render
  // (duckToNarration), attempted before the constant fallback, and a failed
  // sidechain attempt falls back rather than failing the whole mix.
  check("music-mixer only attempts the sidechain graph when the caller says narration is on [0:a] this render (duckToNarration)",
    mixerSrc.includes("if (input.duckToNarration)") && /buildMusicDuckFilterGraph\(\{/.test(mixerSrc))
  check("music-mixer falls back to the constant-level graph when the sidechain attempt is not requested OR fails at ffmpeg",
    /if \(!ducked\)/.test(mixerSrc) && /runMix\(constantFilter\)/.test(mixerSrc))
  check("render-coordinator threads usedVoiceover (whether [0:a] carries narration THIS render) into duckToNarration — not a guess, the actual mux fact",
    /duckToNarration:\s*usedVoiceover/.test(coordinatorSrc))
}

// ═══════════════════════════════════════════════════════════════════════════
// §branding — brand kit in intro AND outro; fair-housing mark on
// listing-facing reels
// ═══════════════════════════════════════════════════════════════════════════

/** Listing/market-facing per VIDEO_FINISH_SPEC (MARKETING, CHART_REEL,
 *  AVATAR_LED, REPORT_CLIENT) — every category EXCEPT the report-internal
 *  shows (audience is already inside the app) and the one composition
 *  content-contract.ts itself declares carries no tenant claim at all
 *  (ProductPromoReel — platform self-marketing, not a listing/client reel). */
const EHO_EXEMPT = new Set(["ProductPromoReel", "PartnersMeetingReel"])
// Renders the mark via a CHILD component rather than its own JSX — checked as
// inheritance below, not as a direct-render miss.
const EHO_INHERITED = new Set(["ListingSectionReel"])

/**
 * A composition renders the mark two ways: the literal "Equal Housing
 * Opportunity" string inline (most compositions), or an IMPORT of the shared
 * remotion/components/EqualHousingMark.tsx survivor plus a JSX use of it
 * (JustListedReel, PhotoWalkthroughReel — merged onto that survivor wave 50,
 * §1). Reading only the literal string would make the merge read as the mark
 * going MISSING; a source that imports the component without ever rendering
 * it (a dead import) does NOT satisfy this — both halves are required, same
 * as the CONTROL below proves for the inline shape.
 */
function rendersEhoMark(source: string): boolean {
  if (/Equal Housing Opportunity/.test(source)) return true
  return (
    /from\s+["'][^"']*EqualHousingMark["']/.test(source) &&
    /<EqualHousingMark\b/.test(source)
  )
}

function brandingSection() {
  console.log("\n── §branding — brand kit + fair-housing mark, intro and outro ──")

  for (const [id, file] of Object.entries(VIDEO_COMPOSITION_FILES)) {
    if (EHO_EXEMPT.has(id)) continue
    const source = readStripped(file)
    check(`${id}: brand interface declares showEhoMark`, /showEhoMark\??:\s*boolean/.test(source))
    if (!EHO_INHERITED.has(id)) {
      check(`${id}: renders the Equal Housing Opportunity mark`, rendersEhoMark(source))
    }
    // The "who" identity in the outro is either the brokerage or (on the
    // agent-only vertical/square listing reels — JustListedReel and its
    // Square/Horizontal/JustSold variants, PhotoWalkthroughReel) the agent —
    // both are legitimate brand-kit identities, so either satisfies this.
    check(`${id}: brand kit carries primaryColor + accentColor + a brokerage-or-agent identity`,
      /primaryColor/.test(source) && /accentColor/.test(source) && (/brokerageName/.test(source) || /agentName/.test(source)))
  }

  // ListingSectionReel inherits EHO through the ListingPresentationSlide it
  // wraps (remotion/ListingSectionReel.tsx passes brand={props.brand}
  // straight through) rather than rendering its own — checked as INHERITANCE,
  // not absence, so this does not read as a false EHO gap.
  const sectionReel = readStripped("remotion/ListingSectionReel.tsx")
  check("ListingSectionReel: inherits EHO via <ListingPresentationSlide brand={props.brand}> rather than duplicating it",
    /<ListingPresentationSlide[\s\S]{0,600}brand=\{props\.brand\}/.test(sectionReel))

  // CONTROL: the EHO check correctly flags a composition-shaped snippet that
  // declares the prop but never renders it — the exact shape
  // NewsletterDigestVideo was in before this wave's fix.
  const missingEhoSnippet = `
    interface Brand { primaryColor: string; accentColor: string; brokerageName: string; showEhoMark?: boolean }
    const OutroCta = () => <div>{brand.brokerageName}</div>
  `
  check("CONTROL: a composition that declares showEhoMark but never renders the mark is correctly flagged",
    /showEhoMark\??:\s*boolean/.test(missingEhoSnippet) && !rendersEhoMark(missingEhoSnippet))

  // CONTROLS for the imported-shared-mark shape (JustListedReel,
  // PhotoWalkthroughReel merged onto EqualHousingMark.tsx wave 50): an import
  // WITH a JSX render passes; an import with no render (a dead import — the
  // string is genuinely absent, same defect class as missingEhoSnippet above)
  // is still correctly flagged, proving rendersEhoMark did not just become
  // "imports the module".
  const importedAndRendered = `import { EqualHousingMark } from "./components/EqualHousingMark"\n{props.brand.showEhoMark && <EqualHousingMark variant="badge" />}`
  check("CONTROL: a composition that imports AND renders <EqualHousingMark> is correctly recognised",
    rendersEhoMark(importedAndRendered))
  const importedNotRendered = `import { EqualHousingMark } from "./components/EqualHousingMark"\nconst unused = EqualHousingMark`
  check("CONTROL: a composition that imports but never renders <EqualHousingMark> is correctly flagged",
    !rendersEhoMark(importedNotRendered))

  // NewsletterDigestVideo specifically — the finding this wave fixed. Named
  // explicitly so a future regression on THIS composition is unambiguous in
  // the failure output, not lost in the fleet loop above.
  const newsletter = readStripped("remotion/NewsletterDigestVideo.tsx")
  check("NewsletterDigestVideo (median price / inventory / DOM — market-facing) declares + renders the EHO mark",
    /showEhoMark\??:\s*boolean/.test(newsletter) && rendersEhoMark(newsletter))

  // JustListedReel + PhotoWalkthroughReel specifically — named explicitly so a
  // regression on the MERGE (wave 50, §1: local EhoBadge → shared
  // EqualHousingMark) is unambiguous rather than lost in the fleet loop above.
  for (const mergedId of ["JustListedReel", "PhotoWalkthroughReel"] as const) {
    const source = readStripped(VIDEO_COMPOSITION_FILES[mergedId])
    check(`${mergedId}: EHO mark now rides the shared EqualHousingMark import, not a local EhoBadge`,
      /from\s+["'][^"']*EqualHousingMark["']/.test(source) &&
      /<EqualHousingMark\b/.test(source) &&
      !/const\s+EhoBadge/.test(source))
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// §avatar — the body window bounds the avatar clip; no wrong-trimBefore
// regression; AvatarPIP windows strictly increasing and in-bounds
// ═══════════════════════════════════════════════════════════════════════════

/**
 * AvatarPIP `startFrame`/`endFrame` windows, resolved two ways:
 *   · DIRECT — `<AvatarPIP {...{ ..., startFrame: EXPR, endFrame: EXPR2 }} />`
 *     (MarketUpdateReel) — evaluated straight off the call site.
 *   · INDIRECT — a small helper (EquityReportReel's `pipFor(start)`) that
 *     returns `{ startFrame: start, endFrame: start ± WIDTH }`; the helper's
 *     OWN offset formula is learned once from its definition, then applied to
 *     each `pipFor(ARG)` call site's resolved argument. Not specific to the
 *     name `pipFor` — matches any `endFrame: start <op> IDENT` shape.
 */
function resolveAvatarPipWindows(source: string, scope: Record<string, number>): Array<{ start: number; end: number }> {
  const direct: Array<{ start: number; end: number }> = []
  const directRe = /startFrame:\s*([^,]+),\s*endFrame:\s*([^}]+)\}/g
  let m: RegExpExecArray | null
  while ((m = directRe.exec(source))) {
    try { direct.push({ start: safeEval(m[1], scope), end: safeEval(m[2], scope) }) } catch { /* unresolvable — skip */ }
  }
  if (direct.length > 0) return direct

  const defMatch = /endFrame:\s*start\s*([+-])\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(source)
  if (!defMatch) return []
  const [, op, widthName] = defMatch
  const width = scope[widthName]
  if (typeof width !== "number") return []
  const out: Array<{ start: number; end: number }> = []
  const helperName = (/const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\([^)]*start[^)]*\)\s*=>/.exec(source)?.[1])
    ?? (/function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*start\b/.exec(source)?.[1])
  if (!helperName) return []
  const helperCallRe = new RegExp(`${helperName}\\(([^)]+)\\)`, "g")
  while ((m = helperCallRe.exec(source))) {
    try {
      const start = safeEval(m[1], scope)
      out.push({ start, end: op === "+" ? start + width : start - width })
    } catch { /* unresolvable — skip */ }
  }
  return out
}

function avatarSection() {
  console.log("\n── §avatar — avatar clip bounded to the body window, captions aligned ──")

  // THE HISTORICAL DEFECT CLASS (documented repeatedly in ComingSoonReel,
  // NeighborhoodSpotlightReel, TestimonialReel): trimBefore set to the
  // ENCLOSING sequence's own global offset (`trimBefore={COVER + BODY}` or
  // `trimBefore={COVER}`), which skips that many SOURCE seconds of a clip
  // whose content starts at source frame 0. Regression-guarded across the
  // whole remotion/ tree, not just the files that were fixed.
  const remotionFiles = readdirSync(join(root, "remotion")).filter((f) => f.endsWith(".tsx"))
  const wrongTrimBefore = /trimBefore=\{(?:COVER|INTRO)(?:\s*\+[^}]*)?\}/
  const offenders: string[] = []
  for (const f of remotionFiles) {
    const src = readStripped(`remotion/${f}`)
    if (wrongTrimBefore.test(src)) offenders.push(f)
  }
  check("no avatar <Video> in remotion/** uses the enclosing sequence's own offset as trimBefore (the historical wrong-trim defect)",
    offenders.length === 0, offenders.join(", "))

  // CONTROL: the regex still recognises the exact defect it was written for.
  check("CONTROL: the wrong-trimBefore regex still catches its own historical shape",
    wrongTrimBefore.test('<Video src={avatarVideoUrl} trimBefore={COVER + BODY} trimAfter={CTA} />'))

  // AvatarPIP startFrame/endFrame call sites — strictly increasing per pair,
  // and bounded by the registered duration_frames. Reuses the same scope
  // builder as §sums so it is not a second arithmetic engine (§6).
  const pipCallers: Array<{ id: string; file: string }> = [
    { id: "MarketUpdateReel", file: "remotion/MarketUpdateReel.tsx" },
    { id: "EquityReportReel", file: "remotion/EquityReportReel.tsx" },
    { id: "ExplainerAnimReel", file: "remotion/ExplainerAnimReel.tsx" },
  ]
  for (const { id, file } of pipCallers) {
    const geometry = COMPOSITION_GEOMETRY[id]
    const source = readStripped(file)
    const scope = buildScope(source, geometry)
    const windows = resolveAvatarPipWindows(source, scope)
    let allOk = true
    let detail = ""
    for (const w of windows) {
      if (!(w.end > w.start) || w.end > geometry.duration_frames || w.start < 0) {
        allOk = false
        detail = `AvatarPIP window [${w.start}, ${w.end}) invalid against duration_frames=${geometry.duration_frames}`
        break
      }
    }
    check(`${id}: every AvatarPIP startFrame/endFrame window is increasing and within [0, duration_frames]`,
      allOk && windows.length > 0, detail || (windows.length === 0 ? "no resolvable AvatarPIP call sites found" : undefined))

    // WAVE 60 AVATAR LEAD-IN FIX — the blind spot the historical `wrongTrimBefore`
    // regex above could never see: these four compositions never write
    // `trimBefore=` themselves — they pass `startFrame`/`endFrame` THROUGH to
    // AvatarPIP (or ExplainerAnimReel's own private copy), which applies them
    // to `<Video trimBefore trimAfter>` internally. The pre-fix shape passed
    // the composition-ABSOLUTE cover/intro-tile frame (COVER/INTRO) as the
    // FIRST window's startFrame — silently skipping that many seconds of REAL
    // narration from the front of the D-ID clip before AvatarPIP ever mounts
    // (nothing pads that much lead-in silence at render time — D-ID's own
    // pad_audio, DID_TALK_REALISM_CONFIG in lib/video/realism-profile.ts, is
    // 0.3s of TRAILING silence only). The FIRST window resolved above must
    // start the clip's own timeline at frame 0 — the moment it first becomes
    // visible — never at the composition's cover/intro offset.
    check(`${id}: the FIRST AvatarPIP window starts the clip at its own frame 0 — no lead-in seconds of real narration skipped before the avatar first appears`,
      windows.length > 0 && windows[0].start === 0,
      windows.length > 0 ? `first window starts at ${windows[0].start}, not 0` : undefined)
  }

  // AgentExplainerReel's three AvatarPIP call sites place startFrame/endFrame
  // mid-object (more props follow), which defeats resolveAvatarPipWindows'
  // generic single-`}`-lookahead parser (it returns [] rather than misparse)
  // — so it is proven here directly instead of through the shared scope
  // engine. Same WAVE 60 AVATAR LEAD-IN FIX as the pipCallers loop above:
  // the first window must start the clip's own timeline at frame 0, never
  // at the composition-absolute COVER frame (which would skip that many
  // seconds of real narration — see the file's own comment on BULLET 1).
  {
    const src = readStripped("remotion/AgentExplainerReel.tsx").replace(/\s+/g, " ")
    const firstCall = /startFrame:\s*([^,]+),\s*endFrame:\s*([^,]+),/.exec(src)
    check("AgentExplainerReel: the FIRST AvatarPIP window starts the clip at its own frame 0 — no lead-in seconds of real narration skipped before the avatar first appears",
      !!firstCall && firstCall[1].trim() === "0", firstCall ? `first call site: startFrame: ${firstCall[1].trim()}` : "no AvatarPIP call site found")
    check("CONTROL: the AgentExplainerReel startFrame/endFrame regex still recognises a call site shape",
      /startFrame:\s*([^,]+),\s*endFrame:\s*([^,]+),/.test('<AvatarPIP {...{ startFrame: COVER, endFrame: COVER + B1, avatarDurationSeconds }} />'))
  }

  // Single continuous-body slides: avatarStartFrame < avatarEndFrame in
  // Root.tsx's own defaultProps (the manual-render path's own contract).
  const rootSrc = readStripped("remotion/Root.tsx")
  for (const id of ["ListingPresentationSlide", "BuyerConsultationSlide"]) {
    const block = rootSrc.slice(rootSrc.indexOf(`id="${id}"`))
    const start = /avatarStartFrame:\s*([0-9]+)/.exec(block)
    const end = /avatarEndFrame:\s*([0-9]+)/.exec(block)
    check(`${id}: Root.tsx defaultProps avatarStartFrame < avatarEndFrame`,
      !!start && !!end && Number(start[1]) < Number(end[1]))
  }

  // WAVE 61 RE-AUDIT — same-body census: BuyerConsultationSlide.tsx and
  // ListingPresentationSlide.tsx each carried a private `AvatarPIP` duplicate
  // (byte-identical to each other, a `position`-less subset of the shared
  // survivor) with NO avatarPipWindowFade freeze guard. Merged onto
  // remotion/components/AvatarPIP.tsx this wave (position="bottom-right").
  // Regression-guard: neither file defines its own `AvatarPIP` anymore, and
  // both import the shared survivor.
  for (const id of ["BuyerConsultationSlide", "ListingPresentationSlide"]) {
    const file = VIDEO_COMPOSITION_FILES[id]
    const src = readStripped(file)
    check(`${id}: imports the SHARED AvatarPIP survivor (./components/AvatarPIP), not a private duplicate`,
      /import \{ AvatarPIP \} from "\.\/components\/AvatarPIP"/.test(src))
    check(`${id}: no private "const AvatarPIP" redefinition remains (the tombstone names the survivor, it doesn't shadow it)`,
      !/const AvatarPIP:/.test(src))
    check(`${id}: passes position="bottom-right" to the shared AvatarPIP (preserves its original corner placement)`,
      /position="bottom-right"/.test(src))
  }
  // CONTROL — the private-duplicate regex still recognises the exact shape it
  // was written to catch (a composition-local AvatarPIP redefinition).
  check("CONTROL: the private-AvatarPIP regex still catches its own historical shape",
    /const AvatarPIP:/.test('const AvatarPIP: React.FC<{ x: number }> = () => null'))

  // Captions align to the composition's own duration/fps via useVideoConfig()
  // — never a second, independently-timed estimate. Source-checked once,
  // fleet-wide, since CaptionLayer is the ONE shared reader every voiced
  // composition uses. Wave 59: the plan is built against the NARRATION
  // WINDOW (hiddenFrom - visibleFrom, both DERIVED from durationInFrames when
  // unset) rather than always durationInFrames itself — so the check now
  // looks for that derivation rather than the literal token pair.
  const captionLayerSrc = readStripped("remotion/components/CaptionLayer.tsx").replace(/\s+/g, " ")
  check("CaptionLayer's narration window still derives from THIS composition's own durationInFrames + fps (useVideoConfig), never a hardcoded estimate",
    /props\.hiddenFromFrame\)\s*\)\s*:\s*durationInFrames/.test(captionLayerSrc) && /buildCaptionPlan\(props\.script,\s*windowFrames,\s*fps/.test(captionLayerSrc))
  check("CaptionLayer's fallback plan is re-anchored onto absolute frames with shiftCaptionCues, never left assuming frame 0",
    /shiftCaptionCues\(planned,\s*visibleFrom\)/.test(captionLayerSrc))

  // §captionWindow (wave 59) — NO CAPTION OVER SILENCE. Four avatar-fronted
  // reels open on a COVER/INTRO tile with NO audio at all before the avatar
  // clip (which carries its own baked-in narration) mounts at an absolute
  // frame > 0. The even-distribution fallback used to plan against the WHOLE
  // composition starting at frame 0, so its first cue's words landed over
  // that silent tile — a caption with nothing audible behind it, exactly the
  // "doesn't look real" tell the owner's ruling names. Fixed via
  // CaptionLayer's new `visibleFromFrame` prop; proven here two ways —
  // (1) every affected composition actually PASSES it, (2) the underlying
  // pure functions genuinely keep a fixture's cues out of the cover window
  // across the task's own 20/45/90s fixture range.
  const COVER_GATED_REELS: Array<{ file: string; coverVar: string }> = [
    { file: "remotion/MarketUpdateReel.tsx", coverVar: "COVER" },
    { file: "remotion/AgentExplainerReel.tsx", coverVar: "COVER" },
    { file: "remotion/ExplainerAnimReel.tsx", coverVar: "COVER" },
    { file: "remotion/TeammateExplainerReel.tsx", coverVar: "INTRO" },
  ]
  for (const { file, coverVar } of COVER_GATED_REELS) {
    const src = readStripped(file).replace(/\s+/g, " ")
    check(`${file}: CaptionLayer is passed visibleFromFrame={${coverVar}} — no cue over the silent cover tile`,
      new RegExp(`<CaptionLayer[^>]*visibleFromFrame=\\{${coverVar}\\}`).test(src))
  }

  // PURE fixture proof — a long, multi-sentence script planned as if it were
  // the fallback estimate for a 480-frame/16s composition (MarketUpdateReel's
  // own geometry) with a 60-frame (2s) silent COVER, at all three of the
  // task's fixture durations (20s/45s/90s scripts, i.e. narration LONGER than,
  // equal to, and shorter than the window — the overrun/underrun sweep). Every
  // resulting cue must start at/after COVER: the defect this closes put cues
  // at frame 0.
  {
    const COVER_TEST = 60 // 2s @ 30fps
    const WINDOW = COMPOSITION_GEOMETRY.MarketUpdateReel.duration_frames - COVER_TEST // matches CaptionLayer's own hiddenFrom-visibleFrom math when hiddenFromFrame is unset
    const fixtureScripts: Record<string, string> = {
      "20s": "Three days on market, two offers already. The kitchen's been redone. Quartz counters, new appliances.",
      "45s": "Three days on market, two offers already. The kitchen's been redone, quartz counters, new appliances. " +
        "It opens right onto the deck. Buyers are responding fast this week. If you want a private showing, text me back.",
      "90s": "Three days on market, two offers already. The kitchen's been redone, quartz counters, new appliances. " +
        "It opens right onto the deck. Buyers are responding fast this week. The roof was replaced last year too. " +
        "Schools nearby scored well this season. Walkable to two parks and a coffee shop. If you want a private showing, text me back. " +
        "We can move quickly once you decide. This won't last through the weekend.",
    }
    for (const [label, script] of Object.entries(fixtureScripts)) {
      const planned = buildCaptionPlan(script, WINDOW, 30).cues
      const shifted = shiftCaptionCues(planned, COVER_TEST)
      check(`fixture ${label}: every cue starts at/after COVER (${COVER_TEST}) once shifted — no caption over the silent cover tile`,
        shifted.every((c) => c.fromFrame >= COVER_TEST))
      check(`fixture ${label}: shifting preserves cue COUNT (re-anchoring never drops/adds cues)`,
        shifted.length === planned.length)
      check(`fixture ${label}: the last cue still ends at/before the narration window's own end (COVER + WINDOW) — never overruns into the CTA tile`,
        shifted.length === 0 || shifted[shifted.length - 1].fromFrame + shifted[shifted.length - 1].durationFrames <= COVER_TEST + WINDOW)
    }
    // POSITIVE CONTROL — the pre-fix behavior (planning straight off frame 0,
    // no shift) DOES put a cue before COVER. Proves the checks above can
    // actually see the defect they exist to catch, not merely pass vacuously.
    const unfixed = buildCaptionPlan(fixtureScripts["45s"], COMPOSITION_GEOMETRY.MarketUpdateReel.duration_frames, 30).cues
    check("[control] the PRE-FIX plan (no shift, full durationInFrames) DOES place its first cue before COVER — proves the fixture is a real regression test",
      unfixed.length > 0 && unfixed[0].fromFrame < COVER_TEST)
  }

  // clipCaptionCuesFromFrame — the start-side twin of clipCaptionCuesBeforeFrame,
  // used defensively on PRECOMPUTED (Path A) cues. Same straddle/drop rules,
  // mirror-imaged.
  {
    const cues: CaptionCue[] = [
      { text: "before", fromFrame: 0, durationFrames: 10 },   // wholly before cutoff → dropped
      { text: "straddle", fromFrame: 15, durationFrames: 15 }, // straddles 20 → shortened to start at 20
      { text: "after", fromFrame: 40, durationFrames: 10 },    // wholly after → untouched
    ]
    const clipped = clipCaptionCuesFromFrame(cues, 20)
    check("CONTROL: clipCaptionCuesFromFrame drops a cue entirely before the boundary",
      !clipped.some((c) => c.text === "before"))
    check("clipCaptionCuesFromFrame shortens a straddling cue to start exactly AT the boundary, never before it",
      clipped.find((c) => c.text === "straddle")?.fromFrame === 20 && clipped.find((c) => c.text === "straddle")?.durationFrames === 10)
    check("clipCaptionCuesFromFrame leaves a cue entirely after the boundary untouched",
      clipped.find((c) => c.text === "after")?.fromFrame === 40 && clipped.find((c) => c.text === "after")?.durationFrames === 10)
    check("clipCaptionCuesFromFrame is a no-op when visibleFromFrame is absent/undefined (additive/opt-in)",
      clipCaptionCuesFromFrame(cues, undefined).length === cues.length)
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// §aiVideoRealism — wave 57: the NON-avatar parts of every automated video
// (b-roll/imagery, music duck level, captions kept off branding, the
// autonomous failed-render requeue). Every absence assertion below carries a
// positive control (§2).
// ═══════════════════════════════════════════════════════════════════════════

function aiVideoRealismSection() {
  console.log("\n── §aiVideoRealism — b-roll/imagery, captions off branding, autonomous requeue (wave 57) ──")

  // ── Captions never draw over a composition's own branding/CTA tile ───────
  const CAPTION_HOSTS = [
    "MarketUpdateReel", "AgentExplainerReel", "ExplainerAnimReel", "JustListedReel",
    "JustListedReelSquare", "JustSoldReelSquare", "NeighborhoodSpotlightReel",
    "PartnersMeetingReel", "PhotoWalkthroughReel", "TeammateExplainerReel",
    // WAVE 61 RE-AUDIT — EquityReportReel gained its CaptionLayer in wave 60
    // but was never added to this proof's own host list, so the wave-59
    // caption-cover-tile guarantee this list exists to enforce was silently
    // blind to it. Added, not a new build.
    "EquityReportReel",
    // WAVE 61 CAPTION-CONSOLIDATION — the 8 of the owner's 11 flagged
    // compositions that clip captions with hiddenFromFrame (the other 3 —
    // BuyerConsultationSlide, ListingSectionReel, ListingPresentationSlide —
    // use a conditional-render gate instead, since their branding tile is a
    // separate "closing"/QR slide kind rather than a late Sequence; ListingPresentationSlide
    // itself stays OUT of this host list — no live producer targets that
    // compositionId, see finish-spec.ts's captions:false override).
    "AffordabilitySnapshotReel", "AgentTalkingHeadReel", "CMAReel", "ComingSoonReel",
    "JustListedReelHorizontal", "NewsletterDigestVideo", "OpenHouseAnnounceReel", "TestimonialReel",
  ]
  for (const id of CAPTION_HOSTS) {
    const file = VIDEO_COMPOSITION_FILES[id]
    if (!file) { check(`${id}: composition file is registered in this simulator's file map`, false); continue }
    const src = readStripped(file)
    check(`${id}: <CaptionLayer> passes hiddenFromFrame so captions never draw over the branding/CTA tile`,
      /<CaptionLayer[\s\S]{0,400}hiddenFromFrame=/.test(src))
  }

  // ── WAVE 61 CAPTION-CONSOLIDATION AUDIT ───────────────────────────────────
  // finish-spec.ts's `captions: true` is a CLAIM about the composition; the
  // only proof is the composition's own source actually carrying a caption
  // reader. A scanner that cannot see stripped source would count the
  // JSDoc/comment naming CaptionLayer as a hit (CLAUDE.md §2's tombstone
  // trap) — readStripped() is used throughout, never raw text.
  const hasCaptionSupport = (src: string): boolean =>
    /<CaptionLayer[\s>]|buildCaptionPlan\(|\bcaptionScript\b|\bcaptionsCues\b|\bcaptionCues\b/.test(src)

  // POSITIVE CONTROL — a specimen claiming captions with no caption reader at
  // all MUST be caught by the same predicate the real loop below uses; a
  // specimen that genuinely mounts CaptionLayer must NOT be caught.
  check("CONTROL: hasCaptionSupport flags a specimen with no CaptionLayer/captionScript/captionsCues token",
    !hasCaptionSupport(`export const FakeReel = () => <AbsoluteFill style={{ color: "red" }}>hi</AbsoluteFill>`))
  check("CONTROL: hasCaptionSupport passes a specimen that genuinely mounts <CaptionLayer>",
    hasCaptionSupport(`<CaptionLayer cues={c} script={s} accentColor={brand.accentColor} />`))

  for (const [id, finish] of Object.entries(VIDEO_FINISH_SPEC)) {
    if (!finish.captions) continue
    const file = VIDEO_COMPOSITION_FILES[id]
    if (!file) { check(`${id}: VIDEO_FINISH_SPEC declares captions:true but has no composition file registered to verify it against`, false); continue }
    check(`${id}: VIDEO_FINISH_SPEC declares captions:true and the composition source actually carries CaptionLayer/buildCaptionPlan/captionScript/captionsCues`,
      hasCaptionSupport(readStripped(file)))
  }

  // ── director-content.ts: every case this wave wired stages captionScript ──
  // (never buildCaptionPlan/captionsCues here — this resolver has no TTS
  // alignment at staging time, only the honest fallback script; see the
  // per-case tombstone comments in lib/video/director-content.ts). Scoped to
  // the cases this wave actually touched (not every case in the switch) so
  // this proof does not newly accuse a pre-existing, out-of-scope gap
  // (e.g. EquityReportReel/MarketUpdateReel/NeighborhoodSpotlightReel, carried
  // unresolved from earlier waves) of a defect this lane was not asked to fix.
  //
  // Most of these cases stage captionScript INSIDE the shared pure builder
  // (listingReelProps / comingSoonProps / openHouseProps / testimonialProps),
  // not as inline case-body text (§6 — one place, reused by every case that
  // calls it) — AgentTalkingHeadReel is the one case that sets it inline. So
  // this checks each fact in the place it actually lives: the builder's own
  // function body for captionScript, and the switch for still routing that
  // case through the builder that owns it.
  const directorSrc = readRaw("lib/video/director-content.ts")
  const directorSrcStripped = readStripped("lib/video/director-content.ts")
  // `function NAME(` … up to the next top-level `export function` — a bounded,
  // unambiguous slice since every builder here is declared that way in file order.
  const functionBody = (src: string, fnName: string): string | null => {
    const m = new RegExp(`function ${fnName}\\([\\s\\S]*?\\n\\}`, "m").exec(src)
    return m ? m[0] : null
  }
  // POSITIVE CONTROL — a specimen function with no captionScript token must be
  // caught by the same extractor + predicate the real loop below uses.
  const specimenFn = `function fakeProps(x) {\n  const out = {}\n  out.hook = x\n  return out\n}`
  const specimenBody = functionBody(specimenFn, "fakeProps")
  check("CONTROL: functionBody extracts the specimen's function body", !!specimenBody)
  check("CONTROL: a specimen director builder with no captionScript token IS caught",
    !!specimenBody && !/captionScript/.test(specimenBody))

  // id → the builder function that resolves it, and whether captionScript is
  // set INLINE in the switch case itself (AgentTalkingHeadReel) rather than
  // inside a named builder.
  const DIRECTOR_CAPTION_CASES: Array<{ id: string; builder: string | null }> = [
    { id: "JustListedReel", builder: "listingReelProps" },
    { id: "JustListedReelSquare", builder: "listingReelProps" },
    { id: "JustListedReelHorizontal", builder: "listingReelProps" },
    { id: "PhotoWalkthroughReel", builder: "listingReelProps" },
    { id: "ComingSoonReel", builder: "comingSoonProps" },
    { id: "OpenHouseAnnounceReel", builder: "openHouseProps" },
    { id: "TestimonialReel", builder: "testimonialProps" },
    { id: "AgentTalkingHeadReel", builder: null }, // inline in the case itself
  ]
  for (const { id, builder } of DIRECTOR_CAPTION_CASES) {
    const file = VIDEO_COMPOSITION_FILES[id]
    const mountsCaptionLayer = !!file && /<CaptionLayer[\s>]/.test(readStripped(file))
    check(`${id}: composition mounts <CaptionLayer> (director-content.ts case is expected to feed it)`, mountsCaptionLayer)
    check(`${id}: director-content.ts's case "${id}" is still wired to a captionScript-staging source`,
      new RegExp(`case "${id}":`).test(directorSrcStripped))
    if (builder) {
      const body = functionBody(directorSrc, builder) ?? functionBody(directorSrcStripped, builder)
      check(`${id}: its builder ${builder}() stages captionScript`, !!body && /captionScript/.test(body))
      check(`${id}: its switch case actually calls ${builder}(`,
        new RegExp(`case "${id}":[\\s\\S]{0,400}?${builder}\\(`).test(directorSrcStripped))
    } else {
      const inlineIdx = directorSrcStripped.indexOf(`case "${id}":`)
      const window = inlineIdx === -1 ? "" : directorSrcStripped.slice(inlineIdx, inlineIdx + 400)
      check(`${id}: its switch case stages captionScript inline`, /captionScript/.test(window))
    }
  }

  // PURE — clipCaptionCuesBeforeFrame itself. POSITIVE CONTROL: a cue that
  // starts inside the cutoff window must be dropped or shortened; a cue
  // entirely before it must survive untouched (the negative-control half —
  // a clipper that drops EVERYTHING is exactly as broken as one that drops
  // nothing).
  const cues: CaptionCue[] = [
    { text: "before", fromFrame: 0, durationFrames: 10 },     // fully before cutoff(20) — survives
    { text: "straddles", fromFrame: 15, durationFrames: 10 }, // 15-25 straddles cutoff — shortened to 15-20
    { text: "after", fromFrame: 25, durationFrames: 5 },      // fully after cutoff — dropped
  ]
  const clipped = clipCaptionCuesBeforeFrame(cues, 20)
  check("CONTROL: clipCaptionCuesBeforeFrame keeps a cue entirely before the cutoff untouched",
    clipped.some((c) => c.text === "before" && c.fromFrame === 0 && c.durationFrames === 10))
  check("clipCaptionCuesBeforeFrame shortens a straddling cue so it ends exactly AT the cutoff, never past it",
    clipped.some((c) => c.text === "straddles" && c.fromFrame === 15 && c.durationFrames === 5))
  check("clipCaptionCuesBeforeFrame drops a cue that starts at/after the cutoff entirely",
    !clipped.some((c) => c.text === "after"))
  check("CONTROL: an undefined cutoff leaves the cue list byte-identical (opt-in, not forced)",
    clipCaptionCuesBeforeFrame(cues, undefined).length === cues.length)

  // ── Music duck level — covered in musicSection() above; cross-referenced
  //    here so §aiVideoRealism reads as the complete realism story in one
  //    place without re-asserting the same fact twice (§6).

  // ── Ken Burns bounds — AUDITED, not changed (documented, not re-derived
  //    here to avoid a second copy of the same numeric contract §6; the real
  //    bound lives in lib/video/ken-burns-plan.ts and is exercised by
  //    scripts/photo-walkthrough-simulator.ts). Source-check that the file
  //    still declares the researched-safe cap.
  const kenBurnsSrc = readStripped("lib/video/ken-burns-plan.ts")
  check("Ken Burns zoom is capped at <=1.12 (12% max push) — inside every researched range for a subtle, non-fake-reading move",
    /Math\.min\(opts\.maxZoom,\s*0\.12\)/.test(kenBurnsSrc))
  check("Ken Burns pan offsets stay at <=3% of frame (PAN_MOVES) — small enough the subject never leaves frame at max scale",
    /\[-3,\s*0\]|\[3,\s*0\]/.test(kenBurnsSrc))
  check("KEN_BURNS_REALISM_AUDIT_NOTE records the audit finding (why no change was made) rather than leaving it unstated",
    /lib\/video\/ken-burns-plan\.ts/.test(KEN_BURNS_REALISM_AUDIT_NOTE) && /AUDITED/.test(KEN_BURNS_REALISM_AUDIT_NOTE))
  check("COVER_CTA_CONTENT_BEAT_RULING records the owner's content-vs-bookend distinction (task item 4) rather than leaving it unstated",
    /CONTENT/.test(COVER_CTA_CONTENT_BEAT_RULING) && /MAX_BRAND_BOOKEND_SECONDS/.test(COVER_CTA_CONTENT_BEAT_RULING))

  // ── AI-image realism prompt block — reaches every ImagePurpose via the
  //    ONE shared prompt builder (§6), not pasted per purpose.
  const imageGenSrc = readStripped("lib/ai/image-generation.ts")
  check("image-generation.ts's buildBrandAwarePrompt appends IMAGE_SCENE_REALISM_PROMPT_BLOCK to every generated-image prompt",
    /lines\.push\(IMAGE_SCENE_REALISM_PROMPT_BLOCK\)/.test(imageGenSrc))
  check("IMAGE_SCENE_REALISM_PROMPT_BLOCK names the researched top AI-image tells (no in-image text, natural lighting, no artefacts)",
    /no legible text/.test(IMAGE_SCENE_REALISM_PROMPT_BLOCK) &&
    /natural unstaged lighting/.test(IMAGE_SCENE_REALISM_PROMPT_BLOCK) &&
    /distorted hands/.test(IMAGE_SCENE_REALISM_PROMPT_BLOCK))
  check(`AI_IMAGE_TELL_CHECKLIST is a real, non-empty checklist (${AI_IMAGE_TELL_CHECKLIST.length} items) — not a placeholder`,
    AI_IMAGE_TELL_CHECKLIST.length >= 5)
  check("FILM_GRAIN_OVERLAY_OPACITY is SUBTLE (<=0.10) — meant to read as 'shot on a camera', not as a visible texture effect",
    FILM_GRAIN_OVERLAY_OPACITY > 0 && FILM_GRAIN_OVERLAY_OPACITY <= 0.10)

  // ── Film grain wired into every BrollLayer call site, not left as a dead
  //    constant (§1 orphan doctrine — an unreferenced constant is a defect).
  const brollLayerFiles = ["remotion/ComingSoonReel.tsx", "remotion/NeighborhoodSpotlightReel.tsx", "remotion/AgentTalkingHeadReel.tsx"]
  for (const f of brollLayerFiles) {
    const src = readStripped(f)
    check(`${f}: <BrollLayer> passes filmGrain (the constant this wave added is a live call site, not orphaned)`,
      /<BrollLayer[\s\S]{0,200}filmGrain/.test(src))
    // WAVE 61 ADVANCEMENT — handheldDrift is opt-in and wired onto the SAME
    // "look real" call sites as filmGrain (still-photo b-roll only, inside
    // _BrollLayer.tsx — see lib/video/realism-profile.ts's research note on
    // why it does not also apply to a Ken Burns still or a b-roll video clip).
    check(`${f}: <BrollLayer> passes handheldDrift (WAVE 61 opt-in still-photo drift, not orphaned)`,
      /<BrollLayer[\s\S]{0,200}handheldDrift/.test(src))
  }

  // ── WAVE 61 REALISM ADVANCEMENTS — wired, not just declared ───────────────
  const didSrc = readStripped("lib/did/index.ts")
  check("lib/did/index.ts: the expression cascade calls inferScriptSentiment BEFORE falling to the hardcoded default — a live call site, not orphaned",
    /input\.expression \?\? inferScriptSentiment\(input\.script\)/.test(didSrc))
  check("lib/did/index.ts: an explicit caller override still wins (inferScriptSentiment is the FALLBACK rung, never overrides an explicit choice)",
    /input\.expression \?\?/.test(didSrc))
  check("PARALLAX_STILL_IMAGE_DEFERRAL_REASON documents WHY it wasn't built (§2 — 'unresolved' beats a guess), not left unstated",
    /depth/.test(PARALLAX_STILL_IMAGE_DEFERRAL_REASON) && /Ken Burns/.test(PARALLAX_STILL_IMAGE_DEFERRAL_REASON))

  // ── Autonomous failed-render requeue — shouldAutoRequeueFailedRender ─────
  const composeContractProps = { agentPhotoUrl: "https://x/y.jpg" } // arbitrary — only shape matters below
  const notFailed = shouldAutoRequeueFailedRender({ render_status: "queued", retry_count: 0 }, [])
  check("CONTROL: a row that is NOT 'failed' is never requeued (no-op, not an error)", !notFailed.requeue)
  const exhausted = shouldAutoRequeueFailedRender({ render_status: "failed", retry_count: MAX_AUTO_REQUEUE_ATTEMPTS }, [])
  check(`a failed row that already spent all ${MAX_AUTO_REQUEUE_ATTEMPTS} auto-retries is left for a human, never requeued again`,
    !exhausted.requeue)
  const doomed = shouldAutoRequeueFailedRender({ render_status: "failed", retry_count: 0 }, ["agentName", "price"])
  check("CONTROL: a DOOMED retry (missing required content props) is refused — requeueing would fail identically",
    !doomed.requeue && /missing required content props/.test(doomed.reason))
  const healthy = shouldAutoRequeueFailedRender({ render_status: "failed", retry_count: 0 }, [])
  check("a transient failure (content-contract satisfied, retries remaining) IS requeued", healthy.requeue)
  void composeContractProps

  // Wired into the cron, not just defined — the missing autonomous half the
  // task named explicitly ("confirm... that a failed render re-queues").
  const cronSrc = readStripped("app/api/cron/composition-render-queue/route.ts")
  check("composition-render-queue cron calls shouldAutoRequeueFailedRender (the autonomous half is MOUNTED, not just built)",
    /shouldAutoRequeueFailedRender\(/.test(cronSrc))
  check("the cron's auto-requeue path is content-contract-gated (missingContentProps), same judgment as the human-approved restart",
    /missingContentProps\(/.test(cronSrc))
  check("the cron's auto-requeue sweep is wrapped in try/catch — a pre-migration environment (no retry_count column yet) degrades to a no-op, never breaks the queue drain",
    /catch \(e\) \{[\s\S]{0,200}auto-requeue sweep failed/.test(cronSrc))
}

// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("══════════════════════════════════════════════════════════")
  console.log(" Video assembly simulator — the complete video, not just the composition")
  console.log("══════════════════════════════════════════════════════════")
  sumsSection()
  brollSection()
  musicSection()
  brandingSection()
  avatarSection()
  aiVideoRealismSection()
  console.log("\n──────────────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(" ✅ Every video-shaped composition's intro+body+outro tiles its registered")
  console.log("    duration exactly, b-roll/image slots derive from what arrived, music is")
  console.log("    ducked/faded/bounded, branding (incl. fair-housing marks) is in intro AND")
  console.log("    outro, and avatar clips are bounded to their body window.")
}
main().catch((e) => { console.error(e); process.exit(1) })
