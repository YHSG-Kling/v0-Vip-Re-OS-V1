import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { DollarSign, TrendingUp, TrendingDown, Minus, Calendar } from "lucide-react"
import { computeHomeWealthStory, type HomeValuePoint } from "@/lib/portal/home-wealth"

interface EquityEstimateCardProps {
  estimatedValueMid?: number | null
  estimatedValueLow?: number | null
  estimatedValueHigh?: number | null
  purchasePrice: number
  marketTrend?: string | null
  generatedAt?: string | null
  /** Close/purchase date — anchors the wealth story & annualized appreciation. */
  closeDate?: string | null
  /** Value series oldest → newest for the living curve. */
  valueSeries?: HomeValuePoint[]
}

export function EquityEstimateCard({
  estimatedValueMid,
  estimatedValueLow,
  estimatedValueHigh,
  purchasePrice,
  marketTrend,
  generatedAt,
  closeDate,
  valueSeries,
}: EquityEstimateCardProps) {
  const story = computeHomeWealthStory({
    purchasePrice,
    closeDate,
    estimatedValueMid,
    estimatedValueLow,
    estimatedValueHigh,
    latestGeneratedAt: generatedAt,
    series: valueSeries,
  })

  if (!story.hasEstimate) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <DollarSign className="h-5 w-5 text-green-600" />
            <CardTitle className="text-lg">Your Home Wealth</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <div className="p-4 rounded-lg bg-muted/50 text-center">
            <p className="text-muted-foreground">
              Your home wealth story will appear here once a value estimate is available
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

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

  // Equity range bar position (0-100%)
  const range = story.equityHigh - story.equityLow
  const midPosition = range > 0 ? ((story.estimatedEquity - story.equityLow) / range) * 100 : 50

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

  // Living curve — dependency-free SVG polyline from the normalized story.curve.
  const W = 100
  const H = 36
  const pad = 2
  const curve = story.curve
  const stepX = curve.length > 1 ? (W - pad * 2) / (curve.length - 1) : 0
  const points = curve.map((p, i) => {
    const x = pad + i * stepX
    // y is 0 (low) .. 1 (high); SVG y grows downward so invert.
    const y = pad + (1 - p.y) * (H - pad * 2)
    return { ...p, x, y }
  })
  const polyline = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")
  const areaPath =
    points.length > 1
      ? `M ${points[0].x.toFixed(1)},${(H - pad).toFixed(1)} ` +
        points.map((p) => `L ${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ") +
        ` L ${points[points.length - 1].x.toFixed(1)},${(H - pad).toFixed(1)} Z`
      : ""
  const lastPoint = points[points.length - 1]

  const gainColor = story.isGain ? "text-green-600" : "text-red-600"
  const gainSign = story.isGain ? "+" : ""

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <DollarSign className="h-5 w-5 text-green-600" />
            <CardTitle className="text-lg">Your Home Wealth</CardTitle>
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
        {/* Headline gain — "you've gained $X since you bought" */}
        <div className="text-center">
          <p className="text-sm text-muted-foreground">
            {story.isGain ? "Estimated gain since you bought" : "Estimated change since you bought"}
          </p>
          <p className={`text-3xl font-bold ${gainColor}`}>
            {gainSign}
            {formatCurrency(story.gainAbsolute)}
          </p>
          {story.purchasePrice > 0 && (
            <p className={`text-sm font-medium ${gainColor}`}>
              {gainSign}
              {story.gainPercent.toFixed(1)}%
              {story.yearsHeld && story.yearsHeld >= 1 ? (
                <span className="text-muted-foreground font-normal">
                  {" "}
                  over {story.yearsHeld} {story.yearsHeld === 1 ? "year" : "years"}
                  {story.annualizedPercent !== null
                    ? ` · ${story.annualizedPercent >= 0 ? "+" : ""}${story.annualizedPercent.toFixed(1)}%/yr`
                    : ""}
                </span>
              ) : null}
            </p>
          )}
        </div>

        {/* Living curve — purchase price → today */}
        {points.length > 1 && (
          <div className="space-y-1">
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-9" preserveAspectRatio="none">
              <defs>
                <linearGradient id="wealthFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="rgb(34,197,94)" stopOpacity="0.25" />
                  <stop offset="100%" stopColor="rgb(34,197,94)" stopOpacity="0" />
                </linearGradient>
              </defs>
              {areaPath && <path d={areaPath} fill="url(#wealthFill)" />}
              <polyline
                points={polyline}
                fill="none"
                stroke="rgb(22,163,74)"
                strokeWidth="1.5"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
              {lastPoint && (
                <circle cx={lastPoint.x} cy={lastPoint.y} r="2" fill="rgb(22,163,74)" />
              )}
            </svg>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Bought {formatCurrency(story.purchasePrice)}</span>
              <span>Now ~{formatCurrency(story.currentValue)}</span>
            </div>
          </div>
        )}

        {/* Equity range bar (low → high estimate confidence) */}
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">Estimated value range</p>
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
            <span>{formatCurrency(story.equityLow + story.purchasePrice)}</span>
            <span>{formatCurrency(story.equityHigh + story.purchasePrice)}</span>
          </div>
        </div>

        {formattedDate && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Calendar className="h-3 w-3" />
            <span>Updated {formattedDate} · estimate, not an appraisal</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
