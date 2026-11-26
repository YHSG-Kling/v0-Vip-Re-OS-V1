// remotion/components/KenBurnsPhoto.tsx
//
// ONE Ken Burns photo — scale + pan via interpolate over the clip's LOCAL frame
// window (the wrapping <Sequence> resets useCurrentFrame to 0 at the clip
// start), plus a lead-in / lead-out opacity cross-fade, and an optional room
// caption pinned to the safe top-left (wave 91 — it was a typed bottom-left corner).
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
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion"
import { cinemaFrame } from "../../lib/video/cinema-finish"
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
  const { width, height } = useVideoConfig()
  const { safe } = cinemaFrame(width, height)
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

  // A TRUE CROSS-DISSOLVE (wave 86, lane 86B — found by a REAL render of
  // PhotoWalkthroughReel). The incoming photo is mounted LATER, so it paints on
  // top: it fades IN over the outgoing photo, which stays fully opaque beneath.
  // The old envelope `[0, fadeIn, max(fadeIn, dur − crossfade), dur]` had two
  // defects: (1) it ALSO faded the outgoing photo out, so mid-dissolve both were
  // half transparent and the dark stage showed through — a dip toward black at
  // every photo change; (2) on the LAST clip (crossfadeFrames 0) the range was
  // `[0, 10, dur, dur]`, which `interpolate` refuses ("inputRange must be strictly
  // monotonically increasing … [0,10,36,36]") — the whole render failed on the
  // last photo of every tour. The FIRST photo no longer fades up from the dark
  // stage either: the cover → tour cut is carried by CinemaFinish's dip.
  const fadeIn = Math.max(1, Math.min(clip.crossfadeFrames > 0 ? clip.crossfadeFrames : 10, dur - 1))
  const opacity = clip.fromFrame === 0 || dur <= 1
    ? 1
    : interpolate(frame, [0, fadeIn], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })

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
      {/* WAVE 91 (lane 91E — the real render, before-PhotoWalkthroughReel-mid.png): the room
          label stood at a typed bottom: 56 / left: 56 — inside the player's bottom UI band
          (safe 97 on 1:1) and directly under the burned-in caption band, so "Step inside"
          printed beneath every cue. The tour beat now names the room from the SAFE TOP-LEFT
          (cinemaFrame), on its own scrim; the bottom belongs to the captions. */}
      {showCaption && clip.roomLabel && (
        <AbsoluteFill style={{ background: "linear-gradient(to bottom, rgba(0,0,0,0.5), transparent 30%)" }} />
      )}
      {showCaption && clip.roomLabel && (
        <div
          style={{
            position: "absolute",
            top: safe.top,
            left: safe.left,
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
