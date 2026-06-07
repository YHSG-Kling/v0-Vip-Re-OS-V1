/**
 * remotion/charts/AffordabilityDonut.tsx — Wave 39 chart layer.
 * Monthly-payment split donut (P&I / taxes / insurance / HOA). Segments
 * sweep in on reveal; the total payment sits in the hole. Pure SVG over
 * lib/charts/geometry donutArcs. The "monthly payment" framing is the
 * first-time-buyer conversion lever.
 */
import React from "react"
import { useCurrentFrame, interpolate } from "remotion"
import { donutArcs } from "../../lib/charts/geometry"

export interface DonutSegmentInput { label: string; value: number; color: string }

export interface AffordabilityDonutProps {
  segments:    DonutSegmentInput[]
  size?:       number
  thickness?:  number
  centerLabel?: string
  centerValue?: string
  startFrame?: number
  sweepFrames?: number
}

export const AffordabilityDonut: React.FC<AffordabilityDonutProps> = ({
  segments, size = 460, thickness = 64, centerLabel = "EST. / MO", centerValue,
  startFrame = 0, sweepFrames = 36,
}) => {
  const frame = useCurrentFrame()
  const cx = size / 2, cy = size / 2, radius = size / 2 - 8
  const sweep = interpolate(frame, [startFrame, startFrame + sweepFrames], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const arcs = donutArcs(segments.map((s) => s.value), { cx, cy, radius, thickness })

  // Reveal by clipping the whole donut behind a rotating conic mask is heavy;
  // instead grow each segment's opacity in order as the sweep advances.
  const segCount = arcs.length || 1

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {arcs.map((a, i) => {
        const segStart = (i / segCount)
        const segEnd = ((i + 1) / segCount)
        const op = interpolate(sweep, [segStart, segEnd], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
        return <path key={i} d={a.d} fill={segments[i].color} opacity={op} />
      })}
      {centerValue && (
        <>
          <text x={cx} y={cy - 4} fill="#fff" fontSize={46} fontFamily="system-ui" fontWeight={800} textAnchor="middle" opacity={sweep}>{centerValue}</text>
          <text x={cx} y={cy + 30} fill="rgba(255,255,255,0.6)" fontSize={18} fontFamily="system-ui" letterSpacing={2} textAnchor="middle" opacity={sweep}>{centerLabel}</text>
        </>
      )}
    </svg>
  )
}
