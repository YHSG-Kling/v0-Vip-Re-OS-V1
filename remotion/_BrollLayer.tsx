/**
 * remotion/_BrollLayer.tsx
 *
 * Wave 39 — shared B-roll overlay primitive used by the neighborhood,
 * coming-soon, and (future) market-update compositions.
 *
 * Concept: many real-estate marketing reels need a layer of generic
 * cutaway footage — city skyline, lifestyle shot, key handoff,
 * neighborhood walk — to fill space between agent-driven moments.
 * Buying that footage stock is fine; producing fresh per-listing
 * B-roll is impractical. This helper takes a list of B-roll URLs
 * (the composer pulls them from brand_asset_library or the
 * content_bank's broll table) and cuts through them on a fixed
 * cadence with a soft cross-fade so the eye reads continuity.
 *
 * Why not a full composition: the B-roll layer is OPTIONAL on every
 * composition that uses it; when no B-roll is supplied the layer
 * returns null and the parent composition uses its solid-color
 * background. Keeping it as a sub-component (not a Composition)
 * lets the parent control timing instead of chaining Sequences.
 *
 * Cost note: this is pure Remotion — no D-ID hit, no API cost. The
 * agent's cloned voice is OPTIONALLY layered on top via the parent
 * composition's <Audio> when narration matters; many B-roll-heavy
 * formats run silent + caption (which is fine for muted feed).
 */
import React from "react"
import { Video } from "@remotion/media"
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion"
import { SafeImg } from "./components/SafeImg"
import { selectBrollPlan } from "../lib/video/broll-plan"

export interface BrollClip {
  /** Either an image URL OR a video URL. The helper detects by
   *  file extension; .mp4/.webm/.mov use the <Video> primitive,
   *  everything else falls back to <Img>. */
  url:           string
  /** Optional caption shown over the bottom of the clip — useful
   *  for neighborhood reels labeling each segment (e.g.
   *  "Brickell promenade"). 6-10 words. */
  caption?:      string
  /**
   * THE CLIP'S OWN LENGTH IN SECONDS, as measured upstream
   * (lib/video/broll-picker.ts: Mediabunny probe → stored
   * video_assets.duration_seconds → DEFAULT_CLIP_SECONDS).
   *
   * WHY IT IS HERE (2026-09-05). Without it this layer had exactly one number
   * to divide by — the clip COUNT — so it split its frame window EVENLY. An
   * even slot is not bounded by anything the clip can deliver: a 4-second
   * cutaway handed a 5.3-second slot is asked to play past its own end, and
   * past its end a `<Video>` HOLDS ITS LAST FRAME. The reel showed a frozen
   * still where it promised motion and the render reported success — the same
   * silent-wrong-thing shape scripts/broll-window-guard.ts closed for a clip's
   * START and published this as its blind spot.
   *
   * OPTIONAL, and honestly so: `lib/agents/seller-update-reel-producer.ts`
   * builds clips from bare URLs with nothing measured. When ANY clip lacks a
   * positive duration the layer falls back to the even division it always did
   * — no regression, and the guard counts that fallback rather than hiding it.
   */
  durationSeconds?: number
}

export interface BrollLayerProps {
  clips:               BrollClip[]
  /** Total frames the layer should occupy. Divided into slots by
   *  `brollSlots`: by each clip's MEASURED length when the clips
   *  carry `durationSeconds` (so no clip is ever asked to play past
   *  its own end), else evenly across the clips as before. */
  totalFrames:         number
  /** Cross-fade duration between adjacent clips. Defaults to 10
   *  frames (~0.33s @ 30fps). Treated as a REQUEST, not a promise:
   *  it is capped to half of either adjacent slot AND to the tail
   *  `brollSlots` was able to reserve out of the outgoing clip's own
   *  footage. A clip with no spare footage gets a hard cut rather
   *  than a dissolve from a frozen frame. */
  crossfadeFrames?:    number
  /** Overlay tint — when present, every clip gets a colored alpha
   *  overlay so on-top captions stay legible. Pass the brand
   *  primaryColor at low alpha (e.g. "rgba(15,23,42,0.45)"). */
  overlayColor?:       string
  /** When true, the clips loop within the parent's playhead. Useful
   *  for compositions longer than the supplied B-roll. Defaults to
   *  true — the cost of looping is zero and it prevents black
   *  flashes if the composer mis-sizes the clip count. */
  loop?:               boolean
}

