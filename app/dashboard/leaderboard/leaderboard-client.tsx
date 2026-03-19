"use client"

import { useRouter, useSearchParams } from "next/navigation"
import { cn } from "@/lib/utils"
import { Trophy, Medal, Award, Users, Building2, User, TrendingUp, DollarSign, FileText, UserPlus } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PointsBadge } from "@/app/components/gamification/PointsBadge"
import { BadgeGrid } from "@/app/components/gamification/BadgeGrid"

interface RankingEntry {
  id: string
  rank_position: number
  metric_value: number
  agent_id: string | null
  team_id: string | null
  agents: {
    id: string
    first_name: string | null
    last_name: string | null
    gamification_points: number | null
    profile_image_url: string | null
  } | null
}

interface PointsData {
  agentId: string
  agentName: string
  points: number
  currentTier: string
  nextTier: string
  pointsToNextTier: number
}

interface BadgesData {
  earned: any[]
  all: any[]
  earnedBadgeIds: Set<string>
}

interface LeaderboardClientProps {
  rankings: RankingEntry[]
  currentAgentId: string | null
  currentUserRank: { rank_position: number; metric_value: number } | null
  currentUserInList: boolean
  pointsData: PointsData
  badgesData: BadgesData
  initialScope: "agent" | "team" | "brokerage"
  initialMetric: "points" | "revenue" | "transactions" | "referrals"
  initialPeriod: string
}

const RANK_ICONS: Record<number, { icon: React.ElementType; color: string }> = {
  1: { icon: Trophy, color: "text-yellow-500" },
  2: { icon: Medal, color: "text-slate-400" },
  3: { icon: Award, color: "text-amber-600" },
}

const SCOPE_OPTIONS = [
  { value: "agent", label: "Agents", icon: User },
  { value: "team", label: "Teams", icon: Users },
  { value: "brokerage", label: "Brokerage", icon: Building2 },
]

const METRIC_OPTIONS = [
  { value: "points", label: "Points", icon: TrendingUp },
  { value: "revenue", label: "Revenue", icon: DollarSign },
  { value: "transactions", label: "Transactions", icon: FileText },
  { value: "referrals", label: "Referrals", icon: UserPlus },
]

const PERIOD_OPTIONS = [
  { value: "month", label: "This Month" },
  { value: "quarter", label: "This Quarter" },
  { value: "year", label: "This Year" },
  { value: "all", label: "All Time" },
]

