"use client"

/**
 * PredictiveListingCard
 *
 * Surfaces top-N most-likely-to-list contacts from predictive_listing_scores.
 * Each row shows: contact name, score, top 2 signals, action buttons.
 *
 * Agent actions:
 *   - Draft Touch          → opens AI message composer (deeplink)
 *   - Schedule Consult     → opens listing consultation booking
 *   - Add to Nurture       → enroll in long-term nurture sequence
 *   - Dismiss (90 days)    → suppress this contact from PLS for 90 days
 *
 * Auto-touch queue: when the brokerage has predictive_listing_auto_touch
 * enabled, agents can review queued sends and cancel before the review
 * window expires.
 */

import { useState, useTransition } from "react"
import Link from "next/link"
import {
  Sparkles,
  TrendingUp,
  Calendar,
  MessageSquare,
  X,
  Clock,
  ChevronRight,
  Send,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  dismissPredictiveSeller,
  markPredictiveAction,
  cancelQueuedAutoTouch,
  listDismissedPredictiveSellers,
} from "@/app/actions/predictive-listing"
import type { PredictiveSellerRow } from "@/app/actions/predictive-listing"

interface QueuedTouch {
  id: string
  contactId: string
  contactName: string
  channel: string | null
  scheduledSendAt: string | null
  triggeringPlsScore: number | null
  triggeringSignals: Array<{ key: string; label: string }> | null
}

interface Props {
  brokerageId: string
  userId: string
  predictedSellers: PredictiveSellerRow[]
  queuedAutoTouches: QueuedTouch[]
}

function scoreColor(score: number): string {
  if (score >= 85) return "bg-red-500 text-white"
  if (score >= 75) return "bg-orange-500 text-white"
  if (score >= 65) return "bg-amber-500 text-white"
  return "bg-slate-400 text-white"
}

function formatRelative(when: string | null | undefined): string {
  if (!when) return ""
  const ms = new Date(when).getTime() - Date.now()
  const min = Math.floor(ms / 60000)
  if (min > 60) return `in ${Math.floor(min / 60)}h ${min % 60}m`
  if (min > 0) return `in ${min}m`
  return "now"
}

interface DismissedRow {
  contactId: string
  contactName: string
  suppressionReason: string | null
  suppressedUntil: string | null
  suppressedByName: string | null
}

function formatAvm(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `$${Math.round(value / 1_000)}K`
  return `$${Math.round(value)}`
}

