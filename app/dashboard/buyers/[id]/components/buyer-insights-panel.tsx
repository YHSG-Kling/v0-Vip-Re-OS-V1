"use client"

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Brain, RefreshCw, Heart, Bookmark, X } from "lucide-react"
import { getBuyerInsights, refreshBuyerInsights, type BuyerInsights } from "@/app/actions/buyer-insights"

interface Props {
  contactId:   string
  brokerageId: string
}

function formatPrice(n: number | null | undefined): string {
  if (!n) return "—"
  return new Intl.NumberFormat("en-US", {
    style:    "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n)
}

function ConfidenceBar({ value }: { value: number }) {
  // value is 0-1; convert to 0-100
  const pct = Math.round(value * 100)
  const color =
    pct < 40  ? "bg-red-500"
    : pct < 70 ? "bg-yellow-500"
    :             "bg-green-500"

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>Confidence</span>
        <span>{pct}%</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

export default function BuyerInsightsPanel({ contactId, brokerageId }: Props) {
  const [insights,  setInsights]  = useState<BuyerInsights | null>(null)
  const [loading,   setLoading]   = useState(true)
  const [signalCounts, setSignalCounts] = useState({ saves: 0, loves: 0, dismissals: 0 })
  const [isPending, startTransition] = useTransition()

  async function load() {
    setLoading(true)
    const res = await getBuyerInsights(contactId)
    if (res.success && res.insights) {
      setInsights(res.insights)
      setSignalCounts(res.signalCounts ?? { saves: 0, loves: 0, dismissals: 0 })
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [contactId])

  function handleRefresh() {
    startTransition(async () => {
      await refreshBuyerInsights(contactId)
      await load()
    })
  }

  const pred = insights?.prediction
  const pref = insights?.preferences

  // Resolve price range — prefer prediction values, fall back to inferred preferences
  const priceMin = pred?.predicted_price_min ?? pref?.inferred_min_price ?? null
  const priceMax = pred?.predicted_price_max ?? pref?.inferred_max_price ?? null
  const propType = pred?.predicted_property_type ?? pref?.inferred_property_types?.[0] ?? null
  const timeline = pred?.predicted_timeline_days ?? null
  const confidence = pred?.confidence_score ?? pred?.confidence ?? null
  const reasoning  = pred?.ai_reasoning ?? null

  const hasData = !!pred || !!pref

  return (
    <Card className="border border-border bg-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Brain className="h-4 w-4 text-primary" />
            <CardTitle className="text-sm font-semibold">AI Buyer Insights</CardTitle>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            disabled={isPending || loading}
            className="h-7 px-2 text-xs"
          >
            <RefreshCw className={`h-3 w-3 mr-1 ${isPending ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {loading ? (
          <div className="space-y-2">
            <div className="h-3 w-3/4 bg-muted rounded animate-pulse" />
            <div className="h-3 w-1/2 bg-muted rounded animate-pulse" />
            <div className="h-3 w-2/3 bg-muted rounded animate-pulse" />
          </div>
        ) : !hasData ? (
          // Spec-exact empty state
          <p className="text-xs text-muted-foreground leading-relaxed">
            Learning from buyer activity. Insights appear after 5+ property interactions.
          </p>
        ) : (
          <>
            {/* Predicted price range */}
            {(priceMin || priceMax) && (
              <div className="space-y-0.5">
                <p className="text-xs text-muted-foreground">Predicted price range</p>
                <p className="text-sm font-semibold tabular-nums">
                  {formatPrice(priceMin)} – {formatPrice(priceMax)}
                </p>
              </div>
            )}

            {/* Predicted property type */}
            {propType && (
              <div className="space-y-0.5">
                <p className="text-xs text-muted-foreground">Predicted property type</p>
                <p className="text-sm font-medium">{propType}</p>
              </div>
            )}

            {/* Predicted timeline */}
            {timeline != null && (
              <div className="space-y-0.5">
                <p className="text-xs text-muted-foreground">Predicted timeline</p>
                <p className="text-sm font-medium">Est. {timeline} days to offer</p>
              </div>
            )}

            {/* Confidence bar with color */}
            {confidence != null && <ConfidenceBar value={confidence} />}

            {/* AI reasoning */}
            {reasoning && (
              <p className="text-xs italic text-muted-foreground leading-relaxed line-clamp-2">
                {reasoning}
              </p>
            )}

            {/* Inferred cities if no prediction cities */}
            {pref?.inferred_cities && pref.inferred_cities.length > 0 && (
              <div className="space-y-0.5">
                <p className="text-xs text-muted-foreground">Top cities</p>
                <p className="text-sm font-medium">{pref.inferred_cities.join(", ")}</p>
              </div>
            )}

            {/* Signal counts row — spec: "X saves · X loves · X dismissals" */}
            <div className="flex items-center gap-3 pt-1 border-t border-border text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Bookmark className="h-3 w-3" />
                {signalCounts.saves} saves
              </span>
              <span className="text-border">·</span>
              <span className="flex items-center gap-1">
                <Heart className="h-3 w-3" />
                {signalCounts.loves} loves
              </span>
              <span className="text-border">·</span>
              <span className="flex items-center gap-1">
                <X className="h-3 w-3" />
                {signalCounts.dismissals} dismissals
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