function isVideoUrl(url: string): boolean {
  const ext = url.split("?")[0].split("#")[0].toLowerCase()
  return ext.endsWith(".mp4") || ext.endsWith(".webm") || ext.endsWith(".mov") || ext.endsWith(".m4v")
}

/**
 * The frame window one clip occupies, in the coordinate space of whatever
 * sequence this layer is mounted in (composition root for ComingSoon /
 * Neighborhood, the BODY sequence for AgentTalkingHead).
 *
 * EXPORTED FOR ITS PROOF, and derived here rather than inline in the render so
 * the arithmetic is testable without a browser: scripts/broll-window-guard.ts
 * asserts that a clip's window START is where its playback must begin.
 */
export interface BrollWindow {
  /** Index into `clips`. */
  index: number
  /** First frame of this clip's slot. */
  from: number
  /** How many frames the slot runs. */
  durationFrames: number
}

/**
 * Which clip is on screen at `effectiveFrame`, and WHERE ITS SLOT STARTED.
 *
 * The second half is the part that was missing. PURE — no Remotion, no DOM.
 */
export function brollWindowAt(
  clipCount: number,
  totalFrames: number,
  effectiveFrame: number,
): BrollWindow | null {
  if (clipCount <= 0 || !(totalFrames > 0)) return null
  const perClip = Math.max(1, Math.floor(totalFrames / clipCount))
  const index = Math.min(clipCount - 1, Math.max(0, Math.floor(effectiveFrame / perClip)))
  // The last clip absorbs the remainder of the window, so its slot is longer
  // than perClip whenever totalFrames does not divide evenly.
  const durationFrames = index === clipCount - 1
    ? Math.max(1, totalFrames - index * perClip)
    : perClip
  return { index, from: index * perClip, durationFrames }
}

/**
 * A clip's own length in FRAMES, or null when nobody measured it.
 *
 * The floor matters: a slot must never round UP past footage that does not
 * exist. `Math.max(1, …)` keeps a sub-frame clip renderable at all.
 */
export function clipFrames(clip: BrollClip, fps: number): number | null {
  const s = clip?.durationSeconds
  if (typeof s !== "number" || !Number.isFinite(s) || s <= 0) return null
  if (!Number.isFinite(fps) || fps <= 0) return null
  return Math.max(1, Math.floor(s * fps))
}

/**
 * THE SLOTS THIS LAYER ACTUALLY RENDERS — one per cut, in order, tiling
 * [0, totalFrames) exactly.
 *
 * ── THE RULE THIS EXISTS TO KEEP (§1: the missing half of the wire) ──────────
 *
 * A SLOT IS NEVER LONGER THAN THE CLIP THAT HAS TO FILL IT. The even division
 * this replaces could not promise that — it knew only how MANY clips there
 * were — so a 4-second cutaway in a 5.3-second slot played past its own end,
 * and past its end a `<Video>` holds its LAST FRAME. Frozen still, render
 * reports success.
 *
 * `lib/video/broll-picker.ts` measures every clip and `selectBrollPlan`
 * already sequences/loops/truncates against those measurements — it was the
 * MEASUREMENTS that never arrived here, not the algorithm. So this calls that
 * SAME function (§6: one implementation, two callers), in the FRAME domain:
 * integer clip lengths, an integer window, integers out — the slots tile the
 * window with no rounding drift, no 1-frame gap that would render black and no
 * 1-frame overshoot past a clip's end.
 *
 * `reserveFrames` is the crossfade the caller wants. Each clip's planned length
 * is shortened by up to that much so the outgoing clip has REAL footage to fade
 * out with, instead of dissolving from a frozen frame. Reserving never takes
 * more than half a clip.
 *
 * FALLBACK, published rather than hidden: when ANY clip lacks a measured
 * duration (`lib/agents/seller-update-reel-producer.ts` builds clips from bare
 * URLs) there is nothing to bound a slot BY, so the even division stands —
 * exactly today's behaviour, no regression. `scripts/broll-slot-guard.ts`
 * counts that path instead of pretending it is covered.
 *
 * PURE — no Remotion, no DOM, no React. Exported for its proof.
 */
