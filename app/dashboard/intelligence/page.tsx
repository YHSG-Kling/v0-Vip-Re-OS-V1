import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { loadValueDrivenDashboard, calculateTrustCapital } from "@/app/actions/analytics"
import { getActivePatterns, getPatternAccuracyStats } from "@/app/actions/pattern-actions"
import { getLeaderboard, getAgentPointsAndTier, getAgentBadges, POINT_VALUES } from "@/app/actions/gamification"
import { getWeeklyMetrics } from "@/lib/intelligence/feedback-aggregator"
import { IntelligenceOSClient } from "./intelligence-os-client"

export const dynamic = "force-dynamic"

export const metadata = {
  title: "Intelligence Center | Pipeline OS",
  description: "Unified analytics, patterns, and AI quality intelligence",
}

export default async function IntelligencePage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  const agentContext = await getAgentContext()
  if (!agentContext) {
    redirect("/dashboard/onboarding")
  }

  const { agentId, brokerageId } = agentContext

  // Calculate period labels
  const now = new Date()
  const periodLabel = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
  
  // Calculate this week's start for AI metrics
  const dayOfWeek = now.getDay()
  const daysToSubtract = dayOfWeek === 0 ? 6 : dayOfWeek - 1
  const thisWeekStart = new Date(now)
  thisWeekStart.setDate(now.getDate() - daysToSubtract)
  thisWeekStart.setHours(0, 0, 0, 0)
  const lastWeekStart = new Date(thisWeekStart)
  lastWeekStart.setDate(lastWeekStart.getDate() - 7)

  // Fetch all intelligence data in parallel
  const [
    valueDashboard,
    trustCapital,
    patterns,
    accuracyStats,
    leaderboardData,
    pointsData,
    badgesData,
    thisWeekAIMetrics,
    lastWeekAIMetrics,
    teamActivity,
  ] = await Promise.all([
    loadValueDrivenDashboard(agentId, "month").catch(() => null),
    calculateTrustCapital(agentId, 30).catch(() => ({ trust_capital_score: 50, metrics: {}, insights: {} })),
    getActivePatterns("all").catch(() => []),
    getPatternAccuracyStats().catch(() => ({ correct: 0, incorrect: 0, pending: 0, accuracy_rate: 0 })),
    getLeaderboard({
      scope: "agent",
      metricType: "points",
      periodLabel,
      limit: 10,
    }).catch(() => ({ rankings: [], currentAgentId: null, brokerageId: null })),
    getAgentPointsAndTier(agentId).catch(() => ({
      agentId,
      agentName: "",
      points: 0,
      currentTier: "none",
      nextTier: "Bronze",
      pointsToNextTier: 500,
    })),
    getAgentBadges(agentId).catch(() => ({ earned: [], all: [], earnedBadgeIds: new Set() })),
    getWeeklyMetrics(brokerageId, thisWeekStart).catch(() => ({
      totalFeedback: 0,
      positiveCount: 0,
      negativeCount: 0,
      avgRating: 0,
      editedCount: 0,
      rejectedCount: 0,
    })),
    getWeeklyMetrics(brokerageId, lastWeekStart).catch(() => ({
      totalFeedback: 0,
      positiveCount: 0,
      negativeCount: 0,
      avgRating: 0,
      editedCount: 0,
      rejectedCount: 0,
    })),
    // Get team activity data
    supabase
      .from("agents")
      .select("id, first_name, last_name, gamification_points, profile_image_url")
      .eq("brokerage_id", brokerageId)
      .eq("status", "active")
      .order("gamification_points", { ascending: false })
      .limit(20),
  ])

  // Process patterns for component props
  const highPriorityPatterns = patterns.filter(p => p.confidence >= 0.75)
  const processedPatterns = patterns.map(p => ({
    id: p.id,
    patternName: p.pattern_name,
    patternSlug: p.pattern_slug,
    entityType: p.entity_type,
    entityId: p.entity_id,
    entityName: p.entity_name || "",
    confidence: p.confidence,
    status: p.status,
    recommendedAction: p.recommended_action,
    predictedEvent: p.predicted_event,
    predictedWithinDays: p.predicted_within_days,
    probability: p.probability,
  }))

  // Process leaderboard for component props
  const processedRankings = leaderboardData.rankings.map(r => ({
    rank: r.rank_position,
    agentId: r.agent_id,
    agentName: r.agents ? `${r.agents.first_name || ""} ${r.agents.last_name || ""}`.trim() : "Unknown",
    avatarUrl: r.agents?.profile_image_url,
    points: r.agents?.gamification_points || 0,
    tier: getTierFromPoints(r.agents?.gamification_points || 0),
    metricValue: r.metric_value,
    isCurrentUser: r.agent_id === leaderboardData.currentAgentId,
  }))

  // Process AI quality metrics
  const thisWeekPositiveRate = thisWeekAIMetrics.totalFeedback > 0
    ? Math.round((thisWeekAIMetrics.positiveCount / thisWeekAIMetrics.totalFeedback) * 100)
    : 0
  const lastWeekPositiveRate = lastWeekAIMetrics.totalFeedback > 0
    ? Math.round((lastWeekAIMetrics.positiveCount / lastWeekAIMetrics.totalFeedback) * 100)
    : 0

  const aiQualityMetrics = {
    thisWeekMetrics: {
      totalFeedback: thisWeekAIMetrics.totalFeedback,
      positiveRate: thisWeekPositiveRate,
      avgRating: thisWeekAIMetrics.avgRating || 0,
      editedResponses: thisWeekAIMetrics.editedCount || 0,
      rejectedResponses: thisWeekAIMetrics.rejectedCount || 0,
    },
    weekOverWeekChange: {
      positiveRate: thisWeekPositiveRate - lastWeekPositiveRate,
      avgRating: (thisWeekAIMetrics.avgRating || 0) - (lastWeekAIMetrics.avgRating || 0),
    },
    recentIssues: [], // Would need a separate query for specific issues
  }

  // Process team activity for heatmap
  const teamMembers = (teamActivity.data || []).map((agent, index) => ({
    id: agent.id,
    name: `${agent.first_name || ""} ${agent.last_name || ""}`.trim() || "Unknown",
    points: agent.gamification_points || 0,
    tier: getTierFromPoints(agent.gamification_points || 0),
    activityScore: Math.min(100, Math.round(((agent.gamification_points || 0) / 500) * 100)),
    trend: "stable" as const,
    alertCount: 0,
  }))

  const averageActivityScore = teamMembers.length > 0
    ? Math.round(teamMembers.reduce((sum, m) => sum + m.activityScore, 0) / teamMembers.length)
    : 0

  // Process badges for motivation rail
  const recentBadges = (badgesData.earned || []).slice(0, 3).map((eb: any) => ({
    id: eb.id,
    name: eb.gamification_badges?.badge_name || "Badge",
    awardedAt: eb.awarded_at,
    tier: eb.gamification_badges?.badge_tier || "bronze",
  }))

  // Find next badge to earn
  const unearnedBadges = (badgesData.all || []).filter(
    (b: any) => !badgesData.earnedBadgeIds.has(b.id)
  )
  const nextBadge = unearnedBadges.length > 0 ? unearnedBadges[0] : null
  const nextBadgeProgress = nextBadge ? {
    id: nextBadge.id,
    name: nextBadge.badge_name,
    description: nextBadge.badge_description || "",
    icon: nextBadge.badge_icon || "star",
    requiredPoints: nextBadge.required_points,
    currentProgress: pointsData.points,
    isEarned: false,
  } : null

  // Point drivers from POINT_VALUES
  const pointDrivers = [
    { action: "Close a listing", points: POINT_VALUES.LISTING_CLOSED, description: "Earn points for closed deals" },
    { action: "Submit an offer", points: POINT_VALUES.OFFER_SUBMITTED, description: "Earn points for submitted offers" },
    { action: "Create a referral", points: POINT_VALUES.REFERRAL_CREATED, description: "Earn points for referrals" },
    { action: "Write a vendor review", points: POINT_VALUES.VENDOR_REVIEW_WRITTEN, description: "Earn points for reviews" },
  ]

  // Generate operational insights from real data
  const operationalInsights = generateOperationalInsights(
    valueDashboard,
    trustCapital,
    patterns.length,
    highPriorityPatterns.length
  )

  return (
    <IntelligenceOSClient
      trustCapitalScore={trustCapital.trust_capital_score}
      totalValueDelivered={valueDashboard?.valueMetrics?.totalValueDelivered || 0}
      activePatternCount={patterns.length}
      highPriorityPatterns={highPriorityPatterns.length}
      accuracyStats={accuracyStats}
      patterns={processedPatterns}
      leaderboardRankings={processedRankings}
      currentUserRank={processedRankings.find(r => r.isCurrentUser) || null}
      periodLabel={periodLabel}
      aiQualityMetrics={aiQualityMetrics}
      teamMembers={teamMembers}
      totalAgents={teamMembers.length}
      averageActivityScore={averageActivityScore}
      pointsData={pointsData}
      recentBadges={recentBadges}
      nextBadgeProgress={nextBadgeProgress}
      pointDrivers={pointDrivers}
      operationalInsights={operationalInsights}
      brokerageId={brokerageId}
    />
  )
}

