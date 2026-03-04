'use client'

import { useEffect, useState, useTransition, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { scheduleAppointment } from '@/app/actions/ai-isa/schedule-appointment'
import type { ScheduleAppointmentInput } from '@/app/actions/ai-isa/schedule-appointment'

// ── Types ──────────────────────────────────────────────────────────────────────

type CalendarEventRow = {
  id: string
  entity_type: 'lead' | 'contact'
  entity_id: string
  agent_id: string | null
  title: string
  start_at: string
  end_at: string
  timezone_name: string
  location: string | null
  is_cancelled: boolean
  metadata: Record<string, unknown> | null
  entity_name?: string  // resolved client-side
}

type AgentOption = {
  id: string
  full_name: string
}

type DetailEvent = CalendarEventRow | null

type ScheduleForm = {
  leadId: string
  contactId: string
  entityMode: 'lead' | 'contact'
  startAt: string
  endAt: string
  timezoneName: string
  location: string
  notes: string
}

const EMPTY_FORM: ScheduleForm = {
  leadId:       '',
  contactId:    '',
  entityMode:   'lead',
  startAt:      '',
  endAt:        '',
  timezoneName: Intl.DateTimeFormat().resolvedOptions().timeZone,
  location:     '',
  notes:        '',
}

// ── Month helpers ──────────────────────────────────────────────────────────────

function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}
function endOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999)
}
function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}
function daysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate()
}
function firstWeekday(year: number, month: number) {
  return new Date(year, month, 1).getDay()
}
const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
]

// ── Main Component ─────────────────────────────────────────────────────────────

