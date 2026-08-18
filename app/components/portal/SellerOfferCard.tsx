"use client"

// components/portal/SellerOfferCard.tsx
// Displays offer status summary for seller portal.

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import { Skeleton } from "@/app/components/ui/skeleton"
import {
  FileText,
  DollarSign,
  ArrowRight,
  PartyPopper,
  Clock,
  TrendingUp,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  OFFER_STATUS_CONFIG,
  formatPrice,
  type OfferData,
} from "@/lib/portal/seller-context-presentation"

interface SellerOfferCardProps {
  total: number
  highest: number | null
  accepted: OfferData | null
  pending: number
  contactId: string
  listPrice?: number | null
  isLoading?: boolean
}

export function SellerOfferCard({
  total,
  highest,
  accepted,
  pending,
  contactId,
  listPrice,
  isLoading = false,
}: SellerOfferCardProps) {
  if (isLoading) {
    return <SellerOfferCardSkeleton />
  }

  // Accepted offer celebration card
  if (accepted) {
    const buyerName = accepted.buyer?.first_name || "Buyer"
    return (
      <Card className="bg-gradient-to-r from-green-50 to-emerald-50 border-green-200">
        <CardContent className="py-6">
          <div className="flex items-start gap-4">
            <div className="h-12 w-12 rounded-full bg-green-100 flex items-center justify-center shrink-0">
              <PartyPopper className="h-6 w-6 text-green-600" />
            </div>
            <div className="space-y-2 flex-1">
              <h3 className="text-lg font-semibold text-green-800">
                Congratulations! Offer Accepted!
              </h3>
              <p className="text-green-700">
                {buyerName} for {formatPrice(accepted.offer_amount)}
              </p>
              {listPrice && accepted.offer_amount && (
                <p className="text-sm text-green-600">
                  {accepted.offer_amount >= listPrice ? (
                    <span className="flex items-center gap-1">
                      <TrendingUp className="h-3.5 w-3.5" />
                      {((accepted.offer_amount / listPrice) * 100).toFixed(1)}% of list price
                    </span>
                  ) : (
                    <span>
                      {((accepted.offer_amount / listPrice) * 100).toFixed(1)}% of list price
                    </span>
                  )}
                </p>
              )}
              <Button className="mt-2 bg-green-600 hover:bg-green-700" asChild>
                <Link href={`/portal/${contactId}/journey`}>
                  View Transaction Timeline
                  <ArrowRight className="h-4 w-4 ml-2" />
                </Link>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    )
  }

  // No offers state
  if (total === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Offers
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-6">
            <Clock className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">
              No offers yet. Your agent is actively marketing your home.
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  // Has offers
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Offers
            {pending > 0 && (
              <Badge variant="secondary" className="bg-amber-100 text-amber-800 ml-1">
                {pending} pending
              </Badge>
            )}
          </CardTitle>
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/portal/${contactId}/offers`}>
              View All
              <ArrowRight className="h-4 w-4 ml-1" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          <div className="text-center p-3 rounded-lg bg-muted/50">
            <p className="text-2xl font-semibold">{total}</p>
            <p className="text-xs text-muted-foreground">Total Offers</p>
          </div>
          <div className="text-center p-3 rounded-lg bg-muted/50">
            <p className="text-2xl font-semibold text-green-600">
              {formatPrice(highest)}
            </p>
            <p className="text-xs text-muted-foreground">Highest Offer</p>
            {listPrice && highest && (
              <p className="text-xs text-muted-foreground mt-1">
                {((highest / listPrice) * 100).toFixed(0)}% of list
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function SellerOfferCardSkeleton() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-8 w-20" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-20 w-full rounded-lg" />
          <Skeleton className="h-20 w-full rounded-lg" />
        </div>
      </CardContent>
    </Card>
  )
}

// TOMBSTONE (orphan tranche 3): OfferComparisonTable deleted — a comparison
// table no surface rendered. The live survivor is the portal offers page
// itself, app/portal/[contactId]/offers/page.tsx, whose comparison section
// covers everything this table showed (per-offer buyer/amount/status/date
// rows, best-offer highlight) plus the persisted agent-authored comparison
// rows this static table could not display.

export { SellerOfferCardSkeleton }
