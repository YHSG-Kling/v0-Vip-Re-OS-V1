"use client"

import { Card, CardContent } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
import { CheckCircle2, Clock, AlertCircle } from "lucide-react"

// Plain-language stage meaning map for seller journey
const SELLER_STAGE_MEANING: Record<string, {
  headline: string
  whatMeans: string
  whatNext: string
  responsible: string
  urgency: "low" | "medium" | "high"
}> = {
  COMING_SOON: {
    headline: "Getting Ready to Launch",
    whatMeans: "Your listing is being prepared for market. Photos, pricing, and marketing materials are being finalized.",
    whatNext: "Once everything is ready, your agent will launch the listing and begin marketing.",
    responsible: "Your Agent",
    urgency: "low",
  },
  ACTIVE: {
    headline: "On the Market",
    whatMeans: "Your home is actively listed and being shown to potential buyers. Marketing is live and working.",
    whatNext: "Your agent will keep you updated on showings and any buyer interest.",
    responsible: "Your Agent + Market",
    urgency: "medium",
  },
  SHOWING_ACTIVE: {
    headline: "Buyers Are Viewing",
    whatMeans: "Your home is getting attention. Showings are happening and buyers are seeing the property.",
    whatNext: "After each showing, your agent will collect feedback and share insights with you.",
    responsible: "Your Agent",
    urgency: "medium",
  },
  OFFER_RECEIVED: {
    headline: "Offer Received",
    whatMeans: "A buyer has submitted an offer on your home. This is an important moment in your sale.",
    whatNext: "Review the offer with your agent. You can accept, counter, or decline.",
    responsible: "You + Your Agent",
    urgency: "high",
  },
  UNDER_CONTRACT: {
    headline: "Under Contract",
    whatMeans: "You have accepted an offer and are now in the due diligence period. The buyer is completing inspections and financing.",
    whatNext: "Key milestones: inspection, appraisal, and final walkthrough before closing.",
    responsible: "Buyer + Your Agent",
    urgency: "medium",
  },
  PENDING: {
    headline: "Sale Pending",
    whatMeans: "All contingencies have been cleared. You are on track to close.",
    whatNext: "Final preparations for closing day. Your agent will coordinate with title and escrow.",
    responsible: "Your Agent + Title",
    urgency: "low",
  },
  CLOSED: {
    headline: "Sold",
    whatMeans: "Congratulations! Your home has sold. The transaction is complete.",
    whatNext: "Your agent remains a resource for any questions about your next chapter.",
    responsible: "You",
    urgency: "low",
  },
}

interface SellerJourneyMeaningCardProps {
  listingStatus: string | null
  offerCount: number
  showingCount: number
  daysOnMarket: number | null
  agentName?: string | null
}

export function SellerJourneyMeaningCard({
  listingStatus,
  offerCount,
  showingCount,
  daysOnMarket,
  agentName,
}: SellerJourneyMeaningCardProps) {
  // Derive stage from listing status and activity
  let stage = "ACTIVE"
  if (listingStatus === "coming_soon") stage = "COMING_SOON"
  else if (listingStatus === "pending" || listingStatus === "under_contract") stage = "UNDER_CONTRACT"
  else if (listingStatus === "sold" || listingStatus === "closed") stage = "CLOSED"
  else if (offerCount > 0) stage = "OFFER_RECEIVED"
  else if (showingCount > 0) stage = "SHOWING_ACTIVE"

  const ctx = SELLER_STAGE_MEANING[stage] || SELLER_STAGE_MEANING.ACTIVE

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
