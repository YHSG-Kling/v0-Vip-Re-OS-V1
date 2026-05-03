"use client"

import { CheckCircle2, Circle, Clock, ChevronRight } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import Link from "next/link"

interface WorkflowStep {
  id: string
  label: string
  description: string
  completed: boolean
  inProgress?: boolean
  actionHref?: string
  actionLabel?: string
}

interface PreListingWorkflowPanelProps {
  listingId: string
  currentStage: string
  vendorBookings: { service_type: string | null; status: string }[]
  tasks: { title: string; status: string }[]
  goLiveDate?: string | null
  /** Show "Go Live on MLS" CTA when all steps complete */
  onGoLiveMls?: () => void
}

const PRE_LISTING_STAGES = new Set([
  "LISTING_AGREEMENT_SIGNED",
  "COMING_SOON_PREP",
  "COMING_SOON_ACTIVE",
  "MEDIA_APPROVED",
  "OPEN_HOUSE_MARKETING",
])

export function PreListingWorkflowPanel({
  listingId,
  currentStage,
  vendorBookings,
  tasks,
  goLiveDate,
}: PreListingWorkflowPanelProps) {
  if (!PRE_LISTING_STAGES.has(currentStage)) return null

  const hasVendor = (type: string) =>
    vendorBookings.some(
      (b) =>
        b.service_type?.toLowerCase().includes(type) &&
        !["cancelled", "no_show"].includes(b.status)
    )
  const hasCompletedVendor = (type: string) =>
    vendorBookings.some(
      (b) =>
        b.service_type?.toLowerCase().includes(type) &&
        b.status === "completed"
    )
  const hasTask = (keyword: string) =>
    tasks.some(
      (t) =>
        t.title.toLowerCase().includes(keyword) &&
        (t.status === "completed" || t.status === "done")
    )

  const isComingSoonActive =
    currentStage === "COMING_SOON_ACTIVE" ||
    currentStage === "OPEN_HOUSE_MARKETING" ||
    currentStage === "MEDIA_APPROVED"

  const isOpenHouseMarketing =
    currentStage === "OPEN_HOUSE_MARKETING"

  const steps: WorkflowStep[] = [
    {
      id: "coming_soon_campaign",
      label: "Coming Soon Campaign",
      description: "Pre-market social posts, emails, and postcards auto-triggered",
      completed: isComingSoonActive,
      inProgress: currentStage === "COMING_SOON_PREP",
      actionHref: `/dashboard/listings/${listingId}/lifecycle`,
      actionLabel: "Launch Campaign",
    },
    {
      id: "inspection_ordered",
      label: "Pre-listing Inspection Ordered",
      description: "TC orders inspector — address issues before listing goes live",
      completed: hasVendor("inspection"),
      actionHref: `/dashboard/vendors`,
      actionLabel: "Book Inspector",
    },
    {
      id: "repairs_completed",
      label: "Repairs Completed",
      description: "TC coordinates all required repairs from inspection",
      completed: hasCompletedVendor("repair") || hasTask("repair"),
    },
    {
      id: "photography_ordered",
      label: "Photography Ordered",
      description: "Professional photos + video scheduled by TC",
      completed: hasVendor("photo") || hasVendor("photograph"),
      actionHref: `/dashboard/vendors`,
      actionLabel: "Book Photographer",
    },
    {
      id: "home_warranty",
      label: "Home Warranty Ordered",
      description: "Warranty provider selected and order placed",
      completed: hasVendor("warranty"),
      actionHref: `/dashboard/vendors`,
      actionLabel: "Order Warranty",
    },
    {
      id: "open_house_campaign",
      label: "Open House Campaign",
      description: "Invitation emails, social posts, and flyers distributed",
      completed: isOpenHouseMarketing,
      inProgress: isComingSoonActive && !isOpenHouseMarketing,
      actionHref: `/dashboard/listings/${listingId}/open-house`,
      actionLabel: "Schedule Open House",
    },
    {
      id: "mls_live_date",
      label: "MLS Live Date Confirmed",
      description: "Go-live date locked in with the MLS",
      completed: !!goLiveDate,
    },
  ]

  const completedCount = steps.filter((s) => s.completed).length
  const progressPct = Math.round((completedCount / steps.length) * 100)
  const allComplete = completedCount === steps.length

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">Pre-Listing Workflow</CardTitle>
          <Badge
            variant={allComplete ? "default" : "secondary"}
            className={allComplete ? "bg-emerald-600" : ""}
          >
            {completedCount}/{steps.length} complete
          </Badge>
        </div>
        <Progress value={progressPct} className="h-2 mt-2" />
      </CardHeader>
      <CardContent className="space-y-2">
        {steps.map((step, idx) => (
          <div
            key={step.id}
            className={[
              "flex items-start gap-3 rounded-lg px-3 py-2.5 border",
              step.completed
                ? "bg-emerald-50/50 border-emerald-200 dark:bg-emerald-950/20 dark:border-emerald-800"
                : step.inProgress
                ? "bg-amber-50/50 border-amber-200 dark:bg-amber-950/20 dark:border-amber-800"
                : "bg-card border-border",
            ].join(" ")}
          >
            <span className="shrink-0 mt-0.5">
              {step.completed ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              ) : step.inProgress ? (
                <Clock className="h-4 w-4 text-amber-600" />
              ) : (
                <Circle className="h-4 w-4 text-muted-foreground" />
              )}
            </span>
            <div className="flex-1 min-w-0">
              <p className={["text-sm font-medium", step.completed ? "text-emerald-800 dark:text-emerald-300" : ""].join(" ")}>
                {idx + 1}. {step.label}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">{step.description}</p>
            </div>
            {!step.completed && step.actionHref && (
              <Button asChild size="sm" variant="ghost" className="h-7 text-xs shrink-0">
                <Link href={step.actionHref}>
                  {step.actionLabel ?? "Action"}
                  <ChevronRight className="h-3 w-3 ml-1" />
                </Link>
              </Button>
            )}
          </div>
        ))}

        {allComplete && (
          <div className="mt-3 pt-3 border-t">
            <Button asChild className="w-full gap-2">
              <Link href={`/dashboard/listings/${listingId}/lifecycle`}>
                <CheckCircle2 className="h-4 w-4" />
                All Steps Complete — Go Live on MLS
              </Link>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
