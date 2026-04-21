"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import {
  Home, Calendar, Users, Star, Plus, Clock, MapPin, ChevronRight,
  Loader2, TrendingUp, CheckCircle2, AlertCircle
} from "lucide-react"
import { createOpenHouse, type OpenHouseEvent } from "@/app/actions/open-house"
import { useToast } from "@/hooks/use-toast"

interface Props {
  initialEvents: OpenHouseEvent[]
  fetchError?: string
}

const STATUS_STYLES: Record<string, string> = {
  scheduled: "bg-blue-100 text-blue-700 border-blue-200",
  active: "bg-green-100 text-green-700 border-green-200",
  completed: "bg-slate-100 text-slate-600 border-slate-200",
  cancelled: "bg-red-100 text-red-700 border-red-200",
}

function formatDate(dateStr: string) {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  })
}

function formatTime(t: string) {
  const [h, m] = t.split(":").map(Number)
  const period = h >= 12 ? "PM" : "AM"
  const hour = h % 12 || 12
  return `${hour}:${m.toString().padStart(2, "0")} ${period}`
}

export function OpenHousesClient({ initialEvents, fetchError }: Props) {
  const [events, setEvents] = useState<OpenHouseEvent[]>(initialEvents)
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()
  const router = useRouter()

  const [form, setForm] = useState({
    listingId: "",
    date: "",
    startTime: "10:00",
    endTime: "12:00",
    maxAttendees: "",
    publicDescription: "",
    agentNotes: "",
  })

  const now = new Date().toLocaleDateString("en-CA") // YYYY-MM-DD in local timezone
  const upcoming = events.filter((e) => e.event_date >= now && e.status !== "cancelled" && e.status !== "completed")
  const past = events.filter((e) => e.event_date < now || e.status === "completed" || e.status === "cancelled")
  const totalAttendees = events.reduce((s, e) => s + (e.attendee_count ?? 0), 0)
  const avgFeedback = (() => {
    const rated = events.filter((e) => e.avg_feedback != null)
    if (!rated.length) return null
    return (rated.reduce((s, e) => s + (e.avg_feedback ?? 0), 0) / rated.length).toFixed(1)
  })()

  const handleCreate = () => {
    if (!form.listingId.trim() || !form.date) {
      toast({ title: "Listing ID and date are required", variant: "destructive" })
      return
    }
    startTransition(async () => {
      const res = await createOpenHouse({
        listingId: form.listingId.trim(),
        date: form.date,
        startTime: form.startTime,
        endTime: form.endTime,
        maxAttendees: form.maxAttendees ? Number(form.maxAttendees) : undefined,
        agentNotes: form.agentNotes || undefined,
        publicDescription: form.publicDescription || undefined,
      })
      if (res.success && res.event) {
        toast({ title: "Open house scheduled" })
        setEvents((prev) => [res.event as OpenHouseEvent, ...prev])
        setOpen(false)
        setForm({ listingId: "", date: "", startTime: "10:00", endTime: "12:00", maxAttendees: "", publicDescription: "", agentNotes: "" })
      } else {
        toast({ title: res.error ?? "Failed to schedule open house", variant: "destructive" })
      }
    })
  }

  return (
    <div className="min-h-screen bg-muted/20">
      <div className="border-b bg-background px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Home className="h-5 w-5 text-primary" /> Open House Engine
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">Schedule, track attendees, and convert open house visitors into clients</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2"><Plus className="h-4 w-4" /> Schedule Open House</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Schedule Open House</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <div>
                <Label className="text-xs">Listing ID</Label>
                <Input
                  placeholder="Paste listing UUID..."
                  value={form.listingId}
                  onChange={(e) => setForm((f) => ({ ...f, listingId: e.target.value }))}
                  className="h-8 text-sm mt-1"
                />
                <p className="text-[10px] text-muted-foreground mt-1">Find the ID from your Listings page</p>
              </div>
              <div>
                <Label className="text-xs">Event Date</Label>
                <Input
                  type="date"
                  value={form.date}
                  onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                  className="h-8 text-sm mt-1"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Start Time</Label>
                  <Input
                    type="time"
                    value={form.startTime}
                    onChange={(e) => setForm((f) => ({ ...f, startTime: e.target.value }))}
                    className="h-8 text-sm mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs">End Time</Label>
                  <Input
                    type="time"
                    value={form.endTime}
                    onChange={(e) => setForm((f) => ({ ...f, endTime: e.target.value }))}
                    className="h-8 text-sm mt-1"
                  />
                </div>
              </div>
              <div>
                <Label className="text-xs">Max Attendees (optional)</Label>
                <Input
                  type="number"
                  placeholder="Leave blank for unlimited"
                  value={form.maxAttendees}
                  onChange={(e) => setForm((f) => ({ ...f, maxAttendees: e.target.value }))}
                  className="h-8 text-sm mt-1"
                />
              </div>
              <div>
                <Label className="text-xs">Public Description</Label>
                <Textarea
                  placeholder="What makes this property special? Visitors will see this."
                  value={form.publicDescription}
                  onChange={(e) => setForm((f) => ({ ...f, publicDescription: e.target.value }))}
                  rows={3}
                  className="text-sm mt-1 resize-none"
                />
              </div>
              <div>
                <Label className="text-xs">Agent Notes (private)</Label>
                <Textarea
                  placeholder="Talking points, objections to handle, features to highlight..."
                  value={form.agentNotes}
                  onChange={(e) => setForm((f) => ({ ...f, agentNotes: e.target.value }))}
                  rows={2}
                  className="text-sm mt-1 resize-none"
                />
              </div>
              <Button onClick={handleCreate} disabled={isPending} className="w-full gap-2">
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Calendar className="h-4 w-4" />}
                Schedule Open House
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {fetchError && (
        <div className="bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-3 text-sm text-destructive flex items-center gap-2 mx-6 mt-4">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {fetchError}
        </div>
      )}

      <div className="p-6 space-y-6">
        {/* KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Calendar className="h-3.5 w-3.5" /> Upcoming
              </div>
              <div className="text-2xl font-bold">{upcoming.length}</div>
              <div className="text-xs text-muted-foreground">open houses scheduled</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Users className="h-3.5 w-3.5" /> Total Attendees
              </div>
              <div className="text-2xl font-bold">{totalAttendees}</div>
              <div className="text-xs text-muted-foreground">across all events</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <Star className="h-3.5 w-3.5" /> Avg Feedback
              </div>
              <div className="text-2xl font-bold">{avgFeedback ?? "—"}</div>
              <div className="text-xs text-muted-foreground">{avgFeedback ? "out of 5 stars" : "no ratings yet"}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <TrendingUp className="h-3.5 w-3.5" /> Past Events
              </div>
              <div className="text-2xl font-bold">{past.length}</div>
              <div className="text-xs text-muted-foreground">completed open houses</div>
            </CardContent>
          </Card>
        </div>

        {/* Upcoming Events */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Calendar className="h-4 w-4 text-primary" /> Upcoming Open Houses
            </CardTitle>
          </CardHeader>
          <CardContent>
            {upcoming.length === 0 ? (
              <div className="text-center py-10 space-y-3">
                <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mx-auto">
                  <Home className="h-6 w-6 text-muted-foreground" />
                </div>
                <p className="text-sm font-medium">No upcoming open houses</p>
                <p className="text-xs text-muted-foreground max-w-xs mx-auto">
                  Schedule your first open house to start capturing leads and converting visitors into buyers.
                </p>
                <Button size="sm" onClick={() => setOpen(true)} className="gap-1.5">
                  <Plus className="h-3.5 w-3.5" /> Schedule Now
                </Button>
              </div>
            ) : (
              <div className="divide-y">
                {upcoming.map((event) => (
                  <EventRow key={event.id} event={event} onClick={() => router.push(`/dashboard/open-houses/${event.id}`)} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Past Events */}
        {past.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-muted-foreground" /> Past Open Houses
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="divide-y">
                {past.slice(0, 10).map((event) => (
                  <EventRow key={event.id} event={event} onClick={() => router.push(`/dashboard/open-houses/${event.id}`)} />
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}

function EventRow({ event, onClick }: { event: OpenHouseEvent; onClick: () => void }) {
  const listing = event.listing
  const address = listing
    ? [listing.address, listing.city, listing.state].filter(Boolean).join(", ")
    : "Unlisted property"

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left flex items-center gap-4 py-3 hover:bg-muted/30 rounded-md px-2 -mx-2 transition-colors"
    >
      <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
        <Home className="h-5 w-5 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium truncate">{address}</p>
          <Badge className={`text-[10px] px-1.5 py-0 border ${STATUS_STYLES[event.status] ?? "bg-muted"}`}>
            {event.status}
          </Badge>
        </div>
        <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
          <span className="flex items-center gap-1"><Calendar className="h-3 w-3" />{formatDate(event.event_date)}</span>
          <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{formatTime(event.start_time)} – {formatTime(event.end_time)}</span>
          {(event.attendee_count ?? 0) > 0 && (
            <span className="flex items-center gap-1"><Users className="h-3 w-3" />{event.attendee_count} attendees</span>
          )}
          {listing?.list_price && (
            <span className="flex items-center gap-1">
              ${(listing.list_price / 1000).toFixed(0)}k
            </span>
          )}
        </div>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
    </button>
  )
}
