"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Megaphone, CheckCircle2, Circle, Video, ImageIcon, Globe, ExternalLink } from "lucide-react"

interface MarketingAsset {
  type: string
  status: "live" | "ready" | "missing"
  label: string
}

interface ListingMarketingStatusProps {
  listingId: string
  assets: MarketingAsset[]
  activeChannels: number
  totalChannels: number
}

export function ListingMarketingStatus({
  listingId,
  assets,
  activeChannels,
  totalChannels,
}: ListingMarketingStatusProps) {
  const live = assets.filter(a => a.status === "live").length
  const missing = assets.filter(a => a.status === "missing").length

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Megaphone className="h-4 w-4 text-purple-600" />
            Marketing Status
          </span>
          <Badge variant={missing > 0 ? "secondary" : "default"} className="text-xs">
            {activeChannels}/{totalChannels} channels
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          {assets.slice(0, 6).map((asset) => (
            <div key={asset.type} className="flex items-center gap-1.5 text-xs">
              {asset.status === "live" && <CheckCircle2 className="h-3 w-3 text-green-600" />}
              {asset.status === "ready" && <Circle className="h-3 w-3 text-blue-600" />}
              {asset.status === "missing" && <Circle className="h-3 w-3 text-muted-foreground" />}
              <span className={asset.status === "missing" ? "text-muted-foreground" : ""}>
                {asset.label}
              </span>
            </div>
          ))}
        </div>
        {missing > 0 && (
          <p className="text-xs text-amber-600">
            {missing} asset{missing > 1 ? "s" : ""} missing
          </p>
        )}
        <div className="flex gap-2 flex-wrap pt-1">
          <Link href={`/dashboard/listings/${listingId}/marketing-tier`}>
            <Button size="sm" variant="outline" className="text-xs gap-1.5">
              <Megaphone className="h-3 w-3" />
              Marketing Studio
            </Button>
          </Link>
          <Link href={`/dashboard/listings/${listingId}/media`}>
            <Button size="sm" variant="outline" className="text-xs gap-1.5">
              <Video className="h-3 w-3" />
              Video Studio
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}
