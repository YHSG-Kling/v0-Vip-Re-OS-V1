"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Calendar, Loader2, ClipboardCheck, Sparkles, Check } from "lucide-react"
import { toast } from "sonner"
import { createAppointment, suggestAppointmentSlots } from "@/app/actions/ai-calendar-management"

interface Props {
  contactId: string
  contactName: string
  agentId: string
  brokerageId: string
}

const APPT_TYPES = [
  { value: "listing_consultation", label: "Initial Consultation" },
  { value: "listing_price_strategy", label: "Price Strategy Meeting" },
  { value: "listing_walkthrough", label: "Walkthrough" },
  { value: "listing_followup", label: "Follow-up" },
] as const

type ApptType = typeof APPT_TYPES[number]["value"]

interface SuggestedSlot {
  date: string
  startTime: string
  endTime: string
  score: number
  reasoning: string
}

function defaultStart(): string {
  const d = new Date()
  d.setDate(d.getDate() + 2)
  d.setHours(10, 0, 0, 0)
  return d.toISOString().slice(0, 16)
}

function toDatetimeLocal(date: string, time: string): string {
  try {
    return `${date}T${time}`
  } catch {
    return defaultStart()
  }
}

export function ListingConsultationScheduler({ contactId, contactName, agentId, brokerageId }: Props) {
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<ApptType>("listing_consultation")
  const [startTime, setStartTime] = useState<string>(defaultStart())
  const [duration, setDuration] = useState<number>(60)
  const [location, setLocation] = useState<string>("")
  const [notes, setNotes] = useState<string>("")
  const [isPending, startTransition] = useTransition()

  // Slot suggestion state
  const [loadingSlots, setLoadingSlots] = useState(false)
  const [suggestedSlots, setSuggestedSlots] = useState<SuggestedSlot[]>([])
  const [selectedSlotIdx, setSelectedSlotIdx] = useState<number | null>(null)

  function reset() {
    setType("listing_consultation")
    setStartTime(defaultStart())
    setDuration(60)
    setLocation("")
    setNotes("")
    setSuggestedSlots([])
    setSelectedSlotIdx(null)
  }

  async function handleSuggestSlots() {
    setLoadingSlots(true)
    setSuggestedSlots([])
    setSelectedSlotIdx(null)
    try {
      const apptType = type === "listing_followup" ? "follow_up" : "listing_presentation"
      const result = await suggestAppointmentSlots({
        agentId,
        contactId,
        appointmentType: apptType as "listing_presentation" | "follow_up",
        duration,
        urgency: "medium",
      })
      const slots: SuggestedSlot[] = (result as any)?.topSlots ?? []
      setSuggestedSlots(slots.slice(0, 3))
      if (slots.length === 0) {
        toast.info("No specific slots suggested — pick a date and time manually below.")
      }
    } catch {
      toast.error("Could not load suggested times. Pick manually below.")
    } finally {
      setLoadingSlots(false)
    }
  }

  function handleSelectSlot(idx: number) {
    setSelectedSlotIdx(idx)
    const slot = suggestedSlots[idx]
    if (slot) {
      setStartTime(toDatetimeLocal(slot.date, slot.startTime))
    }
  }

  function schedule() {
    if (!startTime) {
      toast.error("Pick a date and time.")
      return
    }
    startTransition(async () => {
      const start = new Date(startTime)
      const end = new Date(start.getTime() + duration * 60 * 1000)
      const titleByType: Record<ApptType, string> = {
        listing_consultation: "Listing Consultation",
        listing_price_strategy: "Price Strategy Meeting",
        listing_walkthrough: "Listing Walkthrough",
        listing_followup: "Listing Follow-up",
      }
      const result = await createAppointment({
        agentId,
        contactId,
        brokerageId,
        title: `${titleByType[type]} — ${contactName}`,
        startTime: start.toISOString(),
        endTime: end.toISOString(),
        location: location || undefined,
        notes: notes || undefined,
        type,
      })
      if ((result as any).success) {
        toast.success("Appointment scheduled. The pre-listing prep workflow will trigger automatically.")
        setOpen(false)
        reset()
      } else {
        toast.error((result as any).error ?? "Couldn't schedule.")
      }
    })
  }

  const fmt = (date: string, time: string) => {
    try {
      const dt = new Date(`${date}T${time}`)
      return dt.toLocaleString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    } catch {
      return `${date} ${time}`
    }
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} className="gap-1.5">
        <ClipboardCheck className="h-3.5 w-3.5" />
        Listing Consultation
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-primary" />
              Schedule Listing Consultation
            </DialogTitle>
            <DialogDescription>
              For {contactName}. No listing record exists yet — this lives on the contact and triggers
              the listing-appointment-prep workflow (CMA, presentation, drip).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Appointment type</Label>
              <Select value={type} onValueChange={(v) => { setType(v as ApptType); setSuggestedSlots([]); setSelectedSlotIdx(null) }}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {APPT_TYPES.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* AI suggested slots */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label className="text-xs">Date &amp; time</Label>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs gap-1 text-primary"
                  onClick={handleSuggestSlots}
                  disabled={loadingSlots}
                >
                  {loadingSlots ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Sparkles className="h-3 w-3" />
                  )}
                  Suggest times
                </Button>
              </div>

              {suggestedSlots.length > 0 && (
                <div className="space-y-1.5 mb-3">
                  {suggestedSlots.map((slot, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => handleSelectSlot(i)}
                      className={`w-full text-left rounded-md border p-2.5 text-sm transition-colors ${
                        selectedSlotIdx === i
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-muted-foreground"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{fmt(slot.date, slot.startTime)}</span>
                        <div className="flex items-center gap-1.5">
                          <Badge variant="secondary" className="text-xs">
                            {Math.round(slot.score * 100)}% fit
                          </Badge>
                          {selectedSlotIdx === i && (
                            <Check className="h-4 w-4 text-primary" />
                          )}
                        </div>
                      </div>
                      {slot.reasoning && (
                        <p className="text-xs text-muted-foreground mt-0.5 truncate">{slot.reasoning}</p>
                      )}
                    </button>
                  ))}
                  <p className="text-xs text-muted-foreground">Or pick manually below</p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Input
                    type="datetime-local"
                    value={startTime}
                    onChange={(e) => { setStartTime(e.target.value); setSelectedSlotIdx(null) }}
                  />
                </div>
                <div>
                  <Input
                    type="number"
                    min={15}
                    step={15}
                    value={duration}
                    onChange={(e) => setDuration(Math.max(15, Number(e.target.value) || 60))}
                    placeholder="Duration (min)"
                  />
                </div>
              </div>
            </div>

            <div>
              <Label className="text-xs">Location (optional)</Label>
              <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Property address or video link" />
            </div>
            <div>
              <Label className="text-xs">Agent notes (optional)</Label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="What to bring, key talking points…" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button onClick={schedule} disabled={isPending}>
              {isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Scheduling…
                </>
              ) : (
                <>
                  <Calendar className="h-4 w-4 mr-2" />
                  Schedule
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
