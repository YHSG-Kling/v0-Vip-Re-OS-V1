"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CheckCircle2, XCircle, MapPin, TrendingUp, BookOpen } from "lucide-react"

interface NeighborhoodStoryCardProps {
  listingId: string
  hasReport: boolean
  neighborhoodName?: string
  pricingNarrativeReady: boolean
  marketTrend?: string
  medianPrice?: number
}

export function NeighborhoodStoryCard({
  listingId,
  hasReport,
  neighborhoodName,
  pricingNarrativeReady,
  marketTrend,
  medianPrice,
}: NeighborhoodStoryCardProps) {
  const isReady = hasReport && pricingNarrativeReady

  return (
    <Card className={isReady ? "border-green-200 bg-green-50/30" : "border-muted"}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="flex items-center gap-2">
            <MapPin className="h-4 w-4 text-indigo-600" />
            Neighborhood Story
          </span>
          <Badge variant={isReady ? "default" : "secondary"} className="text-xs">
            {isReady ? "Ready" : "Incomplete"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5">
              {hasReport ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
              ) : (
                <XCircle className="h-3.5 w-3.5 text-amber-500" />
              )}
              Neighborhood Report
            </span>
            {neighborhoodName && (
              <span className="text-foreground font-medium truncate max-w-[120px]">
                {neighborhoodName}
              </span>
            )}
          </div>

          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5">
              {pricingNarrativeReady ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
              ) : (
                <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              Pricing Narrative
            </span>
            <span className={pricingNarrativeReady ? "text-green-700 font-medium" : "text-muted-foreground"}>
              {pricingNarrativeReady ? "Generated" : "Not Ready"}
            </span>
          </div>
        </div>

        {hasReport && (marketTrend || medianPrice) && (
          <div className="p-2 bg-muted/50 rounded text-xs space-y-1">
            {marketTrend && (
              <div className="flex items-center gap-1.5">
                <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
                <span>Market: {marketTrend}</span>
              </div>
            )}
            {medianPrice && (
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground">Median:</span>
                <span className="font-medium">${medianPrice.toLocaleString()}</span>
              </div>
            )}
          </div>
        )}

        <Link href={`/dashboard/listings/${listingId}/neighborhood-report`}>
          <Button size="sm" variant="outline" className="w-full text-xs">
            <BookOpen className="h-3.5 w-3.5 mr-1.5" />
            {hasReport ? "View Report" : "Generate Report"}
          </Button>
        </Link>
      </CardContent>
    </Card>
  )
}
