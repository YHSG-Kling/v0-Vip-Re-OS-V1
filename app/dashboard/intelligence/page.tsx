import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { loadValueDrivenDashboard, calculateTrustCapital } from "@/app/actions/analytics"
import { getActivePatterns, getPatternAccuracyStats } from "@/app/actions/pattern-actions"
import { getLeaderboard, getAgentPointsAndTier, getAgentBadges } from "@/app/actions/gamification"
import { POINT_VALUES } from "@/lib/gamification/award-points"
import { tierLabelForPoints } from "@/lib/gamification/tiers"
import { defaultPeriodLabel, periodWindows } from "@/lib/gamification/leaderboard-vocabulary"
import { getWeeklyMetrics } from "@/lib/intelligence/feedback-aggregator"
import { IntelligenceOSClient } from "./intelligence-os-client"
import { AiCitationVisibilityCard, type CitationObservationRow } from "./components/ai-citation-visibility-card"

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

  const agentId = agentContext.agentId!
  const brokerageId = agentContext.brokerageId!

  // THE PERIOD LABEL COMES FROM THE SHARED VOCABULARY, not from a format string
  // written out again here. This page hand-rolled the same month label the
  // populator writes — the format happened to match, but it was a second copy of a
  // rule that only works while both copies agree.
  const now = new Date()
  const periodLabel = defaultPeriodLabel(now)
  // What the rail PRINTS. The stored label is "2026-08"; a person reads "This month".
  const periodDisplayLabel = periodWindows(now).find((w) => w.value === periodLabel)?.label ?? periodLabel
  
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
    // scope was "agent" — a value the populator has never written and the scope
    // CHECK no longer admits, so this board was empty by construction. The
    // comparison group is the BROKERAGE.
    getLeaderboard({
      scope: "brokerage",
      metricType: "points",
      periodLabel,
      limit: 10,
    }).catch(() => ({ ok: false, rankings: [], currentAgentId: null, brokerageId: "", scope: "brokerage", metricType: "points", periodLabel })),
    getAgentPointsAndTier(agentId).catch(() => ({
      agentId,
      agentName: "",
      points: 0,
      currentTierId: "unranked" as const,
      currentTier: "Unranked",
      nextTier: "Bronze" as string | null,
      pointsToNextTier: 500,
      progressPercent: 0,
    })),
    getAgentBadges(agentId).catch(() => ({ ok: false as const, badges: [] })),
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
      .select("id, gamification_points, profile_image_url, users(first_name, last_name)")
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true)
      .order("gamification_points", { ascending: false })
      .limit(20),
  ])

  // AI-search citation observations — written daily by the citation monitor
  // (lib/kernel/ai-search-citation-monitor.ts) for this brokerage's published
  // reel pages. Last 30 days, newest first.
  const citationSince = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { data: citationRows, error: citationError } = await supabase
    .from("ai_search_citation_observations")
    // `query` is the prompt the monitor asked — the card shows it under each outcome.
    .select("id, platform, outcome, cited_url, provider, public_slug, observed_at, query")
    .eq("brokerage_id", brokerageId)
    .gte("observed_at", citationSince)
    .order("observed_at", { ascending: false })
    .limit(60)
  const citationObservations: CitationObservationRow[] = citationError
    ? []
    : ((citationRows ?? []) as CitationObservationRow[])

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

  // The action returns rows already flattened (lib/gamification/leaderboard-vocabulary:
  // LeaderboardRow), so this no longer digs three levels into a PostgREST embed to
  // find a name — the shape is the same one every other board reader consumes.
  const processedRankings = leaderboardData.rankings.map(r => ({
    rank: r.rank,
    agentId: r.agentId,
    agentName: r.agentName,
    avatarUrl: r.avatarUrl ?? undefined,
    points: r.lifetimePoints,
    tier: tierLabelForPoints(r.lifetimePoints),
    metricValue: r.score,
    isCurrentUser: r.isCurrentAgent,
  }))

  // Process AI quality metrics
  type WeeklyMetricsSummary = { totalFeedback: number; positiveCount: number; negativeCount: number; avgRating: number; editedCount: number; rejectedCount: number }
  const thisWeek = thisWeekAIMetrics as WeeklyMetricsSummary
  const lastWeek = lastWeekAIMetrics as WeeklyMetricsSummary
  const thisWeekPositiveRate = thisWeek.totalFeedback > 0
    ? Math.round((thisWeek.positiveCount / thisWeek.totalFeedback) * 100)
    : 0
  const lastWeekPositiveRate = lastWeek.totalFeedback > 0
    ? Math.round((lastWeek.positiveCount / lastWeek.totalFeedback) * 100)
    : 0

  const aiQualityMetrics = {
    thisWeekMetrics: {
      totalFeedback: thisWeek.totalFeedback,
      positiveRate: thisWeekPositiveRate,
      avgRating: thisWeek.avgRating || 0,
      editedResponses: thisWeek.editedCount || 0,
      rejectedResponses: thisWeek.rejectedCount || 0,
    },
    weekOverWeekChange: {
      positiveRate: thisWeekPositiveRate - lastWeekPositiveRate,
      avgRating: (thisWeek.avgRating || 0) - (lastWeek.avgRating || 0),
    },
    recentIssues: [], // Would need a separate query for specific issues
  }

  // Process team activity for heatmap
  const teamMembers = (teamActivity.data || []).map((agent, index) => ({
    id: agent.id,
    name: [(agent.users as any)?.first_name, (agent.users as any)?.last_name].filter(Boolean).join(" ") || "Unknown",
    points: agent.gamification_points || 0,
    tier: tierLabelForPoints(agent.gamification_points || 0),
    activityScore: Math.min(100, Math.round(((agent.gamification_points || 0) / 500) * 100)),
    trend: "stable" as const,
    alertCount: 0,
  }))

  const averageActivityScore = teamMembers.length > 0
    ? Math.round(teamMembers.reduce((sum, m) => sum + m.activityScore, 0) / teamMembers.length)
    : 0

  // getAgentBadges returns ONE list, each row carrying whether it is earned — it
  // used to return { earned, all, earnedBadgeIds } with a Set in it, which is not
  // serialisable across the server-action boundary.
  const allBadges = badgesData.badges ?? []
  const recentBadges = allBadges
    .filter((b) => b.earned)
    .slice(0, 3)
    .map((b) => ({
      id: b.id,
      name: b.name,
      awardedAt: b.earnedAt ?? "",
      tier: b.tier || "bronze",
    }))

  // Next badge to earn — the catalog is ordered by required_points ascending.
  const nextBadge = allBadges.find((b) => !b.earned) ?? null
  const nextBadgeProgress = nextBadge ? {
    id: nextBadge.id,
    name: nextBadge.name,
    description: nextBadge.description || "",
    icon: nextBadge.icon || "star",
    requiredPoints: nextBadge.requiredPoints,
    currentProgress: pointsData.points,
    isEarned: false,
  } : null

  // Point drivers from the ONE point table.
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
    <>
    <IntelligenceOSClient
      trustCapitalScore={trustCapital.trust_capital_score}
      totalValueDelivered={valueDashboard?.valueMetrics?.total_value_delivered || 0}
      activePatternCount={patterns.length}
      highPriorityPatterns={highPriorityPatterns.length}
      accuracyStats={accuracyStats}
      patterns={processedPatterns}
      leaderboardRankings={processedRankings}
      currentUserRank={processedRankings.find(r => r.isCurrentUser) || null}
      periodLabel={periodDisplayLabel}
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
    {/* GEO / AI-search visibility — citation outcomes for published pages.
        Hidden when the citation monitor has no observations yet. */}
    {citationObservations.length > 0 && (
      <div className="max-w-7xl mx-auto px-4 pb-6">
        <AiCitationVisibilityCard observations={citationObservations} />
      </div>
    )}
    </>
  )
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
