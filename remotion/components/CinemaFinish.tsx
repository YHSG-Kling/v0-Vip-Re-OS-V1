/**
 * remotion/components/CinemaFinish.tsx
 *
 * THE CINEMA FINISH LAYER (wave 82, lane 82C). OWNER: "the videos need to be a
 * completely finished and very smooth cinema quality production as the end
 * product."
 *
 * Every composition registered in remotion/Root.tsx is wrapped by
 * `withCinemaFinish(component, id)` AT REGISTRATION (Root's local `Composition`
 * does it for every entry), so no reel hand-times its own finish and a new
 * composition inherits it by being registered. What it paints is DERIVED by
 * lib/video/cinema-finish.ts from the existing registries (finish-spec,
 * duration-model purposes + bookends, the staged body-visual plan):
 *
 *   1. a subtle GRADE (CSS filter + a soft radial vignette) — "natural" for
 *      homes, "warm" for keepsakes, TRUE COLOUR for screens;
 *   2. an eased DIP through the brand colour on every cut point — an overlay,
 *      so the registered timeline is untouched (see SceneFade.tsx for why not
 *      TransitionSeries); lighter where the voice bridges the cut (J/L cut);
 *   3. a head fade IN from and a tail fade OUT to the BRAND colour — never a
 *      hard cut on black;
 *   4. (wave 83B; per-SEGMENT since wave 86, lane 86B) film-camera MOTION BLUR
 *      (@remotion/motion-blur CameraMotionBlur, 180° shutter) ONLY on the frames of
 *      a segment whose treatment is a synthesised camera move (the Ken Burns photo
 *      push) with nobody on screen, and only when that push is fast enough to show
 *      (cinema-finish.ts cinemaMotionBlurWindows — samples by streak). Every other
 *      frame renders once: never a talking head, a screen, a card, footage or a still.
 *      (A true two-picture crossfade is documented, not built — cinema-finish.ts
 *      § CROSSFADE says why the cut stays a dip.)
 *
 * Stills (finish-spec STILL) pass through untouched. Remotion best practices
 * honoured (remotion-markup/REFERENCE.md + timing.md): everything is driven by
 * `useCurrentFrame()` + `interpolate()` with both extrapolations clamped and
 * `Easing.bezier` curves; no CSS transitions or animations.
 */
import React from "react"
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion"
import { CameraMotionBlur } from "@remotion/motion-blur"
import {
  CINEMA_EASING, CINEMA_MOTION_BLUR, cinemaCutPoints, cinemaFinishFor, cinemaMotionBlurAt,
  cinemaMotionBlurWindows, dipOpacityAt, edgeFadeFrames, gradeFilter,
} from "../../lib/video/cinema-finish"
import { fitBodyVisualPlan, type BodyVisualPlan } from "../../lib/video/body-visual-model"

export interface CinemaFinishProps {
  compositionId: string
  /** The composition's own input props (brand + the staged body-visual plan are read). */
  inputProps: Record<string, unknown>
  children: React.ReactNode
}

function brandColor(props: Record<string, unknown>): string {
  const brand = props.brand as { primaryColor?: unknown } | undefined
  const c = typeof brand?.primaryColor === "string" ? brand.primaryColor : null
  return c && /^#[0-9a-f]{3,8}$/i.test(c) ? c : "#0F172A"
}

export const CinemaFinish: React.FC<CinemaFinishProps> = ({ compositionId, inputProps, children }) => {
  const frame = useCurrentFrame()
  const { fps, durationInFrames, width, height } = useVideoConfig()
  const spec = cinemaFinishFor(compositionId)
  if (!spec.enabled) return <>{children}</>

  const plan = fitBodyVisualPlan((inputProps.bodyVisualPlan ?? null) as BodyVisualPlan | null, compositionId, durationInFrames)
  const cuts = cinemaCutPoints(compositionId, durationInFrames, plan)
  const edges = edgeFadeFrames(spec, fps, durationInFrames)
  const dip = dipOpacityAt(frame, cuts, spec, fps)
  // THE BLUR WINDOWS (wave 86): the staged plan's camera-move segments (or the body
  // when no plan is staged), each at the fewest samples its measured streak needs.
  const blurWindows = cinemaMotionBlurWindows(compositionId, durationInFrames, plan, { width, height, fps, props: inputProps })
  const blurSamples = cinemaMotionBlurAt(frame, blurWindows)
  const head = interpolate(frame, [0, edges.head], [1, 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(...CINEMA_EASING.enter),
  })
  // Strictly increasing even when the cap leaves a 1-frame tail on a very short
  // render ([d − 1, d − 1] threw inside interpolate — lane 85E).
  const tail = interpolate(frame, [Math.min(durationInFrames - edges.tail, durationInFrames - 2), durationInFrames - 1], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(...CINEMA_EASING.exit),
  })
  const filter = gradeFilter(spec.look)
  const veil = Math.max(head, tail, dip)

  return (
    <AbsoluteFill>
      {/* THE GRADE WRAPS THE BLUR (wave 84A, measured): a film camera integrates
          light over the shutter FIRST and the grade is applied to that exposure,
          so the CSS filter sits OUTSIDE CameraMotionBlur and runs ONCE on the
          averaged image — not once per time-offset sample on each copy (it was
          inside: `samples` graded copies, then averaged). Measured (lane-84A
          harness, 90 frames 1280×720, two rounds): grade inside the blur 112.4 /
          94.1 s, grade outside 71.2 / 67.1 s, no blur 25.7 / 19.5 s — a third
          of the blur's cost was the per-sample grade; colours identical
          (static patch 215,45,45 in all three). */}
      <AbsoluteFill style={{ filter }}>
        {blurSamples > 0 ? (
          // Inside a camera-move window only (cinema-finish.ts cinemaMotionBlurWindows).
          // The docs require absolutely positioned children: AbsoluteFill is
          // (remotion.dev/docs/motion-blur/camera-motion-blur).
          <CameraMotionBlur shutterAngle={CINEMA_MOTION_BLUR.shutterAngle} samples={blurSamples}>
            <AbsoluteFill>{children}</AbsoluteFill>
          </CameraMotionBlur>
        ) : (
          children
        )}
      </AbsoluteFill>
      {spec.look.vignette > 0 ? (
        <AbsoluteFill
          style={{
            pointerEvents: "none",
            background: `radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,0,${spec.look.vignette}) 100%)`,
          }}
        />
      ) : null}
      {veil > 0 ? <AbsoluteFill style={{ pointerEvents: "none", backgroundColor: brandColor(inputProps), opacity: veil }} /> : null}
    </AbsoluteFill>
  )
}

const FINISHED = new Map<string, React.FC<Record<string, unknown>>>()

/**
 * Wrap a registered component in the finish, memoised per composition id so the
 * component identity is stable across renders (a new wrapper per render would
 * remount the whole tree every frame).
 */
export function withCinemaFinish(
  Component: React.ComponentType<Record<string, unknown>>,
  compositionId: string,
): React.FC<Record<string, unknown>> {
  const key = compositionId
  const hit = FINISHED.get(key)
  if (hit) return hit
  const Finished: React.FC<Record<string, unknown>> = (props) => (
    <CinemaFinish compositionId={compositionId} inputProps={props}>
      <Component {...props} />
    </CinemaFinish>
  )
  Finished.displayName = `CinemaFinish(${compositionId})`
  FINISHED.set(key, Finished)
  return Finished
}