export function brollSlots(
  clips: BrollClip[],
  totalFrames: number,
  fps: number,
  reserveFrames = 0,
): BrollWindow[] {
  const count = Array.isArray(clips) ? clips.length : 0
  const total = Math.floor(totalFrames)
  if (count <= 0 || !(total > 0)) return []

  const measured = clips.map((c) => clipFrames(c, fps))
  const everyClipMeasured = measured.every((m) => m !== null)

  if (!everyClipMeasured) {
    // Even division — the pre-2026-09-05 behaviour, kept verbatim by calling
    // the same exported deriver the window guard proves.
    const out: BrollWindow[] = []
    let at = 0
    for (let i = 0; i < count; i++) {
      const w = brollWindowAt(count, total, at)
      if (!w) break
      out.push(w)
      at += w.durationFrames
    }
    return out
  }

  const plan = selectBrollPlan(
    clips.map((c, i) => {
      const own = measured[i] as number
      // Hold back the crossfade tail, never more than half the clip.
      const reserve = Math.min(Math.max(0, Math.floor(reserveFrames)), Math.floor(own / 2))
      return { url: c.url || `clip-${i}`, durationSeconds: Math.max(1, own - reserve) }
    }),
    total,
  )

  return plan.map((e) => ({
    index:          e.sourceIndex,
    from:           e.startSeconds,
    durationFrames: e.durationSeconds,
  }))
}

/** Which slot contains `frame`. Clamps to the last slot for a playhead past the
 *  window (the loop=false case), matching brollWindowAt's own clamp. */
function slotAt(slots: BrollWindow[], frame: number): number {
  if (slots.length === 0) return -1
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i]
    if (frame < s.from + s.durationFrames) return Math.max(0, i)
  }
  return slots.length - 1
}

/** One `<ClipFrame>` the layer will mount at a given frame. */
export interface BrollDraw {
  /** Index into `clips`. */
  index:      number
  /** First frame of the media's timeline window (`<Video from=…>`). */
  startFrame: number
  /** How many frames that window runs (`<Video durationInFrames=…>`). THE RULE:
   *  never more than the clip's own measured length. */
  spanFrames: number
  /** 0..1 — the crossfade ramp. */
  opacity:    number
  /** True for the OUTGOING clip of a crossfade. */
  outgoing:   boolean
}

/**
 * EXACTLY WHAT THE LAYER MOUNTS AT `frame` — the whole render decision, as
 * data. The JSX below maps over this and adds no arithmetic of its own, so
 * `scripts/broll-slot-guard.ts` can walk every frame of a cadence and judge the
 * REAL numbers instead of a second copy of them (§2: a guard that reasons from
 * a re-implementation is measuring the re-implementation).
 *
 * PURE — no Remotion hooks, no DOM.
 */
