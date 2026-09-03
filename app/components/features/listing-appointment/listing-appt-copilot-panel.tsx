"use client"

/**
 * <ListingApptCoPilotPanel> — comprehensive review surface for the
 * listing-appt-prep chain outputs.
 *
 * Completes the agent Co-Pilot quartet:
 *   1. Listing Appointment (this component)
 *   2. Offer Negotiation     (negotiation-copilot-panel)
 *   3. Repair Negotiation    (repair-copilot-panel)
 *   4. Closing Risk          (deal-health card on transaction detail)
 *
 * Reads server-resolved data from getListingAppointmentPrepDetail and lets
 * the agent: review the CMA pricing recommendation, edit the presentation,
 * scrub through chapter videos, see the drip schedule, and mark prep ready
 * to present.
 */

import { useState, type ReactElement } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import {
  Loader2,
  CheckCircle2,
  Clock,
  XCircle,
  AlertTriangle,
  TrendingUp,
  Video as VideoIcon,
  FileText,
  Send,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  markListingApptPrepReady,
  type ListingApptPrepDetail,
} from "@/app/actions/listing-appointment-copilot"

interface Props {
  prep: ListingApptPrepDetail
}

const STATUS_ICON: Record<string, ReactElement> = {
  pending:        <Clock          className="h-3.5 w-3.5 text-muted-foreground" />,
  running:        <Loader2        className="h-3.5 w-3.5 animate-spin text-blue-600" />,
  done:           <CheckCircle2   className="h-3.5 w-3.5 text-emerald-600" />,
  failed:         <XCircle        className="h-3.5 w-3.5 text-red-600" />,
  skipped:        <CheckCircle2   className="h-3.5 w-3.5 text-muted-foreground" />,
  needs_approval: <AlertTriangle  className="h-3.5 w-3.5 text-amber-600" />,
}

function formatUsd(n: number | null | undefined): string {
  if (n == null) return "—"
  return `$${Math.round(n).toLocaleString()}`
}

