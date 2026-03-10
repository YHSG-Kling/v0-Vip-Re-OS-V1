import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { DollarSign, TrendingUp, TrendingDown, Minus, Calendar } from "lucide-react"

interface EquityEstimateCardProps {
  estimatedValueMid?: number | null
  estimatedValueLow?: number | null
  estimatedValueHigh?: number | null
  purchasePrice: number
  marketTrend?: string | null
  generatedAt?: string | null
}

export function EquityEstimateCard({
  estimatedValueMid,
  estimatedValueLow,
  estimatedValueHigh,
  purchasePrice,
  marketTrend,
  generatedAt,
}: EquityEstimateCardProps) {
  const hasEstimate = estimatedValueMid && estimatedValueMid > 0

  if (!hasEstimate) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <DollarSign className="h-5 w-5 text-green-600" />
            <CardTitle className="text-lg">Equity Estimate</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="p-4 rounded-lg bg-muted/50 text-center">
            <p className="text-muted-foreground">
              Your equity estimate will appear here once available
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  const estimatedEquity = estimatedValueMid - purchasePrice
  const equityLow = (estimatedValueLow || estimatedValueMid * 0.95) - purchasePrice
  const equityHigh = (estimatedValueHigh || estimatedValueMid * 1.05) - purchasePrice

  const formatCurrency = (value: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(value)

  const formattedDate = generatedAt
    ? new Date(generatedAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : null

  // Calculate position for equity bar (0-100%)
  const range = equityHigh - equityLow
  const midPosition = range > 0 ? ((estimatedEquity - equityLow) / range) * 100 : 50

  const getTrendIcon = () => {
    switch (marketTrend?.toLowerCase()) {
      case "appreciating":
        return <TrendingUp className="h-4 w-4" />
      case "depreciating":
        return <TrendingDown className="h-4 w-4" />
      default:
        return <Minus className="h-4 w-4" />
    }
  }

  const getTrendColor = () => {
    switch (marketTrend?.toLowerCase()) {
      case "appreciating":
        return "bg-green-100 text-green-800"
      case "depreciating":
        return "bg-red-100 text-red-800"
      default:
        return "bg-gray-100 text-gray-800"
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <DollarSign className="h-5 w-5 text-green-600" />
            <CardTitle className="text-lg">Equity Estimate</CardTitle>
          </div>
          {marketTrend && (
            <Badge variant="secondary" className={getTrendColor()}>
              {getTrendIcon()}
              <span className="ml-1 capitalize">{marketTrend}</span>
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="text-center">
          <p className="text-sm text-muted-foreground">Estimated Equity</p>
          <p className={`text-3xl font-bold ${estimatedEquity >= 0 ? "text-green-600" : "text-red-600"}`}>
            {formatCurrency(estimatedEquity)}
          </p>
        </div>

        {/* Equity range bar */}
        <div className="space-y-2">
          <div className="relative h-3 bg-muted rounded-full overflow-hidden">
            <div
              className="absolute inset-y-0 bg-gradient-to-r from-green-200 via-green-400 to-green-200 rounded-full"
              style={{ left: "0%", right: "0%" }}
            />
            <div
              className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-green-600 rounded-full border-2 border-white shadow"
              style={{ left: `${midPosition}%`, transform: `translateX(-50%) translateY(-50%)` }}
            />
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{formatCurrency(equityLow)}</span>
            <span>{formatCurrency(equityHigh)}</span>
          </div>
        </div>

        {formattedDate && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Calendar className="h-3 w-3" />
            <span>Updated {formattedDate}</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
