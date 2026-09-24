/**
 * remotion/components/SegmentBackdrop.tsx
 *
 * THE ONE per-segment BACKDROP (wave 81C — lane 80C's open item: "only
 * MemoryVideoReel switches its backdrop per segment; per-segment background
 * switching on the other compositions is a follow-on").
 *
 * Paints the background kind the body-visual PLAN names for the segment on
 * screen at the current frame (lib/video/body-visual-model.ts BACKGROUND_KINDS):
 *   solid_brand    — the brand's primary colour, flat
 *   brand_gradient — a radial brand gradient (primary → darker primary)
 *   blurred_photo  — a blurred, darkened photo when one is supplied, else the gradient
 *   subtle_motion  — a slow Ken Burns drift on the gradient (motion without a subject)
 * Outside the body (the bookends) and without a plan it paints the flat brand
 * fill — byte-identical to the `backgroundColor: brand.primaryColor` fill the
 * PiP reels painted before. The composition mounts it BEHIND its panels and
 * keeps its own paint marks, so the registry rows stay honest.
 *
 * Remotion best-practices honoured: `interpolate(useCurrentFrame())` for the
 * drift with both extrapolations clamped, an individual `scale` property with
 * `output: "perceptual-scale"` (never a `transform` string), no CSS
 * transitions. PUBLISHED BLIND SPOT: planBodyVisual picks the purpose's FIRST
 * allowed background for every non-full-frame segment today, so a plan only
 * switches kinds across segments once a learned override or a producer's
 * pre-cut segments say so — this component switches whenever the plan does.
 */
import React from "react"
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion"
import { SafeImg } from "./SafeImg"
import { segmentAtFrame, type BackgroundKind, type BodyVisualPlan } from "../../lib/video/body-visual-model"

export interface SegmentBackdropProps {
  plan?: BodyVisualPlan | null
  primaryColor: string
  accentColor: string
  /** A photo for `blurred_photo` segments (the home, the listing). Absent → the gradient. */
  photoUrl?: string | null
  /** The composition-absolute frame offset of the Sequence this is mounted in
   *  (the plan's segments are composition-absolute; a backdrop inside a
   *  `<Sequence from>` sees a local frame). */
  frameOffset?: number
}

/** PURE — the kind to paint at a composition-absolute frame. Exported for the proof. */
export function backdropKindAt(plan: BodyVisualPlan | null | undefined, absoluteFrame: number): BackgroundKind {
  if (!plan) return "solid_brand"
  const seg = segmentAtFrame(plan, absoluteFrame)
  if (!seg || seg.background === "none") return "solid_brand"
  return seg.background
}

function darken(hex: string, amount = 0.35): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return hex
  const ch = (h: string) => Math.max(0, Math.round(parseInt(h, 16) * (1 - amount))).toString(16).padStart(2, "0")
  return `#${ch(m[1])}${ch(m[2])}${ch(m[3])}`
}

export const SegmentBackdrop: React.FC<SegmentBackdropProps> = ({ plan, primaryColor, accentColor, photoUrl, frameOffset = 0 }) => {
  const frame = useCurrentFrame()
  const kind = backdropKindAt(plan, frame + frameOffset)
  const gradient = `radial-gradient(circle at 30% 20%, ${primaryColor} 0%, ${darken(primaryColor)} 100%)`
  if (kind === "solid_brand") return <AbsoluteFill style={{ backgroundColor: primaryColor }} />
  if (kind === "blurred_photo" && photoUrl) {
    return (
      <AbsoluteFill style={{ backgroundColor: primaryColor }}>
        <SafeImg src={photoUrl} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", filter: "blur(40px) brightness(0.45)", scale: "1.1" }} />
      </AbsoluteFill>
    )
  }
  if (kind === "subtle_motion") {
    // A slow drift on the gradient — the only thing that moves is the light.
    const scale = interpolate(frame, [0, 600], [1.0, 1.08], { extrapolateLeft: "clamp", extrapolateRight: "clamp", output: "perceptual-scale" })
    return (
      <AbsoluteFill style={{ backgroundColor: primaryColor }}>
        <AbsoluteFill style={{ background: gradient, scale }} />
        <AbsoluteFill style={{ background: `linear-gradient(160deg, ${accentColor}22 0%, transparent 55%)` }} />
      </AbsoluteFill>
    )
  }
  return <AbsoluteFill style={{ background: gradient }} />
}
