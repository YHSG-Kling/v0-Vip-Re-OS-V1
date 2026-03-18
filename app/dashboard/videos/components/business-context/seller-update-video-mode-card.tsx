"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { TrendingUp, Sparkles, Eye, FileText, Calendar, DollarSign } from "lucide-react"

export type SellerUpdateMode =
  | "weekly_recap"
  | "showing_feedback"
  | "offer_received"
  | "market_context"
  | "price_strategy"

interface UpdateModeOption {
  id: SellerUpdateMode
  label: string
  description: string
  dataNeeded: string
  icon: React.ElementType
}

const SELLER_UPDATE_MODES: UpdateModeOption[] = [
  {
    id: "weekly_recap",
    label: "Weekly Recap",
    description: "Summarize activity from the past week",
    dataNeeded: "Showings, views, inquiries",
    icon: Calendar,
  },
  {
    id: "showing_feedback",
    label: "Showing Feedback",
    description: "Share buyer feedback from recent showings",
    dataNeeded: "Feedback responses",
    icon: Eye,
  },
  {
    id: "offer_received",
    label: "Offer Received",
    description: "Present and explain an incoming offer",
    dataNeeded: "Offer details",
    icon: FileText,
  },
  {
    id: "market_context",
    label: "Market Context",
    description: "Explain current market conditions",
    dataNeeded: "Local market data",
    icon: TrendingUp,
  },
  {
    id: "price_strategy",
    label: "Price Strategy",
    description: "Discuss pricing adjustments or strategy",
    dataNeeded: "Comparable data",
    icon: DollarSign,
  },
]

interface SellerUpdateVideoModeCardProps {
  listingData: any | null
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
  if (!listingData) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-muted-foreground text-sm">
          Select a listing above to create a seller update video
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <TrendingUp className="h-4 w-4" />
          Seller Update Video
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="p-3 bg-muted/40 rounded-lg">
          <p className="text-sm font-medium">{listingData.address}</p>
          <p className="text-xs text-muted-foreground">
            Update your seller with a personalized video message
          </p>
        </div>

        <div className="space-y-2">
          {SELLER_UPDATE_MODES.map((mode) => {
            const Icon = mode.icon
            const isSelected = selectedMode === mode.id
            return (
              <div
                key={mode.id}
                onClick={() => onSelectMode(mode.id)}
                className={cn(
                  "p-3 rounded-lg border-2 cursor-pointer transition-all flex items-start gap-3",
                  isSelected
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/50"
                )}
              >
                <Icon className={cn(
                  "h-5 w-5 mt-0.5 shrink-0",
                  isSelected ? "text-primary" : "text-muted-foreground"
                )} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{mode.label}</p>
                  <p className="text-xs text-muted-foreground">{mode.description}</p>
                  <Badge variant="outline" className="text-[10px] mt-1">
                    Uses: {mode.dataNeeded}
                  </Badge>
                </div>
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
            {isGenerating ? "Generating Update..." : "Generate Seller Update Script"}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

export { SELLER_UPDATE_MODES }
