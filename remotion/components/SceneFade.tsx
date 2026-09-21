/**
 * remotion/components/SceneFade.tsx
 *
 * A dissolve at every cut, WITHOUT changing the timeline.
 *
 * WHY THIS AND NOT `<TransitionSeries>`. The vendored skill
 * (.claude/skills/remotion-best-practices/remotion-markup/transitions.md)
 * recommends `@remotion/transitions` for scene cuts — but a
 * `<TransitionSeries.Transition>` OVERLAPS the adjacent scenes and SHORTENS
 * the composition by the transition's length ("Duration calculation"), while
 * every composition in this fleet renders at FIXED registered geometry that
 * the render cache, the m313 narration pad and test:remotion-setup key on
 * field-for-field (lib/remotion/composition-geometry.ts). Re-timing 20+
 * compositions to absorb overlaps is a geometry migration, not a polish. The
 * package is also not installed (package.json pins remotion/bundler/cli/
 * media/renderer/google-fonts only), and a lane cannot add a dependency to a
 * shared node_modules.
 *
 * So this is the OVERLAY shape the same skill page describes ("render an
 * effect on top of the cut point without shortening the timeline"), done
 * with nothing but `interpolate(useCurrentFrame())` inside the Sequence that
 * mounts it: the scene fades IN from the composition's own background over
 * its first `frames` frames and OUT over its last `frames` frames. Two
 * adjacent scenes that both mount this read as a dissolve through the brand
 * colour, and the intro+body+outro sum is untouched — which is what lets
 * scripts/video-assembly-simulator.ts §sums stay green.
 *
 * `useVideoConfig().durationInFrames` inside a `<Sequence durationInFrames>`
 * is that Sequence's own length (remotion.dev/docs/sequence), so the tail
 * fade is anchored to the real end of THIS scene, never the composition's.
 *
 * Zero provider cost — pure Remotion. Opt-in per scene; a composition that
 * does not mount it renders exactly as before.
 */
import React from "react"
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion"

export interface SceneFadeProps {
  /** Fade length at each edge, in frames. Default 8 (~0.27s @ 30fps). */
  frames?: number
  children: React.ReactNode
}

export const SceneFade: React.FC<SceneFadeProps> = ({ frames = 8, children }) => {
  const frame = useCurrentFrame()
  const { durationInFrames } = useVideoConfig()
  // A scene shorter than two fades gets proportionally shorter ramps rather
  // than a fade-in that never finishes before the fade-out begins.
  const ramp = Math.max(1, Math.min(frames, Math.floor(durationInFrames / 2)))
  return (
    <AbsoluteFill
      style={{
        opacity: Math.min(
          interpolate(frame, [0, ramp], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          interpolate(frame, [durationInFrames - ramp, durationInFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
        ),
      }}
    >
      {children}
    </AbsoluteFill>
  )
}
