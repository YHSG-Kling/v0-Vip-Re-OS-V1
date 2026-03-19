"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/app/components/ui/card"
import { Badge } from "@/app/components/ui/badge"
import { Button } from "@/app/components/ui/button"
import { Activity, Eye, Camera, Calendar, ArrowRight, TrendingUp } from "lucide-react"

interface ListingActivityCardProps {
  contactId: string
  listingStatus: string | null
  showingsThisWeek: number
  totalShowings: number
  totalViews: number
  photoCount: number
  isPublished: boolean
  launchDate: string | null
}

export function ListingActivityCard({
  contactId,
  listingStatus,
  showingsThisWeek,
  totalShowings,
  totalViews,
  photoCount,
  isPublished,
  launchDate,
}: ListingActivityCardProps) {
  const statusConfig: Record<string, { label: string; color: string }> = {
    active: { label: "Active", color: "bg-green-100 text-green-800" },
    pending: { label: "Pending", color: "bg-amber-100 text-amber-800" },
    under_contract: { label: "Under Contract", color: "bg-blue-100 text-blue-800" },
    coming_soon: { label: "Coming Soon", color: "bg-purple-100 text-purple-800" },
    sold: { label: "Sold", color: "bg-slate-100 text-slate-600" },
  }

  const status = statusConfig[listingStatus || "active"] || statusConfig.active

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Listing Activity
          </CardTitle>
          <Badge className={status.color}>{status.label}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Launch Status */}
        {launchDate && (
          <div className="flex items-center gap-2 text-sm">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">Listed</span>
            <span className="font-medium">
              {new Date(launchDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            </span>
          </div>
        )}

        {/* Activity Metrics */}
        <div className="grid grid-cols-2 gap-3">
          <div className="p-3 rounded-lg bg-muted/50">
            <div className="flex items-center gap-2 mb-1">
              <Eye className="h-4 w-4 text-blue-600" />
              <span className="text-xs text-muted-foreground">Total Views</span>
            </div>
            <p className="text-xl font-semibold">{totalViews.toLocaleString()}</p>
          </div>
          <div className="p-3 rounded-lg bg-muted/50">
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp className="h-4 w-4 text-emerald-600" />
              <span className="text-xs text-muted-foreground">This Week</span>
            </div>
            <p className="text-xl font-semibold">{showingsThisWeek} showings</p>
          </div>
        </div>

        {/* Media Status */}
        <div className="flex items-center justify-between p-3 rounded-lg border">
          <div className="flex items-center gap-2">
            <Camera className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm">{photoCount} photos</span>
          </div>
          <Badge variant={isPublished ? "default" : "secondary"}>
            {isPublished ? "Published" : "Draft"}
          </Badge>
        </div>

        {/* Summary */}
        <p className="text-sm text-muted-foreground">
          Your listing has had <span className="font-medium text-foreground">{totalShowings} total showings</span> and{" "}
          <span className="font-medium text-foreground">{totalViews.toLocaleString()} online views</span>.
        </p>

        {/* CTA */}
        <Button variant="outline" size="sm" asChild className="w-full">
          <Link href={`/portal/${contactId}/showings`}>
            View All Showings
            <ArrowRight className="h-4 w-4 ml-2" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  )
}
