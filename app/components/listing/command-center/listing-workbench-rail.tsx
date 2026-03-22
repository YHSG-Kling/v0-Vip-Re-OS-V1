"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Presentation,
  FileText,
  Video,
  Megaphone,
  MessageSquare,
  DollarSign,
  Calendar,
  ExternalLink,
  Loader2,
  Wrench,
  Users,
  Sparkles,
  RefreshCw,
  AlertCircle,
  Calculator,
  CheckCircle2,
  FileBarChart,
  Copy,
  TrendingDown,
} from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { generateListingPresentation, generateBrochureContent, generateSellerNetSheet } from "@/app/actions/ai-listing-presentation"
import { matchBuyersForListing } from "@/app/actions/property-buyer-matching"
import { generateAICMA } from "@/app/actions/ai-predictions"
import { getAIPriceAdjustmentRecommendation } from "@/app/actions/ai-cma"
import { useToast } from "@/hooks/use-toast"

interface WorkbenchRailProps {
  listingId: string
  agentId: string
  sellerId?: string
  listing: {
    address: string
    city: string
    state: string
    zip?: string
    bedrooms?: number
    bathrooms?: number
    square_footage?: number
    property_type?: string
    list_price?: number
    price?: number
    days_on_market?: number
    showing_count?: number
  }
}

interface BuyerMatch {
  contact_id: string
  buyer_name: string
  score: number
  match_confidence: string
  match_factors: string[]
  caution_notes: string[]
}