function getTierFromPoints(points: number): string {
  if (points >= 25000) return "Platinum"
  if (points >= 10000) return "Gold"
  if (points >= 2500) return "Silver"
  if (points >= 500) return "Bronze"
  return "none"
}

function generateOperationalInsights(
  valueDashboard: any,
  trustCapital: any,
  patternCount: number,
  highPriorityCount: number
) {
  const insights = []

  // Trust capital insight
  if (trustCapital.trust_capital_score < 50) {
    insights.push({
      id: "trust-low",
      type: "risk" as const,
      title: "Trust Capital Below Target",
      description: trustCapital.insights?.value_given_assessment || "Focus on delivering more value to build trust",
      priority: "high" as const,
      actionUrl: "/dashboard/analytics",
      actionLabel: "View Metrics",
    })
  } else if (trustCapital.trust_capital_score >= 75) {
    insights.push({
      id: "trust-high",
      type: "milestone" as const,
      title: "High Trust Capital Achieved",
      description: trustCapital.insights?.strength || "Strong trust capital score",
      priority: "low" as const,
    })
  }

  // Pattern insights
  if (highPriorityCount > 3) {
    insights.push({
      id: "patterns-urgent",
      type: "risk" as const,
      title: `${highPriorityCount} High-Priority Patterns`,
      description: "Multiple patterns require immediate attention",
      priority: "high" as const,
      actionUrl: "/dashboard/patterns",
      actionLabel: "Review Patterns",
    })
  } else if (patternCount > 0) {
    insights.push({
      id: "patterns-active",
      type: "trend" as const,
      title: `${patternCount} Active Patterns Detected`,
      description: "AI has identified behavioral patterns in your pipeline",
      priority: "medium" as const,
      actionUrl: "/dashboard/patterns",
      actionLabel: "View Patterns",
    })
  }

  // Value delivery insight
  if (valueDashboard?.valueMetrics?.totalValueDelivered > 5000) {
    insights.push({
      id: "value-high",
      type: "opportunity" as const,
      title: "Strong Value Delivery",
      description: `$${valueDashboard.valueMetrics.totalValueDelivered.toLocaleString()} in value delivered this period`,
      metric: `$${(valueDashboard.valueMetrics.totalValueDelivered / 1000).toFixed(1)}k`,
      trend: "up" as const,
      priority: "low" as const,
    })
  }

  return insights
}
