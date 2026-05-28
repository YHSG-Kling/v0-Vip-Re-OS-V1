"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { X, Home, Eye, Users, Calendar, CheckSquare, Phone, Lock, Sparkles, Clock, Brain } from "lucide-react"
import {
  createAppointment,
  suggestAppointmentSlots,
  suggestMeetingTimes,
  blockCalendarTime,
} from "@/app/actions/ai-calendar-management"

interface CalendarQuickCreatePanelProps {
  agentId: string
  brokerageId: string
  onClose: () => void
  onCreated: () => void
}

type EventCategory = "showing" | "tour" | "appointment" | "follow_up" | "open_house" | "task" | "block_time"

const CATEGORIES: { value: EventCategory; label: string; icon: typeof Home }[] = [
  { value: "showing", label: "Showing", icon: Home },
  { value: "tour", label: "Buyer Tour", icon: Eye },
  { value: "appointment", label: "Appointment", icon: Calendar },
  { value: "follow_up", label: "Follow-up", icon: Phone },
  { value: "open_house", label: "Open House", icon: Users },
  { value: "task", label: "Task/Deadline", icon: CheckSquare },
  { value: "block_time", label: "Block Time", icon: Lock },
]

// Appointment types that surface the AI slot suggester
const AI_SLOT_TYPES: EventCategory[] = ["showing", "appointment", "follow_up"]
// Types that surface suggestMeetingTimes
const MEETING_TYPES: EventCategory[] = ["appointment", "tour"]
// Block type map
const BLOCK_TYPES = [
  { value: "personal", label: "Personal" },
  { value: "admin", label: "Admin" },
  { value: "prospecting", label: "Prospecting" },
  { value: "buffer", label: "Buffer" },
] as const

type BlockType = typeof BLOCK_TYPES[number]["value"]

interface SuggestedSlot {
  date: string
  startTime: string
  endTime: string
  score: number
  reasoning: string
}

interface MeetingSlot {
  startTime: string
  endTime: string
  score: number
  reasoning: string
}

