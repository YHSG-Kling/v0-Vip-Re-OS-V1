"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Activity, TrendingUp, TrendingDown, AlertTriangle, CheckCircle2, Minus } from "lucide-react"
import { useMemo } from "react"

interface Transaction {
  id: string
  property_address: string
  deal_health?: {
    overall_score: number
    risk_level: string
    flags: string[]
    previous_score?: number
    score_delta?: number
  }
}

interface HealthScore {
  transaction_id: string
  overall_score: number
  risk_level: string
  flags: string[]
  previous_score?: number
  score_delta?: number
  ai_narrative?: string
}

interface HealthOverviewProps {
  transactions: Transaction[]
  healthScores: HealthScore[]
}

export function HealthOverview({ transactions, healthScores }: HealthOverviewProps) {
  const metrics = useMemo(() => {
    const scores = transactions
      .map((t) => t.deal_health?.overall_score ?? 0)
      .filter((s) => s > 0)

    const avgScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0

    const riskBreakdown = {
      low: 0,
      medium: 0,
      high: 0,
    }

    transactions.forEach((t) => {
      const level = t.deal_health?.risk_level?.toLowerCase() || "low"
      if (level === "high") riskBreakdown.high++
      else if (level === "medium") riskBreakdown.medium++
      else riskBreakdown.low++
    })

    // Get all unique flags across transactions
    const allFlags: Record<string, number> = {}
    transactions.forEach((t) => {
      t.deal_health?.flags?.forEach((flag) => {
        allFlags[flag] = (allFlags[flag] || 0) + 1
      })
    })

    const topFlags = Object.entries(allFlags)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)

    // Count improving vs declining
    let improving = 0
    let declining = 0
    let stable = 0

    transactions.forEach((t) => {
      const delta = t.deal_health?.score_delta
      if (delta && delta > 0) improving++
      else if (delta && delta < 0) declining++
      else stable++
    })

    return {
      avgScore,
      totalDeals: transactions.length,
      riskBreakdown,
      topFlags,
      improving,
      declining,
      stable,
    }
  }, [transactions])

  const getScoreColor = (score: number) => {
    if (score >= 80) return "text-emerald-600"
    if (score >= 60) return "text-amber-600"
    return "text-red-600"
  }

  const getScoreBg = (score: number) => {
    if (score >= 80) return "bg-emerald-50 border-emerald-200"
    if (score >= 60) return "bg-amber-50 border-amber-200"
    return "bg-red-50 border-red-200"
  }

  if (transactions.length === 0) return null

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Activity className="h-5 w-5 text-blue-600" />
          Portfolio Health Overview
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {/* Average Score */}
          <div className={`rounded-lg border p-4 ${getScoreBg(metrics.avgScore)}`}>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Avg Health Score</p>
            <p className={`text-3xl font-bold mt-1 ${getScoreColor(metrics.avgScore)}`}>{metrics.avgScore}</p>
            <p className="text-xs text-muted-foreground mt-1">across {metrics.totalDeals} deals</p>
          </div>

          {/* Risk Distribution */}
          <div className="rounded-lg border p-4 bg-background">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Risk Distribution</p>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-sm">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                  Low Risk
                </span>
                <Badge variant="secondary" className="bg-emerald-100 text-emerald-700">
                  {metrics.riskBreakdown.low}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-sm">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                  Medium Risk
                </span>
                <Badge variant="secondary" className="bg-amber-100 text-amber-700">
                  {metrics.riskBreakdown.medium}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-sm">
                  <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
                  High Risk
                </span>
                <Badge variant="secondary" className="bg-red-100 text-red-700">
                  {metrics.riskBreakdown.high}
                </Badge>
              </div>
            </div>
          </div>

          {/* Trend */}
          <div className="rounded-lg border p-4 bg-background">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Score Trends</p>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-sm">
                  <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />
                  Improving
                </span>
                <Badge variant="secondary" className="bg-emerald-100 text-emerald-700">
                  {metrics.improving}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-sm">
                  <Minus className="h-3.5 w-3.5 text-muted-foreground" />
                  Stable
                </span>
                <Badge variant="secondary">{metrics.stable}</Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-sm">
                  <TrendingDown className="h-3.5 w-3.5 text-red-500" />
                  Declining
                </span>
                <Badge variant="secondary" className="bg-red-100 text-red-700">
                  {metrics.declining}
                </Badge>
              </div>
            </div>
          </div>

          {/* Top Flags */}
          <div className="rounded-lg border p-4 bg-background">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Common Issues</p>
            {metrics.topFlags.length === 0 ? (
              <p className="text-sm text-muted-foreground">No issues flagged</p>
            ) : (
              <div className="space-y-1">
                {metrics.topFlags.map(([flag, count]) => (
                  <div key={flag} className="flex items-center justify-between gap-2">
                    <span className="text-sm truncate">{flag}</span>
                    <Badge variant="outline" className="text-xs flex-shrink-0">
                      {count}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
