/**
 * <MilestoneEducationPanel> — customer-side education surface.
 *
 * Server component. Mounts on portal home variants and renders the
 * milestone-gated lessons authored in learning_modules.
 *
 *   * UNLOCKED  — visible now, top of the panel, "Start" buttons
 *   * UPCOMING  — gated by the contact's NEXT milestone (preview with
 *                 a lock icon + "Unlocks at X" copy)
 *   * (locked    — silenced; not shown to keep the panel tight)
 *
 * Hides on empty (no unlocked AND no upcoming).
 *
 * Composes with: Sprint 5 portal_event_stream (milestones fire lessons),
 *                Sprint 7 learning_modules + assignments (the surfaced lessons),
 *                migration 1049 gating columns.
 */

import { createClient } from "@/lib/supabase/server"
import { resolveMilestoneGatedFeed } from "@/lib/learning-router/milestone-gated-modules"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Lock, GraduationCap, CheckCircle2 } from "lucide-react"
import Link from "next/link"

interface Props {
  contactId: string
  /** Tighter mode for embedding inside another card. */
  compact?:  boolean
}

const MILESTONE_LABELS: Record<string, string> = {
  offer_submitted:                "Offer Submitted",
  offer_accepted:                 "Offer Accepted",
  earnest_money_due:              "Earnest Money Due",
  inspection_scheduled:           "Inspection Scheduled",
  inspection_deadline:            "Inspection Deadline",
  inspection_completed:           "Inspection Completed",
  appraisal_ordered:              "Appraisal Ordered",
  appraisal_deadline:             "Appraisal Deadline",
  appraisal_completed:            "Appraisal Completed",
  financing_deadline:             "Financing Deadline",
  loan_approved:                  "Loan Approved",
  clear_to_close_received:        "Clear to Close",
  final_walkthrough_scheduled:    "Final Walkthrough",
  closing_scheduled:              "Closing Scheduled",
  closing_date:                   "Closing Day",
  closed:                         "Closed",
  listing_live:                   "Listing Live",
  first_showing:                  "First Showing",
  offer_received:                 "Offer Received",
  under_contract:                 "Under Contract",
  inspection_period:              "Inspection Period",
  appraisal:                      "Appraisal",
  closing_prep:                   "Closing Prep",
}

function milestoneLabel(key: string): string {
  return MILESTONE_LABELS[key] ?? key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
}

export async function MilestoneEducationPanel({ contactId, compact }: Props) {
  const supabase = await createClient()
  const feed     = await resolveMilestoneGatedFeed(supabase, contactId)

  // Hide if nothing to show
  if (feed.unlocked.length === 0 && feed.upcoming.length === 0) return null

  return (
    <Card>
      <CardHeader className={compact ? "pb-2" : "pb-3"}>
        <CardTitle className={`flex items-center gap-2 ${compact ? "text-sm" : "text-base"}`}>
          <GraduationCap className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} />
          Your education
          {feed.currentMilestone && (
            <Badge variant="outline" className="ml-auto text-xs">
              {milestoneLabel(feed.currentMilestone)}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className={`flex flex-col gap-3 ${compact ? "text-sm" : ""}`}>
        {/* Unlocked: lessons the customer can take now */}
        {feed.unlocked.slice(0, 4).map(m => (
          <Link
            key={m.id}
            href={`/portal/lesson/${m.id}`}
            className="rounded-md border p-3 hover:bg-muted/40 transition-colors flex items-start gap-3"
          >
            {m.isCompleted
              ? <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 flex-shrink-0" />
              : <GraduationCap className="h-4 w-4 text-blue-500 mt-0.5 flex-shrink-0" />}
            <div className="min-w-0 flex-1">
              <div className={`font-medium ${m.isCompleted ? "text-muted-foreground line-through" : ""}`}>
                {m.title}
              </div>
              {m.summary && (
                <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{m.summary}</p>
              )}
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {m.milestoneKey && (
                  <Badge variant="secondary" className="text-xs">
                    {milestoneLabel(m.milestoneKey)}
                  </Badge>
                )}
                {m.estimatedMinutes && m.estimatedMinutes > 0 && (
                  <Badge variant="outline" className="text-xs">{m.estimatedMinutes} min</Badge>
                )}
                {m.isCompleted && (
                  <Badge variant="outline" className="text-xs text-emerald-700">Completed</Badge>
                )}
              </div>
            </div>
          </Link>
        ))}

        {/* Upcoming: locked previews so customer sees what's next */}
        {feed.upcoming.slice(0, 2).map(m => (
          <div
            key={m.id}
            className="rounded-md border border-dashed bg-muted/30 p-3 flex items-start gap-3"
          >
            <Lock className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-medium text-muted-foreground">{m.title}</div>
              {m.lockReason && (
                <p className="text-xs text-muted-foreground mt-0.5">{m.lockReason}</p>
              )}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
