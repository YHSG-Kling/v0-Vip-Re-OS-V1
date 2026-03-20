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
  ChevronRight,
} from "lucide-react"
import { generateListingPresentation, generateBrochureContent } from "@/app/actions/ai-listing-presentation"
import { matchBuyersForListing } from "@/app/actions/property-buyer-matching"
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

          {sellerId && (
            <Link href={`/portal/seller/${sellerId}?listing=${listingId}`} target="_blank">
              <Button size="sm" variant="outline" className="w-full text-xs gap-1.5 justify-start">
                <ExternalLink className="h-3 w-3" />
                Portal View
              </Button>
            </Link>
          )}
        </div>
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
