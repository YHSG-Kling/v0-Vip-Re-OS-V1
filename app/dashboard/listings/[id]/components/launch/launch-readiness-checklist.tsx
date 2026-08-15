"use client"

/**
 * LaunchReadinessChecklist — single consolidated checklist for going live.
 *
 * Replaces the trio of overlapping surfaces previously stacked at the top
 * of the lifecycle page:
 *   - LaunchStateStrip (top banner)
 *   - 6 individual *ReadinessCard components in a grid
 *   - LaunchActionsPanel readiness summary (right rail)
 *
 * Single inline checklist with progress bar, per-row status + sublabel +
 * deep-link, blockers shown inline, and one launch CTA gated on completeness.
 */

import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import {
  Camera,
  ClipboardCheck,
  Megaphone,
  Mail,
  Calendar,
  MapPin,
  FileSignature,
  CheckCircle2,
  Circle,
  ArrowRight,
  Rocket,
  AlertTriangle,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { ListingStage } from "@/lib/listing-lifecycle/lifecycle-definitions"

interface LaunchReadinessChecklistProps {
  listingId: string
  currentStage: ListingStage
  // Media
  photoCount: number
  videoCount: number
  hasBranded: boolean
  hasUnbranded: boolean
  minPhotosRequired?: number
  // Publish
  requiredFields: { field: string; complete: boolean }[]
  complianceBlockers: string[]
  packetReady: boolean
  // Marketing tier
  currentTier: { id: string; tier_name: string; description?: string } | null
  isSuperAdmin?: boolean
  // Seller updates
  sellerUpdateHasPendingDraft: boolean
  // Open house
  openHouseEvent?: {
    id: string
    event_date: string
    start_time: string
    end_time: string
    status: string
  }
  openHousePromotionStatus: "not_started" | "scheduled" | "published"
  openHouseRsvpCount: number
  // Neighborhood
  hasNeighborhoodReport: boolean
  neighborhoodName?: string
  pricingNarrativeReady: boolean
  // Listing agreement
  hasListingAgreement: boolean
  agreementFullyExecuted: boolean
  // Aggregate flags from parent
  mediaReady: boolean
  publishReady: boolean
  marketingReady: boolean
  blockers: string[]
}

interface ChecklistRow {
  key: string
  label: string
  icon: React.ComponentType<any>
  status: "complete" | "in_progress" | "pending"
  detail: string
  href: string
  cta?: string
  /** Hide row entirely when not applicable */
  hidden?: boolean
}

export function LaunchReadinessChecklist(props: LaunchReadinessChecklistProps) {
  const {
    listingId,
    currentStage,
    photoCount,
    videoCount,
    hasBranded,
    hasUnbranded,
    minPhotosRequired = 5,
    requiredFields,
    complianceBlockers,
    packetReady,
    currentTier,
    isSuperAdmin,
    sellerUpdateHasPendingDraft,
    openHouseEvent,
    openHousePromotionStatus,
    openHouseRsvpCount,
    hasNeighborhoodReport,
    neighborhoodName,
    pricingNarrativeReady,
    hasListingAgreement,
    agreementFullyExecuted,
    blockers,
  } = props

  const fieldsMissing = requiredFields.filter(f => !f.complete)
  const fieldsComplete = requiredFields.length - fieldsMissing.length

  const rows: ChecklistRow[] = ([
    // 1. Listing agreement
    {
      key: "agreement",
      label: "Listing Agreement",
      icon: FileSignature,
      status: agreementFullyExecuted ? "complete" : hasListingAgreement ? "in_progress" : "pending",
      detail: agreementFullyExecuted
        ? "Fully executed"
        : hasListingAgreement
        ? "Sent — awaiting signatures"
        : "Not yet sent",
      href: `/dashboard/listings/${listingId}/forms`,
      cta: hasListingAgreement ? undefined : "Send agreement",
    },
    // 2. Media
    {
      key: "media",
      label: "Photos & Video",
      icon: Camera,
      status:
        photoCount >= minPhotosRequired ? "complete" :
        photoCount > 0 ? "in_progress" : "pending",
      detail: `${photoCount}/${minPhotosRequired} photos · ${videoCount} videos${
        photoCount >= minPhotosRequired
          ? hasBranded && hasUnbranded
            ? " · branded + unbranded"
            : ""
          : ""
      }`,
      href: `/dashboard/listings/${listingId}/media`,
      cta: photoCount >= minPhotosRequired ? "Manage" : "Upload photos",
    },
    // 3. Publish details
    {
      key: "publish",
      label: "Listing Details",
      icon: ClipboardCheck,
      status:
        fieldsMissing.length === 0 && complianceBlockers.length === 0
          ? "complete"
          : fieldsComplete > 0
          ? "in_progress"
          : "pending",
      detail:
        fieldsMissing.length === 0
          ? complianceBlockers.length > 0
            ? `${complianceBlockers.length} compliance issue${complianceBlockers.length === 1 ? "" : "s"}`
            : packetReady
            ? "Listing packet ready"
            : "All required fields complete"
          : `Missing: ${fieldsMissing.map(f => f.field).join(", ")}`,
      href: `/dashboard/listings/${listingId}/edit`,
      cta: fieldsMissing.length > 0 ? "Complete fields" : undefined,
    },
    // 4. Marketing tier (super-admin only)
    {
      key: "marketing",
      label: "Marketing Tier",
      icon: Megaphone,
      status: currentTier ? "complete" : "pending",
      detail: currentTier
        ? `${currentTier.tier_name} active`
        : "No tier assigned",
      href: `/dashboard/listings/${listingId}/marketing-tier`,
      cta: currentTier ? "View" : "Assign tier",
      hidden: !isSuperAdmin,
    },
    // 5. Neighborhood story
    {
      key: "neighborhood",
      label: "Neighborhood Story",
      icon: MapPin,
      status:
        hasNeighborhoodReport && pricingNarrativeReady
          ? "complete"
          : hasNeighborhoodReport
          ? "in_progress"
          : "pending",
      detail: hasNeighborhoodReport
        ? `${neighborhoodName ?? "Report"} ready${pricingNarrativeReady ? " · pricing narrative" : ""}`
        : "Generate AI report for buyers",
      href: `/dashboard/listings/${listingId}/neighborhood-report`,
      cta: hasNeighborhoodReport ? "View" : "Generate",
    },
    // 6. Open house
    {
      key: "open_house",
      label: "Open House",
      icon: Calendar,
      status:
        openHouseEvent && openHousePromotionStatus === "published"
          ? "complete"
          : openHouseEvent
          ? "in_progress"
          : "pending",
      detail: openHouseEvent
        ? `${formatDate(openHouseEvent.event_date)} · ${openHouseRsvpCount} RSVP${openHouseRsvpCount === 1 ? "" : "s"} · ${openHousePromotionStatus.replace("_", " ")}`
        : "Not yet scheduled",
      href: `/dashboard/listings/${listingId}/open-house`,
      cta: openHouseEvent ? "Manage" : "Schedule",
    },
    // 7. Seller updates
    {
      key: "seller_updates",
      label: "Seller Updates",
      icon: Mail,
      status: sellerUpdateHasPendingDraft ? "in_progress" : "complete",
      detail: sellerUpdateHasPendingDraft
        ? "Draft awaiting send"
        : "Auto-update enabled",
      href: `/dashboard/listings/${listingId}/seller-updates`,
      cta: sellerUpdateHasPendingDraft ? "Review draft" : undefined,
    },
  ] as ChecklistRow[]).filter(r => !r.hidden)

  const completeCount = rows.filter(r => r.status === "complete").length
  const totalCount = rows.length
  const progress = totalCount > 0 ? Math.round((completeCount / totalCount) * 100) : 0
  const allComplete = completeCount === totalCount && blockers.length === 0
  const canLaunch =
    (currentStage as string) === "ACTIVE_PREP" ||
    (currentStage as string) === "COMING_SOON" ||
    (currentStage as string) === "PRE_LISTING"

  return (
    <Card className="border-l-4 border-l-indigo-500">
      <CardContent className="p-4 space-y-3">
        {/* Header row */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <div className={cn(
              "p-2 rounded-full",
              allComplete ? "bg-green-100" : "bg-indigo-100"
            )}>
              {allComplete
                ? <Rocket className="h-4 w-4 text-green-700" />
                : <ClipboardCheck className="h-4 w-4 text-indigo-700" />
              }
            </div>
            <div>
              <h3 className="text-sm font-semibold">Launch Readiness</h3>
              <p className="text-xs text-muted-foreground">
                {completeCount} of {totalCount} ready
                {blockers.length > 0 && ` · ${blockers.length} blocker${blockers.length === 1 ? "" : "s"}`}
              </p>
            </div>
          </div>

          {canLaunch && allComplete ? (
            <Button size="sm" className="bg-green-600 hover:bg-green-700 gap-1.5">
              <Rocket className="h-3.5 w-3.5" />
              Launch Listing
            </Button>
          ) : null}
        </div>

        <Progress value={progress} className="h-1.5" />

        {/* Blockers (compliance/missing) */}
        {blockers.length > 0 && (
          <div className="rounded-md border bg-amber-50/50 border-amber-200 px-3 py-2 space-y-1">
            <div className="flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
              <p className="text-xs font-medium text-amber-800">Blockers</p>
            </div>
            <ul className="text-xs text-amber-800 list-disc pl-4 space-y-0.5">
              {blockers.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          </div>
        )}

        {/* Checklist rows */}
        <div className="divide-y border rounded-md">
          {rows.map(row => {
            const Icon = row.icon
            const StatusIcon =
              row.status === "complete" ? CheckCircle2 :
              row.status === "in_progress" ? Circle :
              Circle
            return (
              <Link
                key={row.key}
                href={row.href}
                className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/40 transition-colors"
              >
                <StatusIcon
                  className={cn(
                    "h-4 w-4 shrink-0",
                    row.status === "complete" && "text-green-600 fill-green-100",
                    row.status === "in_progress" && "text-amber-500",
                    row.status === "pending" && "text-muted-foreground/40"
                  )}
                />
                <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className={cn(
                    "text-sm font-medium",
                    row.status === "complete" && "text-foreground",
                    row.status !== "complete" && "text-foreground"
                  )}>
                    {row.label}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">{row.detail}</p>
                </div>
                {row.cta && row.status !== "complete" && (
                  <Badge variant="outline" className="text-[10px] gap-1 shrink-0">
                    {row.cta}
                    <ArrowRight className="h-2.5 w-2.5" />
                  </Badge>
                )}
              </Link>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    })
  } catch {
    return iso
  }
}
