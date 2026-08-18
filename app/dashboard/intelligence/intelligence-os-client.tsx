"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import {
  IntelligenceCommandStrip,
  PatternRadar,
  TeamHeatmapPanel,
  LeaderboardPanel,
  AIQualityPanel,
  BehaviorPatternsPanel,
  OperationalInsightsPanel,
  ExceptionPatternsPanel,
  MotivationRail,
} from "./components/os"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

interface Pattern {
  id: string
  patternName: string
  patternSlug: string
  entityType: string
  entityId: string
  entityName: string
  confidence: number
  status: "active" | "acknowledged" | "dismissed"
  recommendedAction: string
  predictedEvent?: string
  predictedWithinDays?: number
  probability?: number
}

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

interface TeamMember {
  id: string
  name: string
  points: number
  tier: string
  activityScore: number
  trend: "up" | "down" | "stable"
  alertCount: number
}

interface BadgeProgress {
  id: string
  name: string
  description: string
  icon: string
  requiredPoints: number
  currentProgress: number
  isEarned: boolean
}

interface OperationalInsight {
  id: string
  type: "opportunity" | "risk" | "trend" | "milestone"
  title: string
  description: string
  metric?: string
  trend?: "up" | "down" | "stable"
  actionUrl?: string
  actionLabel?: string
  priority: "high" | "medium" | "low"
}

interface IntelligenceOSClientProps {
  trustCapitalScore: number
  totalValueDelivered: number
  activePatternCount: number
  highPriorityPatterns: number
  accuracyStats: {
    correct: number
    incorrect: number
    pending: number
    accuracy_rate: number
  }
  patterns: Pattern[]
  leaderboardRankings: LeaderboardEntry[]
  currentUserRank: LeaderboardEntry | null
  periodLabel: string
  aiQualityMetrics: {
    thisWeekMetrics: {
      totalFeedback: number
      positiveRate: number
      avgRating: number
      editedResponses: number
      rejectedResponses: number
    }
    weekOverWeekChange: {
      positiveRate: number
      avgRating: number
    }
    recentIssues: Array<{
      id: string
      issueType: string
      context: string
      timestamp: string
    }>
  }
  teamMembers: TeamMember[]
  totalAgents: number
  averageActivityScore: number
  pointsData: {
    points: number
    currentTier: string
    /** Null at the top of the threshold ladder — Diamond is conferred by a broker. */
    nextTier: string | null
    pointsToNextTier: number
    progressPercent: number
  }
  recentBadges: Array<{
    id: string
    name: string
    awardedAt: string
    tier: string
  }>
  nextBadgeProgress: BadgeProgress | null
  pointDrivers: Array<{
    action: string
    points: number
    description: string
  }>
  operationalInsights: OperationalInsight[]
  brokerageId: string
}

