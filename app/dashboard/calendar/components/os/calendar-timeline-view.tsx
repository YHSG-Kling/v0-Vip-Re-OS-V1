"use client"

import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import type { UnifiedCalendarEvent } from "./calendar-shell"

interface CalendarTimelineViewProps {
  events: UnifiedCalendarEvent[]
  weekStart: Date
  onSelectEvent: (event: UnifiedCalendarEvent) => void
}

const HOURS = Array.from({ length: 12 }, (_, i) => i + 7) // 7am to 6pm
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

const EVENT_COLORS: Record<UnifiedCalendarEvent["eventType"], string> = {
  showing: "bg-blue-500/20 border-blue-500 text-blue-700 dark:text-blue-300",
  tour: "bg-green-500/20 border-green-500 text-green-700 dark:text-green-300",
  open_house: "bg-purple-500/20 border-purple-500 text-purple-700 dark:text-purple-300",
  inspection: "bg-orange-500/20 border-orange-500 text-orange-700 dark:text-orange-300",
  appraisal: "bg-amber-500/20 border-amber-500 text-amber-700 dark:text-amber-300",
  closing: "bg-red-500/20 border-red-500 text-red-700 dark:text-red-300",
  appointment: "bg-cyan-500/20 border-cyan-500 text-cyan-700 dark:text-cyan-300",
  task: "bg-slate-500/20 border-slate-500 text-slate-700 dark:text-slate-300",
  follow_up: "bg-teal-500/20 border-teal-500 text-teal-700 dark:text-teal-300",
  isa_appointment: "bg-violet-500/20 border-violet-500 text-violet-700 dark:text-violet-300",
  time_block: "bg-zinc-500/20 border-zinc-500 text-zinc-700 dark:text-zinc-300",
}

const GRID_START_HOUR = HOURS[0]
const GRID_END_HOUR = HOURS[HOURS.length - 1] + 1
const PX_PER_HOUR = 48

/**
 * `dayStart` — THE COLUMN THIS EVENT IS BEING DRAWN IN — WAS ACCEPTED HERE AND READ
 * BY NOTHING until 2026-08-24. Both edges were taken straight off the event's own
 * clock with `getHours()`, which has no idea which day it is positioning, so an event
 * that crossed midnight (a 10pm closing walkthrough ending at 1am, an all-day block)
 * produced an END HOUR SMALLER THAN ITS START: the height went negative, collapsed to
 * the 24px floor, and a five-hour event rendered as a sliver.
 *
 * Both edges are now CLAMPED to the day column they are drawn in, so an event that
 * begins before this day starts at the top of the column and one that runs past
 * midnight is cut off at the bottom instead of inverting.
 */
function getEventPosition(event: UnifiedCalendarEvent, dayStart: Date) {
  const dayMidnight = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate()).getTime()
  const dayEnd = dayMidnight + 24 * 60 * 60 * 1000

  const rawStart = new Date(event.startAt).getTime()
  const rawEnd = new Date(event.endAt).getTime()

  const clampedStart = Math.min(Math.max(rawStart, dayMidnight), dayEnd)
  // An end that is missing or before its own start is not a duration — treat it as a
  // point in time and let the 24px floor below give it a readable body.
  const clampedEnd = Math.min(Math.max(Number.isFinite(rawEnd) ? rawEnd : clampedStart, clampedStart), dayEnd)

  const startHour = (clampedStart - dayMidnight) / (60 * 60 * 1000)
  const endHour = (clampedEnd - dayMidnight) / (60 * 60 * 1000)

  // The grid only renders GRID_START_HOUR..GRID_END_HOUR; anything outside it is
  // pinned to the nearest edge rather than drawn off-canvas.
  const visibleStart = Math.min(Math.max(startHour, GRID_START_HOUR), GRID_END_HOUR)
  const visibleEnd = Math.min(Math.max(endHour, visibleStart), GRID_END_HOUR)

  const top = (visibleStart - GRID_START_HOUR) * PX_PER_HOUR
  const height = Math.max(24, (visibleEnd - visibleStart) * PX_PER_HOUR)

  return { top, height }
}

function isSameDay(d1: Date, d2: Date) {
  return d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
}

export function CalendarTimelineView({ events, weekStart, onSelectEvent }: CalendarTimelineViewProps) {
  const today = new Date()
  
  return (
    <Card>
      <CardContent className="p-0 overflow-x-auto">
        <div className="min-w-[800px]">
          {/* Header row with days */}
          <div className="grid grid-cols-8 border-b border-border">
            <div className="w-16 border-r border-border" /> {/* Time column */}
            {DAYS.map((day, i) => {
              const date = new Date(weekStart.getTime() + i * 24 * 60 * 60 * 1000)
              const isToday = isSameDay(date, today)
              return (
                <div
                  key={day}
                  className={cn(
                    "py-2 px-1 text-center border-r border-border last:border-r-0",
                    isToday && "bg-primary/5"
                  )}
                >
                  <div className="text-xs font-medium text-muted-foreground">{day}</div>
                  <div className={cn(
                    "text-sm font-semibold",
                    isToday ? "text-primary" : "text-foreground"
                  )}>
                    {date.getDate()}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Time grid */}
          <div className="relative">
            {/* Hour rows */}
            {HOURS.map((hour) => (
              <div key={hour} className="grid grid-cols-8 h-12 border-b border-border">
                <div className="w-16 flex items-start justify-end pr-2 text-xs text-muted-foreground border-r border-border">
                  {hour === 12 ? "12 PM" : hour > 12 ? `${hour - 12} PM` : `${hour} AM`}
                </div>
                {DAYS.map((_, i) => {
                  const date = new Date(weekStart.getTime() + i * 24 * 60 * 60 * 1000)
                  const isToday = isSameDay(date, today)
                  return (
                    <div
                      key={i}
                      className={cn(
                        "border-r border-border last:border-r-0 relative",
                        isToday && "bg-primary/5"
                      )}
                    />
                  )
                })}
              </div>
            ))}

            {/* Events overlay */}
            <div className="absolute inset-0 pointer-events-none">
              <div className="grid grid-cols-8 h-full">
                <div className="w-16" /> {/* Time column spacer */}
                {DAYS.map((_, dayIndex) => {
                  const dayDate = new Date(weekStart.getTime() + dayIndex * 24 * 60 * 60 * 1000)
                  const dayEvents = events.filter((e) => isSameDay(new Date(e.startAt), dayDate))
                  
                  return (
                    <div key={dayIndex} className="relative">
                      {dayEvents.map((event) => {
                        const { top, height } = getEventPosition(event, dayDate)
                        const colorClass = EVENT_COLORS[event.eventType] || EVENT_COLORS.appointment
                        
                        return (
                          <button
                            key={event.id}
                            onClick={() => onSelectEvent(event)}
                            className={cn(
                              "absolute left-0.5 right-0.5 px-1 py-0.5 rounded text-xs border-l-2 overflow-hidden pointer-events-auto hover:opacity-80 transition-opacity",
                              colorClass
                            )}
                            style={{ top: `${top}px`, height: `${height}px` }}
                          >
                            <div className="font-medium truncate">{event.title}</div>
                            {height > 32 && (
                              <div className="text-[10px] opacity-80 truncate">
                                {new Date(event.startAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                              </div>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
