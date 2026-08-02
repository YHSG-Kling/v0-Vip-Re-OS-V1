"use client"

import { useState, useTransition, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Mail,
  MessageSquare,
  Users,
  CheckCircle,
  Clock,
  Send,
  CalendarPlus,
  Sparkles,
  Loader2,
  RefreshCw,
} from "lucide-react"
import { inviteFarmContacts, createOpenHouseEvent } from "@/app/actions/seller-open-house"
import {
  getOpenHouseEvents,
  sendOpenHouseInvitations,
  optimizeOpenHouseTiming,
} from "@/app/actions/open-house-automation"
import { createClient } from "@/lib/supabase/client"
import { useToast } from "@/hooks/use-toast"

interface Props {
  listingId: string
  data: any
  onRefresh: (d: any) => void
}

const POST_TYPE_LABELS: Record<string, string> = {
  open_house_announcement: "Open House Announcement",
  open_house_reminder: "Open House Reminder",
  coming_soon: "Coming Soon",
}

const STATUS_COLORS: Record<string, string> = {
  published: "bg-green-100 text-green-800 border-green-200",
  scheduled: "bg-blue-100 text-blue-800 border-blue-200",
  draft: "bg-muted text-muted-foreground border-border",
}

const EVENT_STATUS_COLORS: Record<string, string> = {
  scheduled: "bg-blue-100 text-blue-800 border-blue-200",
  in_progress: "bg-green-100 text-green-800 border-green-200",
  completed: "bg-muted text-muted-foreground border-border",
  cancelled: "bg-red-100 text-red-800 border-red-200",
}

