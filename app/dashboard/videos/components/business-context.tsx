"use client"

import { useState, useEffect } from "react"
import { createClient } from "@/lib/supabase/client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Home,
  TrendingUp,
  Users,
  User,
  Share2,
  Building2,
  MessageCircle,
  MapPin,
  Search,
  Sparkles,
  Loader2,
  CheckCircle2,
  Play,
  BarChart3,
} from "lucide-react"
import { cn } from "@/lib/utils"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type VideoPurpose =
  | "listing_launch"
  | "seller_update"
  | "market_update"
  | "agent_brand"
  | "portal_video"
  | "homeowner_update"
  | "just_sold"
  | "farming"

export type RepurposeDestination =
  | "instagram_reels"
  | "tiktok"
  | "youtube_shorts"
  | "facebook"
  | "linkedin"
  | "email"
  | "portal"
  | "sms"

export type ListingVideoMode =
  | "full_tour"
  | "highlight_reel"
  | "neighborhood"
  | "market_context"

export type SellerUpdateMode =
  | "activity_update"
  | "price_strategy"
  | "market_comparison"
  | "offer_review"

// ─── PURPOSE DEFINITIONS ──────────────────────────────────────────────────────

const VIDEO_PURPOSES: {
  id: VideoPurpose
  label: string
  icon: React.ElementType
  description: string
  badge?: string
  requiresContext: boolean
  contextType?: "listing" | "contact" | "homeowner" | "market"
}[] = [
  {
    id: "listing_launch",
    label: "New Listing Launch",
    icon: Home,
    description: "Launch a new listing with an AI avatar video",
    badge: "Popular",
    requiresContext: true,
    contextType: "listing",
  },
  {
    id: "seller_update",
    label: "Seller Update",
    icon: BarChart3,
    description: "Send a personal video update to a seller",
    requiresContext: true,
    contextType: "listing",
  },
  {
    id: "market_update",
    label: "Market Update",
    icon: TrendingUp,
    description: "Share local market stats with your sphere",
    requiresContext: false,
    contextType: "market",
  },
  {
    id: "agent_brand",
    label: "Agent Introduction",
    icon: User,
    description: "Personal brand intro video for new contacts",
    requiresContext: false,
  },
  {
    id: "portal_video",
    label: "Portal Welcome Video",
    icon: Building2,
    description: "Welcome video for your client portal",
    requiresContext: false,
  },
  {
    id: "homeowner_update",
    label: "Homeowner Update",
    icon: MessageCircle,
    description: "Equity or market update for a homeowner",
    requiresContext: true,
    contextType: "homeowner",
  },
  {
    id: "just_sold",
    label: "Just Sold Announcement",
    icon: CheckCircle2,
    description: "Celebrate a closed deal and build social proof",
    requiresContext: false,
  },
  {
    id: "farming",
    label: "Neighborhood Farming",
    icon: MapPin,
    description: "Hyper-local market video for a farm area",
    requiresContext: false,
  },
]

// ─── REPURPOSE DESTINATIONS ──────────────────────────────────────────────────

const REPURPOSE_DESTINATIONS: {
  id: RepurposeDestination
  label: string
  description: string
}[] = [
  { id: "instagram_reels", label: "Instagram Reels", description: "9:16 vertical" },
  { id: "tiktok", label: "TikTok", description: "9:16 vertical" },
  { id: "youtube_shorts", label: "YouTube Shorts", description: "9:16 vertical" },
  { id: "facebook", label: "Facebook", description: "16:9 or square" },
  { id: "linkedin", label: "LinkedIn", description: "16:9 horizontal" },
  { id: "email", label: "Email Campaign", description: "Embedded thumbnail" },
  { id: "portal", label: "Client Portal", description: "Pinned welcome" },
  { id: "sms", label: "SMS / Text", description: "Link preview" },
]

// ─── LISTING VIDEO MODES ─────────────────────────────────────────────────────

const LISTING_VIDEO_MODES: {
  id: ListingVideoMode
  label: string
  description: string
}[] = [
  { id: "full_tour", label: "Full Property Tour", description: "Walk through every room" },
  { id: "highlight_reel", label: "Highlight Reel", description: "Best features in 30s" },
  { id: "neighborhood", label: "Neighborhood Spotlight", description: "Lifestyle and location" },
  { id: "market_context", label: "Market Context", description: "How this listing fits the market" },
]

// ─── SELLER UPDATE MODES ─────────────────────────────────────────────────────

