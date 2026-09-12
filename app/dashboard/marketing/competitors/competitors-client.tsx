"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import {
  Users,
  TrendingUp,
  BarChart2,
  Target,
  Plus,
  Loader2,
  MapPin,
  ExternalLink,
} from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import {
  addCompetitor,
  getCompetitorContent,
} from "@/app/actions/content-studio"
import { analyzeCompetitorLandscape } from "@/app/dashboard/marketing/studio/components/ad-os/ad-os-actions"
import { competitiveIntelligence } from "@/app/actions/ai-predictions"

interface Competitor {
  id: string
  competitor_name: string
  competitor_url: string | null
  created_at: string
}

interface Props {
  initialCompetitors: Competitor[]
  agentId: string
  defaultMarketArea: string
}

export function CompetitorsClient({ initialCompetitors, agentId, defaultMarketArea }: Props) {
  const { toast } = useToast()
  const [competitors, setCompetitors] = useState<Competitor[]>(initialCompetitors)
  const [newName, setNewName] = useState("")
  const [newUrl, setNewUrl] = useState("")
  const [adding, setAdding] = useState(false)

  const [marketArea, setMarketArea] = useState(defaultMarketArea)
  const [loadingContent, setLoadingContent] = useState(false)
  const [loadingIntel, setLoadingIntel] = useState(false)
  const [loadingLandscape, setLoadingLandscape] = useState(false)

  const [competitorContent, setCompetitorContent] = useState<any[]>([])
  const [marketIntel, setMarketIntel] = useState<any>(null)
  const [landscape, setLandscape] = useState<any>(null)

  async function handleAdd() {
    if (!newName.trim()) return
    setAdding(true)
    try {
      const result = await addCompetitor(newName.trim(), newUrl.trim() || undefined)
      if (result && !("error" in result)) {
        setCompetitors((prev) => [result as Competitor, ...prev])
        setNewName("")
        setNewUrl("")
        toast({ title: "Competitor added", description: `${newName} is now being tracked.` })
      } else {
        toast({ title: "Error", description: (result as any)?.error ?? "Could not add competitor", variant: "destructive" })
      }
    } finally {
      setAdding(false)
    }
  }

  async function handleLoadContent() {
    setLoadingContent(true)
    try {
      const data = await getCompetitorContent()
      setCompetitorContent(data ?? [])
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" })
    } finally {
      setLoadingContent(false)
    }
  }

  async function handleMarketIntel() {
    if (!marketArea.trim()) {
      toast({ title: "Market area required", description: "Enter a city or region to analyze.", variant: "destructive" })
      return
    }
    setLoadingIntel(true)
    try {
      const result = await competitiveIntelligence({ agentId, marketArea })
      setMarketIntel(result)
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" })
    } finally {
      setLoadingIntel(false)
    }
  }

  async function handleLandscape() {
    if (!marketArea.trim()) {
      toast({ title: "Market area required", description: "Enter a city or region to analyze.", variant: "destructive" })
      return
    }
    setLoadingLandscape(true)
    try {
      const result = await analyzeCompetitorLandscape(marketArea)
      if (result.success) setLandscape(result)
      else toast({ title: "Analysis failed", description: result.error, variant: "destructive" })
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" })
    } finally {
      setLoadingLandscape(false)
    }
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Competitor Intelligence</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Track competitors, analyze their content strategy, and surface opportunities to differentiate.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ── Panel 1: Tracked Competitors ─────────────────────────────── */}
        <Card className="lg:col-span-1">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Users className="h-4 w-4" />
              Tracked Competitors
            </CardTitle>
            <CardDescription className="text-xs">
              Add competitors to improve keyword and content analysis.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2">
              <Input
                placeholder="Competitor name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="h-8 text-xs"
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              />
              <Input
                placeholder="Website (optional)"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                className="h-8 text-xs"
              />
              <Button size="sm" className="w-full gap-1.5" onClick={handleAdd} disabled={adding || !newName.trim()}>
                {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                Add Competitor
              </Button>
            </div>

            <Separator />

            <div className="space-y-2 max-h-64 overflow-y-auto">
              {competitors.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-4">No competitors tracked yet.</p>
              )}
              {competitors.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-2 py-1">
                  <div className="min-w-0">
                    <p className="text-xs font-medium truncate">{c.competitor_name}</p>
                    {c.competitor_url && (
                      <a
                        href={c.competitor_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-muted-foreground flex items-center gap-1 hover:underline"
                      >
                        <ExternalLink className="h-3 w-3" />
                        {new URL(c.competitor_url.startsWith("http") ? c.competitor_url : `https://${c.competitor_url}`).hostname}
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* ── Right column ─────────────────────────────────────────────── */}
        <div className="lg:col-span-2 space-y-4">
          {/* Market area input shared by panels 3 & 4 */}
          <div className="flex gap-2 items-center">
            <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
            <Input
              placeholder="Market area (e.g. Austin, TX)"
              value={marketArea}
              onChange={(e) => setMarketArea(e.target.value)}
              className="h-8 text-xs"
            />
          </div>

          {/* ── Panel 2: Competitor Content Intel ──────────────────────── */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <TrendingUp className="h-4 w-4" />
                Competitor Content Intelligence
              </CardTitle>
              <CardDescription className="text-xs">
                AI analysis of what your tracked competitors are likely posting and why it performs.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                size="sm"
                variant="outline"
                onClick={handleLoadContent}
                disabled={loadingContent}
                className="mb-3"
              >
                {loadingContent ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
                Analyze Competitor Content
              </Button>

              {competitorContent.length > 0 && (
                <div className="space-y-3">
                  {competitorContent.map((item: any, i: number) => (
                    <div key={i} className="border rounded-lg p-3 space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-medium">{item.competitor_name}</p>
                        <Badge variant="outline" className="text-xs">{item.content_type}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">{item.content_summary}</p>
                      <div className="flex gap-4 text-xs text-muted-foreground">
                        <span>Open rate: <strong>{item.openRate}%</strong></span>
                        <span>Click rate: <strong>{item.clickRate}%</strong></span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Panel 3: Market Intelligence (IDXBroker) ───────────────── */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <BarChart2 className="h-4 w-4" />
                Market Intelligence
              </CardTitle>
              <CardDescription className="text-xs">
                Live listing data from your market — active inventory, pricing, and days on market.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                size="sm"
                variant="outline"
                onClick={handleMarketIntel}
                disabled={loadingIntel}
                className="mb-3"
              >
                {loadingIntel ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
                Pull Live Market Data
              </Button>

              {marketIntel && (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                  {marketIntel.activeListings != null && (
                    <div className="border rounded-lg p-2.5">
                      <p className="text-muted-foreground">Active Listings</p>
                      <p className="font-semibold text-base">{marketIntel.activeListings}</p>
                    </div>
                  )}
                  {marketIntel.medianListPrice != null && (
                    <div className="border rounded-lg p-2.5">
                      <p className="text-muted-foreground">Median List Price</p>
                      <p className="font-semibold text-base">${marketIntel.medianListPrice?.toLocaleString()}</p>
                    </div>
                  )}
                  {marketIntel.averageDaysOnMarket != null && (
                    <div className="border rounded-lg p-2.5">
                      <p className="text-muted-foreground">Avg Days on Market</p>
                      <p className="font-semibold text-base">{marketIntel.averageDaysOnMarket}</p>
                    </div>
                  )}
                  {marketIntel.aiAnalysis && (
                    <div className="col-span-full border rounded-lg p-2.5">
                      <p className="text-muted-foreground mb-1">AI Analysis</p>
                      <p className="text-xs">{marketIntel.aiAnalysis}</p>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── Panel 4: Landscape Analysis ────────────────────────────── */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Target className="h-4 w-4" />
                Competitive Landscape Analysis
              </CardTitle>
              <CardDescription className="text-xs">
                AI-powered analysis of competitor advertising angles and recommended campaign strategy.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                size="sm"
                variant="outline"
                onClick={handleLandscape}
                disabled={loadingLandscape}
                className="mb-3"
              >
                {loadingLandscape ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
                Analyze Landscape
              </Button>

              {landscape && (
                <div className="space-y-3 text-xs">
                  {landscape.competitorAngles?.length > 0 && (
                    <div>
                      <p className="font-medium mb-1 text-muted-foreground">Common Competitor Angles</p>
                      <ul className="space-y-1">
                        {landscape.competitorAngles.map((angle: string, i: number) => (
                          <li key={i} className="flex items-start gap-1.5">
                            <span className="text-muted-foreground mt-0.5">•</span>
                            <span>{angle}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {landscape.differentiators?.length > 0 && (
                    <div>
                      <p className="font-medium mb-1 text-muted-foreground">Ways to Differentiate</p>
                      <ul className="space-y-1">
                        {landscape.differentiators.map((d: string, i: number) => (
                          <li key={i} className="flex items-start gap-1.5">
                            <span className="text-green-600 mt-0.5">✓</span>
                            <span>{d}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {landscape.recommendedAngle && (
                    <div className="border-l-2 border-primary pl-3">
                      <p className="font-medium text-muted-foreground mb-0.5">Recommended Campaign Angle</p>
                      <p>{landscape.recommendedAngle}</p>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
