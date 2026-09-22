/**
 * scripts/composition-segments.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE composition-timeline extractor for the video proofs (§6 — one
 * spelling). A whitelisted arithmetic evaluator that reads a Remotion
 * composition's own declared frame constants (COVER/BODY/OUTRO-style consts,
 * or a `FRAMES = {...}` object) plus every top-level tag using the
 * `from={…}`/`durationInFrames={…}` contract, and tiles them against the
 * registered geometry.
 *
 * TOMBSTONE (lane 77D): these functions were declared in
 * scripts/video-assembly-simulator.ts (§sums, lines 109-328 before this move)
 * and imported back there. They moved because scripts/video-type-matrix-
 * simulator.ts needs the SAME extraction for the per-type matrix, and a
 * second copy of an evaluator is exactly the drift CLAUDE.md §6 forbids —
 * the day the two disagreed, one proof would accuse a composition the other
 * cleared. Nothing runs at module load; this is a library for proofs only
 * (lib/** must never import it — it reads source files as text).
 *
 * §2: callers hand this STRIPPED source (scripts/strip-comments.ts) — a
 * tombstone naming `<Sequence from={X}>` must never read as a live segment.
 */
import type { RegisteredGeometry } from "../lib/remotion/composition-geometry"
import { computeAssemblyTimeline } from "../lib/video/assembly-timeline"
import { compositionDurationSpec } from "../lib/video/duration-model"

/** Every registered VIDEO composition's remotion/ source file, by id. STILLS
 *  (duration_frames === 1) are out of scope — they have no timeline to tile. */
export const VIDEO_COMPOSITION_FILES: Record<string, string> = {
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
  // Lane 78D — props-driven timeline (memoryVideoChapterLayout); checked by
  // its own rule in the callers, never by the const-chain tiler.
  MemoryVideoReel: "remotion/MemoryVideoReel.tsx",
  // Single-segment slides — the WHOLE duration is one continuous body (an
  // avatar PIP rides over it via avatarStartFrame/avatarEndFrame, not a
  // Sequence chain). The callers check these by their own rule.
  ListingPresentationSlide: "remotion/ListingPresentationSlide.tsx",
  BuyerConsultationSlide: "remotion/BuyerConsultationSlide.tsx",
}

/** Compositions whose split is NOT a flat top-level Sequence chain this tiler
 *  can resolve: derived at render time (PhotoWalkthroughReel), a nested "ask"
 *  Sequence (PartnersMeetingReel), or a single continuous body (the slides and
 *  ListingSectionReel). Callers check each by its own rule — the reason per id
 *  is recorded where the rule lives (video-assembly-simulator §sums). */
export const NON_CHAIN_COMPOSITIONS: ReadonlySet<string> = new Set([
  "ListingPresentationSlide", "BuyerConsultationSlide", "PhotoWalkthroughReel", "PartnersMeetingReel", "ListingSectionReel",
  // Lane 78D: every slot is computed from props (lib/video/memory-video-
  // composition.ts) and the length from calculateMetadata — no const chain.
  "MemoryVideoReel",
])

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

export function safeEval(expr: string, scope: Record<string, unknown>): number {
  const cleaned = expr.trim()
  if (!SAFE_EXPR.test(cleaned)) throw new Error(`unsafe expression: ${cleaned}`)
  const names = Object.keys(scope)
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(...names, `"use strict"; return (${cleaned});`)
  const out = fn(...names.map((n) => scope[n]))
  if (typeof out !== "number" || !Number.isFinite(out)) throw new Error(`non-numeric result: ${cleaned}`)
  return out
}

/** Build the numeric scope for one composition: fps/FPS from the registered
 *  geometry, durationInFrames=the registered total (PartnersMeetingReel
 *  derives cardTotal from it), FRAMES.<key> flattened from a FRAMES object when
 *  present, then every `const NAME = EXPR` that evaluates cleanly against the
 *  scope built so far — evaluated in file order, skipping (not failing on) any
 *  declaration that is not simple arithmetic (strings, JSX, object literals,
 *  ternaries) because this checker only needs the numeric timeline consts. */
