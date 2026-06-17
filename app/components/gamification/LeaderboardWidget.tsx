"use client"

import Link from "next/link"
import { cn } from "@/lib/utils"
import { Trophy, Medal, Award, ChevronRight, User } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"

interface RankingEntry {
  id: string
  rank_position: number
  metric_value: number
  agent_id: string | null
  agents: {
    id: string
    // Identity lives on the joined users row (agents.user_id → users), not on agents.
    users: { first_name: string | null; last_name: string | null } | null
    gamification_points: number | null
    profile_image_url: string | null
  } | null
}

interface LeaderboardWidgetProps {
  rankings: RankingEntry[]
  currentAgentId: string | null
  className?: string
}

const RANK_ICONS: Record<number, { icon: React.ElementType; color: string }> = {
  1: { icon: Trophy, color: "text-yellow-500" },
  2: { icon: Medal, color: "text-slate-400" },
  3: { icon: Award, color: "text-amber-600" },
}

export function LeaderboardWidget({ rankings, currentAgentId, className }: LeaderboardWidgetProps) {
  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Trophy className="h-5 w-5 text-yellow-500" />
            Leaderboard
          </CardTitle>
          <Link href="/dashboard/leaderboard">
            <Button variant="ghost" size="sm" className="text-xs">
              View All
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {rankings.length === 0 ? (
          <div className="text-center py-4 text-muted-foreground">
            <Trophy className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No rankings yet this month</p>
          </div>
        ) : (
          rankings.map(entry => {
            const isCurrentUser = entry.agent_id === currentAgentId
            const rankConfig = RANK_ICONS[entry.rank_position]
            const RankIcon = rankConfig?.icon

            const agentName = entry.agents
              ? `${entry.agents.users?.first_name || ""} ${entry.agents.users?.last_name || ""}`.trim() || "Unknown"
              : "Unknown"

            const initials = entry.agents
              ? `${entry.agents.users?.first_name?.[0] || ""}${entry.agents.users?.last_name?.[0] || ""}`.toUpperCase()
              : "?"

            return (
              <div
                key={entry.id}
                className={cn(
                  "flex items-center gap-3 p-2 rounded-lg transition-colors",
                  isCurrentUser ? "bg-blue-50 border border-blue-200" : "hover:bg-muted/50"
                )}
              >
                <div className="w-8 flex justify-center">
                  {RankIcon ? (
                    <RankIcon className={cn("h-5 w-5", rankConfig.color)} />
                  ) : (
                    <span className="text-sm font-bold text-muted-foreground">
                      #{entry.rank_position}
                    </span>
                  )}
                </div>

                <Avatar className="h-8 w-8">
                  <AvatarImage src={entry.agents?.profile_image_url || undefined} alt={agentName} />
                  <AvatarFallback className="text-xs">{initials}</AvatarFallback>
                </Avatar>

                <div className="flex-1 min-w-0">
                  <p className={cn("text-sm font-medium truncate", isCurrentUser && "text-blue-700")}>
                    {agentName}
                    {isCurrentUser && <span className="ml-1 text-xs">(You)</span>}
                  </p>
                </div>

                <div className="text-right">
                  <p className="text-sm font-semibold">{entry.metric_value.toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground">pts</p>
                </div>
              </div>
            )
          })
        )}
      </CardContent>
    </Card>
  )
}
