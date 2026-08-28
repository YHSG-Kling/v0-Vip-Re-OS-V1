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
import { AbsoluteFill, Img, interpolate, useCurrentFrame } from "remotion"

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

export const BrollLayer: React.FC<BrollLayerProps> = ({
  clips, totalFrames, crossfadeFrames, overlayColor, loop,
}) => {
  const frame = useCurrentFrame()
  if (clips.length === 0) return null

  const shouldLoop  = loop ?? true
  const perClip     = Math.max(1, Math.floor(totalFrames / clips.length))
  const crossfade   = Math.min(crossfadeFrames ?? 10, Math.floor(perClip / 2))
  const effective   = shouldLoop ? (frame % totalFrames) : frame

  // Build the current + next clip indices + their respective opacities.
  const activeIdx   = Math.min(clips.length - 1, Math.floor(effective / perClip))
  const localFrame  = effective - activeIdx * perClip
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
        <ClipFrame clip={clips[prevIdx]} opacity={outOpacity} overlayColor={overlayColor} />
      )}
      <ClipFrame clip={clips[activeIdx]} opacity={inOpacity} overlayColor={overlayColor} />
    </AbsoluteFill>
  )
}

const ClipFrame: React.FC<{
  clip:         BrollClip
  opacity:      number
  overlayColor?: string
}> = ({ clip, opacity, overlayColor }) => {
  const isVideo = isVideoUrl(clip.url)
  return (
    <AbsoluteFill style={{ opacity }}>
      {isVideo ? (
        <Video
          objectFit="cover"
          src={clip.url}
          trimBefore={0}
          style={{ width: "100%", height: "100%" }}
        />
      ) : (
        <Img
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
