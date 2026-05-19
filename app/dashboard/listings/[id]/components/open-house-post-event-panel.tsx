"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Users, Star, MessageSquare, UserPlus, Calendar, ExternalLink, Loader2 } from "lucide-react"
import Link from "next/link"

type Attendee = {
  id: string
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  contact_id?: string | null
  interest_level?: string | null
  feedback_rating?: number | null
  feedback_comments?: string | null
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
}

function isHotProspect(attendee: Attendee): boolean {
  return (
    (attendee.feedback_rating !== null &&
      attendee.feedback_rating !== undefined &&
      attendee.feedback_rating >= 4) ||
    attendee.interest_level === "very_interested" ||
    attendee.interest_level === "very interested"
  )
}

function hasFeedback(attendee: Attendee): boolean {
  return !!attendee.feedback_collected_at
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

export function OpenHousePostEventPanel({ event, attendees }: OpenHousePostEventPanelProps) {
  const [loadingFeedback, setLoadingFeedback] = useState<string | null>(null)
  const [loadingConvert, setLoadingConvert] = useState<string | null>(null)
  const [feedbackSent, setFeedbackSent] = useState<Set<string>>(new Set())
  const [convertedIds, setConvertedIds] = useState<Record<string, string>>({})

  const hotProspects = attendees.filter(isHotProspect)
  const pendingFeedback = attendees.filter((a) => !hasFeedback(a))
  const totalAttended = attendees.length

  async function handleRequestFeedback(attendeeId: string) {
    setLoadingFeedback(attendeeId)
    try {
      const res = await fetch("/api/open-house/request-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attendeeId }),
      })
      if (res.ok) {
        setFeedbackSent((prev) => new Set([...prev, attendeeId]))
      }
    } catch {
      // silently fail — network error
    } finally {
      setLoadingFeedback(null)
    }
  }

  async function handleConvertToContact(attendeeId: string) {
    setLoadingConvert(attendeeId)
    try {
      const res = await fetch("/api/open-house/convert-attendee", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attendeeId }),
      })
      const data = await res.json()
      if (res.ok && data.contactId) {
        setConvertedIds((prev) => ({ ...prev, [attendeeId]: data.contactId }))
      }
    } catch {
      // silently fail
    } finally {
      setLoadingConvert(null)
    }
  }

  function interestBadgeVariant(level?: string | null): "default" | "secondary" | "outline" {
    if (level === "very_interested" || level === "very interested") return "default"
    if (level === "interested" || level === "somewhat_interested") return "secondary"
    return "outline"
  }

  function interestLabel(level?: string | null): string {
    if (!level) return "Unknown"
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
        {/* Feedback pending section */}
        {pendingFeedback.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              Awaiting Feedback
            </p>
            <div className="space-y-1.5">
              {pendingFeedback.map((attendee) => {
                const alreadySent = feedbackSent.has(attendee.id)
                const name =
                  [attendee.first_name, attendee.last_name].filter(Boolean).join(" ") ||
                  attendee.email ||
                  "Anonymous"
                return (
                  <div
                    key={attendee.id}
                    className="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2"
                  >
                    <span className="text-sm text-foreground truncate">{name}</span>
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
                const name =
                  [attendee.first_name, attendee.last_name].filter(Boolean).join(" ") ||
                  attendee.email ||
                  "Anonymous"
                const resolvedContactId = convertedIds[attendee.id] ?? attendee.contact_id
                const canConvert = !resolvedContactId && !!attendee.email

                return (
                  <div
                    key={attendee.id}
                    className="rounded-md border border-border bg-background px-3 py-2.5 space-y-2"
                  >
                    {/* Name + interest badge */}
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium text-foreground">{name}</span>
                      <Badge
                        variant={interestBadgeVariant(attendee.interest_level)}
                        className="text-xs shrink-0"
                      >
                        {interestLabel(attendee.interest_level)}
                      </Badge>
                    </div>

                    {/* Feedback rating */}
                    {attendee.feedback_rating !== null &&
                      attendee.feedback_rating !== undefined && (
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Star className="h-3 w-3 text-amber-400 fill-amber-400" />
                          <span>{attendee.feedback_rating}/5</span>
                          {attendee.feedback_comments && (
                            <span className="truncate ml-1 text-foreground/70">
                              &mdash; {attendee.feedback_comments}
                            </span>
                          )}
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

                      {/* Schedule Showing */}
                      <Button size="sm" variant="default" className="h-7 text-xs" asChild>
                        <Link
                          href={
                            resolvedContactId
                              ? `/dashboard/showings/new?contactId=${resolvedContactId}`
                              : "/dashboard/showings/new"
                          }
                        >
                          <Calendar className="h-3 w-3 mr-1" />
                          Schedule Showing
                        </Link>
                      </Button>
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
