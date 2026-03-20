"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  BarChart3,
  Users,
  Sparkles,
  RefreshCw,
  MessageSquare,
  Send,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  CheckCircle2,
} from "lucide-react"
import {
  predictAttendance,
  processEventFollowups,
  generatePersonalizedInvite,
} from "@/app/actions/open-house-automation"
import { useToast } from "@/hooks/use-toast"
import Link from "next/link"

interface Props {
  listingId: string
  data: any
}

interface AttendancePrediction {
  predicted_attendance_low: number
  predicted_attendance_mid: number
  predicted_attendance_high: number
  confidence_level: number
  serious_buyers_expected: number
}

interface FollowupResult {
  success: boolean
  followups?: Array<{ contactId: string; message: string; channel: string }>
  processed?: number
  error?: string
}

interface InviteDraft {
  contactId: string
  name: string
  draft: string
}

export function IntelligenceTab({ listingId, data }: Props) {
  const { events, attendees } = data
  const { toast } = useToast()

  if (!events || events.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          No open house events scheduled yet. Create an event to use intelligence features.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {events.map((event: any) => {
        const isCompleted = event.status === "completed"
        const isUpcoming =
          event.status === "scheduled" || event.status === "in_progress"
        const eventAttendees = attendees?.filter((a: any) => a.event_id === event.id) ?? []

        const eventDate = new Date(event.event_date).toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
        })

        return (
          <div key={event.id} className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <h3 className="text-sm font-semibold">{eventDate}</h3>
              <Badge
                className={
                  isCompleted
                    ? "bg-emerald-100 text-emerald-800 border border-emerald-200 text-xs"
                    : "bg-blue-100 text-blue-800 border border-blue-200 text-xs"
                }
              >
                {event.status}
              </Badge>
            </div>

            {/* Attendance Prediction — upcoming only */}
            {isUpcoming && (
              <AttendancePredictionCard eventId={event.id} />
            )}

            {/* Personalized Invites — upcoming, if attendees exist to invite */}
            {isUpcoming && (
              <InviteGeneratorCard
                eventId={event.id}
                listingId={listingId}
                eventAttendees={eventAttendees}
              />
            )}

            {/* Follow-up Processing — completed events only */}
            {isCompleted && (
              <FollowupProcessorCard
                eventId={event.id}
                attendeeCount={eventAttendees.length}
                listingId={listingId}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── ATTENDANCE PREDICTION ────────────────────────────────────────────────────

function AttendancePredictionCard({ eventId }: { eventId: string }) {
  const [isPending, startTransition] = useTransition()
  const [prediction, setPrediction] = useState<AttendancePrediction | null>(null)
  const { toast } = useToast()

  function handlePredict() {
    startTransition(async () => {
      const res = await predictAttendance(eventId)
      // predictAttendance returns the prediction object directly (not wrapped in success)
      if (res && typeof res.predicted_attendance_mid === "number") {
        setPrediction(res as AttendancePrediction)
      } else {
        toast({ title: "Could not predict attendance", variant: "destructive" })
      }
    })
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-indigo-600" />
          Attendance Prediction
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!prediction ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              AI estimates expected attendance based on listing activity, market conditions, and historical open house data.
            </p>
            <Button size="sm" onClick={handlePredict} disabled={isPending}>
              {isPending ? (
                <RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5 mr-1.5" />
              )}
              Predict Attendance
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Range display */}
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-lg bg-muted/40 p-3 text-center border">
                <p className="text-xs text-muted-foreground mb-1">Low</p>
                <p className="text-xl font-bold text-foreground">{prediction.predicted_attendance_low}</p>
              </div>
              <div className="rounded-lg bg-indigo-50 border border-indigo-200 p-3 text-center">
                <p className="text-xs text-indigo-700 mb-1">Expected</p>
                <p className="text-xl font-bold text-indigo-700">{prediction.predicted_attendance_mid}</p>
              </div>
              <div className="rounded-lg bg-muted/40 p-3 text-center border">
                <p className="text-xs text-muted-foreground mb-1">High</p>
                <p className="text-xl font-bold text-foreground">{prediction.predicted_attendance_high}</p>
              </div>
            </div>

            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <Users className="h-3.5 w-3.5 text-amber-600" />
                <span>
                  <strong className="text-foreground">{prediction.serious_buyers_expected}</strong> serious buyers expected
                </span>
              </div>
              <span>
                {Math.round(prediction.confidence_level * 100)}% confidence
              </span>
            </div>

            <Button
              size="sm"
              variant="ghost"
              onClick={handlePredict}
              disabled={isPending}
              className="text-xs h-7"
            >
              <RefreshCw className="h-3 w-3 mr-1.5" />
              Re-predict
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ─── PERSONALIZED INVITE GENERATOR ───────────────────────────────────────────

function InviteGeneratorCard({
  eventId,
  listingId,
  eventAttendees,
}: {
  eventId: string
  listingId: string
  eventAttendees: any[]
}) {
  const [isPending, startTransition] = useTransition()
  const [drafts, setDrafts] = useState<InviteDraft[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const { toast } = useToast()

  // Use up to 5 attendees who have a contact_id as invite targets
  const invitableAttendees = eventAttendees
    .filter((a: any) => !!a.contact_id)
    .slice(0, 5)

  function handleGenerateAll() {
    if (invitableAttendees.length === 0) {
      toast({ title: "No registered contacts to invite" })
      return
    }
    startTransition(async () => {
      const results = await Promise.all(
        invitableAttendees.map(async (a: any) => {
          const res = await generatePersonalizedInvite({
            contactId: a.contact_id,
            eventId,
          })
          if (res.success && res.invite) {
            return {
              contactId: a.contact_id,
              name: a.name ?? `Contact ${a.contact_id.slice(0, 6)}`,
              draft: res.invite as string,
            }
          }
          return null
        })
      )
      const valid = results.filter(Boolean) as InviteDraft[]
      setDrafts(valid)
      if (valid.length === 0) {
        toast({ title: "Could not generate invites", variant: "destructive" })
      } else {
        toast({ title: `${valid.length} personalized invite${valid.length !== 1 ? "s" : ""} generated` })
      }
    })
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Send className="h-4 w-4 text-indigo-600" />
          Personalized Invites
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {invitableAttendees.length === 0 ? (
          <div className="flex items-start gap-2 text-xs text-muted-foreground">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            No contacts are registered for this event yet. Add contacts via the Event Day tab to generate invites.
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Generate AI-personalized invites for {invitableAttendees.length} registered contact{invitableAttendees.length !== 1 ? "s" : ""}.
            </p>
            {drafts.length === 0 ? (
              <Button size="sm" onClick={handleGenerateAll} disabled={isPending}>
                {isPending ? (
                  <RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                )}
                Generate Invites
              </Button>
            ) : (
              <div className="flex flex-col gap-2">
                {drafts.map((d) => (
                  <div key={d.contactId} className="rounded-md border border-border">
                    <button
                      onClick={() => setExpanded(expanded === d.contactId ? null : d.contactId)}
                      className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium hover:bg-muted/40 transition-colors"
                    >
                      <span>{d.name}</span>
                      {expanded === d.contactId ? (
                        <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </button>
                    {expanded === d.contactId && (
                      <div className="px-3 pb-3 space-y-2 border-t">
                        <p className="text-xs text-muted-foreground leading-relaxed pt-2">{d.draft}</p>
                        <Link href={`/dashboard/listings/${listingId}/seller-updates?contact=${d.contactId}&draft=${encodeURIComponent(d.draft)}`}>
                          <Button size="sm" variant="outline" className="h-7 text-xs">
                            <Send className="h-3 w-3 mr-1.5" />
                            Open in Message Composer
                          </Button>
                        </Link>
                      </div>
                    )}
                  </div>
                ))}
                <Button size="sm" variant="ghost" onClick={handleGenerateAll} disabled={isPending} className="text-xs h-7 self-start">
                  <RefreshCw className="h-3 w-3 mr-1.5" />
                  Regenerate All
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

// ─── FOLLOW-UP PROCESSOR ─────────────────────────────────────────────────────

function FollowupProcessorCard({
  eventId,
  attendeeCount,
  listingId,
}: {
  eventId: string
  attendeeCount: number
  listingId: string
}) {
  const [isPending, startTransition] = useTransition()
  const [result, setResult] = useState<FollowupResult | null>(null)
  const { toast } = useToast()

  function handleProcess() {
    startTransition(async () => {
      const res = await processEventFollowups(eventId)
      setResult(res as FollowupResult)
      if (res.success) {
        toast({
          title: `Follow-ups ready`,
          description: `${res.processed ?? 0} follow-up message${(res.processed ?? 0) !== 1 ? "s" : ""} prepared`,
        })
      } else {
        toast({ title: "Follow-up processing failed", description: res.error, variant: "destructive" })
      }
    })
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-indigo-600" />
          Follow-up Processing
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!result ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Process follow-up messages for {attendeeCount} attendee{attendeeCount !== 1 ? "s" : ""} from this event. AI scores each visitor and queues personalised outreach.
            </p>
            <Button size="sm" onClick={handleProcess} disabled={isPending}>
              {isPending ? (
                <RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5 mr-1.5" />
              )}
              Process Follow-ups
            </Button>
          </div>
        ) : result.success ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs text-emerald-700">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>
                <strong>{result.processed ?? result.followups?.length ?? 0}</strong> follow-up message{((result.processed ?? 0) !== 1) ? "s" : ""} are ready to review.
              </span>
            </div>
            <Link href={`/dashboard/listings/${listingId}/seller-updates`}>
              <Button size="sm" variant="outline" className="text-xs gap-1.5">
                <MessageSquare className="h-3.5 w-3.5" />
                Review Follow-ups
              </Button>
            </Link>
          </div>
        ) : (
          <div className="flex items-start gap-2 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            {result.error ?? "Processing failed. Try again."}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
