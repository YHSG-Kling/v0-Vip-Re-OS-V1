"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CheckCircle2, XCircle, Image, Video, Camera } from "lucide-react"

interface MediaReadinessCardProps {
  listingId: string
  photoCount: number
  videoCount: number
  hasBranded: boolean
  hasUnbranded: boolean
  minPhotosRequired?: number
}

export function MediaReadinessCard({
  listingId,
  photoCount,
  videoCount,
  hasBranded,
  hasUnbranded,
  minPhotosRequired = 10,
}: MediaReadinessCardProps) {
  const photosComplete = photoCount >= minPhotosRequired
  const videoReady = videoCount > 0
  const isReady = photosComplete

  return (
    <Card className={isReady ? "border-green-200 bg-green-50/30" : "border-amber-200 bg-amber-50/30"}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Image className="h-4 w-4 text-indigo-600" />
            Media Readiness
          </span>
          <Badge variant={isReady ? "default" : "secondary"} className="text-xs">
            {isReady ? "Ready" : "Incomplete"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5">
              {photosComplete ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
              ) : (
                <XCircle className="h-3.5 w-3.5 text-amber-500" />
              )}
              Photos
            </span>
            <span className={photosComplete ? "text-green-700 font-medium" : "text-amber-700"}>
              {photoCount}/{minPhotosRequired}
            </span>
          </div>

          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5">
              {videoReady ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
              ) : (
                <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              Video
            </span>
            <span className={videoReady ? "text-green-700 font-medium" : "text-muted-foreground"}>
              {videoCount > 0 ? `${videoCount} ready` : "Optional"}
            </span>
          </div>

          {(hasBranded || hasUnbranded) && (
            <div className="flex items-center gap-2 text-xs pt-1 border-t">
              {hasBranded && (
                <Badge variant="outline" className="text-xs">Branded</Badge>
              )}
              {hasUnbranded && (
                <Badge variant="outline" className="text-xs">Unbranded</Badge>
              )}
            </div>
          )}
        </div>

        <Link href={`/dashboard/listings/${listingId}/media`}>
          <Button size="sm" variant="outline" className="w-full text-xs">
            <Camera className="h-3.5 w-3.5 mr-1.5" />
            Open Media Manager
          </Button>
        </Link>
      </CardContent>
    </Card>
  )
}
