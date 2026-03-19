'use client'

import React from 'react'
import { Badge } from '@/components/ui/badge'

interface HealthScoreRingProps {
  score: number | null
  size?: 'sm' | 'md' | 'lg'
  showLabel?: boolean
}

const sizeMap = {
  sm: { radius: 12, strokeWidth: 2, fontSize: '12px' },
  md: { radius: 18, strokeWidth: 2.5, fontSize: '14px' },
  lg: { radius: 24, strokeWidth: 3, fontSize: '16px' },
}

export function HealthScoreRing({ score, size = 'md', showLabel = false }: HealthScoreRingProps) {
  const config = sizeMap[size]
  const circumference = 2 * Math.PI * config.radius
  const offset = score !== null ? circumference - (score / 100) * circumference : circumference

  const getStrokeColor = (value: number | null) => {
    if (value === null) return '#9ca3af'
    if (value >= 70) return '#22c55e'
    if (value >= 50) return '#f59e0b'
    return '#ef4444'
  }

  const getLabel = (value: number | null) => {
    if (value === null) return 'Unknown'
    if (value >= 70) return 'Healthy'
    if (value >= 50) return 'At Risk'
    return 'Critical'
  }

  const strokeColor = getStrokeColor(score)
  const diameter = config.radius * 2 + config.strokeWidth * 2
  const viewBox = `0 0 ${diameter} ${diameter}`

  return (
    <div className="flex flex-col items-center gap-2">
      <svg width={diameter} height={diameter} viewBox={viewBox}>
        {/* Background circle */}
        <circle
          cx={diameter / 2}
          cy={diameter / 2}
          r={config.radius}
          fill="none"
          stroke="#e5e7eb"
          strokeWidth={config.strokeWidth}
        />
        {/* Progress circle */}
        <circle
          cx={diameter / 2}
          cy={diameter / 2}
          r={config.radius}
          fill="none"
          stroke={strokeColor}
          strokeWidth={config.strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.3s ease' }}
          transform={`rotate(-90 ${diameter / 2} ${diameter / 2})`}
        />
        {/* Center text */}
        <text
          x={diameter / 2}
          y={diameter / 2}
          textAnchor="middle"
          dy="0.3em"
          fontSize={config.fontSize}
          fontWeight="600"
          fill="#1f2937"
        >
          {score !== null ? score : '—'}
        </text>
      </svg>
      {showLabel && <Badge variant="outline">{getLabel(score)}</Badge>}
    </div>
  )
}