export function CalendarQuickCreatePanel({ agentId, brokerageId, onClose, onCreated }: CalendarQuickCreatePanelProps) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [category, setCategory] = useState<EventCategory>("appointment")

  // Standard form state
  const [form, setForm] = useState({
    title: "",
    startDate: "",
    startTime: "10:00",
    endTime: "11:00",
    location: "",
    notes: "",
  })

  // --- Section A: AI Slot Suggestion state ---
  const [aiMode, setAiMode] = useState<"manual" | "ai">("manual")
  const [aiDate, setAiDate] = useState("")
  const [aiDuration, setAiDuration] = useState("60")
  const [aiAppointmentType, setAiAppointmentType] = useState<
    "showing" | "buyer_consultation" | "listing_presentation" | "follow_up" | "general"
  >("general")
  const [slotSuggestions, setSlotSuggestions] = useState<SuggestedSlot[]>([])
  const [slotLoading, setSlotLoading] = useState(false)
  const [slotError, setSlotError] = useState<string | null>(null)
  const [selectedSlot, setSelectedSlot] = useState<SuggestedSlot | null>(null)

  // --- Section C: Suggest Meeting Times state ---
  const [meetingOpen, setMeetingOpen] = useState(false)
  const [meetingDuration, setMeetingDuration] = useState("60")
  const [meetingPreference, setMeetingPreference] = useState<"morning" | "afternoon" | "evening">("morning")
  const [meetingSlots, setMeetingSlots] = useState<MeetingSlot[]>([])
  const [meetingLoading, setMeetingLoading] = useState(false)
  const [meetingError, setMeetingError] = useState<string | null>(null)
  const [selectedMeetingSlot, setSelectedMeetingSlot] = useState<MeetingSlot | null>(null)

  // --- Section D: Block Time state ---
  const [blockStart, setBlockStart] = useState("")
  const [blockEnd, setBlockEnd] = useState("")
  const [blockType, setBlockType] = useState<BlockType>("admin")
  const [blockLoading, setBlockLoading] = useState(false)
  const [blockError, setBlockError] = useState<string | null>(null)

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function handleSuggestSlots() {
    if (!aiDate) { setSlotError("Select a date first"); return }
    setSlotLoading(true)
    setSlotError(null)
    setSlotSuggestions([])
    setSelectedSlot(null)
    const res = await suggestAppointmentSlots({
      agentId,
      contactId: "",
      appointmentType: aiAppointmentType,
      duration: Number(aiDuration),
    })
    if (res.success && (res as any).suggestions?.topSlots?.length > 0) {
      setSlotSuggestions((res as any).suggestions.topSlots as SuggestedSlot[])
    } else {
      setSlotError((res as any).error ?? "No slots available — try a different date")
    }
    setSlotLoading(false)
  }

  async function handleSuggestMeeting() {
    setMeetingLoading(true)
    setMeetingError(null)
    setMeetingSlots([])
    setSelectedMeetingSlot(null)
    const windowMap = { morning: "08:00-12:00", afternoon: "12:00-17:00", evening: "17:00-20:00" }
    const res = await suggestMeetingTimes({
      agentId,
      duration: Number(meetingDuration),
      preferences: { startTime: windowMap[meetingPreference].split("-")[0], endTime: windowMap[meetingPreference].split("-")[1], daysAhead: 7 },
    })
    if (res.success && (res as any).suggestions?.length > 0) {
      setMeetingSlots((res as any).suggestions as MeetingSlot[])
    } else {
      setMeetingError((res as any).error ?? "No times found — try different preferences")
    }
    setMeetingLoading(false)
  }

  async function handleBlockTime() {
    if (!blockStart || !blockEnd) { setBlockError("Start and end times are required"); return }
    setBlockLoading(true)
    setBlockError(null)
    const res = await blockCalendarTime({
      agentId,
      startTime: blockStart,
      endTime: blockEnd,
      title: BLOCK_TYPES.find((b) => b.value === blockType)?.label ?? "Blocked",
      type: blockType,
    })
    if (res.success) {
      onCreated()
    } else {
      setBlockError((res as any).error ?? "Failed to block time")
      setBlockLoading(false)
    }
  }

  // Standard event submit
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    // Derive start/end from selected AI slot if present
    let startDateTime = `${form.startDate}T${form.startTime}:00`
    let endDateTime = `${form.startDate}T${form.endTime}:00`

    if (aiMode === "ai" && selectedSlot) {
      startDateTime = `${selectedSlot.date}T${selectedSlot.startTime}:00`
      endDateTime = `${selectedSlot.date}T${selectedSlot.endTime}:00`
    } else if (meetingOpen && selectedMeetingSlot) {
      startDateTime = selectedMeetingSlot.startTime
      endDateTime = selectedMeetingSlot.endTime
    }

    if (!form.title) { setError("Title is required"); return }
    if (!startDateTime.includes("T") || startDateTime.endsWith("Tundefined:00")) {
      setError("Valid date and time required")
      return
    }

    startTransition(async () => {
      const res = await createAppointment({
        agentId,
        brokerageId,
        title: form.title,
        startTime: startDateTime,
        endTime: endDateTime,
        location: form.location || undefined,
        notes: form.notes || undefined,
        type: category,
      })
      if (res.success) {
        onCreated()
      } else {
        setError((res as any).error || "Failed to create event")
      }
    })
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const showAiSlots = AI_SLOT_TYPES.includes(category)
  const showMeetingFinder = MEETING_TYPES.includes(category)
  const isBlockTime = category === "block_time"

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 overflow-y-auto py-6">
      <Card className="w-full max-w-lg shadow-xl">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Quick Create Event</CardTitle>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-5">
          {/* Event Type Grid */}
          <div className="grid grid-cols-4 gap-1.5">
            {CATEGORIES.map((cat) => {
              const Icon = cat.icon
              const isActive = category === cat.value
              return (
                <button
                  key={cat.value}
                  type="button"
                  onClick={() => {
                    setCategory(cat.value)
                    setAiMode("manual")
                    setSlotSuggestions([])
                    setSelectedSlot(null)
                    setMeetingOpen(false)
                    setMeetingSlots([])
                    setSelectedMeetingSlot(null)
                  }}
                  className={`flex flex-col items-center gap-1 p-2 rounded-lg border text-xs font-medium transition-colors ${
                    isActive
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border hover:bg-accent text-muted-foreground"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {cat.label}
                </button>
              )
            })}
          </div>

          {/* ─── SECTION D: Block Time form ─────────────────────────────── */}
          {isBlockTime ? (
            <div className="space-y-4">
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Blocked time appears on your calendar and prevents double-booking.
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-sm">Start</Label>
                  <Input
                    type="datetime-local"
                    value={blockStart}
                    onChange={(e) => setBlockStart(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm">End</Label>
                  <Input
                    type="datetime-local"
                    value={blockEnd}
                    onChange={(e) => setBlockEnd(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm">Block reason</Label>
                <Select value={blockType} onValueChange={(v) => setBlockType(v as BlockType)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BLOCK_TYPES.map((b) => (
                      <SelectItem key={b.value} value={b.value}>{b.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {blockError && <p className="text-sm text-destructive">{blockError}</p>}
              <div className="flex gap-2 justify-end pt-1">
                <Button variant="outline" onClick={onClose}>Cancel</Button>
                <Button onClick={handleBlockTime} disabled={blockLoading}>
                  {blockLoading ? "Blocking..." : "Block This Time"}
                </Button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">

              {/* ─── SECTION A: AI Slot Toggle (for slot-capable types) ──── */}
              {showAiSlots && (
                <div className="space-y-3">
                  <div className="flex items-center gap-1 p-1 bg-muted rounded-lg w-fit">
                    <button
                      type="button"
                      onClick={() => { setAiMode("manual"); setSlotSuggestions([]); setSelectedSlot(null) }}
                      className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                        aiMode === "manual" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground"
                      }`}
                    >
                      Manual
                    </button>
                    <button
                      type="button"
                      onClick={() => setAiMode("ai")}
                      className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                        aiMode === "ai" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground"
                      }`}
                    >
                      <Sparkles className="h-3 w-3" />
                      AI Suggest Time
                    </button>
                  </div>

                  {aiMode === "ai" && (
                    <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 space-y-3">
                      <div className="grid grid-cols-3 gap-2">
                        <div className="space-y-1">
                          <Label className="text-xs">Date</Label>
                          <Input
                            type="date"
                            value={aiDate}
                            onChange={(e) => setAiDate(e.target.value)}
                            className="h-8 text-xs"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Duration</Label>
                          <Select value={aiDuration} onValueChange={setAiDuration}>
                            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="30">30 min</SelectItem>
                              <SelectItem value="60">1 hour</SelectItem>
                              <SelectItem value="120">2 hours</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Type</Label>
                          <Select value={aiAppointmentType} onValueChange={(v) => setAiAppointmentType(v as typeof aiAppointmentType)}>
                            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="showing">Showing</SelectItem>
                              <SelectItem value="buyer_consultation">Consultation</SelectItem>
                              <SelectItem value="listing_presentation">Listing Pres.</SelectItem>
                              <SelectItem value="follow_up">Follow-up</SelectItem>
                              <SelectItem value="general">General</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="w-full border-blue-300 text-blue-800 hover:bg-blue-100 gap-1.5"
                        onClick={handleSuggestSlots}
                        disabled={slotLoading}
                      >
                        {slotLoading ? (
                          <><Clock className="h-3.5 w-3.5 animate-pulse" />Finding best times...</>
                        ) : (
                          <><Brain className="h-3.5 w-3.5" />Suggest Time Slots</>
                        )}
                      </Button>
                      {slotError && <p className="text-xs text-destructive">{slotError}</p>}

                      {slotSuggestions.length > 0 && (
                        <div className="space-y-1.5">
                          <p className="text-xs font-medium text-blue-900">Available slots</p>
                          {slotSuggestions.map((slot, i) => {
                            const isSelected = selectedSlot === slot
                            return (
                              <button
                                key={i}
                                type="button"
                                onClick={() => setSelectedSlot(slot)}
                                className={`w-full flex items-center justify-between px-3 py-2 rounded-md border text-xs transition-colors ${
                                  isSelected
                                    ? "border-blue-500 bg-blue-100 text-blue-900"
                                    : "border-blue-200 bg-white text-blue-800 hover:bg-blue-50"
                                }`}
                              >
                                <span className="font-medium">
                                  {new Date(`${slot.date}T${slot.startTime}`).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                                  {" "}&ndash;{" "}
                                  {new Date(`${slot.date}T${slot.endTime}`).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                                  {i === 0 && <Badge className="ml-2 bg-blue-600 text-white text-[10px] py-0">Best</Badge>}
                                </span>
                                <span className="text-blue-600 truncate max-w-[160px]">{slot.reasoning}</span>
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Title */}
              <div className="space-y-1.5">
                <Label htmlFor="title" className="text-sm">Title</Label>
                <Input
                  id="title"
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  placeholder={`Enter ${category.replace("_", " ")} title`}
                  required
                />
              </div>

              {/* Date & Time — shown in manual mode or as override when AI slot selected */}
              {(aiMode === "manual" || !showAiSlots) && (
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="date" className="text-sm">Date</Label>
                    <Input
                      id="date"
                      type="date"
                      value={form.startDate}
                      onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="startTime" className="text-sm">Start</Label>
                    <Input
                      id="startTime"
                      type="time"
                      value={form.startTime}
                      onChange={(e) => setForm((f) => ({ ...f, startTime: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="endTime" className="text-sm">End</Label>
                    <Input
                      id="endTime"
                      type="time"
                      value={form.endTime}
                      onChange={(e) => setForm((f) => ({ ...f, endTime: e.target.value }))}
                    />
                  </div>
                </div>
              )}

              {/* Selected AI slot summary */}
              {aiMode === "ai" && selectedSlot && (
                <div className="rounded-md bg-blue-100 border border-blue-300 px-3 py-2 text-xs text-blue-900 flex items-center justify-between">
                  <span>
                    <span className="font-semibold">Selected: </span>
                    {new Date(`${selectedSlot.date}T${selectedSlot.startTime}`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                    {" "}at{" "}
                    {new Date(`${selectedSlot.date}T${selectedSlot.startTime}`).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                  </span>
                  <button type="button" onClick={() => setSelectedSlot(null)} className="text-blue-600 hover:text-blue-900">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}

              {/* ─── SECTION C: Find a Time That Works (meeting/consultation) ── */}
              {showMeetingFinder && (
                <div>
                  <button
                    type="button"
                    onClick={() => { setMeetingOpen((o) => !o); setMeetingSlots([]); setSelectedMeetingSlot(null) }}
                    className="flex items-center gap-1.5 text-xs text-indigo-700 font-medium hover:text-indigo-900 transition-colors"
                  >
                    <Users className="h-3.5 w-3.5" />
                    {meetingOpen ? "Hide meeting time finder" : "Find a time that works"}
                  </button>

                  {meetingOpen && (
                    <div className="mt-2 rounded-lg border border-indigo-200 bg-indigo-50 p-3 space-y-3">
                      <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <Label className="text-xs">Duration</Label>
                          <Select value={meetingDuration} onValueChange={setMeetingDuration}>
                            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="30">30 min</SelectItem>
                              <SelectItem value="60">60 min</SelectItem>
                              <SelectItem value="90">90 min</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Preferred window</Label>
                          <Select value={meetingPreference} onValueChange={(v) => setMeetingPreference(v as typeof meetingPreference)}>
                            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="morning">Morning</SelectItem>
                              <SelectItem value="afternoon">Afternoon</SelectItem>
                              <SelectItem value="evening">Evening</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="w-full border-indigo-300 text-indigo-800 hover:bg-indigo-100 gap-1.5"
                        onClick={handleSuggestMeeting}
                        disabled={meetingLoading}
                      >
                        {meetingLoading ? "Finding times..." : "Find Available Times"}
                      </Button>
                      {meetingError && <p className="text-xs text-destructive">{meetingError}</p>}

                      {meetingSlots.length > 0 && (
                        <div className="space-y-1.5">
                          <p className="text-xs font-medium text-indigo-900">Available times</p>
                          {meetingSlots.map((slot, i) => {
                            const isSelected = selectedMeetingSlot === slot
                            return (
                              <button
                                key={i}
                                type="button"
                                onClick={() => setSelectedMeetingSlot(slot)}
                                className={`w-full flex items-center justify-between px-3 py-2 rounded-md border text-xs transition-colors ${
                                  isSelected
                                    ? "border-indigo-500 bg-indigo-100 text-indigo-900"
                                    : "border-indigo-200 bg-white text-indigo-800 hover:bg-indigo-50"
                                }`}
                              >
                                <span className="font-medium">
                                  {new Date(slot.startTime).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                                  {" "}
                                  {new Date(slot.startTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                                </span>
                                <span className="text-indigo-600 truncate max-w-[160px]">{slot.reasoning}</span>
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Location */}
              <div className="space-y-1.5">
                <Label htmlFor="location" className="text-sm">Location (optional)</Label>
                <Input
                  id="location"
                  value={form.location}
                  onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
                  placeholder="Address or meeting link"
                />
              </div>

              {/* Notes */}
              <div className="space-y-1.5">
                <Label htmlFor="notes" className="text-sm">Notes (optional)</Label>
                <Textarea
                  id="notes"
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  rows={2}
                  placeholder="Additional details"
                />
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <div className="flex gap-2 justify-end pt-2">
                <Button type="button" variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button type="submit" disabled={isPending}>
                  {isPending ? "Creating..." : "Create Event"}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
