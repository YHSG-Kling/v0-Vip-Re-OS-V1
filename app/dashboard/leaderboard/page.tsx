import { createClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"
import { Suspense } from "react"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { LeaderboardClient } from "./leaderboard-client"
import { getLeaderboard, getAgentPointsAndTier, getAgentBadges } from "@/app/actions/gamification"

export const dynamic = "force-dynamic"

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{
    scope?: string
    metric?: string
    period?: string
  }>
}) {
  const params = await searchParams
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect("/login")

  const agentContext = await getAgentContext()
  if (!agentContext) redirect("/dashboard/onboarding")

  // Default values
  const scope = (params.scope as "agent" | "team" | "brokerage") || "agent"
  const metricType = (params.metric as "points" | "revenue" | "transactions" | "referrals") || "points"
  
  // Calculate period label
  const now = new Date()
  let periodLabel: string
  
  switch (params.period) {
    case "quarter":
      const quarter = Math.floor(now.getMonth() / 3) + 1
      periodLabel = `${now.getFullYear()}-Q${quarter}`
      break
    case "year":
      periodLabel = `${now.getFullYear()}`
      break
    case "all":
      periodLabel = "all-time"
      break
    default:
      periodLabel = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
  }

  // Fetch data in parallel
  const [leaderboardData, pointsData, badgesData] = await Promise.all([
    getLeaderboard({
      scope,
      metricType,
      periodLabel,
      limit: 20,
    }),
    getAgentPointsAndTier(agentContext.agentId ?? ""),
    getAgentBadges(agentContext.agentId ?? ""),
  ])

  // Check if current user is in top 20
  const currentUserInList = leaderboardData.rankings.some(
    r => r.agent_id === leaderboardData.currentAgentId
  )

  // If not in top 20, fetch their rank separately
  let currentUserRank = null
  if (!currentUserInList && leaderboardData.currentAgentId) {
    const { data: userRank } = await supabase
      .from("leaderboard_rankings")
      .select("rank_position, metric_value")
      .eq("brokerage_id", leaderboardData.brokerageId)
      .eq("scope", scope)
      .eq("metric_type", metricType)
      .eq("period_label", periodLabel)
      .eq("agent_id", leaderboardData.currentAgentId)
      .maybeSingle()

    currentUserRank = userRank
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Leaderboard</h1>
        <p className="text-muted-foreground mt-1">
          Track your progress and compete with your team
        </p>
      </div>

      <Suspense fallback={<div className="animate-pulse">Loading leaderboard...</div>}>
        <LeaderboardClient
          rankings={leaderboardData.rankings as any}
          currentAgentId={leaderboardData.currentAgentId}
          currentUserRank={currentUserRank}
          currentUserInList={currentUserInList}
          pointsData={pointsData}
          badgesData={badgesData}
          initialScope={scope}
          initialMetric={metricType}
          initialPeriod={params.period || "month"}
        />
      </Suspense>
    </div>
  )
}
