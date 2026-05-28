"use client"

import { useState, useTransition, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  QrCode,
  Download,
  Users,
  Flame,
  UserCheck,
  ExternalLink,
  RefreshCw,
  CloudSun,
  AlertTriangle,
  CheckCircle2,
  Sparkles,
} from "lucide-react"
import { endOpenHouseEvent, createQrCodeForEvent, checkInAttendee, convertAttendeeToContact } from "@/app/actions/seller-open-house"
import {
  getOpenHouseVisitors,
  fetchWeatherForEvent,
  monitorCompetingEvents,
} from "@/app/actions/open-house-automation"
import { useToast } from "@/hooks/use-toast"

interface Props {
  listingId: string
  data: any
  onRefresh: (d: any) => void
  agentId: string
  userId: string
}

const INTEREST_COLORS: Record<string, string> = {
  hot: "bg-amber-100 text-amber-800 border-amber-200",
  warm: "bg-orange-100 text-orange-800 border-orange-200",
  cold: "bg-blue-100 text-blue-800 border-blue-200",
}

export function EventDayTab({ listingId, data, onRefresh, agentId, userId }: Props) {
  const [endingEventId, setEndingEventId] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()
  const { listing, events, attendees, packetJob } = data

  // Active event = first scheduled or in_progress, fallback to most recent
  const activeEvent =
    events.find((e: any) => e.status === "in_progress") ??
    events.find((e: any) => e.status === "scheduled") ??
    events[0] ??
    null
  const activeEventId: string | null = activeEvent?.id ?? null

  // Event Day Operations state
  const [visitors, setVisitors] = useState<any[]>([])
  const [weather, setWeather] = useState<any>(null)
  const [competing, setCompeting] = useState<any>(null)
  const [walkInName, setWalkInName] = useState("")
  const [walkInPhone, setWalkInPhone] = useState("")
  const [checkingIn, setCheckingIn] = useState(false)
  const [refreshingVisitors, setRefreshingVisitors] = useState(false)

  async function loadVisitors(eventId: string) {
    const res = await getOpenHouseVisitors(eventId).catch(() => null)
    setVisitors((res as any)?.visitors ?? [])
  }

  useEffect(() => {
    if (!activeEventId) return

    // Load visitors, weather, and competing in parallel
    loadVisitors(activeEventId)

    fetchWeatherForEvent(activeEventId)
      .then((w) => setWeather(w))
      .catch(() => null)

    monitorCompetingEvents(activeEventId)
      .then((c) => setCompeting(c))
      .catch(() => null)
  }, [activeEventId])

  async function handleCheckIn() {
    if (!activeEventId) return
    if (!walkInName.trim()) {
      toast({ title: "Enter visitor name", variant: "destructive" })
      return
    }
    setCheckingIn(true)
    try {
      const res = await checkInAttendee({
        eventId: activeEventId,
        name: walkInName.trim(),
        email: walkInPhone
          ? `${walkInPhone.replace(/\D/g, "")}@walkin.open`
          : undefined,
        phone: walkInPhone.trim() || undefined,
        workingWithAgent: false,
        tcpaConsent: true,
      })
      if (res.success) {
        toast({ title: "Visitor checked in", description: walkInName })
        setWalkInName("")
        setWalkInPhone("")
        await loadVisitors(activeEventId)
      } else {
        toast({ title: "Check-in failed", description: res.error, variant: "destructive" })
      }
    } catch {
      toast({ title: "Check-in failed", variant: "destructive" })
    } finally {
      setCheckingIn(false)
    }
  }

  async function handleRefreshVisitors() {
    if (!activeEventId) return
    setRefreshingVisitors(true)
    await loadVisitors(activeEventId)
    setRefreshingVisitors(false)
  }

  function handleEndEvent(eventId: string) {
    setEndingEventId(eventId)
    startTransition(async () => {
      const res = await endOpenHouseEvent({
        eventId,
        listingId,
        brokerageId: listing.brokerage_id,
        agentId: listing.agent_id,
        userId: listing.agent_id,
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

  const weatherOk = weather && !weather.error
  const competingOk = competing && !competing.error

  return (
    <div className="flex flex-col gap-6">
      {/* ── Event Day Operations ── */}
      {activeEventId && (
        <div className="flex flex-col gap-4">
          {/* Row 1: Weather + Competing */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {/* Weather */}
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <CloudSun className="h-4 w-4 text-muted-foreground" />
                  <CardTitle className="text-sm">Weather Forecast</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                {weatherOk ? (
                  <div className="flex flex-col gap-1">
                    <span className="text-2xl font-bold">{weather.temperature}°F</span>
                    <span className="text-sm text-muted-foreground capitalize">{weather.conditions}</span>
                    <div className="flex flex-wrap gap-3 mt-1 text-xs text-muted-foreground">
                      <span>Precip: {weather.precip_chance}%</span>
                      <span>Wind: {weather.wind_speed} mph</span>
                      {weather.quality_score !== undefined && (
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${weather.quality_score >= 70 ? "border-green-300 text-green-700" : weather.quality_score >= 40 ? "border-yellow-300 text-yellow-700" : "border-red-300 text-red-700"}`}
                        >
                          Score {weather.quality_score}/100
                        </Badge>
                      )}
                    </div>
                  </div>
                ) : (
                  <span className="text-sm text-muted-foreground">
                    {weather?.error ?? "Weather unavailable for this property location."}
                  </span>
                )}
              </CardContent>
            </Card>

            {/* Competing Events */}
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                  <CardTitle className="text-sm">Competition</CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                {competingOk ? (
                  <div className="flex flex-col gap-1">
                    {competing.total_competing === 0 ? (
                      <div className="flex items-center gap-1.5 text-sm text-green-700">
                        <CheckCircle2 className="h-4 w-4" />
                        No competing open houses on this date
                      </div>
                    ) : (
                      <>
                        <span className="text-2xl font-bold">{competing.total_competing}</span>
                        <span className="text-sm text-muted-foreground">
                          competing open house{competing.total_competing !== 1 ? "s" : ""} on same date
                        </span>
                        {competing.same_time_conflicts > 0 && (
                          <Badge variant="outline" className="w-fit text-xs border-amber-300 text-amber-700 mt-1">
                            {competing.same_time_conflicts} overlapping time slot{competing.same_time_conflicts !== 1 ? "s" : ""}
                          </Badge>
                        )}
                      </>
                    )}
                  </div>
                ) : (
                  <span className="text-sm text-muted-foreground">
                    Competition data unavailable.
                  </span>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Row 2: Live Visitor Check-In */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm">Live Visitor Check-In</CardTitle>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    Live Attendees: <strong>{visitors.length}</strong>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0"
                    onClick={handleRefreshVisitors}
                    disabled={refreshingVisitors}
                    aria-label="Refresh visitors"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${refreshingVisitors ? "animate-spin" : ""}`} />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {/* Walk-in form */}
              <div className="flex flex-wrap items-end gap-2">
                <div className="flex flex-col gap-1.5 flex-1 min-w-32">
                  <label className="text-xs font-medium text-muted-foreground">Name</label>
                  <Input
                    placeholder="Visitor name"
                    value={walkInName}
                    onChange={(e) => setWalkInName(e.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1.5 flex-1 min-w-32">
                  <label className="text-xs font-medium text-muted-foreground">Phone</label>
                  <Input
                    placeholder="Phone number"
                    value={walkInPhone}
                    onChange={(e) => setWalkInPhone(e.target.value)}
                    type="tel"
                  />
                </div>
                <Button onClick={handleCheckIn} disabled={checkingIn || !walkInName.trim()} className="shrink-0">
                  {checkingIn ? (
                    <RefreshCw className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <UserCheck className="mr-1.5 h-4 w-4" />
                  )}
                  Check In
                </Button>
              </div>

              {/* Live visitor list */}
              {visitors.length > 0 && (
                <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto">
                  {visitors.map((v: any) => {
                    const name =
                      v.contact_name ??
                      (v.contact ? `${v.contact.first_name ?? ""} ${v.contact.last_name ?? ""}`.trim() : null) ??
                      "Guest"
                    const phone = v.contact_phone ?? v.contact?.phone ?? null
                    const checkInTime = v.check_in_time
                      ? new Date(v.check_in_time).toLocaleTimeString("en-US", {
                          hour: "numeric",
                          minute: "2-digit",
                        })
                      : null

                    return (
                      <div
                        key={v.id}
                        className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2"
                      >
                        <div className="flex flex-col gap-0.5">
                          <span className="text-sm font-medium">{name}</span>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            {phone && <span>{phone}</span>}
                            {checkInTime && <span>Checked in {checkInTime}</span>}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {visitors.length === 0 && (
                <p className="text-xs text-muted-foreground">No visitors checked in yet.</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Per-event cards (existing structure) ── */}
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
                      weekday: "long",
                      month: "long",
                      day: "numeric",
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
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleCreateQr(event.id)}
                    disabled={isPending}
                  >
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
                      <AttendeeRow
                        key={attendee.id}
                        attendee={attendee}
                        listingId={listingId}
                        brokerageId={listing.brokerage_id}
                        agentId={agentId}
                        userId={userId}
                        onEnrolled={() => loadVisitors(event.id)}
                      />
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

function AttendeeRow({
  attendee,
  listingId,
  brokerageId,
  agentId,
  userId,
  onEnrolled,
}: {
  attendee: any
  listingId: string
  brokerageId: string
  agentId: string
  userId: string
  onEnrolled: () => void
}) {
  const score = attendee.ai_lead_score ?? 0
  const isHot = score >= 70
  const interest = attendee.interest_level ?? "cold"
  const [enrolling, setEnrolling] = useState(false)
  const { toast } = useToast()

  async function handleEnroll() {
    setEnrolling(true)
    try {
      const res = await convertAttendeeToContact({
        attendeeId: attendee.id,
        listingId,
        brokerageId,
        agentId,
        userId,
      })
      if (res.success) {
        toast({ title: "Contact enrolled", description: (res as any).isNew ? "New contact created" : "Existing contact updated" })
        onEnrolled()
      } else {
        toast({ title: "Enroll failed", description: (res as any).error, variant: "destructive" })
      }
    } catch {
      toast({ title: "Enroll failed", variant: "destructive" })
    } finally {
      setEnrolling(false)
    }
  }

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
              Check-in:{" "}
              {new Date(attendee.check_in_time).toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          )}
          {/* Open House Concierge auto-greeting status — stamped by
              sendInstantOpenHouseGreeting() at /api/open-house/attend. */}
          {attendee.instant_greeting_sent_at && (
            <span className="text-[11px] text-emerald-700 dark:text-emerald-400 flex items-center gap-1">
              <Sparkles className="h-3 w-3" />
              Auto-{attendee.instant_greeting_channel === "sms" ? "text" : "email"} sent{" "}
              {(() => {
                const ms = Date.now() - new Date(attendee.instant_greeting_sent_at).getTime()
                if (ms < 90_000) return "just now"
                const min = Math.floor(ms / 60_000)
                return `${min}m ago`
              })()}
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
        <span className="text-xs font-mono text-muted-foreground w-10 text-right">{score}/100</span>
        {isHot && !attendee.contact_id && (
          <Button
            size="sm"
            variant="outline"
            className="text-xs h-6 px-2 border-amber-300 text-amber-800 hover:bg-amber-100"
            disabled={enrolling}
            onClick={handleEnroll}
          >
            {enrolling ? "Enrolling..." : "Enroll"}
          </Button>
        )}
      </div>
    </div>
  )
}
