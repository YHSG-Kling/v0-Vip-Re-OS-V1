"use client"

// ============================================================
// PANEL B – Competitor Watch
// AI Market Intelligence based on typical market patterns.
// NOT scraping live competitor data — clearly labeled.
// ============================================================

import { useState } from "react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Loader2, Eye, Target, Lightbulb, MapPin, Info, BarChart2, TrendingUp } from "lucide-react"
import { analyzeCompetitorLandscape } from "./ad-os-actions"
import { competitiveIntelligence } from "@/app/actions/ai-predictions"

interface Listing {
  id: string
  address: string
  city: string
  zip?: string
  list_price?: number
}

interface Props {
  listings: Listing[]
  agentId: string
}

interface AnalysisResult {
  competitorAngles: string[]
  differentiators: string[]
  recommendedAngle: string
}

export function CompetitorWatchPanel({ listings, agentId }: Props) {
  const [marketArea, setMarketArea] = useState(
    listings[0]?.city ?? ""
  )
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [result, setResult] = useState<AnalysisResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Live competitive intelligence via competitiveIntelligence()
  const [liveIntelLoading, setLiveIntelLoading] = useState(false)
  const [liveIntelResult, setLiveIntelResult] = useState<any>(null)
  const [liveIntelError, setLiveIntelError] = useState<string | null>(null)

  async function handleAnalyze() {
    if (!marketArea.trim()) return
    setIsAnalyzing(true)
    setResult(null)
    setError(null)

    try {
      const res = await analyzeCompetitorLandscape(marketArea.trim())
      if (!res.success) {
        setError(res.error ?? "Analysis failed")
      } else {
        setResult({
          competitorAngles: res.competitorAngles ?? [],
          differentiators: res.differentiators ?? [],
          recommendedAngle: res.recommendedAngle ?? "",
        })
      }
    } catch {
      setError("Unexpected error — please try again")
    } finally {
      setIsAnalyzing(false)
    }
  }

  return (
    <Card className="border-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Eye className="h-5 w-5 text-violet-600" />
          Competitor Watch
        </CardTitle>
        <CardDescription>
          AI market intelligence to sharpen your positioning.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Disclaimer */}
        <div className="flex items-start gap-2 rounded-md bg-blue-50 border border-blue-200 p-2.5">
          <Info className="h-4 w-4 text-blue-600 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-blue-700 leading-relaxed">
            AI Market Intelligence — based on typical market patterns and general real estate
            advertising knowledge, not live competitor data.
          </p>
        </div>

        {/* Market area input */}
        <div className="space-y-1.5">
          <Label className="text-xs font-medium flex items-center gap-1.5">
            <MapPin className="h-3.5 w-3.5" />
            Market Area
          </Label>
          <div className="flex gap-2">
            <Input
              placeholder="e.g. Austin TX, Brentwood Nashville, Downtown Miami"
              value={marketArea}
              onChange={(e) => setMarketArea(e.target.value)}
              className="h-8 text-sm flex-1"
              onKeyDown={(e) => e.key === "Enter" && handleAnalyze()}
            />
            <Button
              onClick={handleAnalyze}
              disabled={isAnalyzing || !marketArea.trim()}
              className="bg-violet-600 hover:bg-violet-700 h-8 px-3 text-sm"
            >
              {isAnalyzing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Analyze"
              )}
            </Button>
          </div>
          {/* Quick-pick cities from active listings */}
          {listings.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-1">
              {Array.from(new Set(listings.map((l) => l.city)))
                .slice(0, 4)
                .map((city) => (
                  <button
                    key={city}
                    onClick={() => setMarketArea(city)}
                    className="text-xs px-2 py-0.5 rounded-full border border-muted-foreground/30 hover:border-violet-400 hover:text-violet-700 transition-colors"
                  >
                    {city}
                  </button>
                ))}
            </div>
          )}
        </div>

        {/* Live Competitive Intelligence */}
        <div className="border-t pt-3 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <BarChart2 className="h-3.5 w-3.5" />
            Live Competitive Data
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              if (!marketArea.trim()) return
              setLiveIntelLoading(true)
              setLiveIntelResult(null)
              setLiveIntelError(null)
              try {
                const res = await competitiveIntelligence({
                  agentId,
                  marketArea: marketArea.trim(),
                })
                if ((res as any).success === false) {
                  setLiveIntelError((res as any).error ?? "Competitive intelligence failed")
                } else {
                  setLiveIntelResult(res)
                }
              } catch {
                setLiveIntelError("Unexpected error — please try again")
              } finally {
                setLiveIntelLoading(false)
              }
            }}
            disabled={liveIntelLoading || !marketArea.trim()}
            className="w-full justify-start gap-2 h-8 text-xs"
          >
            {liveIntelLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <TrendingUp className="h-3.5 w-3.5" />
            )}
            Pull Live Competitive Data
          </Button>

          {liveIntelError && (
            <p className="text-xs text-red-600 bg-red-50 rounded-md p-2">{liveIntelError}</p>
          )}

          {liveIntelResult && (
            <div className="space-y-3 rounded-md border border-border bg-muted/20 p-3">
              {liveIntelResult.activeListings != null && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-xs text-muted-foreground">Active listings in area</span>
                  <span className="font-semibold">{liveIntelResult.activeListings}</span>
                </div>
              )}
              {liveIntelResult.medianListPrice != null && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-xs text-muted-foreground">Median list price</span>
                  <span className="font-semibold">${Number(liveIntelResult.medianListPrice).toLocaleString()}</span>
                </div>
              )}
              {liveIntelResult.averageDaysOnMarket != null && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-xs text-muted-foreground">Avg. days on market</span>
                  <span className="font-semibold">{liveIntelResult.averageDaysOnMarket}d</span>
                </div>
              )}
              {liveIntelResult.marketPositioning && (
                <div className="pt-1 border-t border-border">
                  <p className="text-xs font-medium mb-1">Market Positioning</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">{liveIntelResult.marketPositioning}</p>
                </div>
              )}
              {liveIntelResult.aiAnalysis && (
                <div className="rounded-md bg-violet-50 border border-violet-100 p-2.5">
                  <p className="text-xs font-semibold text-violet-800 mb-1">AI Analysis</p>
                  <p className="text-xs text-violet-700 leading-relaxed">{liveIntelResult.aiAnalysis}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {error && (
          <p className="text-sm text-red-600 bg-red-50 rounded-md p-2">{error}</p>
        )}

        {/* Results */}
        {result && (
          <div className="space-y-4 border-t pt-4">
            {/* Competitor angles */}
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <Target className="h-3.5 w-3.5" />
                Likely competitor angles
              </p>
              <div className="space-y-1.5">
                {result.competitorAngles.map((angle, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 rounded-md bg-muted/40 p-2.5"
                  >
                    <Badge
                      variant="outline"
                      className="text-xs flex-shrink-0 mt-0.5 w-5 h-5 flex items-center justify-center p-0 rounded-full"
                    >
                      {i + 1}
                    </Badge>
                    <p className="text-sm leading-relaxed">{angle}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Differentiators */}
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                <Lightbulb className="h-3.5 w-3.5" />
                How to stand out
              </p>
              <div className="space-y-1.5">
                {result.differentiators.map((diff, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 rounded-md bg-violet-50 border border-violet-100 p-2.5"
                  >
                    <Badge className="bg-violet-100 text-violet-800 text-xs flex-shrink-0 mt-0.5 w-5 h-5 flex items-center justify-center p-0 rounded-full border-0">
                      {i + 1}
                    </Badge>
                    <p className="text-sm leading-relaxed">{diff}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Recommended campaign angle */}
            {result.recommendedAngle && (
              <div className="rounded-md bg-green-50 border border-green-200 p-3 space-y-1">
                <p className="text-xs font-semibold text-green-800 uppercase tracking-wider">
                  Recommended Campaign Angle for This Market
                </p>
                <p className="text-sm text-green-900 leading-relaxed">
                  {result.recommendedAngle}
                </p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
