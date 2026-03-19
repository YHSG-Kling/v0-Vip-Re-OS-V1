"use client"

import { useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Rocket,
  Home,
  Users,
  UserPlus,
  Calendar,
  TrendingUp,
  Video,
  MessageSquare,
  Mail,
  FileText,
  Mic,
  ChevronRight,
  Loader2,
} from "lucide-react"
import { createCampaign, type CampaignStatus } from "@/app/actions/marketing-studio"
import { generateText } from "@/app/actions/content-generation-engine"

export type CampaignMode =
  | "listing"
  | "sphere"
  | "seller_lead"
  | "buyer_lead"
  | "open_house"
  | "market_update"

interface CampaignLauncherPanelProps {
  listings: Array<{ id: string; address: string; city: string; list_price?: number }>
  agentId: string
  onCampaignCreated?: (campaignId: string) => void
}

const CAMPAIGN_MODES: Array<{
  id: CampaignMode
  label: string
  description: string
  icon: React.ElementType
  channels: string[]
}> = [
  {
    id: "listing",
    label: "Listing Campaign",
    description: "Promote a specific property across all channels",
    icon: Home,
    channels: ["video", "social", "email", "direct_mail", "seller_update"],
  },
  {
    id: "sphere",
    label: "Sphere / Brand Campaign",
    description: "Stay top-of-mind with your sphere of influence",
    icon: Users,
    channels: ["social", "email", "blog", "podcast"],
  },
  {
    id: "seller_lead",
    label: "Seller Lead Campaign",
    description: "Generate seller leads in target areas",
    icon: UserPlus,
    channels: ["social", "email", "direct_mail", "landing_page"],
  },
  {
    id: "buyer_lead",
    label: "Buyer Lead Campaign",
    description: "Attract qualified buyers to your listings",
    icon: UserPlus,
    channels: ["social", "email", "video", "landing_page"],
  },
  {
    id: "open_house",
    label: "Open House Campaign",
    description: "Drive traffic to your open house events",
    icon: Calendar,
    channels: ["social", "email", "direct_mail", "video"],
  },
  {
    id: "market_update",
    label: "Market Update Campaign",
    description: "Position yourself as the local market expert",
    icon: TrendingUp,
    channels: ["video", "social", "email", "blog", "podcast"],
  },
]

const CHANNEL_ICONS: Record<string, React.ElementType> = {
  video: Video,
  social: MessageSquare,
  email: Mail,
  direct_mail: FileText,
  blog: FileText,
  podcast: Mic,
  seller_update: Mail,
  landing_page: FileText,
}

const CHANNEL_ROUTES: Record<string, string> = {
  video: "/dashboard/videos/create",
  social: "/dashboard/marketing/studio",
  email: "/dashboard/marketing/studio",
  direct_mail: "/dashboard/marketing/studio",
  blog: "/dashboard/marketing/blog",
  podcast: "/dashboard/marketing/podcast",
  seller_update: "/dashboard/listings/[listingId]/seller-updates",
  landing_page: "/dashboard/marketing/seo",
}

