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
  AlertCircle,
  Share2,
  QrCode,
} from "lucide-react"
import { generateListingVideo } from "@/app/actions/listing-video"
import { runDealPlayAction } from "@/app/actions/deal-play"

interface LaunchActionsPanelProps {
  listingId: string
  agentId: string
  brokerageId: string
  canLaunch: boolean
  /** Blocker messages to display inline so the agent knows what to fix */
  blockers?: string[]
  /** Marketing tier is superadmin-only — only show the Studio link to superadmins */
  isSuperAdmin?: boolean
}

export function LaunchActionsPanel({
  listingId,
  agentId,
  brokerageId,
  canLaunch,
  blockers = [],
  isSuperAdmin = false,
}: LaunchActionsPanelProps) {
  const [isPending, startTransition] = useTransition()
  const [videoStatus, setVideoStatus] = useState<"idle" | "generating" | "success" | "error">("idle")
  const [playStatus, setPlayStatus] = useState<"idle" | "running" | "done" | "already" | "error">("idle")
  const [playSummary, setPlaySummary] = useState<string | null>(null)

  // THE DEAL PLAY — the whole AI team works this listing in one narrated pass:
  // Listing Concierge stages the launch → Asset Manager cuts the reel →
  // Campaign Orchestrator drafts the channels → Ads Manager stages the ad.
  // Everything lands gated; the command center narrates the handoffs.
  const handleDealPlay = () => {
    setPlayStatus("running")
    setPlaySummary(null)
    startTransition(async () => {
      try {
        const r = await runDealPlayAction(listingId)
        if (!r.ok) { setPlayStatus("error"); setPlaySummary(r.reason ?? "The play could not run."); return }
        if (r.alreadyRan) { setPlayStatus("already"); setPlaySummary("The play already ran for this listing — see the command center for its handoffs."); return }
        setPlayStatus("done")
        setPlaySummary(
          `Staged, all awaiting your approval: ${r.reels} reel, ${r.channelsStaged} channel drafts, ` +
          `${r.openHousesProposed} open-house draft, ${r.adsStaged} ad draft(s). ` +
          `${r.handoffs} manager handoffs narrated in the command center.`,
        )
      } catch {
        setPlayStatus("error")
        setPlaySummary("The play could not run.")
      }
    })
  }

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
        <Link href={`/dashboard/listings/${listingId}/marketing-tier`}>
          <Button
            size="sm"
            className={`w-full text-xs ${canLaunch ? "bg-green-600 hover:bg-green-700" : ""}`}
            disabled={!canLaunch}
          >
            <Rocket className="h-3.5 w-3.5 mr-1.5" />
            Launch Listing Campaign
          </Button>
        </Link>

        {/* Inline blockers — shown only when launch is blocked */}
        {blockers.length > 0 && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-2 space-y-1">
            {blockers.map((blocker, i) => (
              <div key={i} className="flex items-start gap-1.5 text-xs text-amber-800">
                <AlertCircle className="h-3 w-3 mt-0.5 shrink-0 text-amber-600" />
                <span>{blocker}</span>
              </div>
            ))}
          </div>
        )}

        {/* Marketing Studio — superadmin only */}
        {isSuperAdmin && (
          <Link href={`/dashboard/listings/${listingId}/marketing-tier`}>
            <Button size="sm" variant="outline" className="w-full text-xs">
              <Palette className="h-3.5 w-3.5 mr-1.5" />
              Open Marketing Studio
            </Button>
          </Link>
        )}

        {/* THE DEAL PLAY — one click, the whole AI team, every artifact gated */}
        <Button
          size="sm"
          className="w-full text-xs bg-indigo-600 hover:bg-indigo-700"
          onClick={handleDealPlay}
          disabled={isPending || playStatus === "running" || playStatus === "done" || playStatus === "already"}
        >
          {playStatus === "running" ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <Share2 className="h-3.5 w-3.5 mr-1.5" />
          )}
          {playStatus === "done" ? "Deal Play staged ✓"
            : playStatus === "already" ? "Deal Play already ran"
            : playStatus === "running" ? "AI team working…"
            : "Run the Deal Play (AI team)"}
        </Button>
        {playSummary && (
          <p className={`text-[11px] ${playStatus === "error" ? "text-red-600" : "text-muted-foreground"}`}>{playSummary}</p>
        )}

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

        {/* Share + QR */}
        <Link href={`/dashboard/listings/${listingId}/share`}>
          <Button size="sm" variant="outline" className="w-full text-xs">
            <QrCode className="h-3.5 w-3.5 mr-1.5" />
            QR Code & Sharing
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
