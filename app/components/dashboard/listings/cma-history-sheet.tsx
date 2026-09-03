"use client"

import { useState } from "react"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2, FileBarChart, ExternalLink, BarChart2, Sparkles, TrendingDown, AlertTriangle } from "lucide-react"
import Link from "next/link"
import { getCMAReports, updateCMAReport, generateAICMA, getAIPriceAdjustmentRecommendation } from "@/app/actions/ai-cma"
import { createClient } from "@/lib/supabase/client"
import { useToast } from "@/hooks/use-toast"

interface CmaHistorySheetProps {
  listingId: string
  agentId: string
  listingAddress: string
  /* ── PRICE ADJUSTMENT, REACHABLE ────────────────────────────────────────────
   * app/actions/ai-cma.ts:getAIPriceAdjustmentRecommendation reads a CMA and the
   * listing's live performance and says whether to reduce, hold or raise. It had
   * no caller anywhere, so the product could produce a CMA and then had nothing
   * to say when the listing sat.
   *
   * The three performance inputs are PASSED IN from the listings page rather
   * than typed by the agent: list price, days on market and showing count are
   * facts the page already has (listings.list_price, listings.showing_count, and
   * DOM derived from stage_updated_at). Asking an agent to key them in would
   * invite a recommendation built on remembered numbers.
   * ────────────────────────────────────────────────────────────────────────── */
  listPrice?: number | null
  daysOnMarket?: number | null
  showingCount?: number | null
}

const PURPOSE_LABELS: Record<string, string> = {
  listing: "Listing Pricing",
  buyer_offer: "Buyer Offer",
  seller_consultation: "Seller Consultation",
}

const STATUS_CONFIG: Record<string, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "bg-muted text-muted-foreground border-border" },
  shared_with_seller: { label: "Shared", cls: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  expired: { label: "Expired", cls: "bg-red-100 text-red-800 border-red-200" },
  active: { label: "Active", cls: "bg-blue-100 text-blue-800 border-blue-200" },
}

