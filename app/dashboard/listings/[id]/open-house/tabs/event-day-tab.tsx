"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { QrCode, Download, Users, Flame, UserCheck, ExternalLink } from "lucide-react"
import { endOpenHouseEvent, createQrCodeForEvent } from "@/app/actions/seller-open-house"
import { useToast } from "@/hooks/use-toast"
import { createClient } from "@/lib/supabase/client"

interface Props {
  listingId: string
  data: any
  onRefresh: (d: any) => void
}

const INTEREST_COLORS: Record<string, string> = {
  hot: "bg-amber-100 text-amber-800 border-amber-200",
  warm: "bg-orange-100 text-orange-800 border-orange-200",
  cold: "bg-blue-100 text-blue-800 border-blue-200",
}

export function EventDayTab({ listingId, data, onRefresh }: Props) {
  const [endingEventId, setEndingEventId] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()
  const { listing, events, attendees, packetJob } = data

  function handleEndEvent(eventId: string) {
    setEndingEventId(eventId)
    startTransition(async () => {
      const res = await endOpenHouseEvent({
        eventId,
        listingId,
        brokerageId: listing.brokerage_id,
        agentId: listing.agent_id,
        userId: listing.agent_id, // resolved by auth in action; placeholder matches agent
      })
      setEndingEventId(null)
      if (res.success) {
        toast({ title: "Event ended", description: "Attendees scored. Hot leads enrolled in follow-up." })
      } else {
        toast({ title: "Failed to end event", description: res.error, variant: "destructive" })
      }
    })
  }

  function handleCreateQr(eventId: string) {
    startTransition(async () => {
      const res = await createQrCodeForEvent({
        eventId,
        listingId,
        brokerageId: listing.brokerage_id,
        agentId: listing.agent_id,
      })
      if (res.success) {
        toast({ title: "QR code created", description: `Sign-in link ready.` })
      } else {
        toast({ title: "Failed to create QR code", description: res.error, variant: "destructive" })
      }
    })
  }

  if (!events.length) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          No open house events scheduled for this listing yet.
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {events.map((event: any) => {
        const eventAttendees = attendees.filter((a: any) => a.event_id === event.id)
        const hotLeads = eventAttendees.filter((a: any) => (a.ai_lead_score ?? 0) >= 70)
        const signInUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/open-house/${event.id}/signin`

        return (
          <Card key={event.id}>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div className="flex flex-col gap-1">
                  <CardTitle className="text-base">
                    {new Date(event.event_date).toLocaleDateString("en-US", {
                      weekday: "long", month: "long", day: "numeric",
                    })}
                  </CardTitle>
                  <span className="text-sm text-muted-foreground">
                    {event.start_time} – {event.end_time}
                  </span>
                </div>
                <Badge
                  className={`text-xs border ${
                    event.status === "completed"
                      ? "bg-green-100 text-green-800 border-green-200"
                      : event.status === "in_progress"
                      ? "bg-blue-100 text-blue-800 border-blue-200"
                      : "bg-muted text-muted-foreground border-border"
                  }`}
                >
                  {event.status}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {/* Stats row */}
              <div className="flex flex-wrap gap-4">
                <div className="flex items-center gap-1.5 text-sm">
                  <Users className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">{eventAttendees.length}</span>
                  <span className="text-muted-foreground">attendees</span>
                </div>
                <div className="flex items-center gap-1.5 text-sm">
                  <Flame className="h-4 w-4 text-amber-500" />
                  <span className="font-medium">{hotLeads.length}</span>
                  <span className="text-muted-foreground">hot leads</span>
                </div>
                {event.qr_codes && (
                  <div className="flex items-center gap-1.5 text-sm">
                    <QrCode className="h-4 w-4 text-muted-foreground" />
                    <span className="font-medium">{event.qr_codes.scan_count ?? 0}</span>
                    <span className="text-muted-foreground">QR scans</span>
                  </div>
                )}
              </div>

              {/* QR + Packet row */}
              <div className="flex flex-wrap gap-2">
                {event.qr_code_id ? (
                  <a
                    href={signInUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted/50 transition-colors"
                  >
                    <QrCode className="h-3.5 w-3.5" />
                    Open Sign-In
                    <ExternalLink className="h-3 w-3 text-muted-foreground" />
                  </a>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => handleCreateQr(event.id)} disabled={isPending}>
                    <QrCode className="mr-1.5 h-3.5 w-3.5" />
                    Generate QR Code
                  </Button>
                )}
                {packetJob?.output_url && (
                  <a
                    href={packetJob.output_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted/50 transition-colors"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Listing Packet
                  </a>
                )}
              </div>

              {/* Attendee list */}
              {eventAttendees.length > 0 && (
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Attendees
                  </span>
                  <div className="flex flex-col gap-1.5">
                    {eventAttendees.map((attendee: any) => (
                      <AttendeeRow key={attendee.id} attendee={attendee} />
                    ))}
                  </div>
                </div>
              )}

              {/* End Event */}
              {event.status === "scheduled" || event.status === "in_progress" ? (
                <div className="border-t border-border pt-3">
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => handleEndEvent(event.id)}
                    disabled={isPending && endingEventId === event.id}
                  >
                    {isPending && endingEventId === event.id ? "Ending event..." : "End Event"}
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

function AttendeeRow({ attendee }: { attendee: any }) {
  const score = attendee.ai_lead_score ?? 0
  const isHot = score >= 70
  const interest = attendee.interest_level ?? "cold"

  return (
    <div
      className={`flex items-center justify-between rounded-md border px-3 py-2 ${
        isHot ? "border-amber-200 bg-amber-50" : "border-border bg-background"
      }`}
    >
      <div className="flex items-center gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">
            {attendee.contact_id ? `Contact ${attendee.contact_id.slice(0, 6)}` : "Guest"}
          </span>
          {attendee.check_in_time && (
            <span className="text-xs text-muted-foreground">
              Check-in: {new Date(attendee.check_in_time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {attendee.working_with_agent && (
          <Badge variant="outline" className="text-xs">
            <UserCheck className="mr-1 h-3 w-3" />
            Has Agent
          </Badge>
        )}
        <Badge className={`text-xs border ${INTEREST_COLORS[interest] ?? INTEREST_COLORS.cold}`}>
          {interest}
        </Badge>
        <span className="text-xs font-mono text-muted-foreground w-10 text-right">
          {score}/100
        </span>
        {isHot && (
          <Button size="sm" variant="outline" className="text-xs h-6 px-2 border-amber-300 text-amber-800 hover:bg-amber-100">
            Enroll
          </Button>
        )}
      </div>
    </div>
  )
}
