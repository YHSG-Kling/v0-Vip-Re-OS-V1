"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  Rocket,
  Palette,
  Video,
  Mail,
  Home,
  ExternalLink,
  Loader2,
  Sparkles,
} from "lucide-react"
import { generateListingVideo } from "@/app/actions/listing-video"

interface LaunchActionsPanelProps {
  listingId: string
  agentId: string
  brokerageId: string
  canLaunch: boolean
}

export function LaunchActionsPanel({
  listingId,
  agentId,
  brokerageId,
  canLaunch,
}: LaunchActionsPanelProps) {
  const [isPending, startTransition] = useTransition()
  const [videoStatus, setVideoStatus] = useState<"idle" | "generating" | "success" | "error">("idle")

  const handleGenerateVideo = () => {
    setVideoStatus("generating")
    startTransition(async () => {
      try {
        const result = await generateListingVideo({
          propertyId: listingId,
          agentId,
          videoType: "social_snippet",
        })
        if (result.success) {
          setVideoStatus("success")
        } else {
          setVideoStatus("error")
        }
      } catch {
        setVideoStatus("error")
      }
    })
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-indigo-600" />
          Launch Actions
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {/* Primary Launch Action */}
        <Link href={`/dashboard/listings/${listingId}/lifecycle`}>
          <Button
            size="sm"
            className={`w-full text-xs ${canLaunch ? "bg-green-600 hover:bg-green-700" : ""}`}
            disabled={!canLaunch}
          >
            <Rocket className="h-3.5 w-3.5 mr-1.5" />
            Launch Listing Campaign
          </Button>
        </Link>

        {/* Marketing Studio */}
        <Link href={`/dashboard/listings/${listingId}/marketing-tier`}>
          <Button size="sm" variant="outline" className="w-full text-xs">
            <Palette className="h-3.5 w-3.5 mr-1.5" />
            Open Marketing Studio
          </Button>
        </Link>

        {/* Generate Video */}
        <Button
          size="sm"
          variant="outline"
          className="w-full text-xs"
          onClick={handleGenerateVideo}
          disabled={isPending || videoStatus === "generating"}
        >
          {videoStatus === "generating" ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <Video className="h-3.5 w-3.5 mr-1.5" />
          )}
          {videoStatus === "success"
            ? "Video Generated"
            : videoStatus === "error"
            ? "Try Again"
            : "Generate Listing Video"}
        </Button>

        {/* Seller Update */}
        <Link href={`/dashboard/listings/${listingId}/seller-updates`}>
          <Button size="sm" variant="outline" className="w-full text-xs">
            <Mail className="h-3.5 w-3.5 mr-1.5" />
            Send Seller Launch Update
          </Button>
        </Link>

        {/* Open House */}
        <Link href={`/dashboard/listings/${listingId}/open-house`}>
          <Button size="sm" variant="outline" className="w-full text-xs">
            <Home className="h-3.5 w-3.5 mr-1.5" />
            Open House Promotion
          </Button>
        </Link>

        {/* Public Listing View */}
        <Link href={`/listings/${listingId}`} target="_blank">
          <Button size="sm" variant="ghost" className="w-full text-xs">
            <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
            Preview Public Listing
          </Button>
        </Link>
      </CardContent>
    </Card>
  )
}
