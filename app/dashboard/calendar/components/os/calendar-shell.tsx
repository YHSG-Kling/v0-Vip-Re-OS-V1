"use client"

import { useState, useEffect, useCallback } from "react"
import { createClient } from "@/lib/supabase/client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { ChevronLeft, ChevronRight, RefreshCw, CalendarClock, Loader2, CheckCircle2 } from "lucide-react"
import { scheduleSmartFollowUps } from "@/app/actions/ai-calendar-management"
import { CalendarRoleFilterBar, type CalendarRole } from "./calendar-role-filter-bar"
import { CalendarTimelineView } from "./calendar-timeline-view"
import { CalendarAgendaView } from "./calendar-agenda-view"
import { CalendarOptimizationPanel } from "./calendar-optimization-panel"
import { CalendarQuickCreatePanel } from "./calendar-quick-create-panel"
import { CalendarSyncStatusCard } from "./calendar-sync-status-card"
import { MeetingBriefCard } from "./meeting-brief-card"

export type UnifiedCalendarEvent = {
  id: string
  title: string
  startAt: string
  endAt: string
  eventType: "showing" | "tour" | "open_house" | "inspection" | "appraisal" | "closing" | "appointment" | "task" | "follow_up" | "isa_appointment"
  source: "showings" | "calendar_events" | "open_houses" | "transactions" | "tasks" | "scheduled_touchpoints" | "buyer_tours"
  location?: string
  contactId?: string
  contactName?: string
  listingId?: string
  listingAddress?: string
  agentId?: string
  status?: string
  priority?: "high" | "medium" | "low"
  metadata?: Record<string, unknown>
}

interface CalendarShellProps {
  agentId: string
  brokerageId: string
  defaultRole?: CalendarRole
}

