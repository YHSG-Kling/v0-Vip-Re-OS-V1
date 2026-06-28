"use client"

import { Card, CardContent } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
import { CheckCircle2, Clock, AlertCircle } from "lucide-react"
import { deriveSellerStage, resolveSellerStageCopy } from "@/lib/portal/seller-journey-copy"

interface SellerJourneyMeaningCardProps {
  listingStatus: string | null
  offerCount: number
  showingCount: number
  daysOnMarket: number | null
  agentName?: string | null
  /** When the seller is in a self-disclosed sensitive context (probate / divorce / foreclosure /
   *  major transition), the copy shifts to an empathy-forward, lower-pressure register. */
  sensitive?: boolean
}

export function SellerJourneyMeaningCard({
  listingStatus,
  offerCount,
  showingCount,
  daysOnMarket,
  agentName,
  sensitive,
}: SellerJourneyMeaningCardProps) {
  const stage = deriveSellerStage(listingStatus, offerCount, showingCount)
  const ctx = resolveSellerStageCopy(stage, { sensitive })

  const UrgencyIcon = ctx.urgency === "high" ? AlertCircle : ctx.urgency === "medium" ? Clock : CheckCircle2
  const urgencyColor = ctx.urgency === "high" ? "text-amber-600" : ctx.urgency === "medium" ? "text-blue-600" : "text-green-600"

  return (
    <Card className="shadow-lg border-0">
      <CardContent className="p-5 space-y-4">
        {/* Header with status */}
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wide mb-1">Your Sale Status</p>
            <h3 className="text-lg font-semibold text-foreground">{ctx.headline}</h3>
          </div>
          <UrgencyIcon className={`h-5 w-5 ${urgencyColor} shrink-0`} />
        </div>

        {/* What This Means */}
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">What This Means</p>
          <p className="text-sm text-foreground leading-relaxed">{ctx.whatMeans}</p>
        </div>

        {/* Activity Summary */}
        {(showingCount > 0 || offerCount > 0 || daysOnMarket !== null) && (
          <div className="flex flex-wrap gap-2">
            {daysOnMarket !== null && (
              <Badge variant="outline" className="text-xs">
                {daysOnMarket} {daysOnMarket === 1 ? "day" : "days"} on market
              </Badge>
            )}
            {showingCount > 0 && (
              <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700 border-blue-200">
                {showingCount} {showingCount === 1 ? "showing" : "showings"}
              </Badge>
            )}
            {offerCount > 0 && (
              <Badge variant="outline" className="text-xs bg-amber-50 text-amber-700 border-amber-200">
                {offerCount} {offerCount === 1 ? "offer" : "offers"}
              </Badge>
            )}
          </div>
        )}

        {/* What Happens Next */}
        <div className="border-t pt-3 space-y-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">What Happens Next</p>
          <p className="text-sm text-muted-foreground leading-relaxed">{ctx.whatNext}</p>
          <Badge variant="secondary" className="text-xs">
            Responsible: {agentName ? `${agentName} (${ctx.responsible})` : ctx.responsible}
          </Badge>
        </div>
      </CardContent>
    </Card>
  )
}