export function MarketingTab({ listingId, data, onRefresh }: Props) {
  const [channel, setChannel] = useState<"email" | "sms" | "both">("email")
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()
  const { listing, socialPosts, events: dataEvents, invitations } = data

  // Schedule open house state
  const [eventDate, setEventDate] = useState("")
  const [startTime, setStartTime] = useState("10:00")
  const [endTime, setEndTime] = useState("12:00")
  const [creatingEvent, setCreatingEvent] = useState(false)
  const [scheduledEvents, setScheduledEvents] = useState<any[]>([])
  const [timingResult, setTimingResult] = useState<any>(null)
  const [optimizingTiming, setOptimizingTiming] = useState(false)
  const [invitingEventId, setInvitingEventId] = useState<string | null>(null)

  // Load listing-scoped events on mount — filter client-side after fetching by agent
  useEffect(() => {
    if (listing?.agent_id) {
      getOpenHouseEvents(listing.agent_id).then((evts) => {
        const filtered = (evts ?? []).filter(
          (e: any) => e.listing_id === listingId || e.property?.id === listingId
        )
        setScheduledEvents(filtered)
      })
    }
  }, [listing?.agent_id, listingId])

  // Pick the upcoming event for invitations (existing farm invite section)
  const upcomingEvent = dataEvents.find((e: any) => e.status === "scheduled") ?? dataEvents[0]

  // RSVP tallies
  const rsvpYes = invitations.filter((i: any) => i.rsvp_response === "yes").length
  const rsvpMaybe = invitations.filter((i: any) => i.rsvp_response === "maybe").length
  const noResponse = invitations.filter((i: any) => !i.rsvp_response).length

  const comingSoonPosts = socialPosts.filter((p: any) => p.post_type === "coming_soon")
  const openHousePosts = socialPosts.filter((p: any) => p.post_type !== "coming_soon")

  async function handleOptimizeTiming() {
    setOptimizingTiming(true)
    try {
      const result = await optimizeOpenHouseTiming({
        propertyId: listingId,
        agentId: listing.agent_id,
      })
      // The result WAS captured — and then rendered without asking whether it
      // was a result at all. A { success:false, error } object went into the
      // panel as though it were timing advice.
      if (!result?.success) {
        toast({ title: "Could not optimize timing", description: (result as any)?.error ?? "No timing advice was produced.", variant: "destructive" })
        return
      }
      setTimingResult(result)
    } catch {
      toast({ title: "Failed to optimize timing", variant: "destructive" })
    } finally {
      setOptimizingTiming(false)
    }
  }

  async function handleCreateEvent() {
    if (!eventDate) {
      toast({ title: "Select a date first", variant: "destructive" })
      return
    }
    setCreatingEvent(true)
    try {
      const res = await createOpenHouseEvent({
        listingId,
        brokerageId: listing.brokerage_id,
        agentId: listing.agent_id,
        userId: listing.agent_id,
        eventDate,
        startTime,
        endTime,
      })
      if (res.success) {
        toast({ title: "Open house scheduled", description: `${eventDate} from ${startTime} to ${endTime}` })
        setEventDate("")
        setStartTime("10:00")
        setEndTime("12:00")
        setTimingResult(null)
        // Reload events, scoped to this listing
        const evts = await getOpenHouseEvents(listing.agent_id)
        setScheduledEvents(
          (evts ?? []).filter(
            (e: any) => e.listing_id === listingId || e.property?.id === listingId
          )
        )
      } else {
        toast({ title: "Failed to schedule event", description: res.error, variant: "destructive" })
      }
    } catch {
      toast({ title: "Failed to schedule event", variant: "destructive" })
    } finally {
      setCreatingEvent(false)
    }
  }

  async function handleSendInvitations(eventId: string) {
    setInvitingEventId(eventId)
    try {
      const supabase = createClient()
      const { data: farmContacts } = await supabase
        .from("contacts")
        .select("id")
        .eq("brokerage_id", listing.brokerage_id)
        .eq("zip_code", listing.zip)
        .limit(100)

      if (!farmContacts?.length) {
        toast({
          title: "No farm contacts found",
          description: `No contacts found for zip ${listing.zip}.`,
          variant: "destructive",
        })
        return
      }

      const res = await sendOpenHouseInvitations({
        eventId,
        contactIds: farmContacts.map((c: any) => c.id),
      })

      // Report the DELIVERED count, not the size of the list we walked. The old
      // copy said "Invitations sent to N contacts" using farmContacts.length —
      // the number of people considered — for a code path that sent nothing at
      // all. Now that every send passes the consent gate, a refused contact is
      // a normal outcome and the agent needs to see it.
      if (res.success) {
        const refused = (res.attempted ?? 0) - (res.delivered ?? 0)
        toast({
          title: "Invitations sent",
          description:
            `${res.delivered} of ${res.attempted} contacts in ${listing.zip} were invited.` +
            (refused > 0 ? ` ${refused} could not be contacted — check the contact timeline for the reason.` : ""),
        })
      } else {
        toast({ title: "No invitations were delivered", description: res.error, variant: "destructive" })
      }
    } catch {
      toast({ title: "Failed to send invitations", variant: "destructive" })
    } finally {
      setInvitingEventId(null)
    }
  }

  function handleInvite() {
    if (!upcomingEvent) {
      toast({ title: "No upcoming event", description: "Schedule an open house event first.", variant: "destructive" })
      return
    }
    startTransition(async () => {
      const res = await inviteFarmContacts({
        eventId: upcomingEvent.id,
        listingId,
        brokerageId: listing.brokerage_id,
        agentId: listing.agent_id,
        zip: listing.zip,
        channel,
      })
      if (res.success) {
        toast({
          title: `Invitations staged`,
          description: `${res.invited} invitation${res.invited === 1 ? "" : "s"} staged for ${channel}. Nothing has been delivered yet — an invitation sender still has to pick these up.`,
        })
      } else {
        toast({ title: "Failed to send invitations", description: res.error, variant: "destructive" })
      }
    })
  }

  return (
    <div className="flex flex-col gap-6">
      {/* ── Schedule Open House ── */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CalendarPlus className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Schedule Open House</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">Date</label>
              <Input
                type="date"
                value={eventDate}
                onChange={(e) => setEventDate(e.target.value)}
                min={new Date().toISOString().split("T")[0]}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">Start Time</label>
              <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">End Time</label>
              <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleOptimizeTiming} disabled={optimizingTiming}>
              {optimizingTiming ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />
              )}
              Optimize Timing First
            </Button>
            <Button size="sm" onClick={handleCreateEvent} disabled={creatingEvent || !eventDate}>
              {creatingEvent ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <CalendarPlus className="mr-1.5 h-3.5 w-3.5" />
              )}
              Schedule Event
            </Button>
          </div>

          {/* Timing recommendation */}
          {timingResult && timingResult.recommended_times && (
            <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3">
              <span className="text-xs font-medium">AI Timing Recommendations</span>
              {(() => {
                const today = new Date()
                today.setHours(0, 0, 0, 0)
                const validRecs = timingResult.recommended_times.filter((r: any) => new Date(r.date) >= today)
                return validRecs
              })()
                .slice(0, 2).map((rec: any, idx: number) => (
                <div key={idx} className="flex items-start justify-between gap-2">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{rec.date} · {rec.time}</span>
                    <span className="text-xs text-muted-foreground">{rec.reasoning}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant="secondary" className="text-xs">Score {rec.score}</Badge>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-xs px-2"
                      onClick={() => {
                        setEventDate(rec.date)
                        const [s, e] = rec.time.split("-")
                        if (s) setStartTime(s.trim())
                        if (e) setEndTime(e.trim())
                      }}
                    >
                      Use
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Existing scheduled events list */}
          {scheduledEvents.length > 0 && (
            <div className="flex flex-col gap-2 border-t border-border pt-4">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Scheduled Events</span>
              {scheduledEvents.map((event: any) => (
                <div
                  key={event.id}
                  className="flex items-center justify-between rounded-md border border-border px-3 py-2.5"
                >
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">
                      {new Date(event.event_date).toLocaleDateString("en-US", {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {event.start_time} – {event.end_time}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge
                      className={`text-xs border ${EVENT_STATUS_COLORS[event.status] ?? EVENT_STATUS_COLORS.scheduled}`}
                    >
                      {event.status}
                    </Badge>
                    {(event.status === "scheduled" || event.status === "in_progress") && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => handleSendInvitations(event.id)}
                        disabled={invitingEventId === event.id}
                      >
                        {invitingEventId === event.id ? (
                          <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                        ) : (
                          <Send className="mr-1.5 h-3 w-3" />
                        )}
                        Send Invitations
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Coming Soon Posts */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Coming Soon Posts</CardTitle>
          <p className="text-sm text-muted-foreground">
            Coming soon posts use neighborhood only — no full address shown
          </p>
        </CardHeader>
        <CardContent>
          {comingSoonPosts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No coming soon posts yet.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {comingSoonPosts.map((post: any) => (
                <PostRow key={post.id} post={post} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Open House Social Posts */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Open House Social Posts</CardTitle>
        </CardHeader>
        <CardContent>
          {openHousePosts.length === 0 ? (
            <p className="text-sm text-muted-foreground">No open house posts scheduled.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {openHousePosts.map((post: any) => (
                <PostRow key={post.id} post={post} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Invite Farm Contacts */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invite Farm Contacts</CardTitle>
          <p className="text-sm text-muted-foreground">
            Send invitations to contacts in zip <strong>{listing.zip}</strong>
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Select value={channel} onValueChange={(v) => setChannel(v as any)}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="email">
                  <span className="flex items-center gap-1.5">
                    <Mail className="h-3.5 w-3.5" />
                    Email
                  </span>
                </SelectItem>
                <SelectItem value="sms">
                  <span className="flex items-center gap-1.5">
                    <MessageSquare className="h-3.5 w-3.5" />
                    SMS
                  </span>
                </SelectItem>
                <SelectItem value="both">
                  <span className="flex items-center gap-1.5">
                    <Send className="h-3.5 w-3.5" />
                    Both
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={handleInvite} disabled={isPending || !upcomingEvent}>
              <Users className="mr-1.5 h-4 w-4" />
              {isPending ? "Sending..." : "Send Invitations"}
            </Button>
          </div>

          {/* RSVP Tracker */}
          {invitations.length > 0 && (
            <div className="flex items-center gap-4 rounded-md border border-border bg-muted/30 px-4 py-3">
              <div className="flex items-center gap-1.5 text-sm">
                <CheckCircle className="h-4 w-4 text-green-600" />
                <span className="font-medium">{rsvpYes}</span>
                <span className="text-muted-foreground">Yes</span>
              </div>
              <div className="flex items-center gap-1.5 text-sm">
                <Clock className="h-4 w-4 text-yellow-600" />
                <span className="font-medium">{rsvpMaybe}</span>
                <span className="text-muted-foreground">Maybe</span>
              </div>
              <div className="flex items-center gap-1.5 text-sm">
                <span className="font-medium">{noResponse}</span>
                <span className="text-muted-foreground">No response</span>
              </div>
              <span className="text-xs text-muted-foreground ml-auto">{invitations.length} total invited</span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function PostRow({ post }: { post: any }) {
  const isAuto = post.scheduled_for && !post.published_at
  return (
    <div className="flex items-center justify-between rounded-md border border-border px-3 py-2.5">
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium capitalize">{post.platform}</span>
          <span className="text-xs text-muted-foreground">{POST_TYPE_LABELS[post.post_type] ?? post.post_type}</span>
          {isAuto && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              Auto
            </Badge>
          )}
        </div>
        {post.scheduled_for && (
          <span className="text-xs text-muted-foreground">
            {new Date(post.scheduled_for).toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </span>
        )}
      </div>
      <Badge className={`text-xs border ${STATUS_COLORS[post.status] ?? STATUS_COLORS.draft}`}>{post.status}</Badge>
    </div>
  )
}
