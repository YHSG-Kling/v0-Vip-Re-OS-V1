"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { DollarSign, TrendingUp, Shield, Sparkles } from "lucide-react"

interface OfferSummary {
  id: string
  offer_price: number
  financing_type: string
  status: string
}

interface ListingOfferPostureProps {
  listingId: string
  activeOffers: OfferSummary[]
  bestOption: OfferSummary | null
  safestOption: OfferSummary | null
  negotiationRecommended: boolean
}

export function ListingOfferPosture({
  listingId,
  activeOffers,
  bestOption,
  safestOption,
  negotiationRecommended,
}: ListingOfferPostureProps) {
  const count = activeOffers.length

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-green-600" />
            Offer Posture
          </span>
          <Badge variant={count > 0 ? "default" : "secondary"} className="text-xs">
            {count} active
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {count === 0 ? (
          <p className="text-xs text-muted-foreground">No active offers yet</p>
        ) : (
          <>
            {bestOption && (
              <div className="flex items-center gap-2 p-2 bg-green-50 rounded text-xs">
                <TrendingUp className="h-3.5 w-3.5 text-green-600" />
                <div>
                  <span className="font-medium">Best:</span> $
                  {bestOption.offer_price.toLocaleString()}
                  <span className="text-muted-foreground ml-1">({bestOption.financing_type})</span>
                </div>
              </div>
            )}
            {safestOption && safestOption.id !== bestOption?.id && (
              <div className="flex items-center gap-2 p-2 bg-blue-50 rounded text-xs">
                <Shield className="h-3.5 w-3.5 text-blue-600" />
                <div>
                  <span className="font-medium">Safest:</span> $
                  {safestOption.offer_price.toLocaleString()}
                  <span className="text-muted-foreground ml-1">({safestOption.financing_type})</span>
                </div>
              </div>
            )}
            {negotiationRecommended && (
              <div className="flex items-center gap-2 p-2 bg-amber-50 rounded text-xs">
                <Sparkles className="h-3.5 w-3.5 text-amber-600" />
                <span>Negotiation recommended</span>
              </div>
            )}
          </>
        )}
        <Link href={`/dashboard/listings/${listingId}/offers`}>
          <Button size="sm" variant="outline" className="w-full text-xs gap-1.5">
            <DollarSign className="h-3 w-3" />
            {count > 0 ? "Review Offers" : "View Offer Intelligence"}
          </Button>
        </Link>
      </CardContent>
    </Card>
  )
}
