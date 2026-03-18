"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Shield,
  ExternalLink,
  Check,
  Clock,
  Globe,
  Mail,
  Video,
  FileText,
  Home,
  Loader2,
  ChevronRight,
} from "lucide-react"
import { getCampaigns, getAssets } from "@/app/actions/marketing-studio"
import { createClient } from "@/lib/supabase/client"

interface MarketingItem {
  id: string
  type: "campaign" | "asset" | "video" | "email"
  name: string
  status: string
  channel: string
  launchedAt?: string
  description: string
}

interface SellerSafeMarketingSummaryProps {
  listings: Array<{ id: string; address: string; city: string; list_price?: number }>
}

const CHANNEL_ICONS: Record<string, React.ElementType> = {
  social: Globe,
  email: Mail,
  video: Video,
  direct_mail: FileText,
  web: Globe,
}

export function SellerSafeMarketingSummary({ listings }: SellerSafeMarketingSummaryProps) {
  const [selectedListingId, setSelectedListingId] = useState<string>("")
  const [marketingItems, setMarketingItems] = useState<MarketingItem[]>([])
  const [isLoading, setIsLoading] = useState(false)

  const selectedListing = listings.find((l) => l.id === selectedListingId)

  useEffect(() => {
    if (selectedListingId) {
      loadMarketingData()
    }
  }, [selectedListingId])

  async function loadMarketingData() {
    setIsLoading(true)
    try {
      const items: MarketingItem[] = []

      // Get campaigns for this listing
      const campaignsResult = await getCampaigns({ listingId: selectedListingId })
      if (campaignsResult.success && campaignsResult.campaigns) {
        for (const campaign of campaignsResult.campaigns) {
          items.push({
            id: campaign.id,
            type: "campaign",
            name: campaign.campaign_name,
            status: campaign.status,
            channel: campaign.campaign_type,
            launchedAt: campaign.launched_at,
            description: getPlainLanguageDescription("campaign", campaign.status, campaign.campaign_type),
          })
        }
      }

      // Get assets for campaigns
      const assetsResult = await getAssets({ listingId: selectedListingId })
      if (assetsResult.success && assetsResult.assets) {
        for (const asset of assetsResult.assets) {
          items.push({
            id: asset.id,
            type: "asset",
            name: asset.asset_name,
            status: asset.approval_status,
            channel: asset.asset_type,
            description: getPlainLanguageDescription("asset", asset.approval_status, asset.asset_type),
          })
        }
      }

      // Check for videos linked to this listing
      const supabase = createClient()
      const { data: videos } = await supabase
        .from("generated_videos")
        .select("id, title, status, created_at")
        .eq("listing_id", selectedListingId)
        .limit(5)

      if (videos) {
        for (const video of videos) {
          items.push({
            id: video.id,
            type: "video",
            name: video.title,
            status: video.status,
            channel: "video",
            launchedAt: video.created_at,
            description: getPlainLanguageDescription("video", video.status, "video"),
          })
        }
      }

      setMarketingItems(items)
    } catch (error) {
      console.error("Failed to load marketing data:", error)
    } finally {
      setIsLoading(false)
    }
  }

  function getPlainLanguageDescription(type: string, status: string, channel: string): string {
    const statusDescriptions: Record<string, string> = {
      live: "Currently running and reaching potential buyers",
      active: "Currently running and reaching potential buyers",
      approved: "Ready to go live when you give the green light",
      pending: "Waiting for final review before publishing",
      pending_approval: "Under review to ensure it meets quality standards",
      draft: "Being prepared - not visible to the public yet",
      completed: "Campaign has finished running",
      ended: "Campaign has finished running",
    }

    const channelDescriptions: Record<string, string> = {
      social: "on social media platforms",
      email: "via email marketing",
      video: "as a property video",
      direct_mail: "as printed materials",
      web: "on websites and landing pages",
      listing: "as part of listing marketing",
      brand: "as brand awareness content",
    }

    const statusText = statusDescriptions[status] || "Status being updated"
    const channelText = channelDescriptions[channel] || ""

    return `${statusText}${channelText ? ` ${channelText}` : ""}.`
  }

  function getStatusBadge(status: string) {
    const variants: Record<string, { variant: "default" | "secondary" | "outline"; className: string }> = {
      live: { variant: "default", className: "bg-green-600" },
      active: { variant: "default", className: "bg-green-600" },
      approved: { variant: "secondary", className: "bg-blue-100 text-blue-700" },
      pending: { variant: "outline", className: "border-yellow-500 text-yellow-700" },
      pending_approval: { variant: "outline", className: "border-yellow-500 text-yellow-700" },
      draft: { variant: "secondary", className: "" },
      completed: { variant: "secondary", className: "bg-gray-100 text-gray-600" },
      ended: { variant: "secondary", className: "bg-gray-100 text-gray-600" },
    }

    const config = variants[status] || { variant: "secondary" as const, className: "" }

    return (
      <Badge variant={config.variant} className={config.className}>
        {status === "live" || status === "active" ? (
          <Check className="h-3 w-3 mr-1" />
        ) : status.includes("pending") ? (
          <Clock className="h-3 w-3 mr-1" />
        ) : null}
        {status.replace("_", " ")}
      </Badge>
    )
  }

  const liveItems = marketingItems.filter((item) => item.status === "live" || item.status === "active")

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-violet-600" />
          Seller-Safe Marketing Summary
        </CardTitle>
        <CardDescription>
          Plain-language overview of what is live for your listing
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Listing Selector */}
        <Select value={selectedListingId} onValueChange={setSelectedListingId}>
          <SelectTrigger>
            <SelectValue placeholder="Select a listing to view marketing" />
          </SelectTrigger>
          <SelectContent>
            {listings.map((listing) => (
              <SelectItem key={listing.id} value={listing.id}>
                <div className="flex items-center gap-2">
                  <Home className="h-4 w-4" />
                  {listing.address}, {listing.city}
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-violet-600" />
          </div>
        )}

        {!isLoading && selectedListingId && (
          <>
            {/* Summary Stats */}
            <div className="p-4 rounded-lg bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800">
              <p className="font-medium text-green-700 dark:text-green-300">
                {liveItems.length > 0
                  ? `${liveItems.length} marketing item(s) actively promoting this property`
                  : "No active marketing running for this property yet"}
              </p>
              {liveItems.length > 0 && (
                <p className="text-sm text-muted-foreground mt-1">
                  Your listing is being shown to potential buyers across multiple channels.
                </p>
              )}
            </div>

            {/* Marketing Items */}
            <ScrollArea className="h-[250px]">
              {marketingItems.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Shield className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p>No marketing found for this listing</p>
                  <p className="text-sm mt-1">Create a campaign to start promoting</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {marketingItems.map((item) => {
                    const ChannelIcon = CHANNEL_ICONS[item.channel] || Globe
                    return (
                      <div key={item.id} className="p-3 rounded-lg border bg-card">
                        <div className="flex items-start justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <ChannelIcon className="h-4 w-4 text-violet-600" />
                            <p className="font-medium text-sm">{item.name}</p>
                          </div>
                          {getStatusBadge(item.status)}
                        </div>
                        <p className="text-sm text-muted-foreground">{item.description}</p>
                        {item.launchedAt && (
                          <p className="text-xs text-muted-foreground mt-2">
                            Started: {new Date(item.launchedAt).toLocaleDateString()}
                          </p>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </ScrollArea>

            {/* Portal Link */}
            {selectedListing && (
              <Link href={`/portal/${selectedListingId}/listing-visibility`}>
                <Button variant="outline" className="w-full">
                  <ExternalLink className="h-4 w-4 mr-2" />
                  View in Seller Portal
                  <ChevronRight className="h-4 w-4 ml-auto" />
                </Button>
              </Link>
            )}
          </>
        )}

        {!selectedListingId && (
          <div className="text-center py-8 text-muted-foreground">
            <Home className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>Select a listing to see marketing summary</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
