"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Home, Megaphone, Video, Sparkles } from "lucide-react"

export type ListingVideoMode =
  | "property_tour"
  | "just_listed"
  | "price_reduction"
  | "open_house"
  | "coming_soon"

interface VideoModeOption {
  id: ListingVideoMode
  label: string
  description: string
  suggestedLength: string
  orientation: "landscape" | "portrait" | "square"
}

const LISTING_VIDEO_MODES: VideoModeOption[] = [
  {
    id: "property_tour",
    label: "Property Tour",
    description: "Full walkthrough with feature highlights",
    suggestedLength: "60-90s",
    orientation: "landscape",
  },
  {
    id: "just_listed",
    label: "Just Listed",
    description: "Announcement-style for new listings",
    suggestedLength: "30-45s",
    orientation: "portrait",
  },
  {
    id: "price_reduction",
    label: "Price Reduction",
    description: "Highlight new pricing opportunity",
    suggestedLength: "15-30s",
    orientation: "portrait",
  },
  {
    id: "open_house",
    label: "Open House Invite",
    description: "Drive traffic to your open house",
    suggestedLength: "15-30s",
    orientation: "square",
  },
  {
    id: "coming_soon",
    label: "Coming Soon",
    description: "Build anticipation before launch",
    suggestedLength: "15-30s",
    orientation: "portrait",
  },
]

interface ListingVideoModeCardProps {
  listingData: any | null
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
  if (!listingData) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-muted-foreground text-sm">
          Select a listing above to choose a video mode
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Home className="h-4 w-4" />
          Listing Video Mode
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="p-3 bg-muted/40 rounded-lg">
          <p className="text-sm font-medium">{listingData.address}</p>
          <p className="text-xs text-muted-foreground">
            {listingData.city}, {listingData.state} - ${listingData.list_price?.toLocaleString()}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {LISTING_VIDEO_MODES.map((mode) => {
            const isSelected = selectedMode === mode.id
            return (
              <div
                key={mode.id}
                onClick={() => onSelectMode(mode.id)}
                className={cn(
                  "p-3 rounded-lg border-2 cursor-pointer transition-all",
                  isSelected
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/50"
                )}
              >
                <div className="flex items-start justify-between">
                  <p className="text-sm font-medium">{mode.label}</p>
                  <Badge variant="outline" className="text-[10px]">
                    {mode.suggestedLength}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-1">{mode.description}</p>
                <Badge variant="secondary" className="text-[10px] mt-2">
                  {mode.orientation}
                </Badge>
              </div>
            )
          })}
        </div>

        {selectedMode && (
          <Button
            onClick={onGenerateScript}
            disabled={isGenerating}
            className="w-full"
            size="sm"
          >
            <Sparkles className="h-4 w-4 mr-2" />
            {isGenerating ? "Generating Script..." : "Generate Script for Me"}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

export { LISTING_VIDEO_MODES }
