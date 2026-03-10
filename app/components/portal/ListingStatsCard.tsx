"use client"

// components/portal/ListingStatsCard.tsx
// Displays listing status banner with key metrics for seller portal.

import Link from "next/link"
import { Card, CardContent } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import { Skeleton } from "@/app/components/ui/skeleton"
import {
  Home,
  Eye,
  Calendar,
  Users,
  ArrowRight,
  Clock,
  TrendingUp,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  LISTING_STATUS_CONFIG,
  type ListingData,
  type ListingMetrics,
  formatPrice,
  calculateDOM,
} from "@/lib/portal/resolve-seller-context"

interface ListingStatsCardProps {
  listing: ListingData | null
  metrics: ListingMetrics | null
  contactId: string
  isLoading?: boolean
}

export function ListingStatsCard({
  listing,
  metrics,
  contactId,
  isLoading = false,
}: ListingStatsCardProps) {
  if (isLoading) {
    return <ListingStatsCardSkeleton />
  }

  // No listing state
  if (!listing) {
    return (
      <Card className="bg-gradient-to-r from-amber-50 to-orange-50 border-amber-200">
        <CardContent className="py-8">
          <div className="flex flex-col items-center text-center space-y-4">
            <div className="h-16 w-16 rounded-full bg-amber-100 flex items-center justify-center">
              <Home className="h-8 w-8 text-amber-600" />
            </div>
            <div className="space-y-2">
              <h3 className="text-lg font-semibold text-amber-900">
                Your Listing Will Appear Here
              </h3>
              <p className="text-sm text-amber-700 max-w-md">
                Once your home is listed, you will see all the important details,
                activity metrics, and market insights right here.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    )
  }

  const status = LISTING_STATUS_CONFIG[listing.listing_status ?? listing.status ?? "active"] ?? 
    LISTING_STATUS_CONFIG.active
  const address = listing.address || listing.property_address || "Your Property"
  const dom = listing.dom ?? calculateDOM(listing.listing_date)

  // Determine banner color based on status
  const isUnderContract = listing.listing_status === "under_contract" || listing.listing_status === "pending"
  const isSold = listing.listing_status === "sold" || listing.listing_status === "closed"
  
  const bannerClass = isSold
    ? "bg-gradient-to-r from-emerald-50 to-green-50 border-emerald-200"
    : isUnderContract
    ? "bg-gradient-to-r from-blue-50 to-indigo-50 border-blue-200"
    : "bg-gradient-to-r from-amber-50 to-orange-50 border-amber-200"

  return (
    <Card className={bannerClass}>
      <CardContent className="py-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          {/* Listing Info */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Home className="h-5 w-5 text-foreground/70" />
              <h2 className="font-semibold text-lg">{address}</h2>
              <Badge className={cn("shrink-0", status.color)}>{status.label}</Badge>
            </div>
            <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">
                {formatPrice(listing.list_price)}
              </span>
              {listing.listing_date && (
                <span className="flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5" />
                  Listed {new Date(listing.listing_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                </span>
              )}
              <span className="flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" />
                {dom} days on market
              </span>
            </div>
          </div>

          {/* Metrics */}
          <div className="flex flex-wrap items-center gap-6">
            <MetricBadge
              icon={Eye}
              label="Views"
              value={metrics?.total_views ?? 0}
            />
            <MetricBadge
              icon={Users}
              label="Showings"
              value={metrics?.showing_count ?? 0}
            />
            <MetricBadge
              icon={TrendingUp}
              label="Inquiries"
              value={metrics?.inquiry_count ?? 0}
            />
            <Button variant="outline" asChild>
              <Link href={`/portal/${contactId}/listing`}>
                View Details
                <ArrowRight className="h-4 w-4 ml-2" />
              </Link>
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function MetricBadge({
  icon: Icon,
  label,
  value,
}: {
  icon: any
  label: string
  value: number
}) {
  return (
    <div className="text-center">
      <div className="flex items-center justify-center gap-1.5">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-xl font-semibold">{value.toLocaleString()}</span>
      </div>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  )
}

function ListingStatsCardSkeleton() {
  return (
    <Card className="bg-gradient-to-r from-slate-50 to-gray-50 border-slate-200">
      <CardContent className="py-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-5 rounded" />
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            <div className="flex items-center gap-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-28" />
            </div>
          </div>
          <div className="flex items-center gap-6">
            <Skeleton className="h-12 w-16" />
            <Skeleton className="h-12 w-16" />
            <Skeleton className="h-12 w-16" />
            <Skeleton className="h-9 w-28" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export { ListingStatsCardSkeleton }
