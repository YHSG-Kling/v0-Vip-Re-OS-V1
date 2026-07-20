"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { Clock, MapPin, User, Home, Video } from "lucide-react"
import { useRouter } from "next/navigation"
import type { UnifiedCalendarEvent } from "./calendar-shell"

interface CalendarAgendaViewProps {
  events: UnifiedCalendarEvent[]
  weekStart: Date
  onSelectEvent: (event: UnifiedCalendarEvent) => void
}

const EVENT_TYPE_LABELS: Record<UnifiedCalendarEvent["eventType"], { label: string; color: string }> = {
  showing: { label: "Showing", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300" },
  tour: { label: "Tour", color: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300" },
  open_house: { label: "Open House", color: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300" },
  inspection: { label: "Inspection", color: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300" },
  appraisal: { label: "Appraisal", color: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300" },
  closing: { label: "Closing", color: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300" },
  appointment: { label: "Appointment", color: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300" },
  task: { label: "Task", color: "bg-slate-100 text-slate-700 dark:bg-slate-900/30 dark:text-slate-300" },
  follow_up: { label: "Follow-up", color: "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300" },
  isa_appointment: { label: "ISA Appt", color: "bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300" },
  time_block: { label: "Blocked Time", color: "bg-zinc-100 text-zinc-700 dark:bg-zinc-900/30 dark:text-zinc-300" },
}

function isSameDay(d1: Date, d2: Date) {
  return d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
}

export function CalendarAgendaView({ events, weekStart, onSelectEvent }: CalendarAgendaViewProps) {
  const router = useRouter()
  const today = new Date()
  
  // Group events by day
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(weekStart.getTime() + i * 24 * 60 * 60 * 1000)
    const dayEvents = events.filter((e) => isSameDay(new Date(e.startAt), date))
    return { date, events: dayEvents }
  })

  return (
    <div className="space-y-4">
      {days.map(({ date, events: dayEvents }) => {
        const isToday = isSameDay(date, today)
        const isPast = date < today && !isToday
        
        return (
          <Card key={date.toISOString()} className={cn(isPast && "opacity-60")}>
            <CardHeader className={cn("py-3", isToday && "bg-primary/5")}>
              <CardTitle className="text-sm flex items-center gap-2">
                <span className={cn(
                  "w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold",
                  isToday ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                )}>
                  {date.getDate()}
                </span>
                <span className={isToday ? "text-primary" : "text-foreground"}>
                  {date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}
                </span>
                {isToday && <Badge variant="outline" className="text-xs">Today</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent className="py-2">
              {dayEvents.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No events scheduled</p>
              ) : (
                <div className="space-y-2">
                  {dayEvents.map((event) => {
                    const typeInfo = EVENT_TYPE_LABELS[event.eventType] || EVENT_TYPE_LABELS.appointment
                    const startTime = new Date(event.startAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
                    const endTime = new Date(event.endAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
                    
                    return (
                      <button
                        key={event.id}
                        onClick={() => onSelectEvent(event)}
                        className="w-full text-left p-3 rounded-lg border border-border hover:bg-accent/50 transition-colors"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <Badge className={cn("text-xs", typeInfo.color)}>
                                {typeInfo.label}
                              </Badge>
                              {event.priority === "high" && (
                                <Badge variant="destructive" className="text-xs">High Priority</Badge>
                              )}
                            </div>
                            <h4 className="font-medium text-sm text-foreground truncate">{event.title}</h4>
                            <div className="flex flex-wrap items-center gap-3 mt-1 text-xs text-muted-foreground">
                              <span className="flex items-center gap-1">
                                <Clock className="h-3 w-3" />
                                {startTime} - {endTime}
                              </span>
                              {event.location && (
                                <span className="flex items-center gap-1">
                                  <MapPin className="h-3 w-3" />
                                  {event.location}
                                </span>
                              )}
                              {event.contactName && (
                                <span className="flex items-center gap-1">
                                  <User className="h-3 w-3" />
                                  {event.contactName}
                                </span>
                              )}
                              {event.listingAddress && (
                                <span className="flex items-center gap-1">
                                  <Home className="h-3 w-3" />
                                  {event.listingAddress}
                                </span>
                              )}
                              {/* Zoom appointment (round 39) → the in-OS meeting room.
                                  A span (not <a>) — the whole row is already a <button>. */}
                              {event.source === "calendar_events" && !!(event.metadata as any)?.zoom?.join_url && (
                                <span
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    router.push(`/dashboard/meetings/${event.id}`)
                                  }}
                                  className="flex items-center gap-1 text-sky-600 hover:underline cursor-pointer"
                                >
                                  <Video className="h-3 w-3" />
                                  Zoom meeting room
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
