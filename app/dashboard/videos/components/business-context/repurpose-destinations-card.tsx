"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import Link from "next/link"
import {
  ExternalLink,
  Palette,
  Mail,
  Smartphone,
  FileText,
  Heart,
  Users,
} from "lucide-react"
import type { VideoPurpose } from "./video-business-purpose-picker"

export type RepurposeDestination =
  | "portal"
  | "marketing_studio"
  | "email"
  | "social_reel"
  | "seller_update"
  | "homeowner_nurture"

interface DestinationOption {
  id: RepurposeDestination
  label: string
  description: string
  icon: React.ElementType
  route: string | null // null means action-based, not route-based
  requiresListingContext: boolean
  requiresContactContext: boolean
}

// Only destinations with real routes/actions
const DESTINATION_OPTIONS: DestinationOption[] = [
  {
    id: "marketing_studio",
    label: "Marketing Studio",
    description: "Add to marketing campaign assets",
    icon: Palette,
    route: "/dashboard/marketing/studio",
    requiresListingContext: false,
    requiresContactContext: false,
  },
  {
    id: "seller_update",
    label: "Seller Update",
    description: "Attach to seller update communication",
    icon: FileText,
    route: null, // Uses listing ID dynamically
    requiresListingContext: true,
    requiresContactContext: false,
  },
  {
    id: "social_reel",
    label: "Social / Reel",
    description: "Export as short-form vertical video",
    icon: Smartphone,
    route: null, // Generated as variant
    requiresListingContext: false,
    requiresContactContext: false,
  },
  {
    id: "email",
    label: "Email Attachment",
    description: "Generate email-ready video link",
    icon: Mail,
    route: null, // Action-based
    requiresListingContext: false,
    requiresContactContext: false,
  },
]

interface RepurposeDestinationsCardProps {
  purpose: VideoPurpose | null
  selectedDestinations: RepurposeDestination[]
  onToggleDestination: (dest: RepurposeDestination) => void
  listingId?: string
  contactId?: string
}

export function RepurposeDestinationsCard({
  purpose,
  selectedDestinations,
  onToggleDestination,
  listingId,
  contactId,
}: RepurposeDestinationsCardProps) {
  // Filter destinations based on context availability
  const availableDestinations = DESTINATION_OPTIONS.filter((dest) => {
    if (dest.requiresListingContext && !listingId) return false
    if (dest.requiresContactContext && !contactId) return false
    return true
  })

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <ExternalLink className="h-4 w-4" />
          Repurpose Destinations
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Select where to send or repurpose this video after generation
        </p>

        <div className="space-y-2">
          {availableDestinations.map((dest) => {
            const Icon = dest.icon
            const isSelected = selectedDestinations.includes(dest.id)

            return (
              <div
                key={dest.id}
                className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-muted/40 transition-colors"
              >
                <Checkbox
                  id={dest.id}
                  checked={isSelected}
                  onCheckedChange={() => onToggleDestination(dest.id)}
                />
                <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <Label htmlFor={dest.id} className="text-sm font-medium cursor-pointer">
                    {dest.label}
                  </Label>
                  <p className="text-xs text-muted-foreground">{dest.description}</p>
                </div>
                {dest.route && (
                  <Link href={dest.route} target="_blank">
                    <Button size="sm" variant="ghost" className="h-7 text-xs">
                      Open
                    </Button>
                  </Link>
                )}
                {dest.id === "seller_update" && listingId && (
                  <Link href={`/dashboard/listings/${listingId}/seller-updates`} target="_blank">
                    <Button size="sm" variant="ghost" className="h-7 text-xs">
                      Open
                    </Button>
                  </Link>
                )}
              </div>
            )
          })}
        </div>

        {availableDestinations.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-4">
            Select a context above to see available repurpose destinations
          </p>
        )}

        {selectedDestinations.length > 0 && (
          <div className="pt-2 border-t">
            <p className="text-xs text-muted-foreground">
              Selected: {selectedDestinations.length} destination{selectedDestinations.length > 1 ? "s" : ""}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export { DESTINATION_OPTIONS }
