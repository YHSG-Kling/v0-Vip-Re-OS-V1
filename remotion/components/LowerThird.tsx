/**
 * remotion/components/LowerThird.tsx
 *
 * THE ONE broadcast-style lower-third for the avatar-led reels: an accent bar,
 * the agent's name and the brokerage, sliding in from the left edge over the
 * first ~16 frames of whatever Sequence mounts it.
 *
 * SURVIVOR (lane 77D, orphan doctrine §1.1). remotion/TeammateExplainerReel.tsx
 * carried this as a private `LowerThird` (its lines 121-150 before the move)
 * while remotion/AgentTalkingHeadReel.tsx — the PERSONAL message reel, where
 * the agent's name on screen is the single most conventional piece of
 * broadcast chrome — drew only a bottom-left brokerage chip with no agent
 * name at all. Two spellings of "who is speaking" (§6): one reel named the
 * person, the other did not. The Teammate copy is the survivor because it
 * already carried both lines and the slide-in; it moved here so both reels
 * mount the same component, and `bottom` became a prop because the two
 * layouts park it at different heights (Teammate: above its progress bar at
 * 168px; TalkingHead: at the chip's old 24px, under the floating avatar card).
 *
 * Remotion best-practices honoured (.claude/skills/remotion-best-practices/
 * remotion-markup/timing.md): the slide is `interpolate(useCurrentFrame())`
 * with BOTH extrapolations clamped and an individual `translate` property —
 * never a CSS transition, never a `transform` string.
 */
import React from "react"
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion"
import { cinemaFrame, cinemaLowerThirdPlacement } from "../../lib/video/cinema-finish"

export interface LowerThirdProps {
  agentName: string
  brokerageName: string
  primaryColor: string
  accentColor: string
  /** Distance from the bottom edge, px. Default: the ONE derivation, cinemaLowerThirdPlacement —
   *  above the caption band. WAVE 91 (lane 91E — the real render of TeammateExplainerReel): the
   *  typed default 168 put the strap UNDER the burned-in caption band on a 1:1 frame (band from
   *  97 px up ~190 px), so every cue printed across the agent's name; the "progress bar" it was
   *  parked above no longer exists. */
  bottom?: number
  /**
   * Wave 87 (lane 87D) — identify-then-leave. When set, the strap slides OUT
   * over `exitFrames` once it has been fully in for `holdFrames`
   * (lib/video/cinema-finish.ts cinemaLowerThirdPlacement). Absent → it stays
   * for the whole Sequence, exactly as before (TeammateExplainerReel).
   */
  holdFrames?: number
  exitFrames?: number
}

export const LowerThird: React.FC<LowerThirdProps> = ({ agentName, brokerageName, primaryColor, accentColor, bottom, holdFrames, exitFrames = 12 }) => {
  const frame = useCurrentFrame()
  const { width, height, fps } = useVideoConfig()
  const at = bottom ?? cinemaLowerThirdPlacement(width, height, fps).bottom
  // The strap's bar still runs from the frame's edge (broadcast style); its TEXT starts on the
  // safe side inset (wave 91 — it started 30 px from the edge, inside a feed's side chrome).
  const textLeft = Math.max(20, cinemaFrame(width, height).safe.left - 10)
  const enter = interpolate(frame, [0, 16], [-560, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const exitStart = typeof holdFrames === "number" && holdFrames > 0 ? 16 + holdFrames : null
  const exit = exitStart != null
    ? interpolate(frame, [exitStart, exitStart + Math.max(1, exitFrames)], [0, -560], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
    : 0
  return (
    <div
      style={{
        position: "absolute", left: 0, bottom: at,
        translate: `${enter + exit}px`,
      }}
    >
      <div
        style={{
          display: "flex", alignItems: "stretch",
          backgroundColor: `${primaryColor}E6`,
          borderRadius: "0 8px 8px 0", overflow: "hidden",
          boxShadow: "0 4px 18px rgba(0,0,0,0.35)",
        }}
      >
        <div style={{ width: 10, backgroundColor: accentColor }} />
        <div style={{ padding: `16px 28px 16px ${textLeft}px` }}>
          <div style={{ fontSize: 34, fontWeight: 800, color: "#fff", lineHeight: 1.1 }}>{agentName}</div>
          <div style={{ fontSize: 20, fontWeight: 600, color: accentColor, letterSpacing: 1, marginTop: 4 }}>
            {brokerageName}
          </div>
        </div>
      </div>
    </div>
  )
}
