"use client"

import { AlertTriangle, Activity, Flag, TrendingUp } from "lucide-react"

interface KPIBarProps {
  avgHealthScore: number        // 0-1 float → display ×100
  pendingFlagsToday: number
  fairHousingPending: number
  escalationsLast7Days: number
}

function healthColor(score: number) {
  if (score >= 70) return "text-green-600 bg-green-50 border-green-200"
  if (score >= 50) return "text-yellow-600 bg-yellow-50 border-yellow-200"
  return "text-red-600 bg-red-50 border-red-200"
}

export default function KPIBar({ avgHealthScore, pendingFlagsToday, fairHousingPending, escalationsLast7Days }: KPIBarProps) {
  const healthPct = Math.round(avgHealthScore * 100)

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {/* 1 — Avg Health Score */}
      <div className={`rounded-lg border p-4 ${healthColor(healthPct)}`}>
        <div className="flex items-center gap-2 mb-1">
          <Activity className="h-4 w-4 shrink-0" />
          <span className="text-xs font-medium uppercase tracking-wide">Avg Health Score</span>
        </div>
        <p className="text-3xl font-bold">{healthPct}<span className="text-base font-normal">%</span></p>
        <p className="text-xs mt-1 opacity-70">
          {healthPct >= 70 ? "Healthy" : healthPct >= 50 ? "Needs attention" : "Critical"}
        </p>
      </div>

      {/* 2 — Pending Flags Today */}
      <div className="rounded-lg border border-border bg-card p-4 text-card-foreground">
        <div className="flex items-center gap-2 mb-1 text-muted-foreground">
          <Flag className="h-4 w-4 shrink-0" />
          <span className="text-xs font-medium uppercase tracking-wide">Pending Flags Today</span>
        </div>
        <p className="text-3xl font-bold text-foreground">{pendingFlagsToday}</p>
        <p className="text-xs mt-1 text-muted-foreground">Awaiting review</p>
      </div>

      {/* 3 — Fair Housing Flags (always red) */}
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
        <div className="flex items-center gap-2 mb-1">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="text-xs font-medium uppercase tracking-wide">Fair Housing Flags</span>
        </div>
        <p className="text-3xl font-bold">{fairHousingPending}</p>
        <p className="text-xs mt-1 opacity-70">Pending review</p>
      </div>

      {/* 4 — Escalations Recommended */}
      <div className="rounded-lg border border-border bg-card p-4 text-card-foreground">
        <div className="flex items-center gap-2 mb-1 text-muted-foreground">
          <TrendingUp className="h-4 w-4 shrink-0" />
          <span className="text-xs font-medium uppercase tracking-wide">Escalations (7d)</span>
        </div>
        <p className="text-3xl font-bold text-foreground">{escalationsLast7Days}</p>
        <p className="text-xs mt-1 text-muted-foreground">Recommended this week</p>
      </div>
    </div>
  )
}