const SELLER_UPDATE_MODES: {
  id: SellerUpdateMode
  label: string
  description: string
}[] = [
  { id: "activity_update", label: "Activity Update", description: "Showings, inquiries, feedback" },
  { id: "price_strategy", label: "Price Strategy", description: "Pricing discussion and recommendations" },
  { id: "market_comparison", label: "Market Comparison", description: "How comp sales affect your listing" },
  { id: "offer_review", label: "Offer Review", description: "Walk through an offer together" },
]

// ─── VideoBusinessPurposePicker ────────────────────────────────────────────────

interface VideoBusinessPurposePickerProps {
  selectedPurpose: VideoPurpose | null
  onSelectPurpose: (purpose: VideoPurpose) => void
}

export function VideoBusinessPurposePicker({
  selectedPurpose,
  onSelectPurpose,
}: VideoBusinessPurposePickerProps) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      {VIDEO_PURPOSES.map((purpose) => {
        const Icon = purpose.icon
        return (
          <div
            key={purpose.id}
            onClick={() => onSelectPurpose(purpose.id)}
            className={cn(
              "relative p-4 rounded-lg border-2 cursor-pointer transition-all",
              selectedPurpose === purpose.id
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/50 hover:bg-muted/30"
            )}
          >
            {purpose.badge && (
              <Badge variant="secondary" className="absolute top-2 right-2 text-xs">
                {purpose.badge}
              </Badge>
            )}
            <Icon className="h-6 w-6 mb-2 text-muted-foreground" />
            <p className="font-medium text-sm">{purpose.label}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{purpose.description}</p>
            {selectedPurpose === purpose.id && (
              <CheckCircle2 className="h-4 w-4 text-primary absolute bottom-2 right-2" />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── VideoContextPicker ────────────────────────────────────────────────────────

interface VideoContextPickerProps {
  purpose: VideoPurpose
  brokerageId: string
  agentId: string
  selectedContextId: string
  selectedContextType: "listing" | "contact" | "homeowner" | "market" | "none"
  onSelectContext: (id: string, type: "listing" | "contact" | "homeowner" | "market" | "none", data: any) => void
}

export function VideoContextPicker({
  purpose,
  brokerageId,
  agentId,
  selectedContextId,
  selectedContextType,
  onSelectContext,
}: VideoContextPickerProps) {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const supabase = createClient()

  const purposeDef = VIDEO_PURPOSES.find((p) => p.id === purpose)
  const contextType = purposeDef?.contextType

  // Market area doesn't need search — let user type it in directly
  if (contextType === "market" || !contextType) {
    if (contextType === "market") {
      return (
        <div className="space-y-2">
          <Label>Market Area</Label>
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              onSelectContext(e.target.value, "market", { area: e.target.value })
            }}
            placeholder="e.g. Downtown Austin, Zip 78701, Travis County"
            className="max-w-md"
          />
          {query && (
            <p className="text-xs text-muted-foreground">
              Market update will be generated for: <strong>{query}</strong>
            </p>
          )}
        </div>
      )
    }
    return null
  }

  async function handleSearch(value: string) {
    setQuery(value)
    if (!value.trim() || !brokerageId) return

    setLoading(true)
    try {
      if (contextType === "listing") {
        const { data } = await supabase
          .from("listings")
          .select("id, address, city, state, list_price, bedrooms, bathrooms, sqft, status, listing_photos")
          .eq("brokerage_id", brokerageId)
          .or(`address.ilike.%${value}%,city.ilike.%${value}%`)
          .in("status", ["active", "pending", "under_contract"])
          .order("created_at", { ascending: false })
          .limit(8)

        setResults(data ?? [])
      } else if (contextType === "homeowner") {
        const { data } = await supabase
          .from("contacts")
          .select("id, first_name, last_name, email, phone, contact_type, address")
          .eq("brokerage_id", brokerageId)
          .eq("contact_type", "homeowner")
          .or(`first_name.ilike.%${value}%,last_name.ilike.%${value}%,address.ilike.%${value}%`)
          .order("created_at", { ascending: false })
          .limit(8)

        setResults(data ?? [])
      } else {
        // Generic contact search
        const { data } = await supabase
          .from("contacts")
          .select("id, first_name, last_name, email, phone, contact_type")
          .eq("brokerage_id", brokerageId)
          .or(`first_name.ilike.%${value}%,last_name.ilike.%${value}%,email.ilike.%${value}%`)
          .order("created_at", { ascending: false })
          .limit(8)

        setResults(data ?? [])
      }
    } catch (err) {
      console.error("Context search error:", err)
    } finally {
      setLoading(false)
    }
  }

  const placeholder =
    contextType === "listing"
      ? "Search listings by address or city..."
      : contextType === "homeowner"
        ? "Search homeowners by name or address..."
        : "Search contacts..."

  const labelText =
    contextType === "listing"
      ? "Select Listing"
      : contextType === "homeowner"
        ? "Select Homeowner"
        : "Select Contact"

  return (
    <div className="space-y-3">
      <Label>{labelText}</Label>
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder={placeholder}
          className="pl-9"
        />
        {loading && <Loader2 className="absolute right-3 top-2.5 h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      {/* Selected Item */}
      {selectedContextId && selectedContextType !== "none" && (
        <div className="flex items-center gap-2 p-2 bg-primary/5 border border-primary/20 rounded-lg max-w-md">
          <CheckCircle2 className="h-4 w-4 text-primary flex-shrink-0" />
          <span className="text-sm font-medium truncate">Context selected</span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 text-xs"
            onClick={() => {
              setQuery("")
              setResults([])
              onSelectContext("", "none", null)
            }}
          >
            Clear
          </Button>
        </div>
      )}

      {/* Results */}
      {results.length > 0 && !selectedContextId && (
        <div className="space-y-2 max-w-md">
          {results.map((item) => {
            if (contextType === "listing") {
              return (
                <div
                  key={item.id}
                  onClick={() => {
                    onSelectContext(item.id, "listing", item)
                    setQuery(item.address)
                    setResults([])
                  }}
                  className="flex items-start gap-3 p-3 rounded-lg border cursor-pointer hover:bg-muted/50 transition-colors"
                >
                  <Home className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{item.address}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.city}, {item.state} &bull;{" "}
                      {item.list_price ? `$${Number(item.list_price).toLocaleString()}` : "Price TBD"}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      {item.bedrooms && <Badge variant="outline" className="text-xs">{item.bedrooms}bd</Badge>}
                      {item.bathrooms && <Badge variant="outline" className="text-xs">{item.bathrooms}ba</Badge>}
                      <Badge variant="secondary" className="text-xs">{item.status}</Badge>
                    </div>
                  </div>
                </div>
              )
            } else {
              return (
                <div
                  key={item.id}
                  onClick={() => {
                    onSelectContext(item.id, contextType === "homeowner" ? "homeowner" : "contact", item)
                    setQuery(`${item.first_name} ${item.last_name}`)
                    setResults([])
                  }}
                  className="flex items-start gap-3 p-3 rounded-lg border cursor-pointer hover:bg-muted/50 transition-colors"
                >
                  <User className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="font-medium text-sm">
                      {item.first_name} {item.last_name}
                    </p>
                    <p className="text-xs text-muted-foreground">{item.email}</p>
                    {item.address && (
                      <p className="text-xs text-muted-foreground">{item.address}</p>
                    )}
                  </div>
                </div>
              )
            }
          })}
        </div>
      )}

      {query.length > 2 && results.length === 0 && !loading && (
        <p className="text-sm text-muted-foreground">No results found for &ldquo;{query}&rdquo;</p>
      )}
    </div>
  )
}

// ─── RepurposeDestinationsCard ────────────────────────────────────────────────

// Maps social_accounts.platform values to RepurposeDestination IDs
// Non-social destinations (email, portal, sms) are always available
const ALWAYS_CONNECTED: RepurposeDestination[] = ["email", "portal", "sms"]
const PLATFORM_TO_DESTINATION: Record<string, RepurposeDestination> = {
  instagram: "instagram_reels",
  tiktok: "tiktok",
  facebook: "facebook",
  linkedin: "linkedin",
}

interface RepurposeDestinationsCardProps {
  purpose: VideoPurpose
  selectedDestinations: RepurposeDestination[]
  onToggleDestination: (dest: RepurposeDestination) => void
  connectedPlatforms?: string[]
  listingId?: string
  contactId?: string
}

export function RepurposeDestinationsCard({
  purpose,
  selectedDestinations,
  onToggleDestination,
  connectedPlatforms = [],
}: RepurposeDestinationsCardProps) {
  // Build a set of destinations that have an active social account
  const connectedDestinations = new Set<RepurposeDestination>([
    ...ALWAYS_CONNECTED,
    ...connectedPlatforms
      .map((p) => PLATFORM_TO_DESTINATION[p])
      .filter((d): d is RepurposeDestination => !!d),
  ])

  return (
    <div className="space-y-3">
      <div>
        <Label className="text-base">Where will you share this video?</Label>
        <p className="text-xs text-muted-foreground mt-0.5">
          Select all channels — we will format the output accordingly
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {REPURPOSE_DESTINATIONS.map((dest) => {
          const selected = selectedDestinations.includes(dest.id)
          const isConnected = connectedDestinations.has(dest.id)
          return (
            <button
              key={dest.id}
              type="button"
              onClick={() => onToggleDestination(dest.id)}
              title={!isConnected ? `Connect ${dest.label} in Profile Settings to publish here` : undefined}
              className={cn(
                "flex flex-col items-start px-3 py-1.5 rounded-full border text-sm transition-all",
                selected
                  ? "border-primary bg-primary text-primary-foreground"
                  : isConnected
                    ? "border-border hover:border-primary/50"
                    : "border-dashed border-border text-muted-foreground hover:border-primary/40"
              )}
            >
              <span className="flex items-center gap-1.5">
                {selected && <CheckCircle2 className="h-3 w-3" />}
                {dest.label}
              </span>
              {!isConnected && (
                <span className="text-[10px] leading-none mt-0.5 opacity-70">Not connected</span>
              )}
            </button>
          )
        })}
      </div>
      {selectedDestinations.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Output will be optimized for: {selectedDestinations.join(", ")}
        </p>
      )}
    </div>
  )
}

// ─── ListingVideoModeCard ──────────────────────────────────────────────────────

interface ListingVideoModeCardProps {
  listingData: any
  selectedMode: ListingVideoMode | null
  onSelectMode: (mode: ListingVideoMode) => void
  onGenerateScript: () => void
  isGenerating: boolean
}

export function ListingVideoModeCard({
  listingData,
  selectedMode,
  onSelectMode,
  onGenerateScript,
  isGenerating,
}: ListingVideoModeCardProps) {
  return (
    <Card className="border border-primary/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Home className="h-4 w-4" />
          Listing Video Style
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {listingData?.address} &bull; {listingData?.list_price ? `$${Number(listingData.list_price).toLocaleString()}` : ""}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          {LISTING_VIDEO_MODES.map((mode) => (
            <div
              key={mode.id}
              onClick={() => onSelectMode(mode.id)}
              className={cn(
                "p-3 rounded-lg border cursor-pointer transition-all",
                selectedMode === mode.id
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/40"
              )}
            >
              <p className="font-medium text-sm">{mode.label}</p>
              <p className="text-xs text-muted-foreground">{mode.description}</p>
            </div>
          ))}
        </div>

        {selectedMode && (
          <Button
            onClick={onGenerateScript}
            disabled={isGenerating}
            className="w-full"
            size="sm"
          >
            {isGenerating ? (
              <>
                <Loader2 className="h-3 w-3 mr-2 animate-spin" />
                Generating Script...
              </>
            ) : (
              <>
                <Sparkles className="h-3 w-3 mr-2" />
                Generate Script for This Listing
              </>
            )}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

// ─── SellerUpdateVideoModeCard ────────────────────────────────────────────────

interface SellerUpdateVideoModeCardProps {
  listingData: any
  selectedMode: SellerUpdateMode | null
  onSelectMode: (mode: SellerUpdateMode) => void
  onGenerateScript: () => void
  isGenerating: boolean
}

export function SellerUpdateVideoModeCard({
  listingData,
  selectedMode,
  onSelectMode,
  onGenerateScript,
  isGenerating,
}: SellerUpdateVideoModeCardProps) {
  return (
    <Card className="border border-primary/20">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <BarChart3 className="h-4 w-4" />
          Seller Update Type
        </CardTitle>
        {listingData?.address && (
          <p className="text-xs text-muted-foreground">{listingData.address}</p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          {SELLER_UPDATE_MODES.map((mode) => (
            <div
              key={mode.id}
              onClick={() => onSelectMode(mode.id)}
              className={cn(
                "p-3 rounded-lg border cursor-pointer transition-all",
                selectedMode === mode.id
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/40"
              )}
            >
              <p className="font-medium text-sm">{mode.label}</p>
              <p className="text-xs text-muted-foreground">{mode.description}</p>
            </div>
          ))}
        </div>

        {selectedMode && (
          <Button
            onClick={onGenerateScript}
            disabled={isGenerating}
            className="w-full"
            size="sm"
          >
            {isGenerating ? (
              <>
                <Loader2 className="h-3 w-3 mr-2 animate-spin" />
                Generating Script...
              </>
            ) : (
              <>
                <Sparkles className="h-3 w-3 mr-2" />
                Generate Seller Update Script
              </>
            )}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
