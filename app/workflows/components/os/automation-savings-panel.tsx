"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { TrendingUp, Clock, Zap, Calendar } from "lucide-react"

interface AutomationSavingsPanelProps {
  stats: {
    total: number
    succeeded_today: number
    succeeded_month: number
  } | null
}

export function AutomationSavingsPanel({ stats }: AutomationSavingsPanelProps) {
  // Estimate: each successful automation saves ~4 minutes of manual work
  const MINUTES_SAVED_PER_AUTOMATION = 4

  const todaySaved = (stats?.succeeded_today || 0) * MINUTES_SAVED_PER_AUTOMATION
  const monthSaved = (stats?.succeeded_month || 0) * MINUTES_SAVED_PER_AUTOMATION
  const hoursSavedMonth = Math.round(monthSaved / 60)

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-green-600" />
          Automation Impact
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-md bg-blue-50 border border-blue-200 px-3 py-2">
            <div className="flex items-center gap-2 mb-1">
              <Zap className="h-4 w-4 text-blue-600" />
              <span className="text-xs text-blue-700">Today</span>
            </div>
            <p className="text-lg font-bold text-blue-900">{stats?.succeeded_today || 0}</p>
            <p className="text-xs text-blue-700">automations run</p>
          </div>

          <div className="rounded-md bg-purple-50 border border-purple-200 px-3 py-2">
            <div className="flex items-center gap-2 mb-1">
              <Calendar className="h-4 w-4 text-purple-600" />
              <span className="text-xs text-purple-700">This Month</span>
            </div>
            <p className="text-lg font-bold text-purple-900">{stats?.succeeded_month || 0}</p>
            <p className="text-xs text-purple-700">automations run</p>
          </div>

          <div className="rounded-md bg-green-50 border border-green-200 px-3 py-2">
            <div className="flex items-center gap-2 mb-1">
              <Clock className="h-4 w-4 text-green-600" />
              <span className="text-xs text-green-700">Time Saved Today</span>
            </div>
            <p className="text-lg font-bold text-green-900">{todaySaved} min</p>
            <p className="text-xs text-green-700">of manual work</p>
          </div>

          <div className="rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2">
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp className="h-4 w-4 text-emerald-600" />
              <span className="text-xs text-emerald-700">Hours This Month</span>
            </div>
            <p className="text-lg font-bold text-emerald-900">{hoursSavedMonth}h</p>
            <p className="text-xs text-emerald-700">saved</p>
          </div>
        </div>

        <p className="text-xs text-muted-foreground text-center">
          Every automation prevents manual work
        </p>
      </CardContent>
    </Card>
  )
}
