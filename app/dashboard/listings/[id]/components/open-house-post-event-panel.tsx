"use client"

/**
 * Post-event action centre for a completed open house.
 *
 * THREE THINGS WERE WRONG HERE, and all three are the same shape: the control
 * existed, the capability existed, nothing joined them.
 *
 * 1. "Schedule Showing" was a <Link> to /dashboard/showings/new — a route that has
 *    never existed (app/dashboard/showings holds only `prep`). Every agent who
 *    tapped it on a hot prospect got a 404. scheduleShowingFromAttendee was
 *    complete, session-authorised, tenant-scoped, wrote the showing_requests row
 *    and fired SHOWING_REQUESTED — and was reachable from nowhere. It is now what
 *    the button calls.
 *
 * 2. Hot prospects could never be detected. isHotProspect matched
 *    interest_level === "very_interested", and open_house_attendees.interest_level
 *    is the hot|warm|cold enum written by endOpenHouseEvent's scoring pass. The
 *    section was permanently empty. It now matches the vocabulary that is actually
 *    stored, plus the ai_lead_score the same pass computes.
 *
 * 3. Both fetches ended in `catch { // silently fail }`, so a refused conversion
 *    looked identical to a successful one. Every call now reads its outcome and
 *    says so.
 */

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Users, Star, MessageSquare, UserPlus, Calendar, ExternalLink, Loader2, AlertCircle } from "lucide-react"
import { scheduleShowingFromAttendee, requestFeedbackFromAttendee } from "@/app/actions/seller-open-house"
import Link from "next/link"

type Attendee = {
  id: string
  /** open_house_attendees stores ONE `name` column — there is no first/last split. */
  name?: string | null
  email?: string | null
  contact_id?: string | null
  interest_level?: string | null
  feedback_collected_at?: string | null
  ai_lead_score?: number | null
}

type OpenHouseEvent = {
  id: string
  event_date?: string | null
  start_time?: string | null
  end_time?: string | null
  status?: string | null
}

interface OpenHousePostEventPanelProps {
  event: OpenHouseEvent
  attendees: Attendee[]
  /** Required by scheduleShowingFromAttendee — the listing this open house was for. */
  listingId: string
}

/**
 * The vocabulary actually written to open_house_attendees by endOpenHouseEvent:
 * interest_level ∈ hot | warm | cold, ai_lead_score 0-100 with >= 70 = hot.
 */
function isHotProspect(attendee: Attendee): boolean {
  return attendee.interest_level === "hot" || (attendee.ai_lead_score ?? 0) >= 70
}

function hasFeedback(attendee: Attendee): boolean {
  return !!attendee.feedback_collected_at
}

function displayName(attendee: Attendee): string {
  return attendee.name?.trim() || attendee.email || "Anonymous"
}

function formatEventDate(event: OpenHouseEvent): string {
  if (!event.event_date) return "Unknown date"
  try {
    const d = new Date(event.event_date)
    return d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    })
  } catch {
    return String(event.event_date)
  }
}

