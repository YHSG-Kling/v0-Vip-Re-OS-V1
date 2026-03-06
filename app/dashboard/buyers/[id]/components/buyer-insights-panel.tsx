"use client"

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { getBuyerInsights, refreshBuyerInsights, type BuyerInsights } from "@/app/actions/buyer-insights"
import { Brain, RefreshCw, AlertTriangle, Target } from "lucide-react"

const VELOCITY_BADGE: Record<string, { label: string; className: string }> = {
  accelerating: { label: "Accelerating",  className: "bg-green-100 text-green-800 border-green-200" },
  steady:       { label: "Steady",        className: "bg-blue-100  text-blue-800  border-blue-200"  },
  decelerating: { label: "Decelerating",  className: "bg-amber-100 text-amber-800 border-amber-200" },
  stalled:      { label: "Stalled",       className: "bg-red-100   text-red-800   border-red-200"   },
}

function formatPrice(n: number | null): string {
  if (!n) return "—"
  return "$" + new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 0 }).format(n)
}

interface Props {
  contactId: string
}

export default function BuyerInsightsPanel({ contactId }: Props) {
  const [insights, setInsights]   = useState<BuyerInsights | null>(null)
  const [loading, setLoading]     = useState(true)
  const [isPending, startTransition] = useTransition()

  async function load() {
    setLoading(true)
    const res = await getBuyerInsights(contactId)
    if (res.success && res.insights) setInsights(res.insights)
    setLoading(false)
  }

  useEffect(() => { load() }, [contactId])

  function handleRefresh() {
    startTransition(async () => {
      await refreshBuyerInsights(contactId)
      await load()
    })
  }

  const p    = insights?.prediction
  const pref = insights?.preferences
  const hasData = !!p || !!pref

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
          <p className="text-xs text-muted-foreground leading-relaxed">
            No search activity yet — insights will appear after buyer views properties.
          </p>
        ) : (
          <>
            {/* Prediction row */}
            {p && (
              <div className="space-y-2">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-1.5">
                    {p.engagement_velocity && (
                      <Badge
                        variant="outline"
                        className={`text-xs ${VELOCITY_BADGE[p.engagement_velocity]?.className ?? ""}`}
                      >
                        {VELOCITY_BADGE[p.engagement_velocity]?.label ?? p.engagement_velocity}
                      </Badge>
                    )}
                    {p.engagement_score > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {p.engagement_score} signals/month
                      </span>
                    )}
                  </div>
                </div>

                {p.predicted_next_action && (
                  <div className="space-y-0.5">
                    <p className="text-xs text-muted-foreground">Predicted next</p>
                    <p className="text-sm font-medium">{p.predicted_next_action}</p>
                  </div>
                )}

                {p.confidence !== null && (
                  <div className="space-y-0.5">
                    <p className="text-xs text-muted-foreground">
                      Confidence: {Math.round((p.confidence ?? 0) * 100)}%
                    </p>
                    <Progress value={(p.confidence ?? 0) * 100} className="h-1.5" />
                  </div>
                )}

                {p.days_to_predicted_offer !== null && p.days_to_predicted_offer !== undefined && (
                  <p className="text-xs text-muted-foreground">
                    Estimated offer in{" "}
                    <span className="font-medium text-foreground">{p.days_to_predicted_offer} days</span>
                  </p>
                )}
              </div>
            )}

            {/* Separator */}
            {p && pref && <div className="border-t border-border" />}

            {/* Inferred preferences */}
            {pref && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Inferred Preferences
                </p>

                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  {(pref.inferred_min_price || pref.inferred_max_price) && (
                    <>
                      <span className="text-muted-foreground">Price</span>
                      <span className="font-medium">
                        {formatPrice(pref.inferred_min_price)} – {formatPrice(pref.inferred_max_price)}
                      </span>
                    </>
                  )}
                  {pref.inferred_beds_min && (
                    <>
                      <span className="text-muted-foreground">Beds</span>
                      <span className="font-medium">{pref.inferred_beds_min}+</span>
                    </>
                  )}
                  {pref.inferred_baths_min && (
                    <>
                      <span className="text-muted-foreground">Baths</span>
                      <span className="font-medium">{pref.inferred_baths_min}+</span>
                    </>
                  )}
                  {pref.inferred_cities?.length > 0 && (
                    <>
                      <span className="text-muted-foreground">Cities</span>
                      <span className="font-medium">{pref.inferred_cities.join(", ")}</span>
                    </>
                  )}
                  {pref.inferred_property_types?.length > 0 && (
                    <>
                      <span className="text-muted-foreground">Type</span>
                      <span className="font-medium">{pref.inferred_property_types.join(", ")}</span>
                    </>
                  )}
                </div>

                {pref.confidence_score > 0 && (
                  <div className="space-y-0.5">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Preference confidence</span>
                      <span>{Math.round(pref.confidence_score * 100)}%</span>
                    </div>
                    <Progress value={pref.confidence_score * 100} className="h-1.5" />
                  </div>
                )}

                {pref.signals_processed > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Based on {pref.signals_processed} behavior signal{pref.signals_processed !== 1 ? "s" : ""}
                  </p>
                )}
              </div>
            )}

            {/* Alert badges */}
            {(p?.predicted_fatigue_risk || p?.predicted_ready_to_offer) && (
              <div className="flex flex-wrap gap-2 pt-1">
                {p?.predicted_fatigue_risk && (
                  <div className="flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
                    <AlertTriangle className="h-3 w-3" />
                    Fatigue risk detected
                  </div>
                )}
                {p?.predicted_ready_to_offer && (
                  <div className="flex items-center gap-1 rounded-md border border-green-200 bg-green-50 px-2 py-1 text-xs text-green-800">
                    <Target className="h-3 w-3" />
                    Ready to offer
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
