"use client"

import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AlertTriangle, Sparkles, ArrowRight, MapPin, Clock, Users } from "lucide-react"

interface ListingCommandStripProps {
  listing: {
    id: string
    address: string
    city: string
    state: string
    status: string
    seller_contact?: {
      id: string
      first_name?: string
      last_name?: string
    } | null
  }
  priority: {
    action: string
    reason: string
    urgency: "critical" | "high" | "medium" | "low"
    ctaLabel: string
    ctaHref: string
  }
}

const urgencyStyles = {
  critical: "bg-red-50 border-red-200 text-red-800",
  high: "bg-amber-50 border-amber-200 text-amber-800",
  medium: "bg-blue-50 border-blue-200 text-blue-800",
  low: "bg-muted border-border text-muted-foreground",
}

const urgencyBadge = {
  critical: "destructive",
  high: "secondary",
  medium: "outline",
  low: "outline",
} as const

export function ListingCommandStrip({ listing, priority }: ListingCommandStripProps) {
  const sellerName = listing.seller_contact
    ? `${listing.seller_contact.first_name ?? ""} ${listing.seller_contact.last_name ?? ""}`.trim()
    : null

  return (
    <div className={`p-4 rounded-lg border ${urgencyStyles[priority.urgency]}`}>
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-start gap-3 min-w-0">
          {priority.urgency === "critical" && (
            <AlertTriangle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
          )}
          {priority.urgency !== "critical" && (
            <Sparkles className="h-5 w-5 text-indigo-600 shrink-0 mt-0.5" />
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <span className="font-semibold text-sm">{priority.action}</span>
              <Badge variant={urgencyBadge[priority.urgency]} className="text-xs">
                {priority.urgency === "critical" ? "Urgent" : priority.urgency}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">{priority.reason}</p>
            <div className="flex flex-wrap items-center gap-2 mt-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {listing.address}, {listing.city}
              </span>
              <Badge variant="outline" className="text-xs font-normal capitalize">
                {listing.status}
              </Badge>
              {sellerName && (
                <span className="flex items-center gap-1">
                  <Users className="h-3 w-3" />
                  {sellerName}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="shrink-0">
          <Link href={priority.ctaHref}>
            <Button size="sm" className="gap-1.5">
              {priority.ctaLabel}
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </Link>
        </div>
      </div>
    </div>
  )
}
