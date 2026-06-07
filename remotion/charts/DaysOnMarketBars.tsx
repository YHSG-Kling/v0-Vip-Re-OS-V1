/**
 * remotion/charts/DaysOnMarketBars.tsx — Wave 39 chart layer.
 * Vertical bars for a days-on-market (or active-listings) trend. Bars grow
 * up on reveal; lower DOM is "good" (greenish), higher is "warm". Pure SVG.
 */
import React from "react"
import { useCurrentFrame, interpolate } from "remotion"
import { verticalBars } from "../../lib/charts/geometry"

export interface DaysOnMarketBarsProps {
  values:    number[]
  labels?:   string[]
  width?:    number
  height?:   number
  goodColor?: string
  warnColor?: string
  /** Values at/under this read as "good". */
  goodAtOrBelow?: number
  startFrame?: number
  growFrames?: number
  unit?:     string
}

export const DaysOnMarketBars: React.FC<DaysOnMarketBarsProps> = ({
  values, labels = [], width = 900, height = 420, goodColor = "#34D399", warnColor = "#FB923C",
  goodAtOrBelow, startFrame = 0, growFrames = 28, unit = "",
}) => {
  const frame = useCurrentFrame()
  const padY = 50
  const threshold = goodAtOrBelow ?? (Math.min(...values) + Math.max(...values)) / 2
  const bars = verticalBars(values, { width, height, padX: 30, padY, gap: 0.35 }, { min: 0, max: Math.max(...values) })
  const grow = interpolate(frame, [startFrame, startFrame + growFrames], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {bars.map((b, i) => {
        const h = b.h * grow
        const y = b.y + (b.h - h)
        const c = values[i] <= threshold ? goodColor : warnColor
        return (
          <g key={i}>
            <rect x={b.x} y={y} width={b.w} height={h} rx={8} fill={c} />
            <text x={b.x + b.w / 2} y={y - 10} fill="#fff" fontSize={22} fontFamily="system-ui" fontWeight={700} textAnchor="middle" opacity={grow}>{values[i]}{unit}</text>
            {labels[i] && <text x={b.x + b.w / 2} y={height - padY + 30} fill="rgba(255,255,255,0.7)" fontSize={16} fontFamily="system-ui" textAnchor="middle">{labels[i]}</text>}
          </g>
        )
      })}
    </svg>
  )
}
