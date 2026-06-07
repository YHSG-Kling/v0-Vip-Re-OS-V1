/**
 * remotion/charts/CompsBar.tsx — Wave 39 chart layer.
 * Horizontal bars comparing the subject property against comparable sales
 * (sale price or $/sqft). The subject bar is accent-highlighted. Bars grow
 * left→right on reveal. Pure SVG over lib/charts/geometry.
 */
import React from "react"
import { useCurrentFrame, interpolate } from "remotion"
import { horizontalBars } from "../../lib/charts/geometry"

export interface CompRow { label: string; value: number; isSubject?: boolean }

export interface CompsBarProps {
  rows:        CompRow[]
  width?:      number
  height?:     number
  color?:      string
  subjectColor?: string
  format?:     (v: number) => string
  startFrame?: number
  growFrames?: number
}

export const CompsBar: React.FC<CompsBarProps> = ({
  rows, width = 900, height = 460, color = "#475569", subjectColor = "#F59E0B",
  format = (v) => `$${Math.round(v / 1000)}K`, startFrame = 0, growFrames = 30,
}) => {
  const frame = useCurrentFrame()
  const labelW = 220
  const trackW = width - labelW - 140
  const bars = horizontalBars(rows.map((r) => r.value), { width: trackW, height, padY: 16, gap: 0.4 })
  const grow = interpolate(frame, [startFrame, startFrame + growFrames], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {bars.map((b, i) => {
        const row = rows[i]
        const w = b.w * grow
        const c = row.isSubject ? subjectColor : color
        return (
          <g key={row.label + i}>
            <text x={labelW - 16} y={b.y + b.h / 2 + 6} fill="rgba(255,255,255,0.85)" fontSize={20} fontFamily="system-ui" textAnchor="end">{row.label}</text>
            <rect x={labelW} y={b.y} width={w} height={b.h} rx={8} fill={c} />
            <text x={labelW + w + 12} y={b.y + b.h / 2 + 6} fill="#fff" fontSize={20} fontFamily="system-ui" fontWeight={row.isSubject ? 700 : 400} opacity={grow}>{format(row.value)}</text>
          </g>
        )
      })}
    </svg>
  )
}
