"use client"

import { useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
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
} from "lucide-react"
import { generateListingPresentation, generateBrochureContent } from "@/app/actions/ai-listing-presentation"

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

export function ListingWorkbenchRail({ listingId, agentId, sellerId, listing }: WorkbenchRailProps) {
  const [presentationLoading, setPresentationLoading] = useState(false)
  const [brochureLoading, setBrochureLoading] = useState(false)
  const [presentationGenerated, setPresentationGenerated] = useState(false)
  const [brochureGenerated, setBrochureGenerated] = useState(false)

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
  )
}