export function CmaHistorySheet({
  listingId,
  agentId,
  listingAddress,
  listPrice,
  daysOnMarket,
  showingCount,
}: CmaHistorySheetProps) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [reports, setReports] = useState<any[]>([])
  const [toggling, setToggling] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [adjustingId, setAdjustingId] = useState<string | null>(null)
  const [adjustment, setAdjustment] = useState<{ cmaId: string; rec: any; logged: boolean | null } | null>(null)
  const { toast } = useToast()

  /* A price-adjustment read needs a live list price to adjust FROM. Without one
   * the action would be handed 0 and would recommend a percentage change against
   * nothing, so the control is disabled and says why rather than producing a
   * confident number from a missing input. */
  const canAdjust = typeof listPrice === "number" && listPrice > 0

  async function handlePriceAdjustment(cma: any) {
    if (!canAdjust) return
    setAdjustingId(cma.id)
    setAdjustment(null)
    try {
      const res = await getAIPriceAdjustmentRecommendation(
        cma.id,
        listPrice as number,
        daysOnMarket ?? 0,
        showingCount ?? 0,
      )
      if (!res.success) {
        toast({ title: (res as any).error ?? "Could not get a recommendation", variant: "destructive" })
        return
      }
      setAdjustment({
        cmaId: cma.id,
        rec: (res as any).recommendation,
        logged: ((res as any).logged as boolean | undefined) ?? null,
      })
    } catch {
      toast({ title: "Could not get a recommendation", variant: "destructive" })
    } finally {
      setAdjustingId(null)
    }
  }

  async function loadReports() {
    if (reports.length > 0) return
    setLoading(true)
    try {
      const res = await getCMAReports(agentId)
      if (res.success) {
        // getCMAReports doesn't filter by listingId — filter client-side
        const filtered = (res.reports ?? []).filter((r: any) => r.listing_id === listingId)
        setReports(filtered)
      } else {
        toast({ title: (res as any).error ?? "Failed to load CMAs", variant: "destructive" })
      }
    } catch {
      toast({ title: "Failed to load CMAs", variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }

  async function toggleShared(cma: any) {
    const nextStatus = cma.status === "shared_with_seller" ? "draft" : "shared_with_seller"
    setToggling(cma.id)
    try {
      const res = await updateCMAReport(cma.id, { status: nextStatus })
      if (res.success) {
        setReports((prev) =>
          prev.map((r) => (r.id === cma.id ? { ...r, status: nextStatus } : r))
        )
        toast({ title: nextStatus === "shared_with_seller" ? "Marked as shared with seller" : "Marked as draft" })
      } else {
        toast({ title: (res as any).error ?? "Update failed", variant: "destructive" })
      }
    } catch {
      toast({ title: "Update failed", variant: "destructive" })
    } finally {
      setToggling(null)
    }
  }

  async function handleGenerateCMA() {
    setGenerating(true)
    try {
      // Parse address into components as a fallback
      const addressParts = listingAddress.split(",").map((s) => s.trim())

      // Fetch real listing data for accurate CMA
      const supabase = createClient()
      const { data: listingData } = await supabase
        .from("listings")
        .select("address, city, state, zip, bedrooms, bathrooms, sqft, property_type")
        .eq("id", listingId)
        .maybeSingle()

      if (!listingData) {
        toast({ title: "Cannot generate CMA — listing details not found", variant: "destructive" })
        return
      }

      const propertyAddress = listingData.address ?? addressParts[0] ?? listingAddress
      const propertyCity = listingData.city ?? addressParts[1] ?? ""
      const propertyState = listingData.state ?? addressParts[2]?.split(" ")[0] ?? ""
      const propertyZip = listingData.zip ?? addressParts[2]?.split(" ")[1] ?? ""
      const bedrooms = listingData.bedrooms
      const bathrooms = listingData.bathrooms
      const squareFeet = listingData.sqft
      const propertyType = listingData.property_type ?? "single_family"

      if (bedrooms == null || bathrooms == null || squareFeet == null) {
        toast({ title: "Cannot generate CMA — listing is missing beds, baths, or square footage", variant: "destructive" })
        return
      }

      const res = await generateAICMA({
        agentId,
        propertyAddress,
        propertyCity,
        propertyState,
        propertyZip,
        propertyType,
        bedrooms,
        bathrooms,
        squareFeet,
        listingType: "seller",
        listingId,
      })

      if (res.success) {
        toast({ title: "CMA generated successfully" })
        const fetchRes = await getCMAReports(agentId)
        if (fetchRes.success) {
          const filtered = (fetchRes.reports ?? []).filter((r: any) => r.listing_id === listingId)
          setReports(filtered)
        }
      } else {
        toast({ title: (res as any).error ?? "Failed to generate CMA", variant: "destructive" })
      }
    } catch {
      toast({ title: "Failed to generate CMA", variant: "destructive" })
    } finally {
      setGenerating(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={(o) => { setOpen(o); if (o) loadReports() }}>
      <SheetTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs gap-1 text-muted-foreground hover:text-foreground"
          onClick={(e) => e.preventDefault()}
        >
          <FileBarChart className="h-3 w-3" />
          CMAs
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader className="pb-4">
          <SheetTitle className="text-base">CMA History</SheetTitle>
          <p className="text-xs text-muted-foreground truncate">{listingAddress}</p>
        </SheetHeader>

        {/* Generate New CMA button — always visible at top */}
        <div className="mb-5">
          <Button
            onClick={handleGenerateCMA}
            disabled={generating || loading}
            className="w-full gap-2"
            size="sm"
          >
            {generating ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Analyzing comparable sales…
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5" />
                Generate New CMA
              </>
            )}
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : reports.length === 0 ? (
          <div className="py-10 text-center space-y-3">
            <BarChart2 className="h-8 w-8 mx-auto text-muted-foreground/40" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">No CMA created yet</p>
              <p className="text-xs text-muted-foreground max-w-xs mx-auto">
                Generate a Comparative Market Analysis to price this listing competitively and build seller confidence.
              </p>
            </div>
            <Button
              onClick={handleGenerateCMA}
              disabled={generating}
              size="sm"
              className="gap-2"
            >
              {generating ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Analyzing comparable sales…
                </>
              ) : (
                <>
                  <Sparkles className="h-3.5 w-3.5" />
                  Generate New CMA
                </>
              )}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {reports.map((cma) => {
              const statusCfg = STATUS_CONFIG[cma.status] ?? STATUS_CONFIG.draft
              const purpose = PURPOSE_LABELS[cma.purpose ?? "listing"] ?? cma.purpose ?? "—"
              const isShared = cma.status === "shared_with_seller"
              return (
                <div key={cma.id} className="rounded-lg border border-border p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-medium truncate">{purpose}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {new Date(cma.created_at).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </p>
                    </div>
                    <Badge className={`text-[10px] shrink-0 border ${statusCfg.cls}`}>
                      {statusCfg.label}
                    </Badge>
                  </div>

                  {cma.recommended_price && (
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Recommended Price</span>
                      <span className="font-semibold">${Number(cma.recommended_price).toLocaleString()}</span>
                    </div>
                  )}

                  {cma.price_range_low && cma.price_range_high && (
                    <p className="text-[10px] text-muted-foreground">
                      Range: ${Number(cma.price_range_low).toLocaleString()} – ${Number(cma.price_range_high).toLocaleString()}
                    </p>
                  )}

                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      size="sm"
                      variant={isShared ? "secondary" : "outline"}
                      className="h-6 text-[10px] px-2 gap-1"
                      disabled={toggling === cma.id}
                      onClick={() => toggleShared(cma)}
                    >
                      {toggling === cma.id ? (
                        <Loader2 className="h-2.5 w-2.5 animate-spin" />
                      ) : null}
                      {isShared ? "Unmark Shared" : "Mark Shared with Seller"}
                    </Button>
                    {/* Per-row link opens THIS report by id (app/dashboard/cma/[cmaId]).
                        It pointed at /listings/${listingId} labelled "Regenerate" —
                        the listing page, not the report, and regeneration is the
                        "Generate New CMA" button at the top of this sheet. */}
                    <Link href={`/dashboard/cma/${cma.id}`}>
                      <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2 gap-1">
                        <ExternalLink className="h-2.5 w-2.5" />
                        Open report
                      </Button>
                    </Link>
                  </div>

                  {/* Price adjustment against THIS CMA + the listing's live performance. */}
                  <div className="pt-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[10px] px-2 gap-1"
                      disabled={!canAdjust || adjustingId === cma.id}
                      onClick={() => handlePriceAdjustment(cma)}
                    >
                      {adjustingId === cma.id ? (
                        <Loader2 className="h-2.5 w-2.5 animate-spin" />
                      ) : (
                        <TrendingDown className="h-2.5 w-2.5" />
                      )}
                      Price adjustment advice
                    </Button>
                    {!canAdjust && (
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        This listing has no list price recorded, so there is nothing to adjust from.
                      </p>
                    )}

                    {adjustment !== null && adjustment.cmaId === cma.id && adjustment.rec && (
                      <div className="mt-2 rounded-md bg-muted/50 p-2 space-y-1 text-[10px]">
                        <p className="text-xs font-semibold capitalize">
                          {adjustment.rec.recommendedAction ?? "review"}
                          {typeof adjustment.rec.suggestedNewPrice === "number" && (
                            <>
                              {" → $"}
                              {Number(adjustment.rec.suggestedNewPrice).toLocaleString()}
                              {typeof adjustment.rec.percentageChange === "number" && (
                                <span className="ml-1 font-normal text-muted-foreground">
                                  ({adjustment.rec.percentageChange}%)
                                </span>
                              )}
                            </>
                          )}
                        </p>
                        <p className="text-muted-foreground">
                          Based on {daysOnMarket ?? 0} DOM and {showingCount ?? 0} showings.
                        </p>
                        {adjustment.rec.rationale && (
                          <p className="text-muted-foreground">{adjustment.rec.rationale}</p>
                        )}
                        {adjustment.rec.urgency && (
                          <p className="capitalize text-muted-foreground">Urgency: {adjustment.rec.urgency}</p>
                        )}
                        {adjustment.rec.expectedImpact && (
                          <p className="text-muted-foreground">{adjustment.rec.expectedImpact}</p>
                        )}
                        {adjustment.logged === false && (
                          <p className="flex items-center gap-1 text-destructive">
                            <AlertTriangle className="h-2.5 w-2.5" />
                            Not saved to this CMA's history — copy it before you close this panel.
                          </p>
                        )}
                        <p className="text-muted-foreground">
                          A recommendation, not a price change. Changing the list price stays with you and the seller.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