export function OpenHousePostEventPanel({ event, attendees, listingId }: OpenHousePostEventPanelProps) {
  const [loadingFeedback, setLoadingFeedback] = useState<string | null>(null)
  const [loadingConvert, setLoadingConvert] = useState<string | null>(null)
  const [loadingShowing, setLoadingShowing] = useState<string | null>(null)
  const [feedbackSent, setFeedbackSent] = useState<Set<string>>(new Set())
  const [convertedIds, setConvertedIds] = useState<Record<string, string>>({})
  const [showingBooked, setShowingBooked] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const hotProspects = attendees.filter(isHotProspect)
  const pendingFeedback = attendees.filter((a) => !hasFeedback(a))
  const totalAttended = attendees.length

  /**
   * Ask this attendee for feedback.
   *
   * This used to POST /api/open-house/request-feedback, which authenticates the
   * caller but never checks that the ATTENDEE belongs to them — and the live RLS
   * policy on open_house_attendees is `brokerage_id IS NULL OR brokerage_id =
   * current_user_brokerage_id()`, so an untenanted attendee row is reachable from
   * any brokerage. requestFeedbackFromAttendee proves ownership against the
   * stored tenant first and then delegates to the same sender, so the button
   * gained a boundary and lost nothing.
   */
  async function handleRequestFeedback(attendeeId: string) {
    setLoadingFeedback(attendeeId)
    setError(null)
    const res = await requestFeedbackFromAttendee({ attendeeId, listingId })
    setLoadingFeedback(null)
    if (!res.success) {
      setError(res.error ?? "The feedback request was not delivered.")
      return
    }
    setFeedbackSent((prev) => new Set([...prev, attendeeId]))
  }

  async function handleConvertToContact(attendeeId: string) {
    setLoadingConvert(attendeeId)
    setError(null)
    try {
      const res = await fetch("/api/open-house/convert-attendee", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attendeeId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.contactId) {
        setError(data?.error ?? `Attendee was not converted (HTTP ${res.status}).`)
        return
      }
      setConvertedIds((prev) => ({ ...prev, [attendeeId]: data.contactId }))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Attendee could not be converted.")
    } finally {
      setLoadingConvert(null)
    }
  }

  /**
   * The showing request needs a CONTACT — an attendee row is not one. The button
   * is only offered once the attendee has been converted, so this never invents an
   * id, and it surfaces the action's own refusal rather than assuming success.
   */
  async function handleScheduleShowing(attendeeId: string, contactId: string) {
    setLoadingShowing(attendeeId)
    setError(null)
    const res = await scheduleShowingFromAttendee({ attendeeId, contactId, listingId })
    setLoadingShowing(null)
    if (!res.success) {
      setError(res.error ?? "The showing request was not created.")
      return
    }
    setShowingBooked((prev) => new Set([...prev, attendeeId]))
  }

  function interestBadgeVariant(level?: string | null): "default" | "secondary" | "outline" {
    if (level === "hot") return "default"
    if (level === "warm") return "secondary"
    return "outline"
  }

  function interestLabel(level?: string | null): string {
    if (!level) return "Not assessed"
    return level.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  }

  return (
    <Card className="border border-border bg-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm font-semibold text-foreground">
            Post-Event: {formatEventDate(event)}
          </CardTitle>
          <Badge variant="secondary" className="text-xs">
            Completed
          </Badge>
        </div>

        {/* Summary counts */}
        <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Users className="h-3.5 w-3.5" />
            {totalAttended} attended
          </span>
          <span className="flex items-center gap-1">
            <Star className="h-3.5 w-3.5 text-amber-500" />
            {hotProspects.length} hot prospects
          </span>
          <span className="flex items-center gap-1">
            <MessageSquare className="h-3.5 w-3.5" />
            {pendingFeedback.length} feedback pending
          </span>
        </div>
      </CardHeader>

      <CardContent className="pt-0 space-y-4">
        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
            <AlertCircle className="h-3.5 w-3.5 text-destructive mt-0.5 shrink-0" />
            <p className="text-xs text-destructive">{error}</p>
          </div>
        )}

        {/* Feedback pending section */}
        {pendingFeedback.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              Awaiting Feedback
            </p>
            <div className="space-y-1.5">
              {pendingFeedback.map((attendee) => {
                const alreadySent = feedbackSent.has(attendee.id)
                return (
                  <div
                    key={attendee.id}
                    className="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2"
                  >
                    <span className="text-sm text-foreground truncate">{displayName(attendee)}</span>
                    {alreadySent ? (
                      <span className="text-xs text-muted-foreground shrink-0">Sent</span>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs shrink-0"
                        disabled={loadingFeedback === attendee.id}
                        onClick={() => handleRequestFeedback(attendee.id)}
                      >
                        {loadingFeedback === attendee.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          "Request Feedback"
                        )}
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Hot prospects section */}
        {hotProspects.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              Hot Prospects
            </p>
            <div className="space-y-2">
              {hotProspects.map((attendee) => {
                const resolvedContactId = convertedIds[attendee.id] ?? attendee.contact_id
                const canConvert = !resolvedContactId && !!attendee.email
                const booked = showingBooked.has(attendee.id)

                return (
                  <div
                    key={attendee.id}
                    className="rounded-md border border-border bg-background px-3 py-2.5 space-y-2"
                  >
                    {/* Name + interest badge */}
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-foreground">{displayName(attendee)}</span>
                      <Badge
                        variant={interestBadgeVariant(attendee.interest_level)}
                        className="text-xs shrink-0"
                      >
                        {interestLabel(attendee.interest_level)}
                      </Badge>
                    </div>

                    {/* Lead score — computed by the event-end scoring pass */}
                    {typeof attendee.ai_lead_score === "number" && (
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Star className="h-3 w-3 text-amber-400 fill-amber-400" />
                        <span>Lead score {attendee.ai_lead_score}/100</span>
                      </div>
                    )}

                    {/* Actions row */}
                    <div className="flex items-center gap-2 flex-wrap">
                      {/* Open CRM */}
                      {resolvedContactId && (
                        <Button size="sm" variant="outline" className="h-7 text-xs" asChild>
                          <Link href={`/crm?contact=${resolvedContactId}`}>
                            <ExternalLink className="h-3 w-3 mr-1" />
                            Open CRM
                          </Link>
                        </Button>
                      )}

                      {/* Convert to Contact */}
                      {canConvert && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          disabled={loadingConvert === attendee.id}
                          onClick={() => handleConvertToContact(attendee.id)}
                        >
                          {loadingConvert === attendee.id ? (
                            <Loader2 className="h-3 w-3 animate-spin mr-1" />
                          ) : (
                            <UserPlus className="h-3 w-3 mr-1" />
                          )}
                          Convert to Contact
                        </Button>
                      )}

                      {/* Request a follow-up showing — needs a contact to attach to */}
                      {resolvedContactId ? (
                        booked ? (
                          <span className="text-xs text-emerald-700 flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            Showing requested — confirm the time in Showings
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            variant="default"
                            className="h-7 text-xs"
                            disabled={loadingShowing === attendee.id}
                            onClick={() => handleScheduleShowing(attendee.id, resolvedContactId)}
                          >
                            {loadingShowing === attendee.id ? (
                              <Loader2 className="h-3 w-3 animate-spin mr-1" />
                            ) : (
                              <Calendar className="h-3 w-3 mr-1" />
                            )}
                            Request Showing
                          </Button>
                        )
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          Convert to a contact first to request a showing
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Empty state */}
        {hotProspects.length === 0 && pendingFeedback.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-2">
            All attendees have provided feedback. No hot prospects recorded.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