function formatDateShort(iso: string | null | undefined): string {
  if (!iso) return "—"
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function ListingApptCoPilotPanel({ prep }: Props) {
  const router = useRouter()
  const [marking, setMarking] = useState(false)
  const [building, setBuilding] = useState(false)

  /**
   * "PREPARE FOR APPOINTMENT NOW" — the on-demand half of the presentation lane.
   *
   * /api/workflow/listing-presentation exists precisely for this ("Agent presses
   * 'Prepare for appointment now' and gets the same artifact the daily cron would
   * produce"), and NOTHING IN THE TREE ADDRESSED IT: it is session-authed, so it was
   * not an external door either — the button its own header describes was never built.
   * It is here now, on the surface that shows what the prep produced, because this is
   * where an agent discovers the presentation is missing or that a step failed.
   *
   * It requires propertyAddress + state and 400s without them; the subject property is
   * read off the run the chain already wrote (see ListingApptPrepDetail.propertyState),
   * and when the state is genuinely absent the control is disabled with the reason
   * rather than firing a request that can only be refused.
   *
   * buildListingPresentation is IDEMPOTENT per appointment on the cron path; here the
   * agent is explicitly asking for a rebuild, so the outcome — id or error — is shown
   * either way. A silent rebuild would be indistinguishable from a no-op.
   */
  const canBuildNow = Boolean(prep.propertyAddress && prep.propertyState)

  async function handleBuildNow() {
    if (building || !canBuildNow) return
    setBuilding(true)
    try {
      const res = await fetch("/api/workflow/listing-presentation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          propertyAddress: prep.propertyAddress,
          state:           prep.propertyState,
          city:            prep.propertyCity,
          zip:             prep.propertyZip,
          // Not proof of tenancy and not treated as such by the route — the read is
          // anchored on the caller's own resolved brokerageId.
          listingId:       prep.listingId,
          contactId:       prep.contactId,
        }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) {
        toast.error((json && json.error) || `Build refused (HTTP ${res.status})`)
        return
      }
      toast.success("Listing presentation rebuilt")
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not build the presentation")
    } finally {
      setBuilding(false)
    }
  }

  async function handleMarkReady() {
    if (marking) return
    setMarking(true)
    try {
      const r = await markListingApptPrepReady({ runId: prep.runId })
      if (r.success) {
        toast.success("Listing appointment prep marked ready")
        router.refresh()
      } else {
        toast.error(r.error ?? "Could not mark ready")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not mark ready")
    } finally {
      setMarking(false)
    }
  }

  const allStepsDone = prep.steps.every((s) => s.status === "done" || s.status === "skipped")
  const anyFailed = prep.steps.some((s) => s.status === "failed")

  return (
    <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-indigo-900">
            🎯 Listing Appointment Co-Pilot
            {prep.contactName && <> · {prep.contactName}</>}
          </p>
          <p className="text-xs text-indigo-700 mt-0.5">
            {prep.propertyAddress ?? "Property TBD"}
            {prep.appointmentDate && (
              <> · {new Date(prep.appointmentDate).toLocaleString(undefined, {
                month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
              })}</>
            )}
            {prep.daysUntil != null && (
              <span className={cn(
                "ml-2 px-1.5 py-0.5 rounded-full text-[10px] font-medium",
                prep.daysUntil <= 1 ? "bg-red-200 text-red-800" :
                prep.daysUntil <= 3 ? "bg-amber-200 text-amber-800" :
                                      "bg-indigo-200 text-indigo-800",
              )}>
                {prep.daysUntil < 0 ? `${Math.abs(prep.daysUntil)}d ago` :
                 prep.daysUntil === 0 ? "today" :
                 `${prep.daysUntil}d to go`}
              </span>
            )}
          </p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-semibold text-indigo-900 leading-none">{prep.readyPercent}%</p>
          <p className="text-[10px] text-indigo-700 uppercase tracking-wide">ready</p>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 bg-indigo-100 rounded-full overflow-hidden">
        <div
          className={cn(
            "h-full transition-all",
            prep.readyPercent >= 100 ? "bg-emerald-500" :
            prep.readyPercent >= 50  ? "bg-indigo-500" :
                                       "bg-amber-500",
          )}
          style={{ width: `${prep.readyPercent}%` }}
        />
      </div>

      {/* Step tracker */}
      <ol className="space-y-1.5">
        {prep.steps.map((s) => (
          <li key={s.key} className="flex items-start gap-2 text-xs">
            <span className="mt-0.5 shrink-0">{STATUS_ICON[s.status] ?? STATUS_ICON.pending}</span>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-foreground">{s.label}</p>
              {s.errorMessage && (
                <p className="text-[11px] text-red-600 mt-0.5">{s.errorMessage}</p>
              )}
              {s.status === "running" && (
                <p className="text-[11px] text-muted-foreground">In progress…</p>
              )}
            </div>
            <span className="text-[10px] text-muted-foreground whitespace-nowrap">
              {s.attempts > 1 && `${s.attempts}× · `}
              {s.completedAt ? formatDateShort(s.completedAt) : ""}
            </span>
          </li>
        ))}
      </ol>

      {/* CMA card */}
      {prep.cma && (
        <div className="rounded-md bg-white border border-indigo-100 p-3 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-indigo-900 flex items-center gap-1.5">
              <TrendingUp className="h-3.5 w-3.5" /> CMA & Pricing
            </p>
            {/* Restored 2026-09-03: the "Open CMA" link that was tombstoned here
                (no page rendered a cma_reports row by id) now has its route —
                app/dashboard/cma/[cmaId]/page.tsx, read by loadCMAReportById in
                app/actions/seller-cma.ts, brokerage-gated from the session. */}
            {prep.cma.cmaId && (
              <Link
                href={`/dashboard/cma/${prep.cma.cmaId}`}
                className="text-[11px] font-medium text-indigo-700 hover:underline whitespace-nowrap"
              >
                Open CMA →
              </Link>
            )}
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div>
              <p className="text-muted-foreground text-[10px]">Recommended</p>
              <p className="font-semibold">{formatUsd(prep.cma.recommendedPrice)}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-[10px]">Range low</p>
              <p>{formatUsd(prep.cma.priceRangeLow)}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-[10px]">Range high</p>
              <p>{formatUsd(prep.cma.priceRangeHigh)}</p>
            </div>
          </div>
          {prep.cma.comparableCount != null && (
            <p className="text-[11px] text-muted-foreground">
              {prep.cma.comparableCount} comparable{prep.cma.comparableCount === 1 ? "" : "s"} analyzed
            </p>
          )}
          {prep.cma.pricingStrategySummary && (
            <p className="text-[11px] text-foreground leading-snug">{prep.cma.pricingStrategySummary}</p>
          )}
        </div>
      )}

      {/* Presentation card */}
      {prep.presentation && (
        <div className="rounded-md bg-white border border-indigo-100 p-3 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-indigo-900 flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5" /> Listing Presentation
            </p>
            {prep.presentation.presentationId && (
              // REPOINTED (dangling-link sweep, 2026-09-02): was
              // `/dashboard/presentations/${id}` — no such route. The
              // listing_presentations viewer by id is
              // app/dashboard/listings/presentations/[id]/page.tsx.
              <Link
                href={`/dashboard/listings/presentations/${prep.presentation.presentationId}`}
                className="text-[11px] text-indigo-700 hover:underline"
              >
                Review & edit →
              </Link>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {prep.presentation.presentationType ?? "Standard"} ·{" "}
            {prep.presentation.chapterCount ?? 0} chapter{prep.presentation.chapterCount === 1 ? "" : "s"} ·{" "}
            <span className="capitalize">{prep.presentation.status ?? "draft"}</span>
          </p>
        </div>
      )}

      {/* Chapter videos card */}
      {prep.videos && prep.videos.videoIds.length > 0 && (
        <div className="rounded-md bg-white border border-indigo-100 p-3 space-y-2">
          <p className="text-xs font-semibold text-indigo-900 flex items-center gap-1.5">
            <VideoIcon className="h-3.5 w-3.5" /> Chapter videos · {prep.videos.videoIds.length}
          </p>
          <ul className="grid grid-cols-2 gap-2">
            {prep.videos.videos.slice(0, 4).map((v) => (
              <li key={v.id} className="text-[11px] border border-input rounded-md p-1.5">
                <p className="font-medium leading-tight truncate">{v.chapter_title ?? "Chapter"}</p>
                <p className="text-muted-foreground text-[10px] capitalize">
                  {v.status === "completed" || v.status === "ready" ? "✓ Ready" :
                   v.status === "rendering" || v.status === "processing" ? "⟳ Rendering" :
                   v.status === "failed" ? "✗ Failed" :
                   v.status ?? "Pending"}
                </p>
                {v.video_url && (
                  <a
                    href={v.video_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-indigo-700 hover:underline text-[10px]"
                  >
                    Preview ↗
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Drip card */}
      {prep.drip && prep.drip.touchpointsScheduled > 0 && (
        <div className="rounded-md bg-white border border-indigo-100 p-3 space-y-1">
          <p className="text-xs font-semibold text-indigo-900 flex items-center gap-1.5">
            <Send className="h-3.5 w-3.5" /> Pre-appointment drip · {prep.drip.touchpointsScheduled} touchpoint{prep.drip.touchpointsScheduled === 1 ? "" : "s"}
          </p>
          <p className="text-[11px] text-muted-foreground">
            First lands {formatDateShort(prep.drip.firstTouchAt)} · last {formatDateShort(prep.drip.lastTouchAt)}
          </p>
        </div>
      )}

      {/* Footer actions */}
      <div className="flex items-center justify-between pt-1 border-t border-indigo-100">
        <div className="flex items-center gap-1.5 text-[11px] text-indigo-700">
          {anyFailed ? (
            <>
              <AlertTriangle className="h-3 w-3 text-red-600" />
              <span>One or more steps failed — review above.</span>
            </>
          ) : prep.status === "completed" ? (
            <>
              <CheckCircle2 className="h-3 w-3 text-emerald-600" />
              <span>Marked ready · {formatDateShort(prep.completedAt)}</span>
            </>
          ) : allStepsDone ? (
            <span className="text-emerald-700">All steps complete — review and mark ready.</span>
          ) : (
            <span>Prep in progress · {prep.steps.filter((s) => s.status === "done").length}/{prep.steps.length} complete</span>
          )}
        </div>
        <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs gap-1.5"
          disabled={building || !canBuildNow}
          onClick={handleBuildNow}
          title={
            canBuildNow
              ? "Rebuild the CMA, net sheet, marketing plan, deck and packet now"
              : "No state on file for this property — the CMA and listing_presentations.state both require one"
          }
        >
          {building ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileText className="h-3 w-3" />}
          Prepare now
        </Button>
        {prep.status !== "completed" && (
          <Button
            size="sm"
            variant={allStepsDone ? "default" : "outline"}
            className="h-7 text-xs gap-1.5"
            disabled={marking || !allStepsDone}
            onClick={handleMarkReady}
            title={!allStepsDone ? "Complete every step first" : "Confirm prep reviewed and ready to present"}
          >
            {marking ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
            Mark prep ready
          </Button>
        )}
        </div>
      </div>
    </div>
  )
}
