"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Eye,
  TrendingUp,
  TrendingDown,
  Minus,
  Home,
  DollarSign,
  Calendar,
  Lightbulb,
  Loader2,
  RefreshCw,
} from "lucide-react"
import { generateMarketReport } from "@/app/actions/ai-market-intelligence"
import { createClient } from "@/lib/supabase/client"

interface CompetitorListing {
  id: string
  address: string
  city: string
  list_price: number
  days_on_market: number
  status: string
  bedrooms?: number
  bathrooms?: number
  sqft?: number
}

interface CompetitorWatchPanelProps {
  listings: Array<{ id: string; address: string; city: string; zip?: string; list_price?: number }>
  agentId: string
}

export function CompetitorWatchPanel({ listings, agentId }: CompetitorWatchPanelProps) {
  const [selectedListingId, setSelectedListingId] = useState<string>("")
  const [competitors, setCompetitors] = useState<CompetitorListing[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [marketInsights, setMarketInsights] = useState<{
    avgPrice: number
    avgDom: number
    priceReductionRate: number
    differentiation: string[]
  } | null>(null)

  const selectedListing = listings.find((l) => l.id === selectedListingId)

  async function loadCompetitors() {
    if (!selectedListing) return

    setIsLoading(true)
    try {
      const supabase = createClient()

      // Get nearby competing listings (same city, similar price range)
      const priceMin = (selectedListing.list_price || 0) * 0.8
      const priceMax = (selectedListing.list_price || 0) * 1.2

      const { data: competingListings } = await supabase
        .from("listings")
        .select("id, address, city, list_price, days_on_market, status, bedrooms, bathrooms, sqft")
        .eq("city", selectedListing.city)
        .eq("status", "active")
        .neq("id", selectedListingId)
        .gte("list_price", priceMin)
        .lte("list_price", priceMax)
        .order("list_price", { ascending: true })
        .limit(10)

      setCompetitors(competingListings || [])

      // Calculate market insights
      if (competingListings && competingListings.length > 0) {
        const avgPrice = competingListings.reduce((sum, l) => sum + (l.list_price || 0), 0) / competingListings.length
        const avgDom = competingListings.reduce((sum, l) => sum + (l.days_on_market || 0), 0) / competingListings.length

        // Generate differentiation suggestions based on real data
        const differentiation: string[] = []
        
        if ((selectedListing.list_price || 0) < avgPrice) {
          differentiation.push("Price positioning: Below market average - emphasize value")
        } else if ((selectedListing.list_price || 0) > avgPrice) {
          differentiation.push("Price positioning: Premium - highlight unique features")
        }

        const lowDomListings = competingListings.filter((l) => (l.days_on_market || 0) < 14)
        if (lowDomListings.length > competingListings.length / 2) {
          differentiation.push("Fast-moving market - emphasize urgency in messaging")
        }

        if (differentiation.length === 0) {
          differentiation.push("Balanced market - focus on property-specific advantages")
        }

        setMarketInsights({
          avgPrice,
          avgDom,
          priceReductionRate: 0, // Would need price history data
          differentiation,
        })
      }
    } catch (error) {
      console.error("Failed to load competitors:", error)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    if (selectedListingId) {
      loadCompetitors()
    }
  }, [selectedListingId])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Eye className="h-5 w-5 text-violet-600" />
          Competitor Watch
        </CardTitle>
        <CardDescription>
          Monitor nearby competing listings and positioning strategies
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Listing Selector */}
        <div className="flex gap-2">
          <Select value={selectedListingId} onValueChange={setSelectedListingId}>
            <SelectTrigger className="flex-1">
              <SelectValue placeholder="Select a listing to analyze" />
            </SelectTrigger>
            <SelectContent>
              {listings.map((listing) => (
                <SelectItem key={listing.id} value={listing.id}>
                  {listing.address}, {listing.city}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="icon"
            onClick={loadCompetitors}
            disabled={!selectedListingId || isLoading}
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
          </Button>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-violet-600" />
            <span className="ml-2 text-muted-foreground">Analyzing market...</span>
          </div>
        )}

        {!isLoading && selectedListingId && (
          <>
            {/* Market Insights */}
            {marketInsights && (
              <div className="grid grid-cols-3 gap-3">
                <div className="p-3 rounded-lg bg-muted/50">
                  <p className="text-xs text-muted-foreground">Avg Competitor Price</p>
                  <p className="text-lg font-semibold">${marketInsights.avgPrice.toLocaleString()}</p>
                </div>
                <div className="p-3 rounded-lg bg-muted/50">
                  <p className="text-xs text-muted-foreground">Avg Days on Market</p>
                  <p className="text-lg font-semibold">{Math.round(marketInsights.avgDom)} days</p>
                </div>
                <div className="p-3 rounded-lg bg-muted/50">
                  <p className="text-xs text-muted-foreground">Competitors Found</p>
                  <p className="text-lg font-semibold">{competitors.length}</p>
                </div>
              </div>
            )}

            {/* Differentiation Suggestions */}
            {marketInsights?.differentiation && marketInsights.differentiation.length > 0 && (
              <div className="p-3 rounded-lg bg-violet-50 dark:bg-violet-950/30 border border-violet-200 dark:border-violet-800">
                <div className="flex items-center gap-2 mb-2">
                  <Lightbulb className="h-4 w-4 text-violet-600" />
                  <p className="font-medium text-sm text-violet-700 dark:text-violet-300">
                    Differentiation Strategy
                  </p>
                </div>
                <ul className="space-y-1">
                  {marketInsights.differentiation.map((tip, i) => (
                    <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                      <span className="text-violet-600">•</span>
                      {tip}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Competitor List */}
            <ScrollArea className="h-[250px]">
              {competitors.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">
                  No competing listings found in this price range
                </p>
              ) : (
                <div className="space-y-2">
                  {competitors.map((comp) => (
                    <div
                      key={comp.id}
                      className="p-3 rounded-lg border bg-card hover:bg-muted/30 transition-colors"
                    >
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="font-medium text-sm">{comp.address}</p>
                          <p className="text-xs text-muted-foreground">{comp.city}</p>
                        </div>
                        <Badge
                          variant={comp.status === "active" ? "default" : "secondary"}
                          className="capitalize"
                        >
                          {comp.status}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <DollarSign className="h-3 w-3" />
                          ${comp.list_price?.toLocaleString()}
                        </span>
                        <span className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {comp.days_on_market || 0} DOM
                        </span>
                        {comp.bedrooms && (
                          <span>
                            {comp.bedrooms}bd / {comp.bathrooms}ba
                          </span>
                        )}
                        {comp.sqft && <span>{comp.sqft.toLocaleString()} sqft</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </>
        )}

        {!selectedListingId && (
          <div className="text-center py-8 text-muted-foreground">
            <Eye className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>Select a listing to see competitor analysis</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
