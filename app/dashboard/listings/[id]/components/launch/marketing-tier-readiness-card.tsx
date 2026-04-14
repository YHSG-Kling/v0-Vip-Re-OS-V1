"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CheckCircle2, XCircle, Megaphone, TrendingUp } from "lucide-react"

interface MarketingTierReadinessCardProps {
  listingId: string
  currentTier: { id: string; tier_name: string; description?: string } | null
  campaignReady: boolean
  assetsCreated: number
  assetsRequired: number
  isSuperAdmin?: boolean
}

export function MarketingTierReadinessCard({
  listingId,
  currentTier,
  campaignReady,
  assetsCreated,
  assetsRequired,
  isSuperAdmin = false,
}: MarketingTierReadinessCardProps) {
  const hasTier = !!currentTier
  const assetsComplete = assetsCreated >= assetsRequired
  const isReady = hasTier && campaignReady

  return (
    <Card className={isReady ? "border-green-200 bg-green-50/30" : "border-amber-200 bg-amber-50/30"}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-2 min-w-0 truncate">
            <Megaphone className="h-4 w-4 text-indigo-600 shrink-0" />
            Marketing Tier
          </span>
          <Badge variant={isReady ? "default" : "secondary"} className="text-xs shrink-0">
            {isReady ? "Campaign Ready" : "Setup Needed"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5">
              {hasTier ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
              ) : (
                <XCircle className="h-3.5 w-3.5 text-amber-500" />
              )}
              Tier Assigned
            </span>
            {currentTier && (
              <Badge variant="outline" className="text-xs font-medium">
                {currentTier.tier_name}
              </Badge>
            )}
          </div>

          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5">
              {campaignReady ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
              ) : (
                <XCircle className="h-3.5 w-3.5 text-amber-500" />
              )}
              Campaign Created
            </span>
            <span className={campaignReady ? "text-green-700 font-medium" : "text-amber-700"}>
              {campaignReady ? "Active" : "Not Started"}
            </span>
          </div>

          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5">
              {assetsComplete ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
              ) : (
                <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              Marketing Assets
            </span>
            <span className={assetsComplete ? "text-green-700 font-medium" : "text-muted-foreground"}>
              {assetsCreated}/{assetsRequired}
            </span>
          </div>
        </div>

        {currentTier?.description && (
          <p className="text-xs text-muted-foreground bg-muted/50 p-2 rounded">
            {currentTier.description}
          </p>
        )}

        {isSuperAdmin && (
          <Link href={`/dashboard/listings/${listingId}/marketing-tier`}>
            <Button size="sm" variant="outline" className="w-full text-xs">
              <TrendingUp className="h-3.5 w-3.5 mr-1.5" />
              Marketing Settings
            </Button>
          </Link>
        )}
      </CardContent>
    </Card>
  )
}
