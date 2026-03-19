"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import { FileText, AlertCircle, CheckCircle2, Clock, ArrowRight, DollarSign } from "lucide-react"

interface OfferPostureCardProps {
  contactId: string
  totalOffers: number
  pendingOffers: number
  highestOffer: number | null
  listPrice: number | null
  hasAcceptedOffer: boolean
  needsAction: boolean
}

export function OfferPostureCard({
  contactId,
  totalOffers,
  pendingOffers,
  highestOffer,
  listPrice,
  hasAcceptedOffer,
  needsAction,
}: OfferPostureCardProps) {
  // Derive posture state
  let postureState: "no_offers" | "offers_pending" | "action_needed" | "accepted" = "no_offers"
  if (hasAcceptedOffer) postureState = "accepted"
  else if (needsAction) postureState = "action_needed"
  else if (pendingOffers > 0) postureState = "offers_pending"

  const postureConfig: Record<string, { headline: string; meaning: string; color: string; icon: React.ReactNode }> = {
    no_offers: {
      headline: "Waiting for Offers",
      meaning: "No offers have been received yet. Your agent is working to attract buyer interest.",
      color: "bg-slate-100 text-slate-700",
      icon: <Clock className="h-5 w-5 text-slate-500" />,
    },
    offers_pending: {
      headline: "Offers Being Reviewed",
      meaning: `You have ${pendingOffers} ${pendingOffers === 1 ? "offer" : "offers"} to consider. Your agent will help you evaluate each one.`,
      color: "bg-blue-100 text-blue-800",
      icon: <FileText className="h-5 w-5 text-blue-600" />,
    },
    action_needed: {
      headline: "Action Required",
      meaning: "An offer needs your response. Review the details with your agent and decide how to proceed.",
      color: "bg-amber-100 text-amber-800",
      icon: <AlertCircle className="h-5 w-5 text-amber-600" />,
    },
    accepted: {
      headline: "Offer Accepted",
      meaning: "Congratulations! You have accepted an offer and are moving toward closing.",
      color: "bg-green-100 text-green-800",
      icon: <CheckCircle2 className="h-5 w-5 text-green-600" />,
    },
  }

  const posture = postureConfig[postureState]

  // Calculate percentage of list price
  const offerPercent = highestOffer && listPrice ? Math.round((highestOffer / listPrice) * 100) : null

  return (
    <Card className={needsAction ? "border-amber-300 bg-amber-50/30" : ""}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <DollarSign className="h-4 w-4" />
            Offer Status
          </CardTitle>
          <Badge className={posture.color}>{posture.headline}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Status Icon + Meaning */}
        <div className="flex gap-3">
          <div className="shrink-0 mt-0.5">{posture.icon}</div>
          <p className="text-sm text-muted-foreground">{posture.meaning}</p>
        </div>

        {/* Offer Stats */}
        {totalOffers > 0 && (
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 rounded-lg bg-muted/50">
              <p className="text-xs text-muted-foreground mb-1">Total Offers</p>
              <p className="text-xl font-semibold">{totalOffers}</p>
            </div>
            {highestOffer && (
              <div className="p-3 rounded-lg bg-muted/50">
                <p className="text-xs text-muted-foreground mb-1">Highest Offer</p>
                <p className="text-xl font-semibold">${(highestOffer / 1000).toFixed(0)}K</p>
                {offerPercent && (
                  <p className="text-xs text-muted-foreground">{offerPercent}% of list</p>
                )}
              </div>
            )}
          </div>
        )}

        {/* CTA */}
        <Button
          variant={needsAction ? "default" : "outline"}
          size="sm"
          asChild
          className={`w-full ${needsAction ? "bg-amber-600 hover:bg-amber-700" : ""}`}
        >
          <Link href={`/portal/${contactId}/offers`}>
            {needsAction ? "Review Offers Now" : "View Offers"}
            <ArrowRight className="h-4 w-4 ml-2" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  )
}
