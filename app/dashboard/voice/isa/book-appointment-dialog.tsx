"use client"

import { useState } from "react"
import { scheduleAppointment } from "@/app/actions/ai-isa/schedule-appointment"
import {
  APPOINTMENT_TYPES,
  buildAppointmentTimes,
  resolveTimezoneName,
} from "@/lib/ai-isa/appointment-form"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { CalendarPlus, CheckCircle2 } from "lucide-react"

interface BookAppointmentDialogProps {
  contactId: string
  contactName: string
  /** Called after a successful booking (e.g. to remove the item from a queue). */
  onBooked?: (calendarEventId: string) => void
}

export function BookAppointmentDialog({
  contactId,
  contactName,
  onBooked,
}: BookAppointmentDialogProps) {
  const [open, setOpen] = useState(false)
  const [when, setWhen] = useState("")
  const [type, setType] = useState<string>(APPOINTMENT_TYPES[0].value)
  const [location, setLocation] = useState("")
  const [notes, setNotes] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const reset = () => {
    setWhen("")
    setType(APPOINTMENT_TYPES[0].value)
    setLocation("")
    setNotes("")
    setError(null)
    setDone(false)
    setSubmitting(false)
  }

  const handleSubmit = async () => {
    setError(null)

    const built = buildAppointmentTimes(when, type)
    if (!built.ok) {
      setError(built.error)
      return
    }

    setSubmitting(true)
    try {
      const result = await scheduleAppointment({
        contactId,
        startAt: built.times.startAt,
        endAt: built.times.endAt,
        timezoneName: resolveTimezoneName(),
        location: location.trim() || undefined,
        notes: notes.trim() || undefined,
      })

      if (!result.success) {
        setError(result.error)
        setSubmitting(false)
        return
      }

      setDone(true)
      setSubmitting(false)
      onBooked?.(result.calendarEventId)

      // Brief success state, then close
      setTimeout(() => {
        setOpen(false)
        reset()
      }, 900)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to book appointment")
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="shrink-0">
          <CalendarPlus className="h-3 w-3 mr-1" />
          <span className="text-xs">Book Appointment</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Schedule Appointment</DialogTitle>
          <DialogDescription>
            Book an appointment with {contactName || "this contact"}. This advances
            their lifecycle and logs an ISA activity.
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <CheckCircle2 className="h-10 w-10 text-green-500 mb-2" />
            <p className="text-sm font-medium">Appointment booked</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="appt-when">Date &amp; time</Label>
              <Input
                id="appt-when"
                type="datetime-local"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="appt-type">Type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger id="appt-type">
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  {APPOINTMENT_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label} ({t.defaultMinutes}m)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="appt-location">Location (optional)</Label>
              <Input
                id="appt-location"
                placeholder="Office, address, or video link"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="appt-notes">Notes (optional)</Label>
              <Textarea
                id="appt-notes"
                rows={3}
                placeholder="Anything the agent should know"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>

            {error && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5">
                {error}
              </p>
            )}
          </div>
        )}

        {!done && (
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={handleSubmit} disabled={submitting}>
              {submitting ? "Booking..." : "Book Appointment"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
