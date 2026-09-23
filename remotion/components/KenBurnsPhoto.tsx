// remotion/components/KenBurnsPhoto.tsx
//
// ONE Ken Burns photo — scale + pan via interpolate over the clip's LOCAL frame
// window (the wrapping <Sequence> resets useCurrentFrame to 0 at the clip
// start), plus a lead-in / lead-out opacity cross-fade, and an optional room
// caption pinned bottom-left.
//
// SURVIVOR (wave 80C, CLAUDE.md §1.1): this component lived as a private
// `KenBurnsPhoto` in remotion/PhotoWalkthroughReel.tsx:225 (a tombstone stands
// there). MemoryVideoReel's seller_audio_photos mode needs the SAME renderer
// for the home's photos under the seller's own audio, so it moved here rather
// than being copied. `showCaption` is the one addition — a memory film shows
// the seller's words, never a synthesized tour beat.
//
// The motion numbers come from lib/video/ken-burns-plan.ts (kenBurnsPlan) and
// were chosen against the S·T transform composition below — see the note on
// the transform string.
import React from "react"
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion"
import { SafeImg } from "./SafeImg"
import type { KenBurnsClip } from "../../lib/video/ken-burns-plan"

const FONT = "system-ui, -apple-system, 'Segoe UI', sans-serif"

export const KenBurnsPhoto: React.FC<{
  clip: KenBurnsClip
  brand: { accentColor: string }
  /** Render the clip's room label bottom-left. Default true (the walkthrough). */
  showCaption?: boolean
}> = ({ clip, brand, showCaption = true }) => {
  const frame = useCurrentFrame()
  const dur = clip.durationFrames

  // Ken Burns scale + pan. translate is expressed as a PERCENT of the frame
  // (panFromXY/panToXY are %), so we drive translate via percent units.
  const scale = interpolate(frame, [0, dur], [clip.startScale, clip.endScale], {
    easing: Easing.bezier(0.45, 0, 0.55, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    output: "perceptual-scale",
  })
  const panX = interpolate(frame, [0, dur], [clip.panFromXY[0], clip.panToXY[0]], {
    easing: Easing.bezier(0.45, 0, 0.55, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
  const panY = interpolate(frame, [0, dur], [clip.panFromXY[1], clip.panToXY[1]], {
    easing: Easing.bezier(0.45, 0, 0.55, 1),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })

  // Cross-fade: fade IN over the leading edge, fade OUT over the trailing
  // cross-fade window so the next clip (which has already mounted underneath)
  // shows through. The final clip has crossfadeFrames === 0 → no trailing fade.
  const fadeIn = Math.min(dur, clip.crossfadeFrames > 0 ? clip.crossfadeFrames : 10)
  const fadeOutStart = dur - clip.crossfadeFrames
  const opacity = interpolate(
    frame,
    [0, fadeIn, Math.max(fadeIn, fadeOutStart), dur],
    [0, 1, 1, clip.crossfadeFrames > 0 ? 0 : 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  )

  // Caption fades in just after the photo lands.
  const captionOpacity = interpolate(frame, [Math.min(fadeIn, 8), Math.min(fadeIn, 8) + 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })

  return (
    <AbsoluteFill style={{ opacity }}>
      <SafeImg
        src={clip.url}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          // TWO transform functions on ONE element, so the individual `scale` /
          // `translate` properties are NOT equivalent here and the Ken Burns pan
          // would render at the wrong amplitude.
          //
          // `transform: scale(s) translate(t)` composes as the matrix S·T, i.e. the
          // translation is expressed in the ALREADY-SCALED coordinate system — a 6%
          // pan at scale 1.12 moves 6.72% of the frame. The individual properties
          // compose in the fixed order translate → rotate → scale (T·S), which
          // applies the pan in UNSCALED coordinates: the same numbers, a different
          // picture, on every frame of every walkthrough. Percentage translate also
          // resolves against the element's own border box, which is the <Img>'s
          // pre-scale box in both spellings — so the difference is purely the
          // composition order, and it is real.
          //
          // The skill's rule (remotion-markup/REFERENCE.md:50) is about EDITABILITY
          // in Studio, not correctness; it does not license a render change. Left as
          // a transform string deliberately. kenBurnsPlan (lib/video/ken-burns-plan.ts)
          // is the pure producer of `scale` + `panFromXY`/`panToXY`, and its numbers
          // were chosen against S·T.
          //
          // remotion-transform-string: two functions compose in a different order
          // under the individual properties — converting would change the render.
          transform: `scale(${scale}) translate(${panX}%, ${panY}%)`,
        }}
      />
      {/* Bottom gradient so the caption is legible over any photo. */}
      <AbsoluteFill
        style={{ background: "linear-gradient(to top, rgba(0,0,0,0.62), transparent 38%)" }}
      />
      {showCaption && clip.roomLabel && (
        <div
          style={{
            position: "absolute",
            bottom: 56,
            left: 56,
            opacity: captionOpacity,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div
            style={{
              width: 56,
              height: 6,
              borderRadius: 3,
              backgroundColor: brand.accentColor,
            }}
          />
          <div
            style={{
              color: "white",
              fontSize: 46,
              fontWeight: 800,
              letterSpacing: -0.5,
              fontFamily: FONT,
              textShadow: "0 2px 12px rgba(0,0,0,0.4)",
            }}
          >
            {clip.roomLabel}
          </div>
        </div>
      )}
    </AbsoluteFill>
  )
}
