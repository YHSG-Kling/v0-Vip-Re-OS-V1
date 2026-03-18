"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Calendar, TrendingUp, TrendingDown, Minus, Eye } from "lucide-react"

interface ShowingIntelligenceProps {
  listingId: string
  upcomingCount: number
  totalShowings: number
  feedbackTrends: {
    positivePatterns: string[]
    objections: string[]
    pricingSignal?: string
  } | null
}

export function ListingShowingIntelligence({
  listingId,
  upcomingCount,
  totalShowings,
  feedbackTrends,
}: ShowingIntelligenceProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Eye className="h-4 w-4 text-blue-600" />
            Showing Intelligence
          </span>
          <Badge variant="outline" className="text-xs">
            {totalShowings} total
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-4 text-sm">
          <div>
            <p className="text-2xl font-bold">{upcomingCount}</p>
            <p className="text-xs text-muted-foreground">upcoming</p>
          </div>
          <div>
            <p className="text-2xl font-bold">{totalShowings}</p>
            <p className="text-xs text-muted-foreground">completed</p>
          </div>
        </div>

        {feedbackTrends && (
          <div className="space-y-2 border-t pt-2">
            {feedbackTrends.positivePatterns.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {feedbackTrends.positivePatterns.slice(0, 2).map((p, i) => (
                  <span key={i} className="text-xs bg-green-100 text-green-800 px-1.5 py-0.5 rounded">
                    + {p}
                  </span>
                ))}
              </div>
            )}
            {feedbackTrends.objections.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {feedbackTrends.objections.slice(0, 2).map((o, i) => (
                  <span key={i} className="text-xs bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded">
                    ! {o}
                  </span>
                ))}
              </div>
            )}
            {feedbackTrends.pricingSignal && (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium">Pricing:</span> {feedbackTrends.pricingSignal}
              </p>
            )}
          </div>
        )}

        <Link href={`/dashboard/listings/${listingId}/showings`}>
          <Button size="sm" variant="outline" className="w-full text-xs gap-1.5">
            <Calendar className="h-3 w-3" />
            View Showings
          </Button>
        </Link>
      </CardContent>
    </Card>
  )
}
