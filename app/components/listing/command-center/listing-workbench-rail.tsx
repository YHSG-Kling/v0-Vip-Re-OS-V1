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
import { generateAICMA } from "@/app/actions/ai-cma"
import { getAIPriceAdjustmentRecommendation } from "@/app/actions/ai-cma"
import { evaluateListingPresentationReadiness } from "@/app/actions/seller-decision-governance"
import { calculateSellerNet } from "@/app/actions/calculators"
import { useToast } from "@/hooks/use-toast"

interface WorkbenchRailProps {
  listingId: string
  agentId: string
  sellerId?: string
  brokerageId?: string
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
    /** Pre-computed by server from listings.go_live_date via
     *  computeDaysOnMarket. UI just reads it. */
    days_on_market?: number
    go_live_date?: string | null
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

export function ListingWorkbenchRail({ listingId, agentId, sellerId, brokerageId, listing }: WorkbenchRailProps) {
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
  const [netConcessions, setNetConcessions] = useState("")
  const [netRepairs, setNetRepairs] = useState("")

  // AI CMA state
  const [cmaOpen, setCmaOpen] = useState(false)
  const [cmaLoading, setCmaLoading] = useState(false)
  const [cmaResult, setCmaResult] = useState<any>(null)
  const [cmaPurpose, setCmaPurpose] = useState<"listing" | "buyer_offer" | "seller_consultation">("listing")

  // AI Price Adjustment Advisor state
  const [advisorLoading, setAdvisorLoading] = useState(false)
  const [advisorResult, setAdvisorResult] = useState<any>(null)
  // Prefer pre-computed days_on_market (set by server from go_live_date);
  // fall back to client-side computation from go_live_date.
  const daysOnMarket =
    listing.days_on_market ??
    (listing.go_live_date
      ? Math.floor((Date.now() - new Date(listing.go_live_date).getTime()) / 86_400_000)
      : 0)

  // AI Presentation Readiness state
  const [presentationReadinessLoading, setPresentationReadinessLoading] = useState(false)
  const [presentationReadinessResult, setPresentationReadinessResult] = useState<any>(null)
  const [presentationReadinessOpen, setPresentationReadinessOpen] = useState(false)

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
    const homeValue = parseFloat(netSalePrice.replace(/,/g, ""))
    if (!homeValue || isNaN(homeValue) || homeValue <= 0) {
      toast({ title: "Enter a valid sale price", variant: "destructive" })
      return
    }
    setNetSheetLoading(true)
    try {
      const mortgageBalance = netMortgagePayoff ? parseFloat(netMortgagePayoff.replace(/,/g, "")) : 0
      const repairsAmt = netRepairs ? parseFloat(netRepairs.replace(/,/g, "")) : 0
      const concessionsAmt = netConcessions ? parseFloat(netConcessions.replace(/,/g, "")) : 0

      // Use calculateSellerNet when brokerageId is available, otherwise fall back
      if (brokerageId) {
        const res = await calculateSellerNet({
          homeValue,
          mortgageBalance,
          location: listing.city || listing.address,
          state: listing.state,
          repairsConcessions: repairsAmt + concessionsAmt,
          brokerageId,
        })
        setNetSheetResult({ _type: "detailed", ...res })
        toast({ title: "Net sheet calculated" })
      } else {
        const res = await generateSellerNetSheet({
          agentId,
          salePrice: homeValue,
          state: listing.state,
          mortgagePayoff: mortgageBalance || undefined,
          commissionRate: netCommissionRate ? parseFloat(netCommissionRate) : undefined,
        })
        if (res.success) {
          setNetSheetResult({ _type: "simple", ...res })
          toast({ title: "Net sheet calculated" })
        } else {
          toast({ title: (res as any).error ?? "Net sheet failed", variant: "destructive" })
        }
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

          <Button
            size="sm"
            variant={
              presentationReadinessResult?.data?.presentationReady
                ? "secondary"
                : presentationReadinessResult && !presentationReadinessResult?.data?.presentationReady
                ? "outline"
                : "outline"
            }
            className={`text-xs gap-1.5 justify-start col-span-2 ${
              presentationReadinessResult?.data?.presentationReady
                ? "text-green-800 border-green-300 bg-green-50 hover:bg-green-100"
                : ""
            }`}
            onClick={async () => {
              setPresentationReadinessOpen((o) => !o)
              if (!presentationReadinessResult) {
                setPresentationReadinessLoading(true)
                try {
                  const res = await evaluateListingPresentationReadiness(listingId)
                  setPresentationReadinessResult(res)
                } catch {
                  toast({ title: "Presentation readiness check failed", variant: "destructive" })
                } finally {
                  setPresentationReadinessLoading(false)
                }
              }
            }}
            disabled={presentationReadinessLoading}
          >
            {presentationReadinessLoading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : presentationReadinessResult?.data?.presentationReady ? (
              <CheckCircle2 className="h-3 w-3 text-green-600" />
            ) : (
              <Sparkles className="h-3 w-3" />
            )}
            AI: Is Presentation Ready?
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
            <div className="grid grid-cols-2 gap-2">
              <div className="col-span-2 space-y-1">
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
                <Label className="text-xs">Repairs ($)</Label>
                <Input
                  className="h-7 text-xs"
                  placeholder="optional"
                  value={netRepairs}
                  onChange={(e) => setNetRepairs(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Concessions ($)</Label>
                <Input
                  className="h-7 text-xs"
                  placeholder="optional"
                  value={netConcessions}
                  onChange={(e) => setNetConcessions(e.target.value)}
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
                {/* Detailed result from calculateSellerNet */}
                {netSheetResult._type === "detailed" && netSheetResult.net_proceeds != null && (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-emerald-900">Seller Net Proceeds</span>
                      <span className="text-sm font-bold text-emerald-700">
                        ${Number(netSheetResult.net_proceeds).toLocaleString()}
                      </span>
                    </div>
                    {netSheetResult.cost_breakdown && (
                      <div className="space-y-1 pt-1 border-t border-emerald-200">
                        {Object.entries(netSheetResult.cost_breakdown as Record<string, number>).map(([key, val]) => (
                          <div key={key} className="flex items-center justify-between text-xs text-emerald-800">
                            <span className="capitalize">{key.replace(/_/g, " ")}</span>
                            <span className="text-red-600">-${Number(val).toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {netSheetResult.scenarios?.length > 0 && (
                      <div className="pt-1 border-t border-emerald-200 space-y-1">
                        <p className="text-xs font-medium text-emerald-900">AI Scenarios</p>
                        {netSheetResult.scenarios.map((s: any, i: number) => (
                          <div key={i} className="flex items-center justify-between text-xs text-emerald-800">
                            <span>{s.timeframe}</span>
                            <span className="font-medium">${Number(s.net_proceeds).toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {netSheetResult.recommendation && (
                      <p className="text-xs text-emerald-700 italic pt-1">{netSheetResult.recommendation}</p>
                    )}
                  </>
                )}
                {/* Simple result from generateSellerNetSheet */}
                {netSheetResult._type === "simple" && netSheetResult.estimated_net_proceeds != null && (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-emerald-900">Estimated Net Proceeds</span>
                      <span className="text-sm font-bold text-emerald-700">
                        ${Number(netSheetResult.estimated_net_proceeds).toLocaleString()}
                      </span>
                    </div>
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
                  </>
                )}
                {/* Share CTA */}
                <div className="flex gap-2 pt-1 border-t border-emerald-200">
                  <Link href={`/dashboard/listings/${listingId}/seller-updates`}>
                    <Button size="sm" variant="outline" className="h-6 text-xs px-2 border-emerald-300 text-emerald-800 hover:bg-emerald-100">
                      Share with Seller
                    </Button>
                  </Link>
                </div>
              </div>
            )}
          </div>
        )}
        {/* AI Presentation Readiness result panel */}
        {presentationReadinessOpen && presentationReadinessResult && (
          <div className="border-t pt-3 space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Presentation Readiness</p>
            {!presentationReadinessResult.success ? (
              <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                {presentationReadinessResult.error ?? "No presentation data found. Generate a presentation first."}
              </div>
            ) : (
              <div className={`rounded-md border p-3 space-y-2 ${
                presentationReadinessResult.data?.presentationReady
                  ? "bg-green-50 border-green-200"
                  : "bg-amber-50 border-amber-200"
              }`}>
                <div className="flex items-center gap-2">
                  {presentationReadinessResult.data?.presentationReady ? (
                    <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-amber-600 shrink-0" />
                  )}
                  <p className={`text-xs font-semibold ${
                    presentationReadinessResult.data?.presentationReady
                      ? "text-green-900"
                      : "text-amber-900"
                  }`}>
                    {presentationReadinessResult.data?.presentationReady
                      ? "Ready for seller meeting"
                      : "Not yet ready for seller meeting"}
                  </p>
                </div>
                {presentationReadinessResult.data?.warnings?.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-muted-foreground">Fix these items first:</p>
                    <ul className="space-y-0.5">
                      {presentationReadinessResult.data.warnings.map((w: string, i: number) => (
                        <li key={i} className="text-xs text-amber-800 flex items-start gap-1">
                          <span className="shrink-0 mt-0.5">&#9888;</span>
                          {w}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="flex gap-1.5 pt-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-xs px-2"
                    onClick={async () => {
                      setPresentationReadinessResult(null)
                      setPresentationReadinessLoading(true)
                      try {
                        const res = await evaluateListingPresentationReadiness(listingId)
                        setPresentationReadinessResult(res)
                      } catch {
                        toast({ title: "Re-check failed", variant: "destructive" })
                      } finally {
                        setPresentationReadinessLoading(false)
                      }
                    }}
                    disabled={presentationReadinessLoading}
                  >
                    <RefreshCw className="h-3 w-3 mr-1" />
                    Re-check
                  </Button>
                </div>
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
                    agentId,
                    listingId,
                    propertyAddress: listing.address,
                    propertyCity: listing.city,
                    propertyState: listing.state || "FL",
                    propertyZip: listing.zip || "",
                    propertyType: (listing.property_type as any) || "single_family",
                    bedrooms: listing.bedrooms || 0,
                    bathrooms: listing.bathrooms || 0,
                    squareFeet: listing.square_footage || 0,
                    listingType: "seller",
                  })
                  if (res.success) {
                    setCmaResult(res)
                    toast({ title: "AI CMA generated and saved" })
                  } else {
                    toast({ title: (res as any).error ?? "CMA generation failed", variant: "destructive" })
                  }
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

            {cmaResult?.success && (
              <div className="rounded-md border bg-indigo-50 border-indigo-100 p-3 space-y-2">
                {cmaResult.pricingStrategy?.recommendedListPrice && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-indigo-900">Recommended Price</span>
                    <span className="text-sm font-bold text-indigo-700">
                      ${Number(cmaResult.pricingStrategy.recommendedListPrice).toLocaleString()}
                    </span>
                  </div>
                )}
                {cmaResult.pricingStrategy?.priceRangeLow && (
                  <p className="text-xs text-indigo-700">
                    Range: ${Number(cmaResult.pricingStrategy.priceRangeLow).toLocaleString()} – ${Number(cmaResult.pricingStrategy.priceRangeHigh).toLocaleString()}
                  </p>
                )}
                {cmaResult.pricingStrategy?.rationale && (
                  <p className="text-xs text-indigo-800 leading-relaxed">{cmaResult.pricingStrategy.rationale}</p>
                )}
                {cmaResult.comparables?.length > 0 && (
                  <div className="pt-1 border-t border-indigo-200 space-y-1">
                    <p className="text-xs font-medium text-indigo-900">Comparable Sales ({cmaResult.comparables.length})</p>
                    {cmaResult.comparables.slice(0, 3).map((c: any, i: number) => (
                      <div key={i} className="flex items-center justify-between text-xs text-indigo-700">
                        <span className="truncate mr-2">{c.address}</span>
                        <span className="shrink-0">${Number(c.soldPrice ?? c.adjustedValue ?? 0).toLocaleString()}</span>
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
                    <Link href={`/crm/contacts/${match.contact_id}`}>
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