export function IntelligenceOSClient({
  trustCapitalScore,
  totalValueDelivered,
  activePatternCount,
  highPriorityPatterns,
  accuracyStats,
  patterns,
  leaderboardRankings,
  currentUserRank,
  periodLabel,
  aiQualityMetrics,
  teamMembers,
  totalAgents,
  averageActivityScore,
  pointsData,
  recentBadges,
  nextBadgeProgress,
  pointDrivers,
  operationalInsights,
  brokerageId,
}: IntelligenceOSClientProps) {
  const router = useRouter()
  const [currentFilter, setCurrentFilter] = useState("all")

  const handleRefresh = () => {
    router.refresh()
  }

  const handleFilterChange = (filter: string) => {
    setCurrentFilter(filter)
  }

  // Filter patterns based on current filter
  const filteredPatterns = patterns.filter(p => {
    if (currentFilter === "all") return true
    if (currentFilter === "high_priority") return p.confidence >= 0.75
    if (currentFilter === "buyer") return p.entityType === "contact"
    if (currentFilter === "seller") return p.entityType === "listing"
    return true
  })

  // Generate exception patterns from high-confidence patterns with warnings
  const exceptionPatterns = patterns
    .filter(p => p.confidence >= 0.8 && p.status === "active")
    .slice(0, 5)
    .map(p => ({
      id: p.id,
      type: "compliance_risk" as const,
      title: p.patternName,
      description: p.recommendedAction,
      severity: p.confidence >= 0.9 ? "critical" as const : "warning" as const,
      detectedAt: new Date().toISOString(),
      affectedEntity: p.entityName || p.entityId,
      affectedEntityId: p.entityId,
      entityType: p.entityType,
      status: p.status,
    }))

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Command Strip */}
      <IntelligenceCommandStrip
        trustCapitalScore={trustCapitalScore}
        activePatternCount={activePatternCount}
        onRefresh={handleRefresh}
        onFilterChange={handleFilterChange}
        currentFilter={currentFilter}
      />

      {/* Main Content Grid */}
      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="patterns">Patterns</TabsTrigger>
          <TabsTrigger value="team">Team</TabsTrigger>
          <TabsTrigger value="quality">AI Quality</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-3">
            {/* Left Column - Radar & Insights */}
            <div className="space-y-6">
              <PatternRadar
                trustCapitalScore={trustCapitalScore}
                totalValueDelivered={totalValueDelivered}
                activePatterns={activePatternCount}
                highPriorityPatterns={highPriorityPatterns}
                accuracyRate={Math.round(accuracyStats.accuracy_rate)}
                pendingPredictions={accuracyStats.pending}
              />
              <OperationalInsightsPanel
                insights={operationalInsights}
                periodLabel={periodLabel}
              />
            </div>

            {/* Center Column - Patterns & Exceptions */}
            <div className="space-y-6">
              <BehaviorPatternsPanel patterns={filteredPatterns} />
              <ExceptionPatternsPanel exceptions={exceptionPatterns as any} />
            </div>

            {/* Right Column - Motivation & Leaderboard */}
            <div className="space-y-6">
              <MotivationRail
                currentPoints={pointsData.points}
                currentTier={pointsData.currentTier}
                nextTier={pointsData.nextTier}
                pointsToNextTier={pointsData.pointsToNextTier}
                tierProgress={pointsData.progressPercent}
                recentBadges={recentBadges}
                nextBadgeProgress={nextBadgeProgress}
                pointDrivers={pointDrivers}
              />
              <LeaderboardPanel
                rankings={leaderboardRankings}
                currentUserRank={currentUserRank}
                metricType="points"
                periodLabel={periodLabel}
              />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="patterns" className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-2">
            <BehaviorPatternsPanel patterns={filteredPatterns} />
            <ExceptionPatternsPanel exceptions={exceptionPatterns as any} />
          </div>
          <OperationalInsightsPanel
            insights={operationalInsights}
            periodLabel={periodLabel}
          />
        </TabsContent>

        <TabsContent value="team" className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-2">
            <TeamHeatmapPanel
              teamMembers={teamMembers}
              totalAgents={totalAgents}
              averageActivityScore={averageActivityScore}
            />
            <LeaderboardPanel
              rankings={leaderboardRankings}
              currentUserRank={currentUserRank}
              metricType="points"
              periodLabel={periodLabel}
            />
          </div>
        </TabsContent>

        <TabsContent value="quality" className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-2">
            <AIQualityPanel
              thisWeekMetrics={aiQualityMetrics.thisWeekMetrics}
              weekOverWeekChange={aiQualityMetrics.weekOverWeekChange}
              recentIssues={aiQualityMetrics.recentIssues}
            />
            <PatternRadar
              trustCapitalScore={trustCapitalScore}
              totalValueDelivered={totalValueDelivered}
              activePatterns={activePatternCount}
              highPriorityPatterns={highPriorityPatterns}
              accuracyRate={Math.round(accuracyStats.accuracy_rate)}
              pendingPredictions={accuracyStats.pending}
            />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
