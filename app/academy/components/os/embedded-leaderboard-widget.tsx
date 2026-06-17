"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Trophy, Loader2, ArrowRight, Crown, Medal } from "lucide-react"
import Link from "next/link"
import { getLeaderboardWidget } from "@/app/actions/gamification"

interface EmbeddedLeaderboardWidgetProps {
  agentId: string
}

export function EmbeddedLeaderboardWidget({ agentId }: EmbeddedLeaderboardWidgetProps) {
  const [widgetData, setWidgetData] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadWidget()
  }, [agentId])

  async function loadWidget() {
    setLoading(true)
    try {
      const data = await getLeaderboardWidget({ agentId })
      setWidgetData(data)
    } catch (error) {
      console.error("Error loading leaderboard widget:", error)
    } finally {
      setLoading(false)
    }
  }

  const getRankIcon = (rank: number) => {
    if (rank === 1) return <Crown className="h-4 w-4 text-yellow-500" />
    if (rank === 2) return <Medal className="h-4 w-4 text-gray-400" />
    if (rank === 3) return <Medal className="h-4 w-4 text-amber-600" />
    return <span className="text-xs font-medium text-muted-foreground">#{rank}</span>
  }

  return (
    <Card className="max-h-[280px] overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Trophy className="h-5 w-5 text-amber-500" />
          Your Ranking
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : widgetData?.rankings?.length > 0 ? (
          <>
            {/* Top 3 */}
            <div className="space-y-2">
              {widgetData.rankings.slice(0, 3).map((agent: any, index: number) => {
                const isCurrentAgent = agent.id === agentId || agent.agent_id === agentId
                return (
                  <div
                    key={agent.id || index}
                    className={`flex items-center justify-between p-2 rounded-lg ${
                      isCurrentAgent ? "bg-primary/10 border border-primary/30" : "bg-muted/50"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {getRankIcon(index + 1)}
                      <span className={`text-sm ${isCurrentAgent ? "font-semibold" : ""}`}>
                        {`${agent.agents?.users?.first_name || ""} ${agent.agents?.users?.last_name || ""}`.trim() || "Agent"}
                        {isCurrentAgent && " (You)"}
                      </span>
                    </div>
                    <span className="text-sm font-medium">{(agent.agents?.gamification_points ?? agent.metric_value ?? 0).toLocaleString()} pts</span>
                  </div>
                )
              })}
            </div>

            {/* Current Agent Stats if not in top 3 */}
            {widgetData.current_agent && widgetData.current_agent.rank > 3 && (
              <div className="p-2 bg-primary/10 border border-primary/30 rounded-lg">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-muted-foreground">#{widgetData.current_agent.rank}</span>
                    <span className="text-sm font-semibold">You</span>
                  </div>
                  <span className="text-sm font-medium">
                    {(widgetData.current_agent.points || 0).toLocaleString()} pts
                  </span>
                </div>
              </div>
            )}

            {/* Tier Badge */}
            {widgetData.current_agent?.tier && (
              <div className="flex items-center justify-center">
                <Badge variant="secondary" className="gap-1">
                  <Trophy className="h-3 w-3" />
                  {widgetData.current_agent.tier}
                </Badge>
              </div>
            )}

            {/* Link to full leaderboard */}
            <Link
              href="/dashboard/motivation"
              className="flex items-center justify-center gap-1 text-sm text-primary hover:underline pt-2"
            >
              Full Leaderboard
              <ArrowRight className="h-3 w-3" />
            </Link>
          </>
        ) : (
          <div className="text-center py-6 text-muted-foreground text-sm">
            Rankings load as activity is logged
          </div>
        )}
      </CardContent>
    </Card>
  )
}
