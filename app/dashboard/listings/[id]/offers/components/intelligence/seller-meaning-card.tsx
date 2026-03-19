"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { DollarSign, Clock, Shield, ArrowRight } from "lucide-react"

interface SellerMeaningCardProps {
  offer: {
    offer_price: number
    closing_date: string | null
    financing_type: string | null
    contingencies: string[] | null
    appraisal_contingency_days: number | null
    financing_contingency_days: number | null
    inspection_period_days: number | null
    earnest_money_amount: number | null
    down_payment_percent: number | null
  }
  listPrice: number
  mortgagePayoff?: number
}

export function SellerMeaningCard({ offer, listPrice, mortgagePayoff = 0 }: SellerMeaningCardProps) {
  const priceDiff = offer.offer_price - listPrice
  const priceDiffPercent = listPrice > 0 ? ((priceDiff / listPrice) * 100).toFixed(1) : "0"
  const estimatedNet = offer.offer_price - mortgagePayoff
  const contingencyCount = offer.contingencies?.length ?? 0
  const isCash = offer.financing_type?.toLowerCase() === "cash"
  const closingDate = offer.closing_date ? new Date(offer.closing_date) : null
  const daysToClose = closingDate
    ? Math.ceil((closingDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : null

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">What This Offer Means</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Financial */}
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-green-50">
            <DollarSign className="h-4 w-4 text-green-600" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">Financially</p>
            <p className="text-xs text-muted-foreground">
              {priceDiff >= 0 ? (
                <>This offer is <span className="font-medium text-green-700">${Math.abs(priceDiff).toLocaleString()} above</span> your asking price (+{priceDiffPercent}%).</>
              ) : (
                <>This offer is <span className="font-medium text-amber-700">${Math.abs(priceDiff).toLocaleString()} below</span> your asking price ({priceDiffPercent}%).</>
              )}
              {mortgagePayoff > 0 && (
                <> After your mortgage payoff, estimated net proceeds are <span className="font-medium">${estimatedNet.toLocaleString()}</span>.</>
              )}
            </p>
          </div>
        </div>

        {/* Certainty */}
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-blue-50">
            <Shield className="h-4 w-4 text-blue-600" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">For Certainty</p>
            <p className="text-xs text-muted-foreground">
              {isCash ? (
                <>This is a <span className="font-medium text-green-700">cash offer</span> with no financing risk.</>
              ) : (
                <>This buyer needs financing ({offer.financing_type ?? "conventional"}). {offer.down_payment_percent && offer.down_payment_percent >= 20 ? (
                  <span className="text-green-700">Strong {offer.down_payment_percent}% down payment reduces risk.</span>
                ) : (
                  <span className="text-amber-700">Lower down payment ({offer.down_payment_percent ?? 0}%) may increase financing risk.</span>
                )}</>
              )}
              {contingencyCount > 0 ? (
                <> There are <span className="font-medium">{contingencyCount} contingencies</span> that could affect closing.</>
              ) : (
                <> <span className="text-green-700">No contingencies</span> — higher certainty to close.</>
              )}
            </p>
          </div>
        </div>

        {/* Timing */}
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-purple-50">
            <Clock className="h-4 w-4 text-purple-600" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">For Timing</p>
            <p className="text-xs text-muted-foreground">
              {daysToClose !== null ? (
                daysToClose <= 21 ? (
                  <>Proposed close in <span className="font-medium text-green-700">{daysToClose} days</span> — a fast timeline.</>
                ) : daysToClose <= 45 ? (
                  <>Proposed close in <span className="font-medium">{daysToClose} days</span> — standard timeline.</>
                ) : (
                  <>Proposed close in <span className="font-medium text-amber-700">{daysToClose} days</span> — extended timeline.</>
                )
              ) : (
                <>Closing date not specified.</>
              )}
              {offer.inspection_period_days && (
                <> Inspection period: {offer.inspection_period_days} days.</>
              )}
            </p>
          </div>
        </div>

        {/* What Happens Next */}
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-gray-100">
            <ArrowRight className="h-4 w-4 text-gray-600" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">What Happens Next</p>
            <p className="text-xs text-muted-foreground">
              You can <span className="font-medium">accept</span> this offer as-is, <span className="font-medium">counter</span> with different terms, or <span className="font-medium">reject</span> it. If you counter, the buyer will have a chance to respond. Once accepted, the transaction moves to escrow.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
