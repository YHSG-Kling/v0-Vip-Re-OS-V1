"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { MessageSquare, Clock, Sparkles, Video, ExternalLink } from "lucide-react"

interface SellerCommunicationsProps {
  listingId: string
  sellerId?: string
  lastUpdateSent?: string
  nextUpdateReady: boolean
  daysSinceLastUpdate?: number
}

export function ListingSellerCommunications({
  listingId,
  sellerId,
  lastUpdateSent,
  nextUpdateReady,
  daysSinceLastUpdate,
}: SellerCommunicationsProps) {
  const overdue = daysSinceLastUpdate !== undefined && daysSinceLastUpdate > 7

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-teal-600" />
            Seller Communications
          </span>
          {nextUpdateReady && (
            <Badge className="text-xs bg-teal-600">Update Ready</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-xs space-y-1">
          {lastUpdateSent ? (
            <p className={overdue ? "text-amber-600" : "text-muted-foreground"}>
              <Clock className="h-3 w-3 inline mr-1" />
              Last update: {new Date(lastUpdateSent).toLocaleDateString()}
              {daysSinceLastUpdate !== undefined && (
                <span className="ml-1">({daysSinceLastUpdate}d ago)</span>
              )}
            </p>
          ) : (
            <p className="text-muted-foreground">No updates sent yet</p>
          )}
          {overdue && (
            <p className="text-amber-600 font-medium">Seller update overdue</p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <Link href={`/dashboard/listings/${listingId}/seller-updates`}>
            <Button size="sm" variant="outline" className="w-full text-xs gap-1.5">
              <Sparkles className="h-3 w-3" />
              {nextUpdateReady ? "Send Seller Update" : "Generate Update"}
            </Button>
          </Link>
          {sellerId && (
            <Link href={`/portal/seller/${sellerId}?listing=${listingId}`} target="_blank">
              <Button size="sm" variant="ghost" className="w-full text-xs gap-1.5">
                <ExternalLink className="h-3 w-3" />
                View Seller Portal
              </Button>
            </Link>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
