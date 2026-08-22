"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { MapPin, Calendar, Percent, Sparkles } from "lucide-react"

interface ValuationResultCardProps {
  propertyAddress: string
  estimatedValueLow: number
  estimatedValueMid: number
  estimatedValueHigh: number
  confidenceScore: number
  methodology: string
  marketTrend: string
  generatedAt: string
}

export function ValuationResultCard({
  propertyAddress,
  estimatedValueLow,
  estimatedValueMid,
  estimatedValueHigh,
  confidenceScore,
  methodology,
  marketTrend,
  generatedAt,
}: ValuationResultCardProps) {
  const formatCurrency = (value: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(value)

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
  }

  // The badge names the method that actually produced the number. A range built
  // from a regional $/sqft rate is NOT a CMA and must not wear that badge —
  // "AI CMA" is a claim the seller reads as "you looked at real sales nearby".
  const methodologyLabel =
    methodology === "ai_cma"
      ? "AI CMA"
      : methodology === "housecanary"
        ? "HouseCanary"
        : methodology === "sqft_regional_average"
          ? "Regional Average"
          : "Manual"

  // Calculate position of mid value on range bar
  const range = estimatedValueHigh - estimatedValueLow
  const midPosition = ((estimatedValueMid - estimatedValueLow) / range) * 100

  return (
    <Card className="overflow-hidden">
      <CardHeader className="bg-primary/5 pb-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm text-muted-foreground mb-1">Your Home Value Estimate</p>
            <CardTitle className="flex items-center gap-2 text-lg">
              <MapPin className="h-5 w-5 text-primary" />
              {propertyAddress}
            </CardTitle>
          </div>
          <div className="flex gap-2">
            <Badge variant="secondary" className="flex items-center gap-1">
              <Sparkles className="h-3 w-3" />
              {methodologyLabel}
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-6 space-y-6">
        {/* Main Value Display */}
        <div className="text-center">
          <p className="text-sm text-muted-foreground mb-2">Estimated Value</p>
          <p className="text-5xl font-bold text-primary tracking-tight">
            {formatCurrency(estimatedValueMid)}
          </p>
        </div>

        {/* Range Bar */}
        <div className="space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">{formatCurrency(estimatedValueLow)}</span>
            <span className="text-muted-foreground">{formatCurrency(estimatedValueHigh)}</span>
          </div>
          <div className="relative h-3 bg-muted rounded-full overflow-hidden">
            <div
              className="absolute inset-y-0 left-0 bg-gradient-to-r from-primary/30 via-primary to-primary/30 rounded-full"
              style={{ width: "100%" }}
            />
            <div
              className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-primary rounded-full border-2 border-background shadow-sm"
              style={{ left: `calc(${midPosition}% - 8px)` }}
            />
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Low Estimate</span>
            <span>High Estimate</span>
          </div>
        </div>

        {/* Confidence and Meta */}
        <div className="grid grid-cols-3 gap-4 pt-4 border-t">
          <div className="text-center">
            <div className="flex items-center justify-center gap-1 mb-1">
              <Percent className="h-4 w-4 text-muted-foreground" />
              <span className="text-lg font-semibold">{confidenceScore}%</span>
            </div>
            <p className="text-xs text-muted-foreground">Confidence</p>
          </div>
          <div className="text-center border-x">
            <div className="flex items-center justify-center gap-1 mb-1">
              <span
                className={`text-lg font-semibold ${
                  marketTrend === "appreciating"
                    ? "text-green-600"
                    : marketTrend === "depreciating"
                      ? "text-red-600"
                      : "text-muted-foreground"
                }`}
              >
                {marketTrend === "unknown" || !marketTrend
                  ? "Not yet available"
                  : marketTrend.charAt(0).toUpperCase() + marketTrend.slice(1)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">Market Trend</p>
          </div>
          <div className="text-center">
            <div className="flex items-center justify-center gap-1 mb-1">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-semibold">{formatDate(generatedAt)}</span>
            </div>
            <p className="text-xs text-muted-foreground">Generated</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