export default function ISACalendarPage() {
  const supabase = createClient()

  const [today]       = useState(() => new Date())
  const [viewDate, setViewDate] = useState(() => new Date())
  const [events, setEvents]     = useState<CalendarEventRow[]>([])
  const [agents, setAgents]     = useState<AgentOption[]>([])
  const [agentFilter, setAgentFilter] = useState<string>('all')
  const [loading, setLoading]   = useState(true)
  const [detailEvent, setDetailEvent] = useState<DetailEvent>(null)
  const [showSchedule, setShowSchedule] = useState(false)
  const [form, setForm]         = useState<ScheduleForm>(EMPTY_FORM)
  const [formError, setFormError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  // ── Load agents ──────────────────────────────────────────────────────────────
  useEffect(() => {
    async function loadAgents() {
      const { data } = await supabase
        .from('user_profiles')
        .select('id, full_name')
        .eq('user_type', 'agent')
        .order('full_name')
      setAgents((data ?? []) as AgentOption[])
    }
    void loadAgents()
  }, [supabase])

  // ── Load events for current month ────────────────────────────────────────────
  const loadEvents = useCallback(async () => {
    setLoading(true)
    const start = startOfMonth(viewDate).toISOString()
    const end   = endOfMonth(viewDate).toISOString()

    let query = supabase
      .from('calendar_events')
      .select('id, entity_type, entity_id, agent_id, title, start_at, end_at, timezone_name, location, is_cancelled, metadata')
      .eq('event_type', 'isa_appointment')
      .eq('is_cancelled', false)
      .gte('start_at', start)
      .lte('start_at', end)
      .order('start_at', { ascending: true })

    if (agentFilter !== 'all') {
      query = query.eq('agent_id', agentFilter)
    }

    const { data: rawEvents } = await query
    const rows = (rawEvents ?? []) as Omit<CalendarEventRow, 'entity_name'>[]

    // Resolve entity names in parallel
    const enriched: CalendarEventRow[] = await Promise.all(
      rows.map(async (ev) => {
        let entity_name = ev.entity_id
        const table = ev.entity_type === 'lead' ? 'leads' : 'contacts'
        const nameCol = ev.entity_type === 'lead'
          ? 'first_name, last_name'
          : 'first_name, last_name'

        const { data: entity } = await supabase
          .from(table)
          .select(nameCol)
          .eq('id', ev.entity_id)
          .maybeSingle()

        if (entity) {
          const e = entity as { first_name?: string; last_name?: string }
          entity_name = [e.first_name, e.last_name].filter(Boolean).join(' ') || ev.entity_id
        }

        return { ...ev, entity_name }
      })
    )

    setEvents(enriched)
    setLoading(false)
  }, [supabase, viewDate, agentFilter])

  useEffect(() => { void loadEvents() }, [loadEvents])

  // ── Navigate months ──────────────────────────────────────────────────────────
  function prevMonth() {
    setViewDate(d => new Date(d.getFullYear(), d.getMonth() - 1, 1))
  }
  function nextMonth() {
    setViewDate(d => new Date(d.getFullYear(), d.getMonth() + 1, 1))
  }

  // ── Events per day ───────────────────────────────────────────────────────────
  function eventsForDay(day: number): CalendarEventRow[] {
    const target = new Date(viewDate.getFullYear(), viewDate.getMonth(), day)
    return events.filter(ev => sameDay(new Date(ev.start_at), target))
  }

  // ── Schedule submit ──────────────────────────────────────────────────────────
  function handleScheduleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setFormError(null)

    const input: ScheduleAppointmentInput = {
      leadId:       form.entityMode === 'lead'    ? form.leadId    || undefined : undefined,
      contactId:    form.entityMode === 'contact' ? form.contactId || undefined : undefined,
      startAt:      form.startAt,
      endAt:        form.endAt,
      timezoneName: form.timezoneName,
      location:     form.location || undefined,
      notes:        form.notes    || undefined,
    }

    startTransition(async () => {
      const result = await scheduleAppointment(input)
      if (result.success) {
        setShowSchedule(false)
        setForm(EMPTY_FORM)
        await loadEvents()
      } else {
        setFormError(result.error)
      }
    })
  }

  // ── Calendar grid ─────────────────────────────────────────────────────────────
  const year  = viewDate.getFullYear()
  const month = viewDate.getMonth()
  const totalDays  = daysInMonth(year, month)
  const startDay   = firstWeekday(year, month)
  const totalCells = Math.ceil((startDay + totalDays) / 7) * 7

  return (
    <main className="min-h-screen bg-background p-6 font-sans">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-foreground tracking-tight">ISA Appointments</h1>
          <p className="text-sm text-muted-foreground mt-1">Scheduled ISA appointment calendar</p>
        </div>
        <button
          onClick={() => setShowSchedule(true)}
          className="px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-md hover:opacity-90 transition-opacity"
        >
          Schedule Appointment
        </button>
      </div>

      {/* Agent filter */}
      <div className="flex items-center gap-3 mb-6">
        <label className="text-sm text-muted-foreground font-medium">Filter by agent:</label>
        <select
          value={agentFilter}
          onChange={e => setAgentFilter(e.target.value)}
          className="text-sm border border-border rounded-md px-3 py-1.5 bg-background text-foreground"
        >
          <option value="all">All agents</option>
          {agents.map(a => (
            <option key={a.id} value={a.id}>{a.full_name}</option>
          ))}
        </select>
      </div>

      {/* Month navigation */}
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={prevMonth}
          className="px-3 py-1 text-sm border border-border rounded-md text-foreground hover:bg-accent transition-colors"
        >
          &larr;
        </button>
        <h2 className="text-lg font-semibold text-foreground">
          {MONTH_NAMES[month]} {year}
        </h2>
        <button
          onClick={nextMonth}
          className="px-3 py-1 text-sm border border-border rounded-md text-foreground hover:bg-accent transition-colors"
        >
          &rarr;
        </button>
      </div>

      {/* Calendar grid */}
      <div className="rounded-xl border border-border overflow-hidden bg-card">
        {/* Day headers */}
        <div className="grid grid-cols-7 border-b border-border">
          {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => (
            <div key={d} className="py-2 text-center text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              {d}
            </div>
          ))}
        </div>

        {/* Cells */}
        {loading ? (
          <div className="py-24 text-center text-sm text-muted-foreground">Loading appointments…</div>
        ) : (
          <div className="grid grid-cols-7">
            {Array.from({ length: totalCells }).map((_, i) => {
              const dayNum = i - startDay + 1
              const isValid = dayNum >= 1 && dayNum <= totalDays
              const isToday = isValid && sameDay(new Date(year, month, dayNum), today)
              const dayEvents = isValid ? eventsForDay(dayNum) : []

              return (
                <div
                  key={i}
                  className={`min-h-[96px] p-2 border-b border-r border-border last:border-r-0 ${
                    isValid ? 'bg-card' : 'bg-muted/30'
                  }`}
                >
                  {isValid && (
                    <>
                      <span className={`inline-flex items-center justify-center w-6 h-6 text-xs font-medium rounded-full mb-1 ${
                        isToday
                          ? 'bg-primary text-primary-foreground'
                          : 'text-foreground'
                      }`}>
                        {dayNum}
                      </span>
                      <div className="flex flex-col gap-1">
                        {dayEvents.slice(0, 3).map(ev => (
                          <button
                            key={ev.id}
                            onClick={() => setDetailEvent(ev)}
                            className="text-left text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary truncate hover:bg-primary/20 transition-colors"
                          >
                            {new Date(ev.start_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            {' '}{ev.entity_name ?? ev.title}
                          </button>
                        ))}
                        {dayEvents.length > 3 && (
                          <span className="text-xs text-muted-foreground pl-1">
                            +{dayEvents.length - 3} more
                          </span>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Detail sheet */}
      {detailEvent && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40">
          <div className="bg-card border border-border rounded-xl p-6 w-full max-w-md shadow-xl">
            <div className="flex items-start justify-between mb-4">
              <h3 className="text-base font-semibold text-foreground">Appointment Details</h3>
              <button onClick={() => setDetailEvent(null)} className="text-muted-foreground hover:text-foreground text-lg leading-none">&times;</button>
            </div>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground font-medium">Lead / Contact</dt>
                <dd className="text-foreground">{detailEvent.entity_name ?? detailEvent.entity_id}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground font-medium">Type</dt>
                <dd className="text-foreground capitalize">{detailEvent.entity_type}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground font-medium">Start</dt>
                <dd className="text-foreground">
                  {new Date(detailEvent.start_at).toLocaleString()}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground font-medium">End</dt>
                <dd className="text-foreground">
                  {new Date(detailEvent.end_at).toLocaleString()}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground font-medium">Timezone</dt>
                <dd className="text-foreground">{detailEvent.timezone_name}</dd>
              </div>
              {detailEvent.location && (
                <div className="flex justify-between">
                  <dt className="text-muted-foreground font-medium">Location</dt>
                  <dd className="text-foreground">{detailEvent.location}</dd>
                </div>
              )}
              {detailEvent.metadata?.notes && (
                <div>
                  <dt className="text-muted-foreground font-medium mb-1">Notes</dt>
                  <dd className="text-foreground">{String(detailEvent.metadata.notes)}</dd>
                </div>
              )}
            </dl>
            <button
              onClick={() => setDetailEvent(null)}
              className="mt-5 w-full px-4 py-2 text-sm font-medium border border-border rounded-md text-foreground hover:bg-accent transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Schedule modal */}
      {showSchedule && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-card border border-border rounded-xl p-6 w-full max-w-lg shadow-xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between mb-5">
              <h3 className="text-base font-semibold text-foreground">Schedule ISA Appointment</h3>
              <button onClick={() => { setShowSchedule(false); setForm(EMPTY_FORM); setFormError(null) }} className="text-muted-foreground hover:text-foreground text-lg leading-none">&times;</button>
            </div>

            <form onSubmit={handleScheduleSubmit} className="space-y-4">
              {/* Entity mode */}
              <div className="flex gap-3">
                {(['lead', 'contact'] as const).map(mode => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setForm(f => ({ ...f, entityMode: mode }))}
                    className={`flex-1 py-2 text-sm font-medium rounded-md border transition-colors ${
                      form.entityMode === mode
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background text-foreground border-border hover:bg-accent'
                    }`}
                  >
                    {mode.charAt(0).toUpperCase() + mode.slice(1)}
                  </button>
                ))}
              </div>

              {/* Entity ID */}
              {form.entityMode === 'lead' ? (
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">Lead ID</label>
                  <input
                    type="text"
                    required
                    value={form.leadId}
                    onChange={e => setForm(f => ({ ...f, leadId: e.target.value }))}
                    placeholder="Enter lead UUID"
                    className="w-full text-sm border border-border rounded-md px-3 py-2 bg-background text-foreground"
                  />
                </div>
              ) : (
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">Contact ID</label>
                  <input
                    type="text"
                    required
                    value={form.contactId}
                    onChange={e => setForm(f => ({ ...f, contactId: e.target.value }))}
                    placeholder="Enter contact UUID"
                    className="w-full text-sm border border-border rounded-md px-3 py-2 bg-background text-foreground"
                  />
                </div>
              )}

              {/* Start / End */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">Start</label>
                  <input
                    type="datetime-local"
                    required
                    value={form.startAt}
                    onChange={e => setForm(f => ({ ...f, startAt: e.target.value }))}
                    className="w-full text-sm border border-border rounded-md px-3 py-2 bg-background text-foreground"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">End</label>
                  <input
                    type="datetime-local"
                    required
                    value={form.endAt}
                    onChange={e => setForm(f => ({ ...f, endAt: e.target.value }))}
                    className="w-full text-sm border border-border rounded-md px-3 py-2 bg-background text-foreground"
                  />
                </div>
              </div>

              {/* Timezone */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">Timezone</label>
                <input
                  type="text"
                  required
                  value={form.timezoneName}
                  onChange={e => setForm(f => ({ ...f, timezoneName: e.target.value }))}
                  className="w-full text-sm border border-border rounded-md px-3 py-2 bg-background text-foreground"
                />
              </div>

              {/* Location */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">Location <span className="text-muted-foreground font-normal">(optional)</span></label>
                <input
                  type="text"
                  value={form.location}
                  onChange={e => setForm(f => ({ ...f, location: e.target.value }))}
                  placeholder="Office, Zoom link, etc."
                  className="w-full text-sm border border-border rounded-md px-3 py-2 bg-background text-foreground"
                />
              </div>

              {/* Notes */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">Notes <span className="text-muted-foreground font-normal">(optional)</span></label>
                <textarea
                  value={form.notes}
                  onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                  rows={3}
                  className="w-full text-sm border border-border rounded-md px-3 py-2 bg-background text-foreground resize-none"
                />
              </div>

              {formError && (
                <p className="text-sm text-destructive">{formError}</p>
              )}

              <div className="flex gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => { setShowSchedule(false); setForm(EMPTY_FORM); setFormError(null) }}
                  className="flex-1 py-2 text-sm font-medium border border-border rounded-md text-foreground hover:bg-accent transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isPending}
                  className="flex-1 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {isPending ? 'Scheduling…' : 'Schedule'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  )
}
