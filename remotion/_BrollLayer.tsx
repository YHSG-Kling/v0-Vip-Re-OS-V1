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
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion"
import { SafeImg } from "./components/SafeImg"

export interface BrollClip {
  /** Either an image URL OR a video URL. The helper detects by
   *  file extension; .mp4/.webm/.mov use the <Video> primitive,
   *  everything else falls back to <Img>. */
  url:           string
  /** Optional caption shown over the bottom of the clip — useful
   *  for neighborhood reels labeling each segment (e.g.
   *  "Brickell promenade"). 6-10 words. */
  caption?:      string
}

export interface BrollLayerProps {
  clips:               BrollClip[]
  /** Total frames the layer should occupy. The helper divides this
   *  evenly across the clips. */
  totalFrames:         number
  /** Cross-fade duration between adjacent clips. Defaults to 10
   *  frames (~0.33s @ 30fps). Cap to ~half the per-clip duration
   *  so the user never sees more crossfade than clip. */
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

export const BrollLayer: React.FC<BrollLayerProps> = ({
  clips, totalFrames, crossfadeFrames, overlayColor, loop,
}) => {
  const frame = useCurrentFrame()
  if (clips.length === 0) return null

  const shouldLoop  = loop ?? true
  const perClip     = Math.max(1, Math.floor(totalFrames / clips.length))
  const crossfade   = Math.min(crossfadeFrames ?? 10, Math.floor(perClip / 2))
  const effective   = shouldLoop ? (frame % totalFrames) : frame
  // Where THIS pass through the clip list began, in the enclosing sequence's
  // frames. `frame - effective` is 0 on the first pass and one whole
  // `totalFrames` per completed loop, with no second modulo to disagree with
  // the one above (§6).
  const cycleStart  = frame - effective

  // Build the current + next clip indices + their respective opacities.
  const active      = brollWindowAt(clips.length, totalFrames, effective)!
  const activeIdx   = active.index
  const localFrame  = effective - active.from
  const fadingIn    = localFrame < crossfade && activeIdx > 0
  const prevIdx     = fadingIn ? activeIdx - 1 : null
  const inOpacity   = fadingIn
    ? interpolate(localFrame, [0, crossfade], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : 1
  const outOpacity  = fadingIn
    ? interpolate(localFrame, [0, crossfade], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : 0

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {prevIdx !== null && (
        <ClipFrame
          clip={clips[prevIdx]}
          opacity={outOpacity}
          overlayColor={overlayColor}
          // The previous clip's slot, plus the crossfade tail during which it is
          // still visible over the incoming one.
          startFrame={cycleStart + prevIdx * perClip}
          spanFrames={perClip + crossfade}
        />
      )}
      <ClipFrame
        clip={clips[activeIdx]}
        opacity={inOpacity}
        overlayColor={overlayColor}
        startFrame={cycleStart + active.from}
        // Never shorter than the frame currently being drawn. With loop=false a
        // playhead past `totalFrames` clamps to the LAST clip (the behaviour
        // before this change held its final frame there); a window that stopped
        // at totalFrames would unmount it and render black instead.
        spanFrames={Math.max(active.durationFrames, effective - active.from + 1)}
      />
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
