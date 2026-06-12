/**
 * remotion/components/CaptionLayer.tsx
 *
 * SOUND-OFF CAPTION BURN-IN overlay. 85% of social video plays MUTED, so this
 * lower-third layer renders the active caption cue synced to the ElevenLabs
 * voiceover (real word timestamps when available, else an honest even-distribution
 * estimate — lib/video/caption-plan.ts buildCaptionPlan).
 *
 * Two ways to feed it (both OPTIONAL + default-off so a composition with neither
 * prop renders EXACTLY as before):
 *   · cues        — a precomputed CaptionCue[] (the producer/render path built the
 *                   plan upstream from REAL alignment — preferred, word-accurate).
 *   · script      — the raw VO script TEXT; the layer builds an even-distribution
 *                   ESTIMATE in-composition from the composition's own
 *                   durationInFrames + fps. Used when no alignment was stored.
 * `cues` wins when both are supplied.
 *
 * Remotion best-practices honored (.claude/skills/remotion-best-practices):
 *   · Per-cue pop/fade driven by interpolate(useCurrentFrame()) over the cue's
 *     LOCAL frame window — NO CSS transitions, NO Tailwind animation (they don't
 *     render deterministically frame-by-frame).
 *   · Easing.bezier for the enter curve (timing.md), a playful overshoot pop.
 *   · Cue selection is a PURE bounds-checked lookup (activeCueIndex) — out-of-range
 *     frames render nothing.
 *
 * Muted-readability: lower-third, high-contrast — bold white text with a dark
 * stroke + translucent box so it reads over ANY photo/video underneath.
 *
 * Renders NOTHING when there are no cues (empty script / no alignment / no source)
 * — the reel is exactly as it was before captions existed.
 */
import React from "react"
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion"
import {
  buildCaptionPlan,
  activeCueIndex,
  type CaptionCue,
  type CaptionSource,
  type BuildCaptionPlanOptions,
} from "../../lib/video/caption-plan"

const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif"

export interface CaptionLayerProps {
  /** Precomputed cues (preferred — built upstream from REAL ElevenLabs alignment). */
  cues?: CaptionCue[] | null
  /** Raw VO script text — the layer estimates timing from the composition's own
   *  duration when no precomputed cues are supplied. Even-distribution ESTIMATE. */
  script?: CaptionSource
  /** Vertical position of the caption band (% from top). Default 78 (lower-third). */
  bottomPercent?: number
  /** Accent color for the underline tick. Defaults to a warm amber. */
  accentColor?: string
  /** Tuning forwarded to buildCaptionPlan when planning from `script`. */
  planOptions?: BuildCaptionPlanOptions
}

/**
 * Resolve the cue list: explicit cues win; else plan from the script using THIS
 * composition's duration + fps. Returns [] when there is nothing to show.
 */
function useResolvedCues(props: CaptionLayerProps): CaptionCue[] {
  const { durationInFrames, fps } = useVideoConfig()
  if (props.cues && props.cues.length > 0) return props.cues
  if (props.script != null && props.script !== "") {
    return buildCaptionPlan(props.script, durationInFrames, fps, props.planOptions).cues
  }
  return []
}

export const CaptionLayer: React.FC<CaptionLayerProps> = (props) => {
  const frame = useCurrentFrame()
  const cues = useResolvedCues(props)
  if (cues.length === 0) return null

  const idx = activeCueIndex(cues, frame)
  if (idx < 0) return null

  const cue = cues[idx]
  const accent = props.accentColor ?? "#F59E0B"
  const topPercent = props.bottomPercent ?? 78

  // Local frame within the active cue's window drives the pop/fade.
  const localFrame = frame - cue.fromFrame
  const dur = cue.durationFrames

  // Enter pop (playful overshoot, timing.md curve #3) + fade-in over ~6 frames.
  const enterScale = interpolate(localFrame, [0, 8], [0.86, 1], {
    easing: Easing.bezier(0.34, 1.56, 0.64, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
  const fadeIn = interpolate(localFrame, [0, 6], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
  // Fade-out over the cue's trailing ~5 frames so swaps don't hard-cut.
  const fadeOut = interpolate(localFrame, [Math.max(0, dur - 5), dur], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
  const opacity = Math.min(fadeIn, fadeOut)

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          top: `${topPercent}%`,
          left: 0,
          right: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "0 8%",
          opacity,
          transform: `scale(${enterScale})`,
        }}
      >
        <div
          style={{
            backgroundColor: "rgba(0,0,0,0.62)",
            borderRadius: 16,
            padding: "18px 30px",
            maxWidth: "92%",
            textAlign: "center",
          }}
        >
          <span
            style={{
              color: "#FFFFFF",
              fontSize: 56,
              lineHeight: 1.12,
              fontWeight: 800,
              letterSpacing: -0.5,
              fontFamily: FONT,
              // High-contrast stroke so the text survives over ANY frame muted.
              WebkitTextStroke: "2px rgba(0,0,0,0.85)",
              paintOrder: "stroke fill",
              textShadow: "0 3px 14px rgba(0,0,0,0.55)",
            }}
          >
            {cue.text}
          </span>
        </div>
        <div
          style={{
            marginTop: 12,
            width: 64,
            height: 6,
            borderRadius: 3,
            backgroundColor: accent,
          }}
        />
      </div>
    </AbsoluteFill>
  )
}
