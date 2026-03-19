"use client"

import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"

export interface DealHealthRingProps {
  score: number
  size?: number
  showLabel?: boolean
  className?: string
}

function getRiskLevel(score: number): string {
  if (score >= 80) return "healthy"
  if (score >= 65) return "watch"
  if (score >= 45) return "at_risk"
  return "critical"
}

function getColor(score: number): string {
  if (score >= 80) return "#22c55e" // green
  if (score >= 65) return "#eab308" // yellow
  if (score >= 45) return "#f97316" // orange
  return "#ef4444" // red
}

function getRiskLabel(score: number): string {
  if (score >= 80) return "Healthy"
  if (score >= 65) return "Watch"
  if (score >= 45) return "At Risk"
  return "Critical"
}

export function DealHealthRing({
  score,
  size = 120,
  showLabel = false,
  className,
}: DealHealthRingProps) {
  const [animatedScore, setAnimatedScore] = useState(0)
  
  // Clamp score between 0-100
  const clampedScore = Math.min(100, Math.max(0, score))
  
  // SVG calculations
  const strokeWidth = size * 0.1
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const center = size / 2
  
  // Calculate stroke-dasharray based on score
  const strokeDasharray = circumference
  const strokeDashoffset = circumference - (animatedScore / 100) * circumference
  
  const color = getColor(clampedScore)
  const riskLevel = getRiskLevel(clampedScore)
  const riskLabel = getRiskLabel(clampedScore)
  
  // Animate on mount
  useEffect(() => {
    const timer = setTimeout(() => {
      setAnimatedScore(clampedScore)
    }, 50)
    return () => clearTimeout(timer)
  }, [clampedScore])
  
  return (
    <div className={cn("relative inline-flex items-center justify-center", className)}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="transform -rotate-90"
      >
        {/* Background circle */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          className="text-muted/20"
        />
        
        {/* Progress circle */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={strokeDasharray}
          strokeDashoffset={strokeDashoffset}
          style={{
            transition: "stroke-dashoffset 0.8s ease-out",
          }}
        />
      </svg>
      
      {/* Center content */}
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className="font-bold"
          style={{
            fontSize: size * 0.25,
            color,
          }}
        >
          {Math.round(animatedScore)}
        </span>
        
        {showLabel && (
          <span
            className="font-medium"
            style={{
              fontSize: size * 0.12,
              color,
            }}
          >
            {riskLabel}
          </span>
        )}
      </div>
    </div>
  )
}
