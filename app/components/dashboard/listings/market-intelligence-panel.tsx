"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Loader2, TrendingUp, TrendingDown, Zap, BarChart3 } from "lucide-react"
import { predictMarketShift, findMarketArbitrage } from "@/app/actions/ai-predictions"

interface MarketIntelligencePanelProps {
  city: string
  state: string
  agentId: string
}

export function MarketIntelligencePanel({ city, state, agentId }: MarketIntelligencePanelProps) {
  const [shiftData, setShiftData] = useState<any>(null)
  const [arbitrageData, setArbitrageData] = useState<any>(null)
  const [loadingShift, setLoadingShift] = useState(false)
  const [loadingArbitrage, setLoadingArbitrage] = useState(false)

  const runMarketShift = async () => {
    setLoadingShift(true)
    try {
      const result = await predictMarketShift({ city, state })
      setShiftData(result && !(result as any).error ? result : null)
    } catch {
      setShiftData(null)
    } finally {
      setLoadingShift(false)
    }
  }

  const runArbitrage = async () => {
    setLoadingArbitrage(true)
    try {
      const result = await findMarketArbitrage({ city, state, agentId })
      setArbitrageData(result && !(result as any).error ? result : null)
    } catch {
      setArbitrageData(null)
    } finally {
      setLoadingArbitrage(false)
    }
  }

  const shiftDirection = shiftData?.trend_direction ?? shiftData?.shift_direction
  const isShiftUp = shiftDirection === "up" || shiftDirection === "increasing"

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-indigo-500" />
          Market Intelligence
          <Badge variant="secondary" className="ml-auto text-xs">
            {city}, {state}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Action buttons */}
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            className="text-xs gap-1.5"
            onClick={runMarketShift}
            disabled={loadingShift}
          >
            {loadingShift ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <TrendingUp className="h-3.5 w-3.5" />
            )}
            Predict Market Shift
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-xs gap-1.5"
            onClick={runArbitrage}
            disabled={loadingArbitrage}
          >
            {loadingArbitrage ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Zap className="h-3.5 w-3.5" />
            )}
            Find Arbitrage
          </Button>
        </div>

        {/* Market Shift Results */}
        {shiftData && (
          <div className="rounded-md border border-border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium">Market Shift Prediction</p>
              <div className={`flex items-center gap-1 text-xs font-medium ${isShiftUp ? "text-green-600" : "text-red-600"}`}>
                {isShiftUp ? (
                  <TrendingUp className="h-3.5 w-3.5" />
                ) : (
                  <TrendingDown className="h-3.5 w-3.5" />
                )}
                {shiftDirection ?? "Neutral"}
              </div>
            </div>
            {shiftData.confidence_score != null && (
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Confidence</span>
                  <span>{Math.round((shiftData.confidence_score ?? 0) * 100)}%</span>
                </div>
                <Progress value={Math.round((shiftData.confidence_score ?? 0) * 100)} className="h-1.5" />
              </div>
            )}
            {shiftData.summary && (
              <p className="text-xs text-muted-foreground">{shiftData.summary}</p>
            )}
            {shiftData.key_signals?.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-0.5">
                {shiftData.key_signals.slice(0, 3).map((s: string, i: number) => (
                  <Badge key={i} variant="secondary" className="text-xs">{s}</Badge>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Arbitrage Results */}
        {arbitrageData && (
          <div className="rounded-md border border-border p-3 space-y-2">
            <p className="text-xs font-medium">Arbitrage Opportunities</p>
            {arbitrageData.opportunities?.length > 0 ? (
              <div className="space-y-1.5">
                {arbitrageData.opportunities.slice(0, 3).map((opp: any, i: number) => (
                  <div key={i} className="flex items-start gap-2 text-xs">
                    <Zap className="h-3 w-3 text-amber-500 mt-0.5 shrink-0" />
                    <span className="text-muted-foreground">{opp.description ?? opp.opportunity ?? JSON.stringify(opp)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No significant arbitrage opportunities detected in this market.</p>
            )}
            {arbitrageData.avg_below_market_pct != null && (
              <div className="flex items-center gap-1.5 text-xs text-green-700 bg-green-50 rounded px-2 py-1 border border-green-100">
                <TrendingDown className="h-3 w-3 shrink-0" />
                Avg {arbitrageData.avg_below_market_pct}% below market value in identified properties
              </div>
            )}
          </div>
        )}

        {/* Empty state */}
        {!shiftData && !arbitrageData && !loadingShift && !loadingArbitrage && (
          <p className="text-xs text-muted-foreground">
            Run predictions to surface market shift signals and underpriced property opportunities in {city}.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
