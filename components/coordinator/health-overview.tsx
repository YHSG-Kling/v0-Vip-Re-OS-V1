"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { CheckCircle2, AlertTriangle, XCircle, Activity } from "lucide-react"

interface HealthStats {
  totalTransactions: number
  onTrack: number
  atRisk: number
  overdue: number
  avgCompletionRate: number
}

interface HealthOverviewProps {
  stats?: HealthStats
}

export function HealthOverview({
  stats = {
    totalTransactions: 0,
    onTrack: 0,
    atRisk: 0,
    overdue: 0,
    avgCompletionRate: 0,
  },
}: HealthOverviewProps) {
  const healthScore = stats.totalTransactions > 0
    ? Math.round(((stats.onTrack) / stats.totalTransactions) * 100)
    : 100

  const getHealthColor = (score: number) => {
    if (score >= 80) return "text-emerald-500"
    if (score >= 60) return "text-amber-500"
    return "text-red-500"
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Portfolio Health</CardTitle>
            <CardDescription>Transaction status overview</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Activity className={`w-5 h-5 ${getHealthColor(healthScore)}`} />
            <span className={`text-2xl font-bold ${getHealthColor(healthScore)}`}>
              {healthScore}%
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span>Overall Health Score</span>
            <span className="font-medium">{stats.onTrack} of {stats.totalTransactions} on track</span>
          </div>
          <Progress value={healthScore} className="h-2" />
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div className="text-center p-3 border rounded-lg">
            <div className="flex justify-center mb-2">
              <CheckCircle2 className="w-6 h-6 text-emerald-500" />
            </div>
            <p className="text-2xl font-bold">{stats.onTrack}</p>
            <p className="text-xs text-muted-foreground">On Track</p>
          </div>

          <div className="text-center p-3 border rounded-lg">
            <div className="flex justify-center mb-2">
              <AlertTriangle className="w-6 h-6 text-amber-500" />
            </div>
            <p className="text-2xl font-bold">{stats.atRisk}</p>
            <p className="text-xs text-muted-foreground">At Risk</p>
          </div>

          <div className="text-center p-3 border rounded-lg">
            <div className="flex justify-center mb-2">
              <XCircle className="w-6 h-6 text-red-500" />
            </div>
            <p className="text-2xl font-bold">{stats.overdue}</p>
            <p className="text-xs text-muted-foreground">Overdue</p>
          </div>
        </div>

        <div className="pt-4 border-t">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Avg Completion Rate</span>
            <span className="font-semibold">{stats.avgCompletionRate}%</span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
