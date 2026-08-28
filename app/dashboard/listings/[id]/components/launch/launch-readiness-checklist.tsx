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

import { useState } from "react"
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
  Hash,
} from "lucide-react"
import { LaunchListingDialog } from "./launch-listing-dialog"
import { verifyMlsSyndicationAction } from "@/app/actions/listings-kernel"
import type { MlsVerification } from "@/lib/listings/mls-verification"
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
  /** listing_agreements.compliance_passed — TRUE only when the execution
   *  engine's document/signature audit passed at execution time. NULL when no
   *  agreement exists. FALSE covers legacy rows executed before the gate. */
  agreementCompliancePassed?: boolean | null
  // MLS — the kernel's launch gate blocks on mls_number, so it belongs on the
  // checklist that claims to say whether the listing can launch.
  mlsNumber: string | null
  mlsLink: string | null
  listingAddress: string
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
  /** Rows that navigate somewhere. Mutually exclusive with onClick. */
  href?: string
  /** Rows resolved in place (MLS number is entered in the launch dialog, not on a page). */
  onClick?: () => void
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
    agreementCompliancePassed,
    mlsNumber,
    mlsLink,
    listingAddress,
    blockers,
  } = props

  const [launchOpen, setLaunchOpen] = useState(false)
  const [mlsCheck, setMlsCheck] = useState<MlsVerification | null>(null)
  const [mlsChecking, setMlsChecking] = useState(false)

  // The claim "live on the MLS" verified against the feeds the brokerage already
  // pays for. Reads the outcome and shows it — including "unverifiable", which is
  // the honest answer for a tenant with no feed connected and must never be
  // allowed to render as "not on the MLS".
  const runMlsCheck = async () => {
    setMlsChecking(true)
    const res = await verifyMlsSyndicationAction(listingId)
    setMlsChecking(false)
    setMlsCheck(res.success && res.verification ? res.verification : null)
  }

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
        ? agreementCompliancePassed
          ? "Fully executed · compliance audit passed"
          : "Fully executed · executed before the compliance gate — re-verify documents"
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
    // 4. MLS number — the kernel refuses to launch without one
    //    (validateListingLaunchReadiness). This row existed as a hard blocker
    //    inside the kernel and nowhere on the surface, so the checklist could
    //    read 7-of-7 ready while Launch failed with "No MLS number entered".
    //
    //    Once a number IS stored, the row stops being a to-do and becomes a
    //    CLAIM — "this listing is live on the MLS" — which nothing ever
    //    verified. Clicking it then runs the feed check instead of reopening
    //    the launch dialog. Storing a number and being live are different
    //    facts, and only one of them was ever visible here.
    {
      key: "mls",
      label: "MLS Number",
      icon: Hash,
      status: mlsNumber ? "complete" : "pending",
      detail: mlsNumber
        ? `MLS# ${mlsNumber}${mlsLink ? " · linked" : ""}${
            mlsCheck ? ` · ${mlsCheck.verdict === "pending" ? "not seen on feeds yet" : mlsCheck.verdict}` : ""
          }`
        : "Required to go live — enter the number from your MLS",
      onClick: mlsNumber ? runMlsCheck : () => setLaunchOpen(true),
      cta: mlsNumber ? (mlsChecking ? "Checking…" : "Verify it's live") : "Add MLS number",
    },
    // 5. Marketing tier (super-admin only)
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

          {/* This button had NO onClick. The single most prominent control on
              the lifecycle page — the one the whole checklist counts down to —
              did nothing when pressed. It now opens the launch dialog, which is
              where the MLS number is confirmed and launchListingAction runs. */}
          {canLaunch ? (
            <Button
              size="sm"
              className="bg-green-600 hover:bg-green-700 gap-1.5"
              onClick={() => setLaunchOpen(true)}
              disabled={!allComplete}
              title={allComplete ? undefined : "Clear the remaining items first"}
            >
              <Rocket className="h-3.5 w-3.5" />
              Launch Listing
            </Button>
          ) : null}
        </div>

        <Progress value={progress} className="h-1.5" />

        {/* The MLS claim, checked. `contradicted` is the one that needs a human:
            a feed showing this address under a different number means we are
            publishing someone else's identifier for the property. */}
        {mlsCheck && (
          <div
            className={cn(
              "rounded-md border px-3 py-2",
              mlsCheck.verdict === "confirmed" && "border-emerald-200 bg-emerald-50/50",
              mlsCheck.verdict === "contradicted" && "border-destructive/40 bg-destructive/5",
              (mlsCheck.verdict === "pending" || mlsCheck.verdict === "unverifiable") && "border-muted bg-muted/30",
            )}
          >
            <p className="text-xs font-medium mb-0.5">
              {mlsCheck.verdict === "confirmed" ? "MLS syndication confirmed"
                : mlsCheck.verdict === "contradicted" ? "MLS number disputed by a feed"
                : mlsCheck.verdict === "unverifiable" ? "No feed connected to verify with"
                : "Not on the feeds yet"}
            </p>
            <p className="text-xs text-muted-foreground">{mlsCheck.explanation}</p>
          </div>
        )}

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
            const RowShell = ({ children }: { children: React.ReactNode }) =>
              row.href ? (
                <Link href={row.href} className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/40 transition-colors">
                  {children}
                </Link>
              ) : (
                <button
                  type="button"
                  onClick={row.onClick}
                  className="w-full text-left flex items-center gap-3 px-3 py-2.5 hover:bg-muted/40 transition-colors"
                >
                  {children}
                </button>
              )
            return (
              <RowShell key={row.key}>
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
              </RowShell>
            )
          })}
        </div>
      </CardContent>

      <LaunchListingDialog
        open={launchOpen}
        onOpenChange={setLaunchOpen}
        listingId={listingId}
        listingAddress={listingAddress}
        initialMlsNumber={mlsNumber}
        initialMlsLink={mlsLink}
        outstanding={rows.filter(r => r.key !== "mls" && r.status !== "complete").map(r => r.label)}
      />
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
