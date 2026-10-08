"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import Link from "next/link"
// TOMBSTONE (orphan doctrine §1.3): `TrendingUp` and `Star` were imported here and
// rendered NOWHERE. Both questions they could have answered are already answered on
// this panel by SURVIVORS: rank is carried by the medal set at leaderboard-panel.tsx:39-41
// (Trophy / Medal / Award) and tier by the Badge at :101 — so a star or a trend arrow
// would be a third and fourth spelling of "how is this agent doing" (§6). This panel
// renders a RANKED SNAPSHOT and holds no previous-period value, so there is no trend
// for TrendingUp to point up or down at.
import { Trophy, Medal, Award, ArrowRight } from "lucide-react"
import { METRIC_LABEL, type LeaderboardMetric } from "@/lib/gamification/leaderboard-vocabulary"

interface LeaderboardEntry {
  rank: number
  agentId: string
  agentName: string
  avatarUrl?: string
  points: number
  tier: string
  metricValue: number
  isCurrentUser?: boolean
}

interface LeaderboardPanelProps {
  rankings: LeaderboardEntry[]
  currentUserRank?: LeaderboardEntry | null
  // THE ONE LEADERBOARD VOCABULARY. This union carried "revenue", which nothing has
  // ever written to leaderboard_rankings and which a peer-visible board must not
  // carry anyway (#185, #57 — commission is off agent-facing display).
  metricType: LeaderboardMetric
  periodLabel: string
}

export function LeaderboardPanel({
  rankings,
  currentUserRank,
  metricType,
  periodLabel,
}: LeaderboardPanelProps) {
  const getRankIcon = (rank: number) => {
    if (rank === 1) return <Trophy className="h-4 w-4 text-yellow-500" />
    if (rank === 2) return <Medal className="h-4 w-4 text-gray-400" />
    if (rank === 3) return <Award className="h-4 w-4 text-amber-600" />
    return <span className="text-sm text-muted-foreground">#{rank}</span>
  }

  const getTierColor = (tier: string) => {
    switch (tier.toLowerCase()) {
      case "platinum": return "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400"
      case "gold": return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
      case "silver": return "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400"
      case "bronze": return "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
      default: return "bg-muted text-muted-foreground"
    }
  }

  const formatMetric = (value: number, type: LeaderboardMetric) => {
    if (type === "points") return `${value.toLocaleString()} pts`
    return `${value.toLocaleString()} ${METRIC_LABEL[type].toLowerCase()}`
  }

  const getInitials = (name: string) => {
    return name.split(" ").map(n => n[0]).join("").toUpperCase().slice(0, 2)
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Trophy className="h-4 w-4 text-primary" />
            Leaderboard
          </CardTitle>
          <Badge variant="outline" className="text-xs">
            {periodLabel}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Top Rankings */}
        {rankings.slice(0, 5).map((entry) => (
          <div
            key={entry.agentId}
            className={`flex items-center justify-between rounded-lg p-2 ${
              entry.isCurrentUser ? "bg-primary/5 ring-1 ring-primary/20" : ""
            }`}
          >
            <div className="flex items-center gap-3">
              <div className="flex h-6 w-6 items-center justify-center">
                {getRankIcon(entry.rank)}
              </div>
              <Avatar className="h-8 w-8">
                <AvatarImage src={entry.avatarUrl} />
                <AvatarFallback className="text-xs">
                  {getInitials(entry.agentName)}
                </AvatarFallback>
              </Avatar>
              <div className="flex flex-col">
                <span className="text-sm font-medium">
                  {entry.agentName}
                  {entry.isCurrentUser && <span className="ml-1 text-xs text-primary">(You)</span>}
                </span>
                <Badge className={`text-xs ${getTierColor(entry.tier)}`}>
                  {entry.tier}
                </Badge>
              </div>
            </div>
            <div className="text-right">
              <span className="font-semibold">
                {formatMetric(entry.metricValue, metricType)}
              </span>
            </div>
          </div>
        ))}

        {/* Current User (if not in top 5) */}
        {currentUserRank && !rankings.slice(0, 5).some(r => r.isCurrentUser) && (
          <>
            <div className="border-t pt-2 text-center text-xs text-muted-foreground">
              ...
            </div>
            <div className="flex items-center justify-between rounded-lg bg-primary/5 p-2 ring-1 ring-primary/20">
              <div className="flex items-center gap-3">
                <div className="flex h-6 w-6 items-center justify-center">
                  <span className="text-sm text-muted-foreground">#{currentUserRank.rank}</span>
                </div>
                <Avatar className="h-8 w-8">
                  <AvatarImage src={currentUserRank.avatarUrl} />
                  <AvatarFallback className="text-xs">
                    {getInitials(currentUserRank.agentName)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex flex-col">
                  <span className="text-sm font-medium">
                    {currentUserRank.agentName} <span className="text-xs text-primary">(You)</span>
                  </span>
                  <Badge className={`text-xs ${getTierColor(currentUserRank.tier)}`}>
                    {currentUserRank.tier}
                  </Badge>
                </div>
              </div>
              <span className="font-semibold">
                {formatMetric(currentUserRank.metricValue, metricType)}
              </span>
            </div>
          </>
        )}

        <Link href="/dashboard/motivation">
          <Button variant="outline" size="sm" className="w-full gap-2">
            View Full Leaderboard
            <ArrowRight className="h-4 w-4" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  )
}