export function ListingWorkbenchRail({ listingId, agentId, sellerId, listing }: WorkbenchRailProps) {
  const [presentationLoading, setPresentationLoading] = useState(false)
  const [brochureLoading, setBrochureLoading] = useState(false)
  const [presentationGenerated, setPresentationGenerated] = useState(false)
  const [brochureGenerated, setBrochureGenerated] = useState(false)
  const [buyerMatches, setBuyerMatches] = useState<BuyerMatch[]>([])
  const [buyerMatchTotal, setBuyerMatchTotal] = useState<number | null>(null)
  const [matchPending, startMatchTransition] = useTransition()
  const { toast } = useToast()
  // Seller net sheet
  const [netSheetOpen, setNetSheetOpen] = useState(false)
  const [netSheetLoading, setNetSheetLoading] = useState(false)
  const [netSheetResult, setNetSheetResult] = useState<any>(null)
  const defaultPrice = listing.list_price ?? listing.price ?? 0
  const [netSalePrice, setNetSalePrice] = useState(defaultPrice > 0 ? String(defaultPrice) : "")
  const [netMortgagePayoff, setNetMortgagePayoff] = useState("")
  const [netCommissionRate, setNetCommissionRate] = useState("3")

  // AI CMA state
  const [cmaOpen, setCmaOpen] = useState(false)
  const [cmaLoading, setCmaLoading] = useState(false)
  const [cmaResult, setCmaResult] = useState<any>(null)
  const [cmaPurpose, setCmaPurpose] = useState<"listing" | "buyer_offer" | "seller_consultation">("listing")

  // AI Price Adjustment Advisor state
  const [advisorLoading, setAdvisorLoading] = useState(false)
  const [advisorResult, setAdvisorResult] = useState<any>(null)
  const daysOnMarket = listing.days_on_market ?? 0

  function handleMatchBuyers() {
    startMatchTransition(async () => {
      const res = await matchBuyersForListing({ listingId, minScore: 50, limit: 10 })
      if (res.success) {
        const matches = (res.matches ?? []) as BuyerMatch[]
        setBuyerMatches(matches)
        setBuyerMatchTotal((res.metadata as any)?.viable_matches ?? matches.length)
        if (matches.length === 0) {
          toast({ title: "No matching buyers found above threshold" })
        }
      } else {
        toast({ title: "Buyer match failed", description: (res as any).error, variant: "destructive" })
      }
    })
  }

  const handleGenerateNetSheet = async () => {
    const salePrice = parseFloat(netSalePrice.replace(/,/g, ""))
    if (!salePrice || isNaN(salePrice) || salePrice <= 0) {
      toast({ title: "Enter a valid sale price", variant: "destructive" })
      return
    }
    setNetSheetLoading(true)
    try {
      const res = await generateSellerNetSheet({
        agentId,
        salePrice,
        state: listing.state,
        mortgagePayoff: netMortgagePayoff ? parseFloat(netMortgagePayoff.replace(/,/g, "")) : undefined,
        commissionRate: netCommissionRate ? parseFloat(netCommissionRate) : undefined,
      })
      if (res.success) {
        setNetSheetResult(res)
        toast({ title: "Net sheet calculated" })
      } else {
        toast({ title: (res as any).error ?? "Net sheet failed", variant: "destructive" })
      }
    } catch (err) {
      toast({ title: "Net sheet calculation failed", variant: "destructive" })
    } finally {
      setNetSheetLoading(false)
    }
  }

  const handleGeneratePresentation = async () => {
    setPresentationLoading(true)
    try {
      await generateListingPresentation({
        agentId,
        propertyData: {
          address: listing.address,
          city: listing.city,
          state: listing.state,
          zipCode: listing.zip || "",
          bedrooms: listing.bedrooms || 0,
          bathrooms: listing.bathrooms || 0,
          sqft: listing.square_footage || 0,
          propertyType: listing.property_type || "Single Family",
        },
        presentationType: "full",
      })
      setPresentationGenerated(true)
    } catch (error) {
      console.error("Failed to generate presentation:", error)
    } finally {
      setPresentationLoading(false)
    }
  }

  const handleGenerateBrochure = async () => {
    setBrochureLoading(true)
    try {
      await generateBrochureContent({
        agentId,
        listingId,
        brochureType: "standard",
      })
      setBrochureGenerated(true)
    } catch (error) {
      console.error("Failed to generate brochure:", error)
    } finally {
      setBrochureLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Wrench className="h-4 w-4 text-slate-600" />
          Workbench
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <Button
            size="sm"
            variant="outline"
            className="text-xs gap-1.5 justify-start"
            onClick={handleGeneratePresentation}
            disabled={presentationLoading}
          >
            {presentationLoading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Presentation className="h-3 w-3" />
            )}
            {presentationGenerated ? "Presentation Ready" : "Presentation"}
          </Button>

          <Button
            size="sm"
            variant="outline"
            className="text-xs gap-1.5 justify-start"
            onClick={handleGenerateBrochure}
            disabled={brochureLoading}
          >
            {brochureLoading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <FileText className="h-3 w-3" />
            )}
            {brochureGenerated ? "Brochure Ready" : "Brochure"}
          </Button>

          <Link href={`/dashboard/listings/${listingId}/media`}>
            <Button size="sm" variant="outline" className="w-full text-xs gap-1.5 justify-start">
              <Video className="h-3 w-3" />
              Video
            </Button>
          </Link>

          <Link href={`/dashboard/listings/${listingId}/marketing-tier`}>
            <Button size="sm" variant="outline" className="w-full text-xs gap-1.5 justify-start">
              <Megaphone className="h-3 w-3" />
              Marketing
            </Button>
          </Link>

          <Link href={`/dashboard/listings/${listingId}/seller-updates`}>
            <Button size="sm" variant="outline" className="w-full text-xs gap-1.5 justify-start">
              <MessageSquare className="h-3 w-3" />
              Update
            </Button>
          </Link>

          <Link href={`/dashboard/listings/${listingId}/offers`}>
            <Button size="sm" variant="outline" className="w-full text-xs gap-1.5 justify-start">
              <DollarSign className="h-3 w-3" />
              Offers
            </Button>
          </Link>

          <Link href={`/dashboard/listings/${listingId}/open-house`}>
            <Button size="sm" variant="outline" className="w-full text-xs gap-1.5 justify-start">
              <Calendar className="h-3 w-3" />
              Open House
            </Button>
          </Link>

          <Button
            size="sm"
            variant={netSheetResult ? "secondary" : "outline"}
            className="text-xs gap-1.5 justify-start"
            onClick={() => setNetSheetOpen((o) => !o)}
          >
            {netSheetResult ? (
              <CheckCircle2 className="h-3 w-3 text-emerald-500" />
            ) : (
              <Calculator className="h-3 w-3" />
            )}
            Seller Net Sheet
          </Button>

          <Button
            size="sm"
            variant={cmaResult ? "secondary" : "outline"}
            className="text-xs gap-1.5 justify-start"
            onClick={() => setCmaOpen((o) => !o)}
          >
            {cmaResult ? (
              <CheckCircle2 className="h-3 w-3 text-indigo-500" />
            ) : (
              <FileBarChart className="h-3 w-3" />
            )}
            AI CMA
          </Button>

          {cmaResult?.id && daysOnMarket >= 7 && (
            <Button
              size="sm"
              variant={advisorResult ? "secondary" : "outline"}
              className="text-xs gap-1.5 justify-start col-span-2"
              onClick={async () => {
                setAdvisorLoading(true)
                try {
                  const res = await getAIPriceAdjustmentRecommendation(
                    cmaResult.id,
                    listing.list_price ?? listing.price ?? 0,
                    daysOnMarket,
                    listing.showing_count ?? 0,
                  )
                  if (res.success) {
                    setAdvisorResult(res.recommendation)
                    toast({ title: "Price advisor ready" })
                  } else {
                    toast({ title: (res as any).error ?? "Advisor failed", variant: "destructive" })
                  }
                } catch {
                  toast({ title: "Advisor failed", variant: "destructive" })
                } finally {
                  setAdvisorLoading(false)
                }
              }}
              disabled={advisorLoading}
            >
              {advisorLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <TrendingDown className="h-3 w-3" />
              )}
              AI Price Advisor
            </Button>
          )}

          {sellerId && (
            <Link href={`/portal/seller/${sellerId}?listing=${listingId}`} target="_blank">
              <Button size="sm" variant="outline" className="w-full text-xs gap-1.5 justify-start">
                <ExternalLink className="h-3 w-3" />
                Portal View
              </Button>
            </Link>
          )}
        </div>

        {/* Net Sheet inline form */}
        {netSheetOpen && (
          <div className="border-t pt-3 space-y-3">
            <p className="text-xs font-medium text-muted-foreground">Seller Net Sheet</p>
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-3 space-y-1">
                <Label className="text-xs">Sale Price ($)</Label>
                <Input
                  className="h-7 text-xs"
                  placeholder="e.g. 650000"
                  value={netSalePrice}
                  onChange={(e) => setNetSalePrice(e.target.value)}
                />
              </div>
              <div className="col-span-2 space-y-1">
                <Label className="text-xs">Mortgage Payoff ($)</Label>
                <Input
                  className="h-7 text-xs"
                  placeholder="optional"
                  value={netMortgagePayoff}
                  onChange={(e) => setNetMortgagePayoff(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Commission (%)</Label>
                <Input
                  className="h-7 text-xs"
                  placeholder="3"
                  value={netCommissionRate}
                  onChange={(e) => setNetCommissionRate(e.target.value)}
                />
              </div>
            </div>
            <Button
              size="sm"
              className="w-full text-xs gap-1.5"
              onClick={handleGenerateNetSheet}
              disabled={netSheetLoading}
            >
              {netSheetLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Calculator className="h-3 w-3" />
              )}
              Calculate Net Proceeds
            </Button>

            {/* Net sheet result */}
            {netSheetResult && (
              <div className="rounded-md border bg-emerald-50 border-emerald-100 p-3 space-y-1.5">
                {netSheetResult.estimated_net_proceeds != null && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-emerald-900">Estimated Net Proceeds</span>
                    <span className="text-sm font-bold text-emerald-700">
                      ${Number(netSheetResult.estimated_net_proceeds).toLocaleString()}
                    </span>
                  </div>
                )}
                {netSheetResult.line_items?.length > 0 && (
                  <div className="space-y-1 pt-1 border-t border-emerald-200">
                    {netSheetResult.line_items.map((item: { label: string; amount: number }, i: number) => (
                      <div key={i} className="flex items-center justify-between text-xs text-emerald-800">
                        <span>{item.label}</span>
                        <span className={item.amount < 0 ? "text-red-600" : ""}>
                          {item.amount < 0 ? "-" : ""}${Math.abs(item.amount).toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {netSheetResult.notes && (
                  <p className="text-xs text-emerald-700 pt-1">{netSheetResult.notes}</p>
                )}
              </div>
            )}
          </div>
        )}
        {/* AI CMA inline panel */}
        {cmaOpen && (
          <div className="border-t pt-3 space-y-3">
            <p className="text-xs font-medium text-muted-foreground">AI Comparative Market Analysis</p>
            <div className="space-y-2">
              <div className="space-y-1">
                <Label className="text-xs">Property Address</Label>
                <p className="text-xs text-muted-foreground bg-muted/30 rounded px-2 py-1">{listing.address}</p>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Purpose</Label>
                <Select value={cmaPurpose} onValueChange={(v) => setCmaPurpose(v as typeof cmaPurpose)}>
                  <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="listing">Listing Pricing</SelectItem>
                    <SelectItem value="seller_consultation">Seller Consultation</SelectItem>
                    <SelectItem value="buyer_offer">Buyer Offer</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">State</Label>
                <p className="text-xs text-muted-foreground bg-muted/30 rounded px-2 py-1">{listing.state || "—"}</p>
              </div>
            </div>
            <Button
              size="sm"
              className="w-full text-xs gap-1.5"
              onClick={async () => {
                setCmaLoading(true)
                try {
                  const res = await generateAICMA({
                    propertyAddress: listing.address,
                    leadId: agentId,
                    purpose: cmaPurpose,
                    state: listing.state || "FL",
                  })
                  setCmaResult(res)
                  toast({ title: "AI CMA generated" })
                } catch {
                  toast({ title: "CMA generation failed", variant: "destructive" })
                } finally {
                  setCmaLoading(false)
                }
              }}
              disabled={cmaLoading}
            >
              {cmaLoading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <FileBarChart className="h-3 w-3" />
              )}
              Generate CMA
            </Button>

            {cmaResult && (
              <div className="rounded-md border bg-indigo-50 border-indigo-100 p-3 space-y-2">
                {cmaResult.recommendedPrice && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-indigo-900">Recommended Price</span>
                    <span className="text-sm font-bold text-indigo-700">
                      ${Number(cmaResult.recommendedPrice).toLocaleString()}
                    </span>
                  </div>
                )}
                {cmaResult.priceRange && (
                  <p className="text-xs text-indigo-700">
                    Range: ${Number(cmaResult.priceRange.low).toLocaleString()} – ${Number(cmaResult.priceRange.high).toLocaleString()}
                  </p>
                )}
                {cmaResult.marketAnalysis && (
                  <p className="text-xs text-indigo-800 leading-relaxed">{cmaResult.marketAnalysis}</p>
                )}
                {cmaResult.comparables?.length > 0 && (
                  <div className="pt-1 border-t border-indigo-200 space-y-1">
                    <p className="text-xs font-medium text-indigo-900">Comparable Sales</p>
                    {cmaResult.comparables.slice(0, 3).map((c: any, i: number) => (
                      <div key={i} className="flex items-center justify-between text-xs text-indigo-700">
                        <span className="truncate mr-2">{c.address}</span>
                        <span className="shrink-0">${Number(c.soldPrice ?? c.price ?? 0).toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-indigo-700 px-0 gap-1"
                  onClick={() => {
                    const text = JSON.stringify(cmaResult, null, 2)
                    navigator.clipboard.writeText(text)
                    toast({ title: "CMA copied to clipboard" })
                  }}
                >
                  <Copy className="h-3 w-3" />
                  Copy Summary
                </Button>
              </div>
            )}
          </div>
        )}

        {/* AI Price Adjustment Advisor result */}
        {advisorResult && (
          <div className="border-t pt-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">Price Advisor</p>
              {(() => {
                const action = advisorResult.recommendedAction
                const cfg =
                  action === "hold"
                    ? { label: "Hold Price", cls: "bg-emerald-100 text-emerald-800 border-emerald-200" }
                    : action === "reduce" && (advisorResult.percentageChange ?? 0) > 3
                    ? { label: "Significant Reduction", cls: "bg-red-100 text-red-800 border-red-200" }
                    : action === "reduce"
                    ? { label: "Minor Reduction", cls: "bg-amber-100 text-amber-800 border-amber-200" }
                    : { label: "Price Increase", cls: "bg-blue-100 text-blue-800 border-blue-200" }
                return (
                  <Badge className={`text-xs border ${cfg.cls}`}>{cfg.label}</Badge>
                )
              })()}
            </div>
            {advisorResult.suggestedNewPrice && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Suggested Price</span>
                <span className="font-bold">${Number(advisorResult.suggestedNewPrice).toLocaleString()}</span>
              </div>
            )}
            {advisorResult.percentageChange != null && (
              <p className="text-xs text-muted-foreground">
                {advisorResult.percentageChange > 0 ? "+" : ""}{advisorResult.percentageChange}% from current
              </p>
            )}
            {advisorResult.rationale && (
              <p className="text-xs text-muted-foreground leading-relaxed">{advisorResult.rationale}</p>
            )}
            {advisorResult.expectedImpact && (
              <p className="text-xs text-muted-foreground italic">{advisorResult.expectedImpact}</p>
            )}
            <div className="flex gap-1.5 pt-1">
              <Link href={`/dashboard/listings/${listingId}/seller-updates`}>
                <Button size="sm" variant="outline" className="h-6 text-xs px-2">
                  Share with Seller
                </Button>
              </Link>
              <Link href={`/dashboard/listings/${listingId}/edit`}>
                <Button size="sm" variant="outline" className="h-6 text-xs px-2">
                  Apply Price Change
                </Button>
              </Link>
            </div>
          </div>
        )}
      </CardContent>
    </Card>

    {/* Find Matching Buyers card */}
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Users className="h-4 w-4 text-indigo-600" />
            Find Matching Buyers
          </CardTitle>
          {buyerMatchTotal !== null && buyerMatchTotal > 0 && (
            <Badge className="bg-indigo-100 text-indigo-800 border border-indigo-200 text-xs">
              {buyerMatchTotal} match{buyerMatchTotal !== 1 ? "es" : ""}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {buyerMatches.length === 0 && buyerMatchTotal === null ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Surface active buyers from your pipeline who are a strong fit for this listing.
            </p>
            <Button size="sm" onClick={handleMatchBuyers} disabled={matchPending}>
              {matchPending ? (
                <RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5 mr-1.5" />
              )}
              Match Buyers to This Listing
            </Button>
          </div>
        ) : buyerMatches.length === 0 ? (
          <div className="flex items-start gap-2 text-xs text-muted-foreground">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            No buyers in your pipeline currently score above 50 for this listing.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {buyerMatches.map((match) => {
              const confidenceStyle =
                match.match_confidence === "high"
                  ? "bg-emerald-100 text-emerald-800 border-emerald-200"
                  : match.match_confidence === "medium"
                  ? "bg-amber-100 text-amber-800 border-amber-200"
                  : "bg-muted text-muted-foreground border-border"

              return (
                <div
                  key={match.contact_id}
                  className="rounded-md border border-border p-2.5 flex flex-col gap-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs font-medium truncate">{match.buyer_name}</span>
                      <Badge className={`text-xs border ${confidenceStyle} shrink-0`}>
                        {match.score}/100
                      </Badge>
                    </div>
                  </div>
                  {match.match_factors && match.match_factors.length > 0 && (
                    <p className="text-xs text-muted-foreground truncate">
                      {match.match_factors.slice(0, 2).join(" · ")}
                    </p>
                  )}
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <Link href={`/dashboard/contacts/${match.contact_id}`}>
                      <Button size="sm" variant="outline" className="h-6 text-xs px-2 gap-1">
                        <MessageSquare className="h-3 w-3" />
                        Contact Agent
                      </Button>
                    </Link>
                    <Link href={`/dashboard/listings/${listingId}/showings?contact=${match.contact_id}`}>
                      <Button size="sm" variant="outline" className="h-6 text-xs px-2 gap-1">
                        <Calendar className="h-3 w-3" />
                        Schedule Showing
                      </Button>
                    </Link>
                  </div>
                </div>
              )
            })}
            <Button
              size="sm"
              variant="ghost"
              onClick={handleMatchBuyers}
              disabled={matchPending}
              className="text-xs h-7 self-start"
            >
              <RefreshCw className="h-3 w-3 mr-1.5" />
              Re-run Match
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
    </div>
  )
}
