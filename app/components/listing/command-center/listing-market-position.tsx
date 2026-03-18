"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { TrendingUp, TrendingDown, Minus, MapPin, Target } from "lucide-react"

interface MarketPositionProps {
  listingId: string
  neighborhoodSummary?: string
  marketTrend: "up" | "down" | "stable"
  competitorPressure: "high" | "medium" | "low"
  pricingSignal?: string
}

export function ListingMarketPosition({
  listingId,
  neighborhoodSummary,
  marketTrend,
  competitorPressure,
  pricingSignal,
}: MarketPositionProps) {
  const TrendIcon = marketTrend === "up" ? TrendingUp : marketTrend === "down" ? TrendingDown : Minus
  const trendColor = marketTrend === "up" ? "text-green-600" : marketTrend === "down" ? "text-red-600" : "text-muted-foreground"

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Target className="h-4 w-4 text-orange-600" />
            Market Position
          </span>
          <div className="flex items-center gap-1">
            <TrendIcon className={`h-3.5 w-3.5 ${trendColor}`} />
            <span className={`text-xs ${trendColor}`}>
              {marketTrend === "up" ? "Rising" : marketTrend === "down" ? "Declining" : "Stable"}
            </span>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {neighborhoodSummary && (
          <p className="text-xs text-muted-foreground line-clamp-2">{neighborhoodSummary}</p>
        )}

        <div className="flex gap-2">
          <Badge
            variant={competitorPressure === "high" ? "destructive" : competitorPressure === "medium" ? "secondary" : "outline"}
            className="text-xs"
          >
            {competitorPressure} competition
          </Badge>
        </div>

        {pricingSignal && (
          <p className="text-xs p-2 bg-muted/40 rounded">
            <span className="font-medium">Pricing:</span> {pricingSignal}
          </p>
        )}

        <div className="flex gap-2 flex-wrap">
          <Link href={`/dashboard/listings/${listingId}/neighborhood-report`}>
            <Button size="sm" variant="outline" className="text-xs gap-1.5">
              <MapPin className="h-3 w-3" />
              Neighborhood Report
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}
