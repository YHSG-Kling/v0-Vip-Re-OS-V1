"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts"
import { TrendingUp, TrendingDown, Minus, RefreshCw } from "lucide-react"
import { triggerPricePrediction, resolvePriceTrendAlert } from "@/app/actions/seller-cma"
import type { PricingPageData } from "@/app/actions/seller-cma"

interface Listing {
  id: string
  lifecycle_stage: string | null
}

interface Props {
  listing: Listing
  data: PricingPageData
}

const severityClass: Record<string, string> = {
  low: "bg-blue-100 text-blue-800 border-blue-300",
  medium: "bg-amber-100 text-amber-800 border-amber-300",
  high: "bg-red-100 text-red-800 border-red-300",
  critical: "bg-red-200 text-red-900 border-red-400",
}

const fmt = (n: number) => `$${Math.round(n).toLocaleString()}`

export function PricingIntelligenceTab({ listing, data }: Props) {
  const { latestPrediction, priceHistory, activeAlerts } = data
  const [prediction, setPrediction] = useState(latestPrediction)
  const [alerts, setAlerts] = useState(activeAlerts)
  const [isPending, startTransition] = useTransition()
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null)

  function handleRefresh() {
    startTransition(async () => {
      setRefreshMsg(null)
      const result = await triggerPricePrediction(listing.id)
      if (result.success && result.predictedPrice) {
        setRefreshMsg(`Prediction refreshed: ${fmt(result.predictedPrice)}`)
        // Optimistic update
        setPrediction((prev) =>
          prev
            ? { ...prev, predicted_price: result.predictedPrice!, prediction_date: new Date().toISOString().split("T")[0] }
            : null
        )
      } else {
        setRefreshMsg(result.error ?? "Refresh failed.")
      }
    })
  }

  function handleResolveAlert(alertId: string) {
    startTransition(async () => {
      const result = await resolvePriceTrendAlert(alertId)
      if (result.success) {
        setAlerts((prev) => prev.filter((a) => a.id !== alertId))
      }
    })
  }

  // Prepare chart data
  const chartData = priceHistory.map((h) => ({
    date: new Date(h.recorded_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    price: Number(h.price),
    type: h.price_type,
  }))

  // Find MLS_ACTIVE annotation date
  const mlsActivePoint = priceHistory.find((h) => h.price_type === "mls_active")

  return (
    <div className="p-6 space-y-6 pb-20">

      {/* Prediction card */}
      <Card>
        <CardHeader className="py-3 px-4 flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium">AI Price Prediction</CardTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={handleRefresh}
            disabled={isPending}
            className="gap-1.5 h-7 text-xs"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isPending ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          {prediction ? (
            <div className="grid sm:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-muted-foreground mb-1">Predicted Price</p>
                <p className="text-2xl font-bold text-foreground">
                  {fmt(prediction.predicted_price)}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {new Date(prediction.prediction_date).toLocaleDateString()}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Confidence</p>
                <p className="text-2xl font-semibold text-foreground">
                  {prediction.confidence_score ?? "—"}
                  <span className="text-base text-muted-foreground font-normal">%</span>
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Trend</p>
                <div className="flex items-center gap-1.5">
                  {prediction.trend_direction === "up" && <TrendingUp className="h-4 w-4 text-green-600" />}
                  {prediction.trend_direction === "down" && <TrendingDown className="h-4 w-4 text-red-500" />}
                  {prediction.trend_direction === "stable" && <Minus className="h-4 w-4 text-muted-foreground" />}
                  <span className="text-base font-semibold capitalize text-foreground">
                    {prediction.trend_direction ?? "—"}
                  </span>
                  {prediction.trend_percentage != null && (
                    <span className="text-sm text-muted-foreground">
                      {Number(prediction.trend_percentage).toFixed(1)}%
                    </span>
                  )}
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Est. Days to Sell</p>
                <p className="text-2xl font-semibold text-foreground">
                  {prediction.days_to_sell_estimate ?? "—"}
                </p>
              </div>
            </div>
          ) : (
            <div className="text-center py-8">
              <p className="text-sm text-muted-foreground">No prediction yet.</p>
              <Button size="sm" className="mt-3" onClick={handleRefresh} disabled={isPending}>
                Generate Prediction
              </Button>
            </div>
          )}

          {/* Market factors */}
          {prediction?.market_factors && Object.keys(prediction.market_factors).length > 0 && (
            <div className="mt-4 grid sm:grid-cols-2 gap-2">
              {Object.entries(prediction.market_factors).map(([k, v]) => (
                <div key={k} className="text-xs bg-muted/40 rounded px-3 py-1.5">
                  <span className="font-medium text-muted-foreground capitalize">
                    {k.replace(/_/g, " ")}:{" "}
                  </span>
                  <span className="text-foreground">{String(v)}</span>
                </div>
              ))}
            </div>
          )}

          {refreshMsg && (
            <p className="text-xs text-muted-foreground mt-3">{refreshMsg}</p>
          )}
        </CardContent>
      </Card>

      {/* Price history chart */}
      {chartData.length > 0 && (
        <Card>
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-sm font-medium">Price History</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartData} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11 }}
                  className="fill-muted-foreground"
                />
                <YAxis
                  tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
                  tick={{ fontSize: 11 }}
                  className="fill-muted-foreground"
                  width={56}
                />
                <Tooltip
                  formatter={((value: number) => [fmt(value), "Price"]) as any}
                  contentStyle={{ fontSize: 12 }}
                />
                {mlsActivePoint && (
                  <ReferenceLine
                    x={new Date(mlsActivePoint.recorded_at).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })}
                    stroke="hsl(var(--primary))"
                    strokeDasharray="4 2"
                    label={{ value: "MLS Active", fontSize: 10, fill: "hsl(var(--primary))" }}
                  />
                )}
                <Line
                  type="monotone"
                  dataKey="price"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Active alerts */}
      {alerts.length > 0 && (
        <Card>
          <CardHeader className="py-3 px-4">
            <CardTitle className="text-sm font-medium text-foreground">
              Active Alerts ({alerts.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 space-y-3">
            {alerts.map((alert) => (
              <div
                key={alert.id}
                className="flex items-start gap-3 p-3 rounded border border-border bg-background"
              >
                <Badge className={severityClass[alert.severity] ?? "bg-muted text-muted-foreground"}>
                  {alert.severity}
                </Badge>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-foreground">{alert.message}</p>
                  {alert.recommended_action && (
                    <p className="text-xs text-muted-foreground mt-0.5">{alert.recommended_action}</p>
                  )}
                  <p className="text-xs text-muted-foreground mt-1">
                    {alert.created_at ? new Date(alert.created_at).toLocaleDateString() : ""}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs shrink-0"
                  onClick={() => handleResolveAlert(alert.id)}
                  disabled={isPending}
                >
                  Resolve
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {alerts.length === 0 && priceHistory.length === 0 && !prediction && (
        <Card className="border-dashed">
          <CardContent className="py-16 text-center">
            <p className="text-sm text-muted-foreground">No pricing data yet.</p>
            <p className="text-xs text-muted-foreground mt-1">
              Run a prediction to begin tracking price intelligence for this listing.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
