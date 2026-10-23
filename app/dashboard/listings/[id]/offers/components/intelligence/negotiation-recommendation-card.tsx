"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, MessageSquare, Clock, XCircle, Sparkles } from "lucide-react"

type RecommendationType = "accept" | "counter" | "hold" | "reject"

interface NegotiationRecommendationCardProps {
  offer: {
    offer_price: number
    financing_type: string | null
    contingencies: string[] | null
    ai_recommendation: string | null
    ai_analysis: Record<string, unknown> | null
    earnest_money: number | null
    down_payment_percent: number | null
    appraisal_gap: number | null
    escalation_clause: boolean | null
  }
  listPrice: number
  totalOffers: number
  daysOnMarket?: number
}

/**
 * How long a listing has been out before its leverage is gone. Heuristic, and named
 * so it reads as one — the same status as the 5% / 10% / 3-offer / 20%-down numbers
 * this card has always used.
 */
const FRESH_MARKET_DAYS = 14
const STALE_MARKET_DAYS = 45

/**
 * `daysOnMarket` WAS ACCEPTED HERE AND READ BY NOTHING until 2026-08-24 — while the
 * REJECT branch's own comment promised "significantly below ask, weak terms, or stale
 * market". The stale-market half was never written, so this card gave a seller
 * eighty days into a listing exactly the advice it gives one on day two: hold out for
 * more offers, reject the low one. Time on market is the single biggest thing that
 * moves a seller's leverage, and it was sitting in the signature unread.
 */
function deriveRecommendation(
  offer: NegotiationRecommendationCardProps["offer"],
  listPrice: number,
  totalOffers: number,
  daysOnMarket: number
): { type: RecommendationType; reason: string } {
  const priceDiffPercent = listPrice > 0 ? ((offer.offer_price - listPrice) / listPrice) * 100 : 0
  const isCash = offer.financing_type?.toLowerCase() === "cash"
  const hasEscalation = offer.escalation_clause
  const hasAppraisalGap = (offer.appraisal_gap ?? 0) > 0
  const strongDown = (offer.down_payment_percent ?? 0) >= 20
  const contingencyCount = offer.contingencies?.length ?? 0

  // Accept: at or above ask, cash or strong financing, few contingencies
  if (priceDiffPercent >= 0 && (isCash || strongDown) && contingencyCount <= 1) {
    return {
      type: "accept",
      reason: `Strong offer at ${priceDiffPercent > 0 ? "above" : ""} asking price with ${isCash ? "cash financing" : "solid financing"} and minimal contingencies.`,
    }
  }

  // Counter: close to ask but has room for improvement
  if (priceDiffPercent >= -5 && priceDiffPercent < 0) {
    return {
      type: "counter",
      reason: `Offer is ${Math.abs(priceDiffPercent).toFixed(1)}% below asking. Consider countering to close the gap while keeping the buyer engaged.`,
    }
  }

  // Hold: multiple offers on a listing that is still FRESH. Waiting is leverage only
  // while buyers are still arriving; on a listing that has been out for weeks it is
  // the advice that loses the only offer on the table.
  if (totalOffers >= 3 && priceDiffPercent >= -3 && daysOnMarket <= FRESH_MARKET_DAYS) {
    return {
      type: "hold",
      reason: `You have ${totalOffers} active offers and the listing is only ${daysOnMarket} day${daysOnMarket === 1 ? "" : "s"} old. Consider waiting to see all offers before responding to maximize leverage.`,
    }
  }

  // Reject: significantly below ask or weak terms — UNLESS the market has already
  // spoken. A listing past the stale mark has lost the leverage a rejection assumes,
  // so the same offer becomes something to counter rather than to send away.
  if (priceDiffPercent < -10 || (contingencyCount >= 3 && priceDiffPercent < -5)) {
    if (daysOnMarket >= STALE_MARKET_DAYS) {
      return {
        type: "counter",
        reason: `Offer is ${Math.abs(priceDiffPercent).toFixed(1)}% below asking, but the listing has been on the market ${daysOnMarket} days. Counter rather than reject — this may be the market's answer on price.`,
      }
    }
    return {
      type: "reject",
      reason: `Offer is ${Math.abs(priceDiffPercent).toFixed(1)}% below asking with ${contingencyCount > 0 ? `${contingencyCount} contingencies` : "weak terms"}. May not be worth pursuing.`,
    }
  }

  // Default to counter
  return {
    type: "counter",
    reason: `Standard offer with room for negotiation. Consider a counter to improve terms.`,
  }
}

const recommendationConfig: Record<RecommendationType, { icon: typeof CheckCircle2; color: string; bgColor: string; label: string }> = {
  accept: { icon: CheckCircle2, color: "text-green-700", bgColor: "bg-green-50", label: "Accept" },
  counter: { icon: MessageSquare, color: "text-blue-700", bgColor: "bg-blue-50", label: "Counter" },
  hold: { icon: Clock, color: "text-amber-700", bgColor: "bg-amber-50", label: "Hold" },
  reject: { icon: XCircle, color: "text-red-700", bgColor: "bg-red-50", label: "Reject" },
}

export function NegotiationRecommendationCard({
  offer,
  listPrice,
  totalOffers,
  daysOnMarket = 30,
}: NegotiationRecommendationCardProps) {
  // Use AI recommendation if available, otherwise derive
  const aiRec = offer.ai_recommendation?.toLowerCase() as RecommendationType | undefined
  const derived = deriveRecommendation(offer, listPrice, totalOffers, daysOnMarket)
  const recommendation = aiRec && recommendationConfig[aiRec] ? aiRec : derived.type
  const config = recommendationConfig[recommendation]
  const Icon = config.icon

  const reason = offer.ai_analysis?.recommendation_reason as string | undefined ?? derived.reason

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-indigo-600" />
          Negotiation Recommendation
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className={`p-4 rounded-lg ${config.bgColor} flex items-start gap-3`}>
          <Icon className={`h-5 w-5 ${config.color} mt-0.5`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Badge variant="outline" className={`${config.color} border-current`}>
                {config.label}
              </Badge>
              {offer.ai_recommendation && (
                <span className="text-xs text-muted-foreground">AI-powered</span>
              )}
            </div>
            <p className="text-sm text-foreground">{reason}</p>
          </div>
        </div>

        {/* Quick factors */}
        <div className="mt-4 grid grid-cols-2 gap-2">
          <div className="text-xs">
            <span className="text-muted-foreground">Price vs Ask:</span>{" "}
            <span className={`font-medium ${offer.offer_price >= listPrice ? "text-green-700" : "text-amber-700"}`}>
              {offer.offer_price >= listPrice ? "+" : ""}{listPrice > 0 ? (((offer.offer_price - listPrice) / listPrice) * 100).toFixed(1) : 0}%
            </span>
          </div>
          <div className="text-xs">
            <span className="text-muted-foreground">Financing:</span>{" "}
            <span className="font-medium">{offer.financing_type ?? "Unknown"}</span>
          </div>
          <div className="text-xs">
            <span className="text-muted-foreground">Contingencies:</span>{" "}
            <span className="font-medium">{offer.contingencies?.length ?? 0}</span>
          </div>
          <div className="text-xs">
            <span className="text-muted-foreground">Competition:</span>{" "}
            <span className="font-medium">{totalOffers} offer{totalOffers !== 1 ? "s" : ""}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
