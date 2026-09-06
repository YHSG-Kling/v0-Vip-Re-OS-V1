"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import { Users, TrendingUp, TrendingDown, AlertTriangle, ArrowRight } from "lucide-react"

interface TeamMember {
  id: string
  name: string
  points: number
  tier: string
  activityScore: number // 0-100
  trend: "up" | "down" | "stable"
  alertCount: number
}

interface TeamHeatmapPanelProps {
  teamMembers: TeamMember[]
  totalAgents: number
  averageActivityScore: number
}

export function TeamHeatmapPanel({
  teamMembers,
  totalAgents,
  averageActivityScore,
}: TeamHeatmapPanelProps) {
  const getActivityColor = (score: number) => {
    if (score >= 80) return "bg-green-500"
    if (score >= 60) return "bg-green-400"
    if (score >= 40) return "bg-amber-400"
    if (score >= 20) return "bg-amber-500"
    return "bg-red-500"
  }

  const getTrendIcon = (trend: "up" | "down" | "stable") => {
    if (trend === "up") return <TrendingUp className="h-3 w-3 text-green-600" />
    if (trend === "down") return <TrendingDown className="h-3 w-3 text-red-600" />
    return null
  }

  const sortedMembers = [...teamMembers].sort((a, b) => b.activityScore - a.activityScore)
  const topPerformers = sortedMembers.slice(0, 5)
  const needsAttention = sortedMembers.filter(m => m.activityScore < 40 || m.alertCount > 0)

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="h-4 w-4 text-primary" />
            Team Activity Heatmap
          </CardTitle>
          <Badge variant="outline">
            {totalAgents} agents
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Avg Activity: <span className="font-medium">{averageActivityScore}%</span>
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Heatmap Grid */}
        <div className="flex flex-wrap gap-1">
          {sortedMembers.slice(0, 20).map((member) => (
            <div
              key={member.id}
              className={`h-6 w-6 rounded ${getActivityColor(member.activityScore)} cursor-pointer transition-transform hover:scale-110`}
              title={`${member.name}: ${member.activityScore}% activity`}
            />
          ))}
          {totalAgents > 20 && (
            <div className="flex h-6 items-center px-2 text-xs text-muted-foreground">
              +{totalAgents - 20} more
            </div>
          )}
        </div>

        {/* Top Performers */}
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Top Performers</h4>
          {topPerformers.slice(0, 3).map((member, index) => (
            <div key={member.id} className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">#{index + 1}</span>
                <span>{member.name}</span>
                {getTrendIcon(member.trend)}
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-xs">
                  {member.tier}
                </Badge>
                <span className="font-medium">{member.points} pts</span>
              </div>
            </div>
          ))}
        </div>

        {/* Needs Attention */}
        {needsAttention.length > 0 && (
          <div className="space-y-2 rounded-lg bg-amber-50 p-3 dark:bg-amber-950/20">
            <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-4 w-4" />
              Needs Attention ({needsAttention.length})
            </div>
            {needsAttention.slice(0, 2).map((member) => (
              <div key={member.id} className="flex items-center justify-between text-sm">
                <span>{member.name}</span>
                <span className="text-amber-600">{member.activityScore}% activity</span>
              </div>
            ))}
          </div>
        )}

        <Link href="/dashboard/team">
          <Button variant="outline" size="sm" className="w-full gap-2">
            View Full Team Heatmap
            <ArrowRight className="h-4 w-4" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  )
}