export function PredictiveListingCard(props: Props) {
  const { brokerageId, userId, predictedSellers, queuedAutoTouches } = props
  const [isPending, startTransition] = useTransition()
  const [sellers, setSellers] = useState(predictedSellers)
  const [queue, setQueue] = useState(queuedAutoTouches)

  // The dismissals ledger — who hid which contact, why, and until when
  // (suppression_reason / suppressed_by_user_id / suppressed_until, written by
  // handleDismiss below and previously read by nothing). Lazy-loaded on expand
  // so the dashboard's initial read stays what it was.
  const [dismissedOpen, setDismissedOpen] = useState(false)
  const [dismissed, setDismissed] = useState<DismissedRow[] | null>(null)

  function toggleDismissed() {
    const opening = !dismissedOpen
    setDismissedOpen(opening)
    if (opening && dismissed === null) {
      listDismissedPredictiveSellers()
        .then(setDismissed)
        .catch(() => setDismissed([]))
    }
  }

  function handleDismiss(contactId: string) {
    if (!confirm("Hide this contact from your Predicted Sellers for 90 days?")) return
    startTransition(async () => {
      await dismissPredictiveSeller({
        contactId,
        brokerageId,
        userId,
        days: 90,
      })
      setSellers(sellers.filter((s) => s.contactId !== contactId))
    })
  }

  function handleMarkAction(contactId: string, actionType: "touched" | "consulted" | "nurtured") {
    startTransition(async () => {
      await markPredictiveAction({ contactId, brokerageId, actionType })
    })
  }

  function handleCancelQueued(actionId: string) {
    if (!confirm("Cancel this auto-send? You can still send manually.")) return
    startTransition(async () => {
      await cancelQueuedAutoTouch({ actionId, brokerageId, userId })
      setQueue(queue.filter((q) => q.id !== actionId))
    })
  }

  if (sellers.length === 0 && queue.length === 0) return null

  return (
    <Card className="border-amber-200 dark:border-amber-900">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-amber-500" />
            Most Likely to List
          </CardTitle>
          {queue.length > 0 && (
            <Badge variant="outline" className="text-[10px] gap-1">
              <Clock className="h-3 w-3" />
              {queue.length} auto-send queued
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          AI-predicted sellers in your sphere this quarter — based on tenure,
          equity, neighbor sales, and life events.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Predicted Sellers */}
        {sellers.map((s) => (
          <div
            key={s.contactId}
            className="flex flex-col gap-2 p-3 border rounded-lg bg-card"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2 min-w-0 flex-1">
                <div
                  className={`flex items-center justify-center h-8 w-8 rounded-full text-xs font-semibold shrink-0 ${scoreColor(s.plsScore)}`}
                >
                  {Math.round(s.plsScore)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link
                      href={`/crm?contact=${s.contactId}`}
                      className="font-medium text-sm hover:underline truncate"
                    >
                      {s.contactName}
                    </Link>
                    <Badge variant="outline" className="text-[10px]">
                      {Math.round(s.confidence * 100)}% confidence
                    </Badge>
                    {s.lastActionType === "auto_touched" && (
                      <Badge variant="outline" className="text-[10px] bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
                        Auto-touched
                      </Badge>
                    )}
                  </div>
                  {s.topSignals.length > 0 && (
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">
                      {s.topSignals.slice(0, 2).map((sig) => sig.label).join(" • ")}
                    </p>
                  )}
                  {/* The scorer's own context, recorded on every pass and never
                      shown: the home value it worked from (with its source, so a
                      cached estimate is not mistaken for a fresh AVM) and the
                      evidence depth behind the score. */}
                  {(s.avmValue != null || s.signalsFired != null) && (
                    <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                      {s.avmValue != null && (
                        <>
                          Est. {formatAvm(s.avmValue)}
                          {s.avmSource ? ` (${s.avmSource})` : ""}
                        </>
                      )}
                      {s.avmValue != null && s.signalsFired != null && " · "}
                      {s.signalsFired != null && (
                        <>
                          {s.signalsFired} signal{s.signalsFired === 1 ? "" : "s"}
                          {s.motivationTotal != null ? ` (+${Math.round(s.motivationTotal)} motivation)` : ""}
                        </>
                      )}
                    </p>
                  )}
                </div>
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0"
                onClick={() => handleDismiss(s.contactId)}
                disabled={isPending}
                title="Dismiss for 90 days"
              >
                <X className="h-4 w-4 text-muted-foreground" />
              </Button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Link href={`/crm?contact=${s.contactId}&action=draft_touch`}>
                <Button
                  size="sm"
                  className="h-7 text-xs gap-1"
                  onClick={() => handleMarkAction(s.contactId, "touched")}
                >
                  <MessageSquare className="h-3 w-3" />
                  Draft Touch
                </Button>
              </Link>
              <Link href={`/crm?contact=${s.contactId}&action=schedule_consult`}>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1"
                  onClick={() => handleMarkAction(s.contactId, "consulted")}
                >
                  <Calendar className="h-3 w-3" />
                  Schedule Consult
                </Button>
              </Link>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs gap-1"
                onClick={() => handleMarkAction(s.contactId, "nurtured")}
                disabled={isPending}
              >
                <TrendingUp className="h-3 w-3" />
                Add to Nurture
              </Button>
              <Link
                href={`/crm?contact=${s.contactId}`}
                className="ml-auto text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5"
              >
                View profile <ChevronRight className="h-3 w-3" />
              </Link>
            </div>
          </div>
        ))}

        {/* Queued Auto-Send Review Block */}
        {queue.length > 0 && (
          <div className="border-t pt-3 space-y-2">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
              Auto-send queue · review window
            </p>
            {queue.map((q) => (
              <div
                key={q.id}
                className="flex items-center justify-between gap-3 p-2 border rounded-lg bg-blue-50/50 dark:bg-blue-950/20"
              >
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <Send className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium truncate">
                      {q.contactName}
                      <span className="text-muted-foreground ml-1.5">
                        · {q.channel ?? "email"} · sends {formatRelative(q.scheduledSendAt)}
                      </span>
                    </p>
                    {q.triggeringSignals && q.triggeringSignals.length > 0 && (
                      <p className="text-[11px] text-muted-foreground truncate">
                        {q.triggeringSignals.slice(0, 2).map((s) => s.label).join(" • ")}
                      </p>
                    )}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => handleCancelQueued(q.id)}
                  disabled={isPending}
                >
                  Cancel
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Recently dismissed — the other half of the Dismiss button above. */}
        <div className="border-t pt-2">
          <button
            type="button"
            onClick={toggleDismissed}
            className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5"
          >
            Recently dismissed
            <ChevronRight className={`h-3 w-3 transition-transform ${dismissedOpen ? "rotate-90" : ""}`} />
          </button>
          {dismissedOpen && (
            dismissed === null ? (
              <p className="text-xs text-muted-foreground mt-1">Loading…</p>
            ) : dismissed.length === 0 ? (
              <p className="text-xs text-muted-foreground mt-1">Nothing is currently dismissed.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {dismissed.map((d) => (
                  <li key={d.contactId} className="text-xs text-muted-foreground">
                    <Link href={`/crm?contact=${d.contactId}`} className="text-foreground hover:underline">
                      {d.contactName}
                    </Link>
                    {" — "}
                    {(d.suppressionReason ?? "dismissed").replace(/_/g, " ")}
                    {d.suppressedByName ? ` by ${d.suppressedByName}` : ""}
                    {d.suppressedUntil
                      ? ` · hidden until ${new Date(d.suppressedUntil).toLocaleDateString()}`
                      : ""}
                  </li>
                ))}
              </ul>
            )
          )}
        </div>
      </CardContent>
    </Card>
  )
}
