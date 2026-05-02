"use client"

import { useState, useTransition } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
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
import { Calendar, Loader2, ClipboardCheck } from "lucide-react"
import { toast } from "sonner"
import { createAppointment } from "@/app/actions/ai-calendar-management"

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

function defaultStart(): string {
  const d = new Date()
  d.setDate(d.getDate() + 2)
  d.setHours(10, 0, 0, 0)
  return d.toISOString().slice(0, 16)
}

export function ListingConsultationScheduler({ contactId, contactName, agentId, brokerageId }: Props) {
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<ApptType>("listing_consultation")
  const [startTime, setStartTime] = useState<string>(defaultStart())
  const [duration, setDuration] = useState<number>(60)
  const [location, setLocation] = useState<string>("")
  const [notes, setNotes] = useState<string>("")
  const [isPending, startTransition] = useTransition()

  function reset() {
    setType("listing_consultation")
    setStartTime(defaultStart())
    setDuration(60)
    setLocation("")
    setNotes("")
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
              <Select value={type} onValueChange={(v) => setType(v as ApptType)}>
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
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Date &amp; time</Label>
                <Input
                  type="datetime-local"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                />
              </div>
              <div>
                <Label className="text-xs">Duration (min)</Label>
                <Input
                  type="number"
                  min={15}
                  step={15}
                  value={duration}
                  onChange={(e) => setDuration(Math.max(15, Number(e.target.value) || 60))}
                />
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
