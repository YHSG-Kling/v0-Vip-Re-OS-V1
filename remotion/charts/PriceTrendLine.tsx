/**
 * remotion/charts/PriceTrendLine.tsx — Wave 39 chart layer.
 * Animated median-price line + area over N periods. The line draws on with
 * stroke-dashoffset; the area fades in under it. Pure SVG over
 * lib/charts/geometry (deterministic, tested).
 */
import React from "react"
import { useCurrentFrame, interpolate } from "remotion"
import { seriesToPoints, linePath, areaPath, niceScale } from "../../lib/charts/geometry"

export interface PriceTrendLineProps {
  values:    number[]
  labels?:   string[]
  width?:    number
  height?:   number
  color?:    string
  fill?:     string
  /** Frame the draw starts + its duration. */
  startFrame?: number
  drawFrames?: number
}

export const PriceTrendLine: React.FC<PriceTrendLineProps> = ({
  values, labels = [], width = 900, height = 420,
  color = "#F59E0B", fill = "rgba(245,158,11,0.18)", startFrame = 0, drawFrames = 40,
}) => {
  const frame = useCurrentFrame()
  const padX = 60, padY = 40
  const scale = niceScale(Math.min(...values), Math.max(...values))
  const pts = seriesToPoints(values, { width, height, padX, padY }, { min: scale.min, max: scale.max })
  const path = linePath(pts)
  const area = areaPath(pts, height - padY)

  const progress = interpolate(frame, [startFrame, startFrame + drawFrames], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const pathLen = 2200 // generous upper bound; dashoffset reveal
  const areaOpacity = interpolate(frame, [startFrame + drawFrames * 0.5, startFrame + drawFrames], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      {scale.ticks.map((t) => {
        const y = pts.length ? seriesToPoints([t], { width, height, padX, padY }, { min: scale.min, max: scale.max })[0].y : 0
        return (
          <g key={t}>
            <line x1={padX} y1={y} x2={width - padX} y2={y} stroke="rgba(255,255,255,0.12)" strokeWidth={1} />
            <text x={8} y={y + 4} fill="rgba(255,255,255,0.6)" fontSize={18} fontFamily="system-ui">
              ${Math.round(t / 1000)}K
            </text>
          </g>
        )
      })}
      <path d={area} fill={fill} opacity={areaOpacity} />
      <path d={path} fill="none" stroke={color} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round"
        strokeDasharray={pathLen} strokeDashoffset={pathLen * (1 - progress)} />
      {pts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={interpolate(frame, [startFrame + drawFrames, startFrame + drawFrames + 8], [0, 6], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })} fill={color} />
      ))}
      {labels.map((lab, i) => pts[i] && (
        <text key={lab + i} x={pts[i].x} y={height - padY + 26} fill="rgba(255,255,255,0.7)" fontSize={16} fontFamily="system-ui" textAnchor="middle">{lab}</text>
      ))}
    </svg>
  )
}