export function CalendarShell({ agentId, brokerageId, defaultRole = "agent" }: CalendarShellProps) {
  const supabase = createClient()
  const [viewDate, setViewDate] = useState(() => new Date())
  const [events, setEvents] = useState<UnifiedCalendarEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [activeRole, setActiveRole] = useState<CalendarRole>(defaultRole)
  const [activeView, setActiveView] = useState<"timeline" | "agenda">("timeline")
  const [selectedEvent, setSelectedEvent] = useState<UnifiedCalendarEvent | null>(null)
  const [showQuickCreate, setShowQuickCreate] = useState(false)

  // Section B: Smart Follow-Up Scheduler sheet
  const [followUpSheetOpen, setFollowUpSheetOpen] = useState(false)
  const [followUpDaysAhead, setFollowUpDaysAhead] = useState("7")
  const [followUpLoading, setFollowUpLoading] = useState(false)
  const [followUpResult, setFollowUpResult] = useState<any>(null)
  const [followUpError, setFollowUpError] = useState<string | null>(null)

  // Get week boundaries
  const getWeekBounds = useCallback((date: Date) => {
    const start = new Date(date)
    start.setDate(start.getDate() - start.getDay())
    start.setHours(0, 0, 0, 0)
    const end = new Date(start)
    end.setDate(end.getDate() + 7)
    return { start, end }
  }, [])

  // Aggregate all calendar sources
  const loadUnifiedCalendar = useCallback(async () => {
    setLoading(true)
    const { start, end } = getWeekBounds(viewDate)
    const startISO = start.toISOString()
    const endISO = end.toISOString()

    try {
      // Parallel fetch all calendar sources
      const [
        showingsRes,
        calendarEventsRes,
        openHousesRes,
        transactionsRes,
        tasksRes,
        touchpointsRes,
        toursRes,
      ] = await Promise.all([
        // 1. Showings (main appointment source)
        supabase
          .from("showings")
          .select(`
            id, scheduled_at, duration_minutes, status, notes, location,
            contact_id, listing_id, agent_id,
            contacts(first_name, last_name),
            listings(address, city)
          `)
          .eq("agent_id", agentId)
          .gte("scheduled_at", startISO)
          .lt("scheduled_at", endISO)
          .neq("status", "cancelled"),

        // 2. Calendar events (ISA appointments, deadlines — filtered by brokerage)
        supabase
          .from("calendar_events")
          .select("id, start_at, end_at, event_type, entity_type, entity_id, metadata, brokerage_id, timezone_name")
          .eq("brokerage_id", brokerageId)
          .gte("start_at", startISO)
          .lt("start_at", endISO),

        // 3. Open house events (correct table name)
        supabase
          .from("open_house_events")
          .select(`
            id, event_date, start_time, end_time, status, notes,
            listing_id,
            listings(address, city)
          `)
          .eq("agent_id", agentId)
          .gte("event_date", startISO)
          .lt("event_date", endISO),

        // 4. Transactions with key dates
        supabase
          .from("transactions")
          .select(`
            id, property_address, status,
            inspection_date, appraisal_date, closing_date,
            contact_id,
            contacts(first_name, last_name)
          `)
          .eq("agent_id", agentId)
          .in("status", ["under_contract", "inspection", "appraisal", "financing", "closing"]),

        // 5. Tasks with due dates
        supabase
          .from("tasks")
          .select("*")
          .eq("agent_id", agentId)
          .gte("due_date", start.toISOString().split("T")[0])
          .lte("due_date", end.toISOString().split("T")[0])
          .neq("status", "completed"),

        // 6. Scheduled touchpoints / follow-ups
        supabase
          .from("scheduled_touchpoints")
          .select(`
            id, scheduled_date, touchpoint_type, purpose, priority, status,
            contact_id,
            contacts(first_name, last_name)
          `)
          .eq("agent_id", agentId)
          .eq("status", "scheduled")
          .gte("scheduled_date", startISO)
          .lt("scheduled_date", endISO),

        // 7. Tours (correct table name is tours, not buyer_tours)
        supabase
          .from("tours")
          .select(`
            id, tour_date, scheduled_at, status, notes,
            contact_id,
            contacts(first_name, last_name)
          `)
          .eq("agent_id", agentId)
          .gte("tour_date", start.toISOString().split("T")[0])
          .lte("tour_date", end.toISOString().split("T")[0]),
      ])

      const unified: UnifiedCalendarEvent[] = []

      // Transform showings
      showingsRes.data?.forEach((s: any) => {
        const endAt = new Date(new Date(s.scheduled_at).getTime() + (s.duration_minutes || 30) * 60000)
        unified.push({
          id: s.id,
          title: s.notes || "Showing",
          startAt: s.scheduled_at,
          endAt: endAt.toISOString(),
          eventType: "showing",
          source: "showings",
          location: s.location,
          contactId: s.contact_id,
          contactName: s.contacts ? `${s.contacts.first_name || ""} ${s.contacts.last_name || ""}`.trim() : undefined,
          listingId: s.listing_id,
          listingAddress: s.listings ? `${s.listings.address}, ${s.listings.city}` : undefined,
          agentId: s.agent_id,
          status: s.status,
        })
      })

      // Transform calendar events (no title/location/agent_id columns — derive from metadata + event_type)
      calendarEventsRes.data?.forEach((e: any) => {
        const meta = (e.metadata as Record<string, unknown>) || {}
        const derivedTitle = (meta.title as string) || e.event_type?.replace(/_/g, " ") || "Calendar Event"
        unified.push({
          id: e.id,
          title: derivedTitle,
          startAt: e.start_at,
          endAt: e.end_at ?? new Date(new Date(e.start_at).getTime() + 30 * 60000).toISOString(),
          eventType: e.event_type === "isa_appointment" ? "isa_appointment" : "appointment",
          source: "calendar_events",
          contactId: e.entity_type === "contact" ? e.entity_id : undefined,
          metadata: meta,
        })
      })

      // Transform open house events
      openHousesRes.data?.forEach((oh: any) => {
        const datePrefix = oh.event_date ? oh.event_date.split("T")[0] : new Date().toISOString().split("T")[0]
        unified.push({
          id: oh.id,
          title: `Open House: ${oh.listings?.address || "Property"}`,
          startAt: `${datePrefix}T${oh.start_time || "10:00:00"}`,
          endAt: `${datePrefix}T${oh.end_time || "13:00:00"}`,
          eventType: "open_house",
          source: "open_houses",
          listingId: oh.listing_id,
          listingAddress: oh.listings ? `${oh.listings.address}, ${oh.listings.city}` : undefined,
          status: oh.status,
        })
      })

      // Transform transaction milestones
      transactionsRes.data?.forEach((t: any) => {
        const dateFields = [
          { field: "inspection_date", type: "inspection" as const },
          { field: "appraisal_date", type: "appraisal" as const },
          { field: "closing_date", type: "closing" as const },
        ]
        dateFields.forEach(({ field, type }) => {
          if (t[field]) {
            const dateStr = t[field]
            const eventDate = new Date(dateStr)
            if (eventDate >= start && eventDate < end) {
              unified.push({
                id: `${t.id}-${type}`,
                title: `${type.charAt(0).toUpperCase() + type.slice(1)}: ${t.property_address}`,
                startAt: new Date(dateStr + "T10:00:00").toISOString(),
                endAt: new Date(dateStr + "T12:00:00").toISOString(),
                eventType: type,
                source: "transactions",
                contactId: t.contact_id,
                contactName: t.contacts ? `${t.contacts.first_name || ""} ${t.contacts.last_name || ""}`.trim() : undefined,
                priority: "high",
              })
            }
          }
        })
      })

      // Transform tasks
      tasksRes.data?.forEach((task: any) => {
        unified.push({
          id: task.id,
          title: task.title,
          startAt: new Date(task.due_date + "T09:00:00").toISOString(),
          endAt: new Date(task.due_date + "T09:30:00").toISOString(),
          eventType: "task",
          source: "tasks",
          priority: task.priority as "high" | "medium" | "low",
          status: task.status,
        })
      })

      // Transform touchpoints
      touchpointsRes.data?.forEach((tp: any) => {
        unified.push({
          id: tp.id,
          title: `Follow-up: ${tp.contacts?.first_name || "Contact"} - ${tp.purpose}`,
          startAt: tp.scheduled_date,
          endAt: new Date(new Date(tp.scheduled_date).getTime() + 15 * 60000).toISOString(),
          eventType: "follow_up",
          source: "scheduled_touchpoints",
          contactId: tp.contact_id,
          contactName: tp.contacts ? `${tp.contacts.first_name || ""} ${tp.contacts.last_name || ""}`.trim() : undefined,
          priority: tp.priority as "high" | "medium" | "low",
        })
      })

      // Transform tours (real table: tours, uses tour_date + scheduled_at)
      toursRes.data?.forEach((tour: any) => {
        const tourStart = tour.scheduled_at || `${tour.tour_date}T10:00:00`
        const tourEnd = new Date(new Date(tourStart).getTime() + 2 * 60 * 60000).toISOString()
        unified.push({
          id: tour.id,
          title: `Tour: ${tour.contacts?.first_name || "Buyer"}`,
          startAt: tourStart,
          endAt: tourEnd,
          eventType: "tour",
          source: "buyer_tours",
          contactId: tour.contact_id,
          contactName: tour.contacts ? `${tour.contacts.first_name || ""} ${tour.contacts.last_name || ""}`.trim() : undefined,
          status: tour.status,
        })
      })

      // Sort by start time
      unified.sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime())

      setEvents(unified)
    } catch (err) {
      console.error("Failed to load unified calendar:", err)
    } finally {
      setLoading(false)
    }
  }, [supabase, agentId, viewDate, getWeekBounds])

  useEffect(() => {
    loadUnifiedCalendar()
  }, [loadUnifiedCalendar])

  // Filter events by role
  const filteredEvents = events.filter((e) => {
    if (activeRole === "all") return true
    if (activeRole === "isa") return e.eventType === "isa_appointment" || e.eventType === "follow_up"
    if (activeRole === "listing") return ["showing", "open_house"].includes(e.eventType)
    if (activeRole === "transaction") return ["inspection", "appraisal", "closing"].includes(e.eventType)
    if (activeRole === "buyer") return e.eventType === "tour"
    return true // agent sees all
  })

  // Navigation
  const prevWeek = () => setViewDate((d) => new Date(d.getTime() - 7 * 24 * 60 * 60 * 1000))
  const nextWeek = () => setViewDate((d) => new Date(d.getTime() + 7 * 24 * 60 * 60 * 1000))
  const goToToday = () => setViewDate(new Date())

  const { start: weekStart } = getWeekBounds(viewDate)
  const weekLabel = `${weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" })} - ${new Date(weekStart.getTime() + 6 * 24 * 60 * 60 * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Calendar OS</h1>
          <p className="text-sm text-muted-foreground">Unified scheduling across all domains</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => loadUnifiedCalendar()}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setFollowUpSheetOpen(true)
              setFollowUpResult(null)
              setFollowUpError(null)
            }}
          >
            <CalendarClock className="h-4 w-4 mr-1" />
            AI Follow-Ups
          </Button>
          <Button size="sm" onClick={() => setShowQuickCreate(true)}>
            Quick Create
          </Button>
        </div>
      </div>

      {/* Role Filter */}
      <CalendarRoleFilterBar activeRole={activeRole} onRoleChange={setActiveRole} />

      {/* Week Navigation */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={prevWeek}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={goToToday}>
            Today
          </Button>
          <Button variant="outline" size="icon" onClick={nextWeek}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <h2 className="text-lg font-medium text-foreground">{weekLabel}</h2>
        <Tabs value={activeView} onValueChange={(v) => setActiveView(v as "timeline" | "agenda")}>
          <TabsList>
            <TabsTrigger value="timeline">Timeline</TabsTrigger>
            <TabsTrigger value="agenda">Agenda</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {/* Calendar View (3 cols) */}
        <div className="lg:col-span-3">
          {loading ? (
            <Card>
              <CardContent className="py-16 text-center text-muted-foreground">
                Loading unified calendar...
              </CardContent>
            </Card>
          ) : activeView === "timeline" ? (
            <CalendarTimelineView
              events={filteredEvents}
              weekStart={weekStart}
              onSelectEvent={setSelectedEvent}
            />
          ) : (
            <CalendarAgendaView
              events={filteredEvents}
              weekStart={weekStart}
              onSelectEvent={setSelectedEvent}
            />
          )}
        </div>

        {/* Right Sidebar (1 col) */}
        <div className="space-y-4">
          <CalendarSyncStatusCard agentId={agentId} />
          <CalendarOptimizationPanel
            agentId={agentId}
            date={viewDate.toISOString().split("T")[0]}
            events={filteredEvents}
          />
          {selectedEvent && (
            <MeetingBriefCard
              event={selectedEvent}
              agentId={agentId}
              onClose={() => setSelectedEvent(null)}
            />
          )}
        </div>
      </div>

      {/* Section B: AI Follow-Up Scheduler Sheet */}
      <Sheet open={followUpSheetOpen} onOpenChange={setFollowUpSheetOpen}>
        <SheetContent className="w-full sm:max-w-md overflow-y-auto">
          <SheetHeader className="pb-4">
            <SheetTitle>Schedule This Week's Follow-Ups</SheetTitle>
            <SheetDescription>
              AI will schedule the optimal follow-up times for your most important contacts based on their stage, last interaction, and lead score.
            </SheetDescription>
          </SheetHeader>

          <div className="space-y-5 pt-2">
            <div className="space-y-1.5">
              <Label className="text-sm">Schedule ahead</Label>
              <Select value={followUpDaysAhead} onValueChange={setFollowUpDaysAhead}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7">This week (7 days)</SelectItem>
                  <SelectItem value="14">Next 2 weeks</SelectItem>
                  <SelectItem value="30">Next month</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Button
              className="w-full gap-2"
              onClick={async () => {
                setFollowUpLoading(true)
                setFollowUpError(null)
                setFollowUpResult(null)
                const res = await scheduleSmartFollowUps({
                  agentId,
                  daysAhead: Number(followUpDaysAhead),
                })
                if (res.success) {
                  setFollowUpResult(res)
                  if ((res as any).scheduled > 0) loadUnifiedCalendar()
                } else {
                  setFollowUpError((res as any).error ?? "Follow-up scheduling failed")
                }
                setFollowUpLoading(false)
              }}
              disabled={followUpLoading}
            >
              {followUpLoading ? (
                <><Loader2 className="h-4 w-4 animate-spin" />Scheduling...</>
              ) : (
                <><CalendarClock className="h-4 w-4" />Schedule Follow-Ups</>
              )}
            </Button>

            {followUpError && (
              <p className="text-sm text-destructive">{followUpError}</p>
            )}

            {followUpResult && (
              <div className="space-y-4">
                {/* Summary */}
                <div className="flex items-center gap-2 rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2.5">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                  <p className="text-sm text-emerald-900">
                    {(followUpResult as any).scheduled > 0
                      ? `Scheduled ${(followUpResult as any).scheduled} follow-up touchpoints`
                      : (followUpResult as any).message ?? "All contacts already have follow-ups scheduled"}
                  </p>
                </div>

                {/* Scheduled list */}
                {(followUpResult as any).followUpPlan?.scheduledFollowUps?.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Scheduled touchpoints</p>
                    {(followUpResult as any).followUpPlan.scheduledFollowUps.map((f: any, i: number) => (
                      <div key={i} className="rounded-md border border-border p-3 space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium truncate">{f.contactName}</span>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <Badge
                              className={`text-[10px] py-0 ${
                                f.priority === "high"
                                  ? "bg-red-100 text-red-700 border-red-200"
                                  : f.priority === "medium"
                                  ? "bg-amber-100 text-amber-700 border-amber-200"
                                  : "bg-slate-100 text-slate-600 border-slate-200"
                              }`}
                            >
                              {f.priority}
                            </Badge>
                            <Badge variant="outline" className="text-[10px] py-0 capitalize">{f.channel}</Badge>
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {f.suggestedDate} at {f.suggestedTime}
                        </p>
                        <p className="text-xs text-muted-foreground">{f.purpose}</p>
                        {f.talkingPoints?.length > 0 && (
                          <ul className="space-y-0.5 pt-0.5">
                            {f.talkingPoints.slice(0, 2).map((tp: string, j: number) => (
                              <li key={j} className="text-xs text-muted-foreground flex gap-1.5">
                                <span className="shrink-0 text-muted-foreground">&bull;</span>
                                {tp}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {(followUpResult as any).scheduled > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => {
                      setFollowUpSheetOpen(false)
                      loadUnifiedCalendar()
                    }}
                  >
                    View on Calendar
                  </Button>
                )}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Quick Create Panel */}
      {showQuickCreate && (
        <CalendarQuickCreatePanel
          agentId={agentId}
          brokerageId={brokerageId}
          onClose={() => setShowQuickCreate(false)}
          onCreated={() => {
            setShowQuickCreate(false)
            loadUnifiedCalendar()
          }}
        />
      )}
    </div>
  )
}
