"use client"

import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import {
  Home,
  TrendingUp,
  Users,
  User,
  Heart,
  Megaphone,
  BookOpen,
  Share2,
} from "lucide-react"

export type VideoPurpose =
  | "listing_launch"
  | "seller_update"
  | "homeowner_update"
  | "market_update"
  | "buyer_education"
  | "referral_ask"
  | "portal_video"
  | "social_cutdown"

interface PurposeOption {
  id: VideoPurpose
  label: string
  description: string
  icon: React.ElementType
  requiresContext: "listing" | "contact" | "homeowner" | "market" | "none"
}

const PURPOSE_OPTIONS: PurposeOption[] = [
  {
    id: "listing_launch",
    label: "Listing Launch",
    description: "Introduce a new listing to market",
    icon: Home,
    requiresContext: "listing",
  },
  {
    id: "seller_update",
    label: "Seller Update",
    description: "Update seller on showing/offer activity",
    icon: TrendingUp,
    requiresContext: "listing",
  },
  {
    id: "homeowner_update",
    label: "Homeowner Update",
    description: "Nurture past clients with market info",
    icon: Heart,
    requiresContext: "homeowner",
  },
  {
    id: "market_update",
    label: "Market Update",
    description: "Share local market trends",
    icon: TrendingUp,
    requiresContext: "market",
  },
  {
    id: "buyer_education",
    label: "Buyer Education",
    description: "Educate buyers on the process",
    icon: BookOpen,
    requiresContext: "none",
  },
  {
    id: "referral_ask",
    label: "Referral Ask",
    description: "Request referrals from your network",
    icon: Users,
    requiresContext: "none",
  },
  {
    id: "portal_video",
    label: "Portal Video",
    description: "Personalized video for client portal",
    icon: User,
    requiresContext: "contact",
  },
  {
    id: "social_cutdown",
    label: "Social Cutdown",
    description: "Short-form content for social media",
    icon: Share2,
    requiresContext: "none",
  },
]

interface VideoBusinessPurposePickerProps {
  selectedPurpose: VideoPurpose | null
  onSelectPurpose: (purpose: VideoPurpose) => void
}

export function VideoBusinessPurposePicker({
  selectedPurpose,
  onSelectPurpose,
}: VideoBusinessPurposePickerProps) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold mb-1">What is this video for?</h3>
        <p className="text-xs text-muted-foreground">
          Select the business purpose to get tailored script suggestions and delivery options
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {PURPOSE_OPTIONS.map((option) => {
          const Icon = option.icon
          const isSelected = selectedPurpose === option.id
          return (
            <Card
              key={option.id}
              onClick={() => onSelectPurpose(option.id)}
              className={cn(
                "cursor-pointer transition-all hover:shadow-md",
                isSelected
                  ? "border-primary bg-primary/5 ring-1 ring-primary"
                  : "border-border hover:border-primary/50"
              )}
            >
              <CardContent className="p-4 text-center">
                <Icon className={cn(
                  "h-6 w-6 mx-auto mb-2",
                  isSelected ? "text-primary" : "text-muted-foreground"
                )} />
                <p className="text-sm font-medium">{option.label}</p>
                <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                  {option.description}
                </p>
                {option.requiresContext !== "none" && (
                  <Badge variant="outline" className="text-[10px] mt-2">
                    Needs {option.requiresContext}
                  </Badge>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}

export { PURPOSE_OPTIONS }