export function brollDrawAt(
  clips: BrollClip[],
  totalFrames: number,
  fps: number,
  crossfadeFrames: number | undefined,
  frame: number,
  loop?: boolean,
): BrollDraw[] {
  const requested = Math.max(0, Math.floor(crossfadeFrames ?? 10))
  const slots = brollSlots(clips, totalFrames, fps, requested)
  if (clips.length === 0 || slots.length === 0 || !(totalFrames > 0)) return []

  const shouldLoop = loop ?? true
  const effective  = shouldLoop ? (frame % totalFrames) : frame
  // Where THIS pass through the clip list began, in the enclosing sequence's
  // frames. `frame - effective` is 0 on the first pass and one whole
  // `totalFrames` per completed loop, with no second modulo to disagree with
  // the one above (§6).
  const cycleStart = frame - effective

  const cut      = slotAt(slots, effective)
  const active   = slots[cut]
  const prevSlot = cut > 0 ? slots[cut - 1] : null

  // THE CROSSFADE IS BOUNDED BY FOOTAGE THAT EXISTS. `brollSlots` already held
  // back a tail on every measured clip; the fade can be no longer than that
  // SPARE, nor than half of either slot. Where a clip has no spare, the
  // boundary is a HARD CUT — the honest render, because you cannot cross-fade
  // frames the source does not contain. (On the unmeasured fallback there is no
  // measurement to bound by, so the old formula stands.)
  const prevOwn   = prevSlot ? clipFrames(clips[prevSlot.index], fps) : null
  const prevSpare = prevSlot
    ? (prevOwn === null ? requested : Math.max(0, prevOwn - prevSlot.durationFrames))
    : 0
  const crossfade = prevSlot
    ? Math.min(
        requested,
        Math.floor(active.durationFrames / 2),
        Math.floor(prevSlot.durationFrames / 2),
        prevSpare,
      )
    : 0

  const localFrame = effective - active.from
  const fadingIn   = crossfade > 0 && localFrame < crossfade && prevSlot !== null

  const draws: BrollDraw[] = []
  if (fadingIn && prevSlot) {
    draws.push({
      index:      prevSlot.index,
      // The previous clip's slot, plus the crossfade tail during which it is
      // still visible under the incoming one — a tail `brollSlots` reserved out
      // of that clip's own length, so this sum never exceeds it.
      startFrame: cycleStart + prevSlot.from,
      spanFrames: prevSlot.durationFrames + crossfade,
      opacity:    interpolate(localFrame, [0, crossfade], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
      outgoing:   true,
    })
  }
  draws.push({
    index:      active.index,
    startFrame: cycleStart + active.from,
    // Never shorter than the frame currently being drawn. With loop=false a
    // playhead past `totalFrames` clamps to the LAST clip (before the 2026-09-04
    // fix it held its final frame there); a window stopping at totalFrames would
    // unmount it and render black instead. No current call site passes
    // loop={false} — ComingSoon/Neighborhood pass `loop`, AgentTalkingHead
    // defaults to it — so this max is defensive, and the slot guard publishes
    // the past-the-window playhead as out of scope rather than claiming it.
    spanFrames: Math.max(active.durationFrames, effective - active.from + 1),
    opacity:    fadingIn
      ? interpolate(localFrame, [0, crossfade], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
      : 1,
    outgoing:   false,
  })
  return draws
}

export const BrollLayer: React.FC<BrollLayerProps> = ({
  clips, totalFrames, crossfadeFrames, overlayColor, loop,
}) => {
  const frame   = useCurrentFrame()
  const { fps } = useVideoConfig()
  const draws   = brollDrawAt(clips, totalFrames, fps, crossfadeFrames, frame, loop)
  if (draws.length === 0) return null

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {draws.map((d, i) => (
        <ClipFrame
          key={`${d.index}-${d.outgoing ? "out" : "in"}-${i}`}
          clip={clips[d.index]}
          opacity={d.opacity}
          overlayColor={overlayColor}
          startFrame={d.startFrame}
          spanFrames={d.spanFrames}
        />
      ))}
    </AbsoluteFill>
  )
}

const ClipFrame: React.FC<{
  clip:         BrollClip
  opacity:      number
  overlayColor?: string
  /** First frame of this clip's slot, in the enclosing sequence's frames. */
  startFrame:   number
  /** How long the slot runs — the media's timeline window. */
  spanFrames:   number
}> = ({ clip, opacity, overlayColor, startFrame, spanFrames }) => {
  const isVideo = isVideoUrl(clip.url)
  return (
    <AbsoluteFill style={{ opacity }}>
      {isVideo ? (
        // EVERY CLIP PLAYS FROM ITS OWN FRAME 0.
        //
        // THE DEFECT (found 2026-09-04). This `<Video>` was mounted BARE —
        // no `from`, no wrapping `<Sequence>` — so its playback position was the
        // ENCLOSING sequence's frame, not the frame within this clip's own slot.
        // Clip #1 looked right (its slot starts at 0, so the two agree) and every
        // clip after it did not: with three clips over a 480-frame window
        // (perClip = 160), clip #2 was asked for source second 5.3 and clip #3
        // for source second 10.7 — of stock cutaways that lib/video/broll-picker
        // measures and typically finds are 4-8 seconds long. Past its end the
        // clip renders its last frame, so the reel showed a frozen still where
        // it promised motion, and the render reported success. The same wrong
        // offset also skipped whatever the first 5-10 seconds of each clip
        // actually showed.
        //
        // `from`/`durationInFrames` on `<Video>` are the props the vendored skill
        // documents for exactly this ("Delaying, trimming",
        // .claude/skills/remotion-best-practices/remotion-markup/REFERENCE.md:174-192);
        // the installed @remotion/media declares them via InteractiveBaseProps
        // (node_modules/remotion/dist/cjs/Interactive.d.ts:9). This is the same
        // shape remotion/PhotoWalkthroughReel.tsx:197 already uses to give each
        // Ken Burns photo its own clock.
        //
        // `trimBefore={0}` is gone with it: it was the DEFAULT, and it read like
        // a deliberate statement that the clip starts at its beginning — which is
        // precisely what was not happening.
        <Video
          objectFit="cover"
          src={clip.url}
          from={startFrame}
          durationInFrames={Math.max(1, spanFrames)}
          style={{ width: "100%", height: "100%" }}
        />
      ) : (
        <SafeImg
          src={clip.url}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      )}
      {overlayColor && (
        <AbsoluteFill style={{ backgroundColor: overlayColor }} />
      )}
      {clip.caption && (
        <div style={{
          position: "absolute", bottom: 32, left: 32,
          padding: "8px 16px", borderRadius: 6,
          backgroundColor: "rgba(0,0,0,0.55)", color: "#fff",
          fontSize: 18, fontWeight: 500, letterSpacing: 1,
        }}>
          {clip.caption}
        </div>
      )}
    </AbsoluteFill>
  )
}

/** Shared cue-chip helper for compositions that surface
 *  content-bank context (e.g. "Trending in your area",
 *  "Sourced from competitor scan"). The composer hands in
 *  the chip text; the composition decides placement.
 *
 *  Tier note: the W40 ad creator gates which TIERS get to read the
 *  content_bank — solo_agent might only get a single cue;
 *  brokerage gets a curated row. The composition trusts whatever
 *  it's handed and just renders. */
export const ContextCueRow: React.FC<{
  cues:        string[]
  accentColor: string
  position?:   "top" | "bottom"
}> = ({ cues, accentColor, position }) => {
  if (cues.length === 0) return null
  const pos = position ?? "top"
  return (
    <div style={{
      position: "absolute",
      top:    pos === "top"    ? 24 : "auto",
      bottom: pos === "bottom" ? 24 : "auto",
      left: 0, right: 0,
      display: "flex", justifyContent: "center", gap: 8, flexWrap: "wrap",
      padding: "0 24px",
    }}>
      {cues.map((cue, i) => (
        <span key={i} style={{
          padding: "6px 12px", borderRadius: 12,
          backgroundColor: `${accentColor}E6`,  // ~90% alpha
          color: "#0F172A", fontSize: 14, fontWeight: 700, letterSpacing: 1,
          textTransform: "uppercase",
        }}>
          {cue}
        </span>
      ))}
    </div>
  )
}
