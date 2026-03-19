"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { X, Home, Eye, Users, Calendar, CheckSquare, Phone } from "lucide-react"
import { createAppointment } from "@/app/actions/ai-calendar-management"

interface CalendarQuickCreatePanelProps {
  agentId: string
  brokerageId: string
  onClose: () => void
  onCreated: () => void
}

type EventCategory = "showing" | "tour" | "appointment" | "follow_up" | "open_house" | "task"

const CATEGORIES: { value: EventCategory; label: string; icon: typeof Home }[] = [
  { value: "showing", label: "Showing", icon: Home },
  { value: "tour", label: "Buyer Tour", icon: Eye },
  { value: "appointment", label: "Appointment", icon: Calendar },
  { value: "follow_up", label: "Follow-up", icon: Phone },
  { value: "open_house", label: "Open House", icon: Users },
  { value: "task", label: "Task/Deadline", icon: CheckSquare },
]

export function CalendarQuickCreatePanel({ agentId, brokerageId, onClose, onCreated }: CalendarQuickCreatePanelProps) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [category, setCategory] = useState<EventCategory>("appointment")
  const [form, setForm] = useState({
    title: "",
    startDate: "",
    startTime: "10:00",
    endTime: "11:00",
    location: "",
    notes: "",
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!form.title || !form.startDate) {
      setError("Title and date are required")
      return
    }

    const startDateTime = `${form.startDate}T${form.startTime}:00`
    const endDateTime = `${form.startDate}T${form.endTime}:00`

    startTransition(async () => {
      const res = await createAppointment({
        agentId,
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
        setError(res.error || "Failed to create event")
      }
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <Card className="w-full max-w-lg shadow-xl">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Quick Create Event</CardTitle>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Event Type */}
            <div className="grid grid-cols-3 gap-2">
              {CATEGORIES.map((cat) => {
                const Icon = cat.icon
                const isActive = category === cat.value
                return (
                  <button
                    key={cat.value}
                    type="button"
                    onClick={() => setCategory(cat.value)}
                    className={`flex flex-col items-center gap-1 p-2 rounded-lg border transition-colors ${
                      isActive
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border hover:bg-accent"
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    <span className="text-xs font-medium">{cat.label}</span>
                  </button>
                )
              })}
            </div>

            {/* Title */}
            <div className="space-y-1.5">
              <Label htmlFor="title" className="text-sm">Title</Label>
              <Input
                id="title"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder={`Enter ${category} title`}
                required
              />
            </div>

            {/* Date & Time */}
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

            {/* Actions */}
            <div className="flex gap-2 justify-end pt-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? "Creating..." : "Create Event"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
