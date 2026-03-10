"use client"

import { cn } from "@/lib/utils"
import { Trophy, Star, Award, Crown, Gem, Target } from "lucide-react"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

interface PointsBadgeProps {
  points: number
  currentTier: string
  nextTier?: string
  pointsToNextTier?: number
  variant?: "compact" | "large"
  className?: string
}

const TIER_CONFIG: Record<string, { icon: React.ElementType; color: string; bgColor: string }> = {
  none: { icon: Target, color: "text-muted-foreground", bgColor: "bg-muted" },
  Bronze: { icon: Award, color: "text-amber-700", bgColor: "bg-amber-100" },
  Silver: { icon: Trophy, color: "text-slate-500", bgColor: "bg-slate-100" },
  Gold: { icon: Star, color: "text-yellow-500", bgColor: "bg-yellow-100" },
  Platinum: { icon: Crown, color: "text-purple-600", bgColor: "bg-purple-100" },
  Diamond: { icon: Gem, color: "text-cyan-500", bgColor: "bg-cyan-100" },
}

export function PointsBadge({
  points,
  currentTier,
  nextTier,
  pointsToNextTier,
  variant = "compact",
  className,
}: PointsBadgeProps) {
  const tierConfig = TIER_CONFIG[currentTier] || TIER_CONFIG.none
  const TierIcon = tierConfig.icon

  if (variant === "compact") {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={cn(
                "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-sm font-medium",
                tierConfig.bgColor,
                tierConfig.color,
                className
              )}
            >
              <TierIcon className="h-4 w-4" />
              <span>{points.toLocaleString()}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent>
            <p className="font-medium">{currentTier === "none" ? "No tier yet" : `${currentTier} Tier`}</p>
            {nextTier && pointsToNextTier !== undefined && pointsToNextTier > 0 && (
              <p className="text-xs text-muted-foreground">
                {pointsToNextTier.toLocaleString()} pts to {nextTier}
              </p>
            )}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  // Large variant
  const progress = nextTier && pointsToNextTier !== undefined && pointsToNextTier > 0
    ? Math.min(100, Math.max(0, 100 - (pointsToNextTier / (points + pointsToNextTier)) * 100))
    : 100

  return (
    <div className={cn("p-4 rounded-lg border bg-card", className)}>
      <div className="flex items-center gap-3 mb-3">
        <div className={cn("p-2 rounded-full", tierConfig.bgColor)}>
          <TierIcon className={cn("h-6 w-6", tierConfig.color)} />
        </div>
        <div>
          <p className="text-2xl font-bold">{points.toLocaleString()}</p>
          <p className="text-sm text-muted-foreground">
            {currentTier === "none" ? "Points" : `${currentTier} Tier`}
          </p>
        </div>
      </div>

      {nextTier && pointsToNextTier !== undefined && pointsToNextTier > 0 && (
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Progress to {nextTier}</span>
            <span className="font-medium">{pointsToNextTier.toLocaleString()} pts needed</span>
          </div>
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div
              className={cn("h-full rounded-full transition-all", tierConfig.bgColor)}
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {currentTier === "Platinum" && (
        <p className="text-xs text-muted-foreground mt-2">
          Diamond tier is broker-assigned for exceptional performance
        </p>
      )}
    </div>
  )
}