export function buildScope(source: string, geometry: RegisteredGeometry, compositionId?: string): Record<string, number> {
  const scope: Record<string, number> = { fps: geometry.fps, FPS: geometry.fps, durationInFrames: geometry.duration_frames }

  // THE DERIVED-BODY IDIOM (wave 78, lib/video/duration-model.ts): a
  // composition reads its bookends from the ONE registry —
  //   const BOOKENDS = compositionBookends("X"); const COVER = BOOKENDS.introFrames
  // — and its body from the duration it is rendering at —
  //   const timeline = computeAssemblyTimeline({ durationInFrames, introFrames: COVER, outroFrames: OUTRO })
  //   const BODY = timeline.body.durationInFrames
  // Neither right-hand side is arithmetic this evaluator can run, so both are
  // seeded here through the SAME two survivors the composition calls, at the
  // `durationInFrames` the geometry hands in (the registered cap by default; a
  // planned duration when a proof passes one). A hardcoded body reintroduced
  // beside them no longer tiles at any other duration — which is the control.
  const spec = compositionId ? compositionDurationSpec(compositionId) : null
  if (spec) {
    ;(scope as Record<string, unknown>).BOOKENDS = { introFrames: spec.introFrames, outroFrames: spec.outroFrames }
    ;(scope as Record<string, unknown>).timeline = computeAssemblyTimeline({
      durationInFrames: geometry.duration_frames, introFrames: spec.introFrames, outroFrames: spec.outroFrames,
    })
  }

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

export interface Segment { tag: string; from: number; duration: number; fromExpr: string; durExpr: string }

/** Resolvable `durationInFrames` values off KEYED tags — a `.map()`-generated
 *  repeat (per-shot images, per-card stats, per-proof beats) that a flat
 *  top-level tiler cannot see AS individual entries, because their `from`
 *  expressions reference the map's own loop variable (`i`, `idx`) and are
 *  therefore unresolvable by design (extractSegments already drops them for
 *  exactly that reason). What CAN be resolved, when the keyed tag's own
 *  `durationInFrames` does not reference the loop variable, is how big ONE
 *  repeat is — enough to explain a gap between two resolved top-level
 *  segments as "N repeats of a keyed shot", not a real hole in the timeline. */
export function extractKeyedUnitDurations(source: string, scope: Record<string, number>): number[] {
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
export function gapExplainedByKeyedRepeat(gapFrames: number, unitSizes: number[]): number | null {
  for (const size of unitSizes) {
    if (size > 0 && gapFrames % size === 0) return gapFrames / size
  }
  return null
}

/** Every from/durationInFrames tag this checker could resolve to numbers,
 *  in source order. Unresolvable candidates (a generic wrapper DEFINITION
 *  using its own prop names as the expression, e.g. CMAReel's
 *  `<Sequence from={from} durationInFrames={durationInFrames}>` inside the
 *  `Slide` component itself) throw on an unknown identifier and are DROPPED —
 *  correctly, since they are not a literal instantiation. */
export function extractSegments(source: string, scope: Record<string, number>): Segment[] {
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

export interface TileResult {
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
 * in the callers exercise it directly with synthetic segment lists.
 */
export function tileSegments(segments: Segment[], expectedTotal: number): TileResult {
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

/**
 * Tile a Sequence-chain composition, explaining a gap that is exactly N
 * repeats of a keyed per-shot Sequence (a `.map()` loop the evaluator cannot
 * resolve by index) rather than reporting it as a hole. Returns the tile
 * result plus the note the caller should print. Shared by both proofs so the
 * "gap explained by keyed repeat" rule has one spelling.
 */
export function tileChain(source: string, scope: Record<string, number>, expectedTotal: number): TileResult & { note: string } {
  const segments = extractSegments(source, scope)
  let result = tileSegments(segments, expectedTotal)
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
  return { ...result, note }
}

/**
 * The composition-absolute NARRATION WINDOW a composition declares on its own
 * `<CaptionLayer>` — `visibleFromFrame` (the frame real audio starts; 0 when
 * absent, a root `<Audio>` narrates from frame 0) and `hiddenFromFrame` (the
 * frame the branding/CTA tile starts; the registered total when absent).
 * Resolved through the SAME scope as the segment tiler, so a composition that
 * writes `visibleFromFrame={COVER}` is read at COVER's real value. A literal
 * (ProductPromoReel's `hiddenFromFrame={330}`) resolves through safeEval too.
 * `declared` says whether the composition mounts a CaptionLayer at all.
 */
export function narrationWindow(source: string, scope: Record<string, number>, total: number): { from: number; to: number; declared: boolean } {
  const tag = /<CaptionLayer\b([\s\S]*?)\/>/.exec(source)
  if (!tag) return { from: 0, to: total, declared: false }
  const attrs = tag[1]
  const read = (name: string, fallback: number): number => {
    const m = new RegExp(`${name}=\\{([^}]+)\\}`).exec(attrs)
    if (!m) return fallback
    try { return safeEval(m[1], scope) } catch { return fallback }
  }
  const from = Math.max(0, Math.min(total, read("visibleFromFrame", 0)))
  const to = Math.max(from, Math.min(total, read("hiddenFromFrame", total)))
  return { from, to, declared: true }
}
