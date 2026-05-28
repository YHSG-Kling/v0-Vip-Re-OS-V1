"use client"

import { useState, useTransition, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select"
import {
  Home, Calendar, Users, Star, Plus, Clock, ChevronRight,
  Loader2, TrendingUp, CheckCircle2, AlertCircle, Send, XCircle,
  ThumbsUp, MessageSquare, DollarSign, UserCheck
} from "lucide-react"
import {
  createOpenHouse,
  getOpenHouseAttendees,
  getOpenHouseFeedback,
  sendOpenHouseInvites,
  cancelOpenHouse,
  recordAttendee,
  type OpenHouseEvent,
  type OpenHouseAttendee,
  type OpenHouseFeedback,
} from "@/app/actions/open-house"
import { useToast } from "@/hooks/use-toast"
import { toast as sonnerToast } from "sonner"

interface Props {
  initialEvents: OpenHouseEvent[]
  fetchError?: string
}

const STATUS_STYLES: Record<string, string> = {
  scheduled: "bg-blue-100 text-blue-700 border-blue-200",
  active: "bg-green-100 text-green-700 border-green-200",
  completed: "bg-slate-100 text-slate-600 border-slate-200",
  cancelled: "bg-red-100 text-red-700 border-red-200",
  invitations_sent: "bg-purple-100 text-purple-700 border-purple-200",
}

const INTEREST_STYLES: Record<string, string> = {
  high: "bg-green-100 text-green-700 border-green-200",
  medium: "bg-yellow-100 text-yellow-700 border-yellow-200",
  low: "bg-slate-100 text-slate-600 border-slate-200",
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

function formatCheckInTime(ts: string | null) {
  if (!ts) return "—"
  return new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
}

function StarRating({ rating }: { rating: number | null }) {
  if (rating == null) return <span className="text-muted-foreground text-xs">No rating</span>
  return (
    <span className="flex items-center gap-0.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <Star
          key={i}
          className={`h-3.5 w-3.5 ${i < rating ? "text-yellow-400 fill-yellow-400" : "text-muted-foreground/30"}`}
        />
      ))}
      <span className="text-xs text-muted-foreground ml-1">{rating}/5</span>
    </span>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// ATTENDEES TAB
// ─────────────────────────────────────────────────────────────────────────────

function AttendeesTab({ eventId }: { eventId: string }) {
  const [attendees, setAttendees] = useState<OpenHouseAttendee[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [loaded, setLoaded] = useState(false)

  // Load once when this tab mounts (i.e. when the sheet is opened and tab is shown)
  useEffect(() => {
    startTransition(async () => {
      const res = await getOpenHouseAttendees(eventId)
      if (res.success) {
        setAttendees(res.attendees ?? [])
      } else {
        setLoadError(res.error ?? "Failed to load attendees")
      }
      setLoaded(true)
    })
   
  }, [eventId])

  const [showAddForm, setShowAddForm] = useState(false)
  const [addForm, setAddForm] = useState({
    name: "",
    email: "",
    interestLevel: "",
  })
  const [addPending, startAddTransition] = useTransition()

  const handleAdd = () => {
    if (!addForm.name.trim()) {
      sonnerToast.error("Name is required")
      return
    }
    startAddTransition(async () => {
      const res = await recordAttendee(eventId, {
        name: addForm.name.trim(),
        email: addForm.email.trim() || undefined,
        interestLevel: addForm.interestLevel || undefined,
      })
      if (res.success) {
        sonnerToast.success("Attendee recorded")
        setAddForm({ name: "", email: "", interestLevel: "" })
        setShowAddForm(false)
        // Refresh attendee list
        const refresh = await getOpenHouseAttendees(eventId)
        if (refresh.success) setAttendees(refresh.attendees ?? [])
      } else {
        sonnerToast.error(res.error ?? "Failed to record attendee")
      }
    })
  }

  if (isPending && !loaded) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive py-6 px-1">
        <AlertCircle className="h-4 w-4 shrink-0" />
        {loadError}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{attendees?.length ?? 0} attendee{attendees?.length !== 1 ? "s" : ""}</p>
        <Button size="sm" variant="outline" className="gap-1.5 h-7 text-xs" onClick={() => setShowAddForm((v) => !v)}>
          <Plus className="h-3.5 w-3.5" />
          Add Attendee
        </Button>
      </div>

      {showAddForm && (
        <div className="rounded-lg border bg-muted/30 p-3 space-y-3">
          <p className="text-xs font-medium">New Attendee</p>
          <div>
            <Label className="text-xs">Name *</Label>
            <Input
              value={addForm.name}
              onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Full name"
              className="h-7 text-xs mt-1"
            />
          </div>
          <div>
            <Label className="text-xs">Email (optional)</Label>
            <Input
              type="email"
              value={addForm.email}
              onChange={(e) => setAddForm((f) => ({ ...f, email: e.target.value }))}
              placeholder="email@example.com"
              className="h-7 text-xs mt-1"
            />
          </div>
          <div>
            <Label className="text-xs">Interest Level</Label>
            <Select
              value={addForm.interestLevel}
              onValueChange={(v) => setAddForm((f) => ({ ...f, interestLevel: v }))}
            >
              <SelectTrigger className="h-7 text-xs mt-1">
                <SelectValue placeholder="Select level…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="high">High</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="low">Low</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2">
            <Button size="sm" className="h-7 text-xs gap-1" onClick={handleAdd} disabled={addPending}>
              {addPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
              Save
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowAddForm(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {attendees && attendees.length === 0 && !showAddForm && (
        <div className="text-center py-8 text-sm text-muted-foreground">
          <Users className="h-8 w-8 mx-auto mb-2 opacity-30" />
          No attendees recorded yet
        </div>
      )}

      {attendees && attendees.length > 0 && (
        <div className="divide-y text-sm">
          {attendees.map((a) => (
            <div key={a.id} className="py-2.5 flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-xs truncate">{a.name ?? "—"}</span>
                  {a.interest_level && (
                    <Badge className={`text-[10px] px-1.5 py-0 border ${INTEREST_STYLES[a.interest_level] ?? "bg-muted"}`}>
                      {a.interest_level}
                    </Badge>
                  )}
                  {a.working_with_agent && (
                    <Badge className="text-[10px] px-1.5 py-0 border bg-orange-100 text-orange-700 border-orange-200">
                      <UserCheck className="h-2.5 w-2.5 mr-0.5" />
                      Has agent
                    </Badge>
                  )}
                </div>
                {a.email && <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{a.email}</p>}
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Check-in: {formatCheckInTime(a.check_in_time)}
                </p>
              </div>
              {a.ai_lead_score != null && (
                <div className="text-right shrink-0">
                  <div className="text-[10px] text-muted-foreground">AI Score</div>
                  <div className={`text-sm font-semibold ${a.ai_lead_score >= 70 ? "text-green-600" : a.ai_lead_score >= 40 ? "text-yellow-600" : "text-red-500"}`}>
                    {a.ai_lead_score}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// FEEDBACK TAB
// ─────────────────────────────────────────────────────────────────────────────

function FeedbackTab({ eventId }: { eventId: string }) {
  const [feedback, setFeedback] = useState<OpenHouseFeedback[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [loaded, setLoaded] = useState(false)

  // Load once when this tab mounts (i.e. when the sheet is opened and tab is shown)
  useEffect(() => {
    startTransition(async () => {
      const res = await getOpenHouseFeedback(eventId)
      if (res.success) {
        setFeedback(res.feedback ?? [])
      } else {
        setLoadError(res.error ?? "Failed to load feedback")
      }
      setLoaded(true)
    })
   
  }, [eventId])

  if (isPending && !loaded) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive py-6 px-1">
        <AlertCircle className="h-4 w-4 shrink-0" />
        {loadError}
      </div>
    )
  }

  if (!feedback || feedback.length === 0) {
    return (
      <div className="text-center py-8 text-sm text-muted-foreground">
        <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-30" />
        No feedback submitted yet
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{feedback.length} response{feedback.length !== 1 ? "s" : ""}</p>
      {feedback.map((f) => (
        <div key={f.id} className="rounded-lg border p-3 space-y-2 bg-muted/20">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium truncate">{f.attendee_name ?? "Anonymous"}</span>
            <StarRating rating={f.rating} />
          </div>
          {f.liked_most && (
            <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <ThumbsUp className="h-3.5 w-3.5 mt-0.5 shrink-0 text-green-500" />
              <span>{f.liked_most}</span>
            </div>
          )}
          {f.concerns && (
            <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-yellow-500" />
              <span>{f.concerns}</span>
            </div>
          )}
          {f.price_opinion && (
            <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <DollarSign className="h-3.5 w-3.5 mt-0.5 shrink-0 text-blue-500" />
              <span>{f.price_opinion}</span>
            </div>
          )}
          {f.interested_in_offer != null && (
            <Badge
              className={`text-[10px] px-1.5 py-0 border ${
                f.interested_in_offer
                  ? "bg-green-100 text-green-700 border-green-200"
                  : "bg-slate-100 text-slate-600 border-slate-200"
              }`}
            >
              {f.interested_in_offer ? "Interested in offer" : "Not making offer"}
            </Badge>
          )}
        </div>
      ))}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIONS TAB
// ─────────────────────────────────────────────────────────────────────────────

function ActionsTab({
  event,
  onCancelled,
}: {
  event: OpenHouseEvent
  onCancelled: () => void
}) {
  const [invitePending, startInviteTransition] = useTransition()
  const [cancelPending, startCancelTransition] = useTransition()
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)

  const canCancel = event.status === "scheduled" || event.status === "active" || event.status === "invitations_sent"

  const handleSendInvites = () => {
    startInviteTransition(async () => {
      const res = await sendOpenHouseInvites(event.id)
      if (res.success) {
        sonnerToast.success(
          res.sent === 0
            ? "No eligible contacts found to invite"
            : `Invites sent to ${res.sent} contact${res.sent !== 1 ? "s" : ""}`
        )
      } else {
        sonnerToast.error(res.error ?? "Failed to send invites")
      }
    })
  }

  const handleCancel = () => {
    startCancelTransition(async () => {
      const res = await cancelOpenHouse(event.id)
      if (res.success) {
        sonnerToast.success("Event cancelled")
        setShowCancelConfirm(false)
        onCancelled()
      } else {
        sonnerToast.error(res.error ?? "Failed to cancel event")
        setShowCancelConfirm(false)
      }
    })
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Send className="h-4 w-4 text-primary" />
          <p className="text-sm font-medium">Send Invites</p>
        </div>
        <p className="text-xs text-muted-foreground">
          Sends email invitations to all eligible buyer contacts in your database.
        </p>
        <Button
          size="sm"
          className="gap-1.5"
          onClick={handleSendInvites}
          disabled={invitePending}
        >
          {invitePending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          Send Invites
        </Button>
      </div>

      {canCancel && (
        <div className="rounded-lg border border-destructive/20 p-4 space-y-2 bg-destructive/5">
          <div className="flex items-center gap-2">
            <XCircle className="h-4 w-4 text-destructive" />
            <p className="text-sm font-medium text-destructive">Cancel Event</p>
          </div>
          <p className="text-xs text-muted-foreground">
            This will mark the event as cancelled. This action cannot be undone.
          </p>
          <Button
            size="sm"
            variant="destructive"
            className="gap-1.5"
            onClick={() => setShowCancelConfirm(true)}
            disabled={cancelPending}
          >
            {cancelPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
            Cancel Event
          </Button>
        </div>
      )}

      <AlertDialog open={showCancelConfirm} onOpenChange={setShowCancelConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this open house?</AlertDialogTitle>
            <AlertDialogDescription>
              The event will be marked as cancelled and will appear in your past events.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelPending}>Keep Event</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCancel}
              disabled={cancelPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {cancelPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
              Yes, Cancel Event
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// EVENT DETAIL SHEET
// ─────────────────────────────────────────────────────────────────────────────

function EventDetailSheet({
  event,
  open,
  onOpenChange,
  onEventCancelled,
}: {
  event: OpenHouseEvent
  open: boolean
  onOpenChange: (v: boolean) => void
  onEventCancelled: () => void
}) {
  const listing = event.listing
  const address = listing
    ? [listing.address, listing.city, listing.state].filter(Boolean).join(", ")
    : "Unlisted property"

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader className="pb-2">
          <SheetTitle className="text-base leading-snug pr-6">{address}</SheetTitle>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge className={`text-[10px] px-1.5 py-0 border ${STATUS_STYLES[event.status] ?? "bg-muted"}`}>
              {event.status}
            </Badge>
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Calendar className="h-3 w-3" />{formatDate(event.event_date)}
            </span>
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />{formatTime(event.start_time)} – {formatTime(event.end_time)}
            </span>
          </div>
        </SheetHeader>

        <div className="px-4 pb-6">
          <Tabs defaultValue="attendees">
            <TabsList className="w-full mb-4">
              <TabsTrigger value="attendees" className="flex-1">
                <Users className="h-3.5 w-3.5 mr-1.5" />
                Attendees
              </TabsTrigger>
              <TabsTrigger value="feedback" className="flex-1">
                <Star className="h-3.5 w-3.5 mr-1.5" />
                Feedback
              </TabsTrigger>
              <TabsTrigger value="actions" className="flex-1">
                Actions
              </TabsTrigger>
            </TabsList>

            <TabsContent value="attendees">
              <AttendeesTab eventId={event.id} />
            </TabsContent>

            <TabsContent value="feedback">
              <FeedbackTab eventId={event.id} />
            </TabsContent>

            <TabsContent value="actions">
              <ActionsTab
                event={event}
                onCancelled={onEventCancelled}
              />
            </TabsContent>
          </Tabs>
        </div>
      </SheetContent>
    </Sheet>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN CLIENT
// ─────────────────────────────────────────────────────────────────────────────

export function OpenHousesClient({ initialEvents, fetchError }: Props) {
  const [events, setEvents] = useState<OpenHouseEvent[]>(initialEvents)
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()

  // Detail sheet state
  const [selectedEvent, setSelectedEvent] = useState<OpenHouseEvent | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)

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
    if (form.startTime && form.endTime) {
      const [sh, sm] = form.startTime.split(":").map(Number)
      const [eh, em] = form.endTime.split(":").map(Number)
      if (sh * 60 + sm >= eh * 60 + em) {
        toast({ title: "End time must be after start time", variant: "destructive" })
        return
      }
    }
    startTransition(async () => {
      try {
        const res = await createOpenHouse({
          listingId: form.listingId.trim(),
          date: form.date,
          startTime: form.startTime,
          endTime: form.endTime,
          maxAttendees: form.maxAttendees
            ? Math.max(1, Math.floor(Number(form.maxAttendees))) || undefined
            : undefined,
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
      } catch (err) {
        toast({ title: err instanceof Error ? err.message : "Failed to schedule open house", variant: "destructive" })
      }
    })
  }

  const openDetail = (event: OpenHouseEvent) => {
    setSelectedEvent(event)
    setSheetOpen(true)
  }

  const handleEventCancelled = () => {
    if (!selectedEvent) return
    setEvents((prev) =>
      prev.map((e) => (e.id === selectedEvent.id ? { ...e, status: "cancelled" } : e))
    )
    setSheetOpen(false)
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
                  <EventRow key={event.id} event={event} onClick={() => openDetail(event)} />
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
                  <EventRow key={event.id} event={event} onClick={() => openDetail(event)} />
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Detail Sheet */}
      {selectedEvent && (
        <EventDetailSheet
          event={selectedEvent}
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          onEventCancelled={handleEventCancelled}
        />
      )}
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