export function CampaignLauncherPanel({
  listings,
  agentId,
  onCampaignCreated,
}: CampaignLauncherPanelProps) {
  const [selectedMode, setSelectedMode] = useState<CampaignMode | null>(null)
  const [selectedListingId, setSelectedListingId] = useState<string>("")
  const [campaignName, setCampaignName] = useState("")
  const [isCreating, setIsCreating] = useState(false)
  const [createdCampaignId, setCreatedCampaignId] = useState<string | null>(null)

  const selectedModeConfig = CAMPAIGN_MODES.find((m) => m.id === selectedMode)
  const selectedListing = listings.find((l) => l.id === selectedListingId)

  const needsListing = selectedMode === "listing" || selectedMode === "open_house"

  async function handleCreateCampaign() {
    if (!selectedMode || !campaignName) return
    if (needsListing && !selectedListingId) return

    setIsCreating(true)
    try {
      const result = await createCampaign({
        campaignName,
        campaignType: selectedMode === "listing" || selectedMode === "open_house" ? "listing" : "brand",
        listingId: needsListing ? selectedListingId : undefined,
        budgetTotal: 0,
        visibilityScope: "agent",
      })

      if (result.success && result.campaign) {
        setCreatedCampaignId(result.campaign.id)
        onCampaignCreated?.(result.campaign.id)
      }
    } catch (error) {
      console.error("Failed to create campaign:", error)
    } finally {
      setIsCreating(false)
    }
  }

  function getChannelRoute(channel: string): string {
    let route = CHANNEL_ROUTES[channel] || "/dashboard/marketing/studio"
    if (channel === "seller_update" && selectedListingId) {
      route = route.replace("[listingId]", selectedListingId)
    }
    return route
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Rocket className="h-5 w-5 text-violet-600" />
          Campaign Launcher
        </CardTitle>
        <CardDescription>
          Select a campaign mode to generate assets across all channels
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Mode Selection */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {CAMPAIGN_MODES.map((mode) => {
            const Icon = mode.icon
            const isSelected = selectedMode === mode.id
            return (
              <button
                key={mode.id}
                onClick={() => {
                  setSelectedMode(mode.id)
                  setCreatedCampaignId(null)
                }}
                className={`p-4 rounded-lg border-2 text-left transition-all ${
                  isSelected
                    ? "border-violet-600 bg-violet-50 dark:bg-violet-950/30"
                    : "border-border hover:border-violet-300"
                }`}
              >
                <Icon className={`h-5 w-5 mb-2 ${isSelected ? "text-violet-600" : "text-muted-foreground"}`} />
                <p className="font-medium text-sm">{mode.label}</p>
                <p className="text-xs text-muted-foreground mt-1">{mode.description}</p>
              </button>
            )
          })}
        </div>

        {/* Configuration */}
        {selectedMode && (
          <div className="space-y-4 pt-4 border-t">
            <div className="space-y-2">
              <Label>Campaign Name</Label>
              <Input
                value={campaignName}
                onChange={(e) => setCampaignName(e.target.value)}
                placeholder={`${selectedModeConfig?.label} - ${new Date().toLocaleDateString()}`}
              />
            </div>

            {needsListing && (
              <div className="space-y-2">
                <Label>Select Listing</Label>
                <Select value={selectedListingId} onValueChange={setSelectedListingId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a listing" />
                  </SelectTrigger>
                  <SelectContent>
                    {listings.map((listing) => (
                      <SelectItem key={listing.id} value={listing.id}>
                        {listing.address}, {listing.city}
                        {listing.list_price && ` - $${listing.list_price.toLocaleString()}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Channel Preview */}
            <div className="space-y-2">
              <Label>Assets to Generate</Label>
              <div className="flex flex-wrap gap-2">
                {selectedModeConfig?.channels.map((channel) => {
                  const ChannelIcon = CHANNEL_ICONS[channel] || FileText
                  return (
                    <Badge key={channel} variant="secondary" className="flex items-center gap-1">
                      <ChannelIcon className="h-3 w-3" />
                      {channel.replace("_", " ")}
                    </Badge>
                  )
                })}
              </div>
            </div>

            {/* Create Button */}
            {!createdCampaignId && (
              <Button
                onClick={handleCreateCampaign}
                disabled={isCreating || !campaignName || (needsListing && !selectedListingId)}
                className="w-full bg-violet-600 hover:bg-violet-700"
              >
                {isCreating ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Creating Campaign...
                  </>
                ) : (
                  <>
                    <Rocket className="h-4 w-4 mr-2" />
                    Create Campaign & Generate Assets
                  </>
                )}
              </Button>
            )}

            {/* Channel Actions (after campaign created) */}
            {createdCampaignId && (
              <div className="space-y-3">
                <p className="text-sm text-green-600 font-medium">Campaign created! Generate assets:</p>
                <div className="grid grid-cols-2 gap-2">
                  {selectedModeConfig?.channels.map((channel) => {
                    const ChannelIcon = CHANNEL_ICONS[channel] || FileText
                    return (
                      <Link key={channel} href={getChannelRoute(channel)}>
                        <Button variant="outline" size="sm" className="w-full justify-start">
                          <ChannelIcon className="h-4 w-4 mr-2" />
                          {channel.replace("_", " ")}
                          <ChevronRight className="h-4 w-4 ml-auto" />
                        </Button>
                      </Link>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
