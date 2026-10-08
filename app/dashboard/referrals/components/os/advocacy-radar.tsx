"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Target, Users, Trophy } from "lucide-react"

interface AdvocacyRadarProps {
  sphereScore?: {
    overall: number
    engagement: number
    loyalty: number
    advocacy: number
  } | null
  topAdvocates?: Array<{
    id: string
    name: string
    score: number
    potential: "high" | "medium" | "low"
  }> | null
  leaderboardWidget?: {
    topReferrers: Array<{ name: string; count: number; rank: number }>
  } | null
  /**
   * ORPHAN DOCTRINE §1.2 (2026-09-04) — clients whose engagement score was
   * computed for a DIFFERENT agent (client_engagement_scores.agent_id, written
   * by the scorer and read by nobody until now). The Engagement figure below is
   * an average over those rows too, so without this line an agent reads a
   * relationship number that is partly somebody else's work.
   */
  inheritedEngagementScores?: number
}

export function AdvocacyRadar({
  sphereScore,
  topAdvocates,
  leaderboardWidget,
  inheritedEngagementScores,
}: AdvocacyRadarProps) {
  const score = sphereScore?.overall ?? 0

  return (
    <div className="grid grid-cols-3 gap-4">
      {/* Sphere Score Card */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Target className="h-4 w-4" />
            Sphere Score
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center">
            <div className="relative h-24 w-24">
              <svg className="h-24 w-24 transform -rotate-90" viewBox="0 0 100 100">
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  stroke="currentColor"
                  strokeWidth="8"
                  fill="none"
                  className="text-muted"
                />
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  stroke="currentColor"
                  strokeWidth="8"
                  fill="none"
                  strokeDasharray={`${(score / 100) * 251.2} 251.2`}
                  className="text-rose-500"
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-2xl font-bold">{score}</span>
              </div>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
            <div>
              <p className="text-muted-foreground">Engagement</p>
              <p className="font-semibold">{sphereScore?.engagement ?? 0}</p>
              {/* §1.2 — the borrowed share, named rather than netted out. */}
              {!!inheritedEngagementScores && inheritedEngagementScores > 0 && (
                <p className="text-[10px] text-muted-foreground">
                  {inheritedEngagementScores} scored for another agent
                </p>
              )}
            </div>
            <div>
              <p className="text-muted-foreground">Loyalty</p>
              <p className="font-semibold">{sphereScore?.loyalty ?? 0}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Advocacy</p>
              <p className="font-semibold">{sphereScore?.advocacy ?? 0}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Top Advocates */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Users className="h-4 w-4" />
            Top Advocates
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {topAdvocates && topAdvocates.length > 0 ? (
              topAdvocates.slice(0, 3).map((advocate) => (
                <div key={advocate.id} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded-full bg-rose-100 flex items-center justify-center text-xs font-semibold text-rose-700">
                      {advocate.name.split(" ").map(n => n[0]).join("")}
                    </div>
                    <span className="text-sm font-medium truncate max-w-[100px]">{advocate.name}</span>
                  </div>
                  <Badge
                    variant="outline"
                    className={
                      advocate.potential === "high"
                        ? "border-emerald-500 text-emerald-700"
                        : advocate.potential === "medium"
                          ? "border-amber-500 text-amber-700"
                          : "border-gray-500 text-gray-700"
                    }
                  >
                    {advocate.potential}
                  </Badge>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground text-center py-4">
                No advocates identified yet
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Leaderboard Widget */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Trophy className="h-4 w-4 text-amber-500" />
            Referral Leaderboard
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {leaderboardWidget?.topReferrers && leaderboardWidget.topReferrers.length > 0 ? (
              leaderboardWidget.topReferrers.slice(0, 3).map((referrer, index) => (
                <div key={index} className="flex items-center justify-between p-2 rounded-lg bg-muted/50">
                  <div className="flex items-center gap-2">
                    <div
                      className={`h-6 w-6 rounded-full flex items-center justify-center text-xs font-bold ${
                        index === 0
                          ? "bg-amber-100 text-amber-700"
                          : index === 1
                            ? "bg-gray-200 text-gray-700"
                            : "bg-orange-100 text-orange-700"
                      }`}
                    >
                      {referrer.rank}
                    </div>
                    <span className="text-sm truncate max-w-[80px]">{referrer.name}</span>
                  </div>
                  <span className="text-sm font-semibold">{referrer.count}</span>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground text-center py-4">
                No leaderboard data
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
