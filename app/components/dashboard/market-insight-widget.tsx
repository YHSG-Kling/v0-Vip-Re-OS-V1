"use client"

import { useEffect, useState, useCallback } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  BarChart3,
  RefreshCw,
  Loader2,
  TrendingUp,
  TrendingDown,
  Minus,
  AlertCircle,
  Lightbulb,
  Bell,
  ChevronRight,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { generateMarketInsights } from "@/app/actions/market-insights"
import type { MarketInsightResult } from "@/app/actions/market-insights"

// ─── Temperature Config ────────────────────────────────────────────────────────

type MarketTemperature = MarketInsightResult["marketTemperature"]

const TEMPERATURE_CONFIG: Record<
  MarketTemperature,
  {
    label: string
    badgeClass: string
    icon: React.ElementType
    description: string
  }
> = {
  "Seller's Market": {
    label: "Seller's Market",
    badgeClass: "bg-red-100 text-red-700 border-red-200",
    icon: TrendingUp,
    description: "Low inventory, fast moving",
  },
  "Balanced Market": {
    label: "Balanced Market",
    badgeClass: "bg-emerald-100 text-emerald-700 border-emerald-200",
    icon: Minus,
    description: "Equilibrium between buyers and sellers",
  },
  "Buyer's Market": {
    label: "Buyer's Market",
    badgeClass: "bg-blue-100 text-blue-700 border-blue-200",
    icon: TrendingDown,
    description: "High inventory, buyers have leverage",
  },
}

// ─── Loading Skeleton ──────────────────────────────────────────────────────────

function MarketInsightSkeleton() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Skeleton className="h-5 w-5 rounded" />
            <Skeleton className="h-5 w-28" />
          </div>
          <Skeleton className="h-7 w-24 rounded-full" />
        </div>
        <Skeleton className="h-4 w-40 mt-1" />
      </CardHeader>
      <CardContent className="space-y-4">
        <Skeleton className="h-10 w-full rounded-lg" />
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-12 w-full rounded-lg" />
      </CardContent>
    </Card>
  )
}

// ─── Action Item Card ──────────────────────────────────────────────────────────

function ActionItemCard({
  text,
  index,
}: {
  text: string
  index: number
}) {
  return (
    <div className="flex items-start gap-3 p-3 rounded-lg border bg-card hover:bg-muted/40 transition-colors cursor-default group">
      <div className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-semibold mt-0.5">
        {index + 1}
      </div>
      <p className="text-sm text-foreground leading-snug flex-1">{text}</p>
      <ChevronRight className="h-4 w-4 text-muted-foreground/40 shrink-0 mt-0.5 group-hover:text-muted-foreground/70 transition-colors" />
    </div>
  )
}

// ─── Main Component ────────────────────────────────────────────────────────────

export function MarketInsightWidget() {
  const [insights, setInsights] = useState<MarketInsightResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [regenerating, setRegenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchInsights = useCallback(async (force = false) => {
    if (force) {
      setRegenerating(true)
    } else {
      setLoading(true)
    }
    setError(null)

    try {
      const result = await generateMarketInsights()
      if (result.insights) {
        setInsights(result.insights)
      } else {
        setError(result.error ?? "Failed to load market insights")
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoading(false)
      setRegenerating(false)
    }
  }, [])

  // Load on mount
  useEffect(() => {
    fetchInsights(false)
  }, [fetchInsights])

  // ── Loading state ──────────────────────────────────────────────────────────
  if (loading) {
    return <MarketInsightSkeleton />
  }

  // ── Error state ────────────────────────────────────────────────────────────
  if (error && !insights) {
    return (
      <Card className="border-destructive/30">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="h-5 w-5 text-primary" />
            Market Pulse
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <AlertCircle className="h-8 w-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fetchInsights(false)}
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              Retry
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  // ── Empty / no insights ────────────────────────────────────────────────────
  if (!insights) {
    return null
  }

  const tempConfig = TEMPERATURE_CONFIG[insights.marketTemperature]
  const TempIcon = tempConfig.icon

  const formattedTime = new Date(insights.generatedAt).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })

  return (
    <Card>
      {/* Header */}
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="h-5 w-5 text-primary shrink-0" />
            Market Pulse
          </CardTitle>
          {/* Temperature Badge */}
          <Badge
            variant="outline"
            className={cn("shrink-0 flex items-center gap-1.5 text-xs font-medium px-2.5 py-1", tempConfig.badgeClass)}
          >
            <TempIcon className="h-3.5 w-3.5" />
            {tempConfig.label}
          </Badge>
        </div>
        <CardDescription className="text-xs text-muted-foreground mt-0.5">
          AI-generated from your data &middot; Updated {formattedTime}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Key Insight */}
        <div className="flex items-start gap-2.5 p-3 rounded-lg bg-muted/50 border border-border/50">
          <Lightbulb className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
          <p className="text-sm text-foreground leading-relaxed">{insights.keyInsight}</p>
        </div>

        {/* Action Items */}
        {insights.actionItems.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Action Items
            </p>
            {insights.actionItems.map((item, idx) => (
              <ActionItemCard key={idx} text={item} index={idx} />
            ))}
          </div>
        )}

        {/* Opportunity Alert */}
        {insights.opportunityAlert && (
          <div className="flex items-start gap-2.5 p-3 rounded-lg bg-amber-50 border border-amber-200/70">
            <Bell className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-semibold text-amber-700 mb-0.5">Opportunity Alert</p>
              <p className="text-sm text-amber-800 leading-snug">{insights.opportunityAlert}</p>
            </div>
          </div>
        )}

        {/* Snapshot Stats Row */}
        <div className="grid grid-cols-3 gap-2 pt-1">
          <div className="text-center">
            <p className="text-lg font-bold text-foreground">
              {insights.snapshot.activeListings}
            </p>
            <p className="text-[10px] text-muted-foreground leading-tight">Active Listings</p>
          </div>
          <div className="text-center">
            <p className="text-lg font-bold text-foreground">
              {insights.snapshot.avgDaysOnMarket !== null
                ? `${insights.snapshot.avgDaysOnMarket}d`
                : "—"}
            </p>
            <p className="text-[10px] text-muted-foreground leading-tight">Avg DOM</p>
          </div>
          <div className="text-center">
            <p className="text-lg font-bold text-foreground">
              {insights.snapshot.activeBuyerContacts}
            </p>
            <p className="text-[10px] text-muted-foreground leading-tight">Active Buyers</p>
          </div>
        </div>

        {/* Regenerate Button */}
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => fetchInsights(true)}
          disabled={regenerating}
        >
          {regenerating ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Regenerating...
            </>
          ) : (
            <>
              <RefreshCw className="h-4 w-4 mr-2" />
              Regenerate
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  )
}
