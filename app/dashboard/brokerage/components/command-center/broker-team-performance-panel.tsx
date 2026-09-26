"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import {
  Users,
  ArrowRight,
  TrendingUp,
  TrendingDown,
} from "lucide-react"

interface AgentPerformance {
  id: string
  name: string
  ytdGCI: number
  transactions: number
  conversionRate: number
  trend: "up" | "down" | "flat"
  status: "top_performer" | "on_track" | "underperforming" | "at_risk"
}

interface BrokerTeamPerformancePanelProps {
  agents: AgentPerformance[]
  summary: {
    totalAgents: number
    topPerformers: number
    atRisk: number
    avgConversionRate: number
  }
}

export function BrokerTeamPerformancePanel({ agents, summary }: BrokerTeamPerformancePanelProps) {
  const formatCurrency = (val: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(val)

  const statusStyles = {
    top_performer: {
      badge: "outline" as const,
      text: "text-green-600",
      label: "Top Performer",
    },
    on_track: {
      badge: "secondary" as const,
      text: "text-blue-600",
      label: "On Track",
    },
    underperforming: {
      badge: "secondary" as const,
      text: "text-orange-600",
      label: "Below Target",
    },
    at_risk: {
      badge: "destructive" as const,
      text: "text-red-600",
      label: "At Risk",
    },
  }

  // Show at-risk and underperforming agents first, limited to 5
  const sortedAgents = [...agents]
    .sort((a, b) => {
      const order = { at_risk: 0, underperforming: 1, on_track: 2, top_performer: 3 }
      return order[a.status] - order[b.status]
    })
    .slice(0, 5)

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-4 w-4" />
            Team Performance
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">
              {summary.totalAgents} Agents
            </Badge>
            {summary.atRisk > 0 && (
              <Badge variant="destructive" className="text-xs">
                {summary.atRisk} Need Attention
              </Badge>
            )}
            <Link href="/dashboard/team">
              <Button variant="ghost" size="sm" className="text-xs">
                View Team
                <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Summary Stats */}
        <div className="grid grid-cols-3 gap-4 p-3 bg-muted/50 rounded-lg text-center">
          <div>
            <div className="text-lg font-bold text-green-600">{summary.topPerformers}</div>
            <div className="text-xs text-muted-foreground">Top Performers</div>
          </div>
          <div>
            <div className="text-lg font-bold">{summary.avgConversionRate.toFixed(1)}%</div>
            <div className="text-xs text-muted-foreground">Avg Conversion</div>
          </div>
          <div>
            <div className="text-lg font-bold text-orange-600">{summary.atRisk}</div>
            <div className="text-xs text-muted-foreground">Need Support</div>
          </div>
        </div>

        {/* Agent List */}
        {sortedAgents.map((agent) => {
          const styles = statusStyles[agent.status]
          const TrendIcon = agent.trend === "up" ? TrendingUp : agent.trend === "down" ? TrendingDown : TrendingUp

          return (
            <div
              key={agent.id}
              className="flex items-center justify-between p-3 rounded-lg border bg-card"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className={`h-8 w-8 rounded-full flex items-center justify-center text-xs font-medium ${
                    agent.status === "at_risk" ? "bg-red-100 text-red-700" :
                    agent.status === "top_performer" ? "bg-green-100 text-green-700" :
                    "bg-muted text-muted-foreground"
                  }`}
                >
                  {agent.name.split(" ").map(n => n[0]).join("").slice(0, 2)}
                </div>
                <div className="min-w-0">
                  <div className="font-medium text-sm truncate">{agent.name}</div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{agent.transactions} deals</span>
                    <span className="h-1 w-1 rounded-full bg-muted-foreground" />
                    <span className={`flex items-center gap-0.5 ${agent.trend === "up" ? "text-green-600" : agent.trend === "down" ? "text-red-600" : ""}`}>
                      <TrendIcon className="h-3 w-3" />
                      {agent.conversionRate.toFixed(0)}%
                    </span>
                  </div>
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="font-bold text-sm">{formatCurrency(agent.ytdGCI)}</div>
                <Badge variant={styles.badge} className="text-xs mt-1">
                  {styles.label}
                </Badge>
              </div>
            </div>
          )
        })}

        {agents.length === 0 && (
          <div className="text-center py-6 text-muted-foreground text-sm">
            No agent performance data available
          </div>
        )}
      </CardContent>
    </Card>
  )
}
