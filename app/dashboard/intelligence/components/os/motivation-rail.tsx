"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import Link from "next/link"
import {
  Trophy,
  Star,
  Zap,
  Target,
  ArrowRight,
  Award,
  TrendingUp,
  Gift,
} from "lucide-react"

interface BadgeProgress {
  id: string
  name: string
  description: string
  icon: string
  requiredPoints: number
  currentProgress: number
  isEarned: boolean
}

interface MotivationRailProps {
  currentPoints: number
  currentTier: string
  /** Null at the top of the threshold ladder — Diamond is conferred, not earned. */
  nextTier: string | null
  pointsToNextTier: number
  /** 0-100, from lib/gamification/tiers.ts — the ONE ladder. */
  tierProgress: number
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
}

export function MotivationRail({
  currentPoints,
  currentTier,
  nextTier,
  pointsToNextTier,
  tierProgress,
  recentBadges,
  nextBadgeProgress,
  pointDrivers,
}: MotivationRailProps) {
  const getTierColor = (tier: string) => {
    switch (tier.toLowerCase()) {
      case "platinum": return "bg-purple-100 text-purple-700 border-purple-300 dark:bg-purple-900/30 dark:text-purple-400 dark:border-purple-700"
      case "gold": return "bg-yellow-100 text-yellow-700 border-yellow-300 dark:bg-yellow-900/30 dark:text-yellow-400 dark:border-yellow-700"
      case "silver": return "bg-gray-100 text-gray-700 border-gray-300 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-600"
      case "bronze": return "bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-700"
      default: return "bg-muted text-muted-foreground border-border"
    }
  }

  // The progress bar used to be `(currentPoints % 2500) / (pointsToNextTier + currentPoints % 2500)`
  // — a modulo against a hard-coded 2,500 that belonged to no rung of any ladder, so the bar
  // moved to a rhythm unrelated to the tier it claimed to measure. It is computed once, in
  // lib/gamification/tiers.ts, and handed in.

  return (
    <Card className="border-2 border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Zap className="h-4 w-4 text-primary" />
            Your Progress
          </CardTitle>
          <Badge className={`${getTierColor(currentTier)} border`}>
            <Trophy className="h-3 w-3 mr-1" />
            {currentTier}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Points Display */}
        <div className="text-center">
          <div className="text-3xl font-bold text-primary">
            {currentPoints.toLocaleString()}
          </div>
          <p className="text-sm text-muted-foreground">total points</p>
        </div>

        {/* Tier Progress */}
        {nextTier && pointsToNextTier > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Progress to {nextTier}</span>
              <span className="font-medium">{pointsToNextTier} pts to go</span>
            </div>
            <Progress value={tierProgress} className="h-2" />
          </div>
        )}

        {/* Next Badge Progress */}
        {nextBadgeProgress && !nextBadgeProgress.isEarned && (
          <div className="rounded-lg bg-muted/50 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Award className="h-4 w-4 text-primary" />
                <span className="text-sm font-medium">{nextBadgeProgress.name}</span>
              </div>
              <span className="text-xs text-muted-foreground">
                {nextBadgeProgress.currentProgress}/{nextBadgeProgress.requiredPoints}
              </span>
            </div>
            <Progress 
              value={(nextBadgeProgress.currentProgress / nextBadgeProgress.requiredPoints) * 100} 
              className="h-1.5" 
            />
            <p className="text-xs text-muted-foreground">{nextBadgeProgress.description}</p>
          </div>
        )}

        {/* Recent Badges */}
        {recentBadges.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium flex items-center gap-2">
              <Star className="h-4 w-4 text-yellow-500" />
              Recent Achievements
            </h4>
            <div className="flex flex-wrap gap-2">
              {recentBadges.slice(0, 3).map((badge) => (
                <Badge key={badge.id} variant="secondary" className="text-xs">
                  {badge.name}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Point Drivers */}
        <div className="space-y-2">
          <h4 className="text-sm font-medium flex items-center gap-2">
            <Target className="h-4 w-4 text-green-600" />
            Earn Points By
          </h4>
          <div className="space-y-1">
            {pointDrivers.slice(0, 3).map((driver, index) => (
              <div key={index} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{driver.action}</span>
                <span className="font-medium text-green-600">+{driver.points}</span>
              </div>
            ))}
          </div>
        </div>

        <Link href="/dashboard/motivation">
          <Button variant="outline" size="sm" className="w-full gap-2">
            View Leaderboard
            <ArrowRight className="h-4 w-4" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  )
}