export function LeaderboardClient({
  rankings,
  currentAgentId,
  currentUserRank,
  currentUserInList,
  pointsData,
  badgesData,
  initialScope,
  initialMetric,
  initialPeriod,
}: LeaderboardClientProps) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const handleScopeChange = (value: string) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set("scope", value)
    router.push(`/dashboard/leaderboard?${params.toString()}`)
  }

  const handleMetricChange = (value: string) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set("metric", value)
    router.push(`/dashboard/leaderboard?${params.toString()}`)
  }

  const handlePeriodChange = (value: string) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set("period", value)
    router.push(`/dashboard/leaderboard?${params.toString()}`)
  }

  const getMetricLabel = (metric: string) => {
    switch (metric) {
      case "points": return "pts"
      case "revenue": return ""
      case "transactions": return "deals"
      case "referrals": return "refs"
      default: return ""
    }
  }

  const formatMetricValue = (value: number, metric: string) => {
    if (metric === "revenue") {
      return `$${value.toLocaleString()}`
    }
    return value.toLocaleString()
  }

  return (
    <div className="grid gap-6 md:grid-cols-3">
      {/* Left Column: Your Stats */}
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-lg">Your Progress</CardTitle>
          </CardHeader>
          <CardContent>
            <PointsBadge
              points={pointsData.points}
              currentTier={pointsData.currentTier}
              nextTier={pointsData.nextTier}
              pointsToNextTier={pointsData.pointsToNextTier}
              variant="large"
            />

            {currentUserRank && !currentUserInList && (
              <div className="mt-4 p-3 bg-blue-50 rounded-lg border border-blue-200">
                <p className="text-sm text-blue-700">
                  Your current rank: <span className="font-bold">#{currentUserRank.rank_position}</span>
                </p>
                <p className="text-xs text-blue-600">
                  {formatMetricValue(currentUserRank.metric_value, initialMetric)} {getMetricLabel(initialMetric)}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-lg">Your Badges</CardTitle>
          </CardHeader>
          <CardContent>
            <BadgeGrid
              allBadges={badgesData.all}
              earnedBadges={badgesData.earned}
              currentPoints={pointsData.points}
            />
          </CardContent>
        </Card>
      </div>

      {/* Right Column: Leaderboard */}
      <div className="md:col-span-2 space-y-4">
        {/* Filters */}
        <Card>
          <CardContent className="pt-4 space-y-4">
            {/* Scope Toggle */}
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-2 block">Scope</label>
              <Tabs value={initialScope} onValueChange={handleScopeChange}>
                <TabsList className="grid w-full grid-cols-3">
                  {SCOPE_OPTIONS.map(option => {
                    const Icon = option.icon
                    return (
                      <TabsTrigger key={option.value} value={option.value} className="flex items-center gap-1.5">
                        <Icon className="h-4 w-4" />
                        <span className="hidden sm:inline">{option.label}</span>
                      </TabsTrigger>
                    )
                  })}
                </TabsList>
              </Tabs>
            </div>

            {/* Metric Toggle */}
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-2 block">Metric</label>
              <Tabs value={initialMetric} onValueChange={handleMetricChange}>
                <TabsList className="grid w-full grid-cols-4">
                  {METRIC_OPTIONS.map(option => {
                    const Icon = option.icon
                    return (
                      <TabsTrigger key={option.value} value={option.value} className="flex items-center gap-1">
                        <Icon className="h-4 w-4" />
                        <span className="hidden sm:inline">{option.label}</span>
                      </TabsTrigger>
                    )
                  })}
                </TabsList>
              </Tabs>
            </div>

            {/* Period Toggle */}
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-2 block">Period</label>
              <Tabs value={initialPeriod} onValueChange={handlePeriodChange}>
                <TabsList className="grid w-full grid-cols-4">
                  {PERIOD_OPTIONS.map(option => (
                    <TabsTrigger key={option.value} value={option.value}>
                      {option.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>
          </CardContent>
        </Card>

        {/* Rankings List */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Trophy className="h-5 w-5 text-yellow-500" />
              Rankings
            </CardTitle>
          </CardHeader>
          <CardContent>
            {rankings.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <Trophy className="h-12 w-12 mx-auto mb-3 opacity-50" />
                <p>No rankings available for this period</p>
              </div>
            ) : (
              <div className="space-y-2">
                {rankings.map(entry => {
                  const isCurrentUser = entry.agent_id === currentAgentId
                  const rankConfig = RANK_ICONS[entry.rank_position]
                  const RankIcon = rankConfig?.icon

                  const agentName = entry.agents
                    ? `${entry.agents.first_name || ""} ${entry.agents.last_name || ""}`.trim() || "Unknown"
                    : "Unknown"

                  const initials = entry.agents
                    ? `${entry.agents.first_name?.[0] || ""}${entry.agents.last_name?.[0] || ""}`.toUpperCase()
                    : "?"

                  return (
                    <div
                      key={entry.id}
                      className={cn(
                        "flex items-center gap-4 p-3 rounded-lg transition-colors",
                        isCurrentUser ? "bg-blue-50 border border-blue-200" : "hover:bg-muted/50"
                      )}
                    >
                      <div className="w-10 flex justify-center">
                        {RankIcon ? (
                          <RankIcon className={cn("h-6 w-6", rankConfig.color)} />
                        ) : (
                          <span className="text-lg font-bold text-muted-foreground">
                            #{entry.rank_position}
                          </span>
                        )}
                      </div>

                      <Avatar className="h-10 w-10">
                        <AvatarImage src={entry.agents?.profile_image_url || undefined} alt={agentName} />
                        <AvatarFallback>{initials}</AvatarFallback>
                      </Avatar>

                      <div className="flex-1 min-w-0">
                        <p className={cn("font-medium truncate", isCurrentUser && "text-blue-700")}>
                          {agentName}
                          {isCurrentUser && <span className="ml-2 text-xs bg-blue-100 px-2 py-0.5 rounded">You</span>}
                        </p>
                        {entry.agents?.gamification_points !== undefined && entry.agents?.gamification_points !== null && initialMetric === "points" && (
                          <p className="text-xs text-muted-foreground">
                            Total: {entry.agents.gamification_points.toLocaleString()} pts
                          </p>
                        )}
                      </div>

                      <div className="text-right">
                        <p className="text-lg font-bold">
                          {formatMetricValue(entry.metric_value, initialMetric)}
                        </p>
                        <p className="text-xs text-muted-foreground">{getMetricLabel(initialMetric)}</p>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {/* Current user rank if not in top 20 */}
            {currentUserRank && !currentUserInList && (
              <div className="mt-4 pt-4 border-t">
                <div className="flex items-center gap-4 p-3 bg-blue-50 rounded-lg border border-blue-200">
                  <div className="w-10 flex justify-center">
                    <span className="text-lg font-bold text-blue-700">
                      #{currentUserRank.rank_position}
                    </span>
                  </div>
                  <div className="flex-1">
                    <p className="font-medium text-blue-700">Your Position</p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold text-blue-700">
                      {formatMetricValue(currentUserRank.metric_value, initialMetric)}
                    </p>
                    <p className="text-xs text-blue-600">{getMetricLabel(initialMetric)}</p>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
