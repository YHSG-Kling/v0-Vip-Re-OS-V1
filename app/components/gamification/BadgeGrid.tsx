"use client"

import { cn } from "@/lib/utils"
import { Lock, Award, Trophy, Star, Crown, Gem, Target, CheckCircle2 } from "lucide-react"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { format } from "date-fns"

interface Badge {
  id: string
  badge_name: string
  badge_description: string
  badge_icon: string | null
  badge_tier: string
  required_points: number
  trigger_event: string | null
}

interface EarnedBadge {
  id: string
  badge_id: string
  awarded_at: string
  awarded_reason: string | null
  gamification_badges: Badge | null
}

interface BadgeGridProps {
  allBadges: Badge[]
  earnedBadges: EarnedBadge[]
  currentPoints: number
  className?: string
}

const TIER_ICONS: Record<string, React.ElementType> = {
  Bronze: Award,
  Silver: Trophy,
  Gold: Star,
  Platinum: Crown,
  Diamond: Gem,
}

const TIER_COLORS: Record<string, { text: string; bg: string; border: string }> = {
  Bronze: { text: "text-amber-700", bg: "bg-amber-100", border: "border-amber-300" },
  Silver: { text: "text-slate-500", bg: "bg-slate-100", border: "border-slate-300" },
  Gold: { text: "text-yellow-600", bg: "bg-yellow-100", border: "border-yellow-300" },
  Platinum: { text: "text-purple-600", bg: "bg-purple-100", border: "border-purple-300" },
  Diamond: { text: "text-cyan-600", bg: "bg-cyan-100", border: "border-cyan-300" },
}

export function BadgeGrid({ allBadges, earnedBadges, currentPoints, className }: BadgeGridProps) {
  const earnedBadgeIds = new Set(earnedBadges.map(eb => eb.badge_id))

  const badgesByTier = allBadges.reduce((acc, badge) => {
    const tier = badge.badge_tier || "Bronze"
    if (!acc[tier]) acc[tier] = []
    acc[tier].push(badge)
    return acc
  }, {} as Record<string, Badge[]>)

  const tierOrder = ["Bronze", "Silver", "Gold", "Platinum", "Diamond"]

  return (
    <TooltipProvider>
      <div className={cn("space-y-6", className)}>
        {tierOrder.map(tier => {
          const badges = badgesByTier[tier]
          if (!badges || badges.length === 0) return null

          const TierIcon = TIER_ICONS[tier] || Target
          const colors = TIER_COLORS[tier] || TIER_COLORS.Bronze

          return (
            <div key={tier}>
              <div className="flex items-center gap-2 mb-3">
                <TierIcon className={cn("h-5 w-5", colors.text)} />
                <h3 className="font-semibold">{tier} Tier</h3>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                {badges.map(badge => {
                  const isEarned = earnedBadgeIds.has(badge.id)
                  const earnedData = earnedBadges.find(eb => eb.badge_id === badge.id)
                  const pointsNeeded = badge.required_points - currentPoints

                  return (
                    <Tooltip key={badge.id}>
                      <TooltipTrigger asChild>
                        <div
                          className={cn(
                            "relative p-4 rounded-lg border-2 transition-all cursor-pointer",
                            isEarned
                              ? cn(colors.bg, colors.border, "opacity-100")
                              : "bg-muted/50 border-muted opacity-60 grayscale"
                          )}
                        >
                          <div className="flex flex-col items-center text-center">
                            {isEarned ? (
                              <TierIcon className={cn("h-8 w-8 mb-2", colors.text)} />
                            ) : (
                              <Lock className="h-8 w-8 mb-2 text-muted-foreground" />
                            )}
                            <p className="text-sm font-medium line-clamp-2">{badge.badge_name}</p>
                            {isEarned && (
                              <CheckCircle2 className="absolute top-2 right-2 h-4 w-4 text-green-600" />
                            )}
                          </div>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-xs">
                        <p className="font-semibold">{badge.badge_name}</p>
                        <p className="text-sm text-muted-foreground">{badge.badge_description}</p>
                        {isEarned && earnedData ? (
                          <div className="mt-2 pt-2 border-t">
                            <p className="text-xs text-green-600">
                              Earned {format(new Date(earnedData.awarded_at), "MMM d, yyyy")}
                            </p>
                            {earnedData.awarded_reason && (
                              <p className="text-xs text-muted-foreground">{earnedData.awarded_reason}</p>
                            )}
                          </div>
                        ) : (
                          <div className="mt-2 pt-2 border-t">
                            <p className="text-xs text-muted-foreground">
                              {pointsNeeded > 0
                                ? `${pointsNeeded.toLocaleString()} points needed`
                                : "Special badge - broker assigned"}
                            </p>
                          </div>
                        )}
                      </TooltipContent>
                    </Tooltip>
                  )
                })}
              </div>
            </div>
          )
        })}

        {allBadges.length === 0 && (
          <div className="text-center py-8 text-muted-foreground">
            <Target className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p>No badges available yet</p>
          </div>
        )}
      </div>
    </TooltipProvider>
  )
}
