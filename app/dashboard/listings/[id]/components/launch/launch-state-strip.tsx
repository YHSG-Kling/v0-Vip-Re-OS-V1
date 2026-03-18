"use client"

import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Rocket, AlertTriangle, CheckCircle2, Clock } from "lucide-react"
import type { ListingStage } from "@/lib/listing-lifecycle/lifecycle-definitions"

interface LaunchStateStripProps {
  listingId: string
  currentStage: ListingStage
  mediaReady: boolean
  publishReady: boolean
  marketingReady: boolean
  blockers: string[]
}

export function LaunchStateStrip({
  listingId,
  currentStage,
  mediaReady,
  publishReady,
  marketingReady,
  blockers,
}: LaunchStateStripProps) {
  const readinessScore = [mediaReady, publishReady, marketingReady].filter(Boolean).length
  const isLaunchReady = readinessScore === 3 && blockers.length === 0
  const canLaunch = currentStage === "ACTIVE_PREP" || currentStage === "COMING_SOON"

  const stageLabels: Record<string, string> = {
    LEAD: "Lead",
    SIGNED: "Agreement Signed",
    ACTIVE_PREP: "Preparing to Launch",
    COMING_SOON: "Coming Soon",
    ACTIVE: "Active on Market",
    UNDER_CONTRACT: "Under Contract",
    PENDING: "Pending",
    CLOSED: "Closed",
    WITHDRAWN: "Withdrawn",
    EXPIRED: "Expired",
  }

  return (
    <div className="p-4 bg-gradient-to-r from-indigo-50 to-blue-50 border border-indigo-100 rounded-lg">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-full ${isLaunchReady ? 'bg-green-100' : 'bg-amber-100'}`}>
            {isLaunchReady ? (
              <Rocket className="h-5 w-5 text-green-700" />
            ) : (
              <Clock className="h-5 w-5 text-amber-700" />
            )}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-foreground">Launch Status</h3>
              <Badge variant={isLaunchReady ? "default" : "secondary"} className="text-xs">
                {stageLabels[currentStage] || currentStage}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {isLaunchReady
                ? "All systems ready for launch"
                : `${3 - readinessScore} item${3 - readinessScore !== 1 ? 's' : ''} remaining before launch`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs">
            {mediaReady ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
            ) : (
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
            )}
            <span className={mediaReady ? "text-green-700" : "text-amber-700"}>Media</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            {publishReady ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
            ) : (
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
            )}
            <span className={publishReady ? "text-green-700" : "text-amber-700"}>Publish</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            {marketingReady ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
            ) : (
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
            )}
            <span className={marketingReady ? "text-green-700" : "text-amber-700"}>Marketing</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {canLaunch && isLaunchReady ? (
            <Link href={`/dashboard/listings/${listingId}/lifecycle`}>
              <Button size="sm" className="bg-green-600 hover:bg-green-700">
                <Rocket className="h-3.5 w-3.5 mr-1.5" />
                Launch Listing
              </Button>
            </Link>
          ) : (
            <Link href={`/dashboard/listings/${listingId}/lifecycle`}>
              <Button size="sm" variant="outline">
                View Checklist
              </Button>
            </Link>
          )}
        </div>
      </div>

      {blockers.length > 0 && (
        <div className="mt-3 pt-3 border-t border-indigo-200">
          <p className="text-xs font-medium text-amber-700 mb-1">Blockers:</p>
          <div className="flex flex-wrap gap-1.5">
            {blockers.map((blocker, idx) => (
              <Badge key={idx} variant="outline" className="text-xs bg-amber-50 text-amber-800 border-amber-200">
                {blocker}
              </Badge>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3">
        <Progress value={(readinessScore / 3) * 100} className="h-1.5" />
      </div>
    </div>
  )
}
