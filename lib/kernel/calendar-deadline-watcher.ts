// lib/kernel/calendar-deadline-watcher.ts
//
// Polls calendar_events for upcoming deadlines (within 24h — or, for transaction
// deadlines, the tenant's optimized reminder lead, wave 137E) and emits a
// KernelEvent notification for each unnotified event.
//
// Constraints:
// - No any
// - TypeScript strict
// - Uses existing processKernelEvent signature
// - deadline_notified is set to true AFTER all notifications fire

import { createServiceClient } from '@/lib/supabase/service'
import { KernelEvent } from './events'
// emitKernelEvent, not processKernelEvent (integrator, 2026-09-03): the five
// *_DUE events have LIVE notification_rules rows but processKernelEvent writes
// no lifecycle_events audit row, so a fired deadline left no record. The
// survivor (lib/kernel/emit.ts) writes the row AND fans out.
import { emitKernelEvent } from './emit'
import { CalendarEventType } from './calendar-types'

// ─── CALENDAR EVENT TYPE → KERNEL EVENT MAP ───────────────────────────────────
// Lane 76B — CalendarEventType.DEMO_APPOINTMENT (a PLATFORM prospect's product
// demo, entity_type 'platform_prospect', keyed to the sales rep's brokerage)
// is deliberately EXCLUDED from this map by its type: it has no tenant
// lifecycle and must never fire a tenant KernelEvent. The loop below marks
// such rows notified without emitting, so they do not re-log as "Unknown
// event_type" on every run. Its own reminders ride
// lib/ai-isa/listing-appointment.ts::sendAppointmentReminders.
type TenantCalendarEventType = Exclude<CalendarEventType, CalendarEventType.DEMO_APPOINTMENT>
const CALENDAR_TYPE_TO_KERNEL_EVENT: Record<TenantCalendarEventType, KernelEvent> = {
  [CalendarEventType.INSPECTION]:          KernelEvent.INSPECTION_DUE,
  [CalendarEventType.APPRAISAL]:           KernelEvent.APPRAISAL_DUE,
  [CalendarEventType.FINANCING_DEADLINE]:  KernelEvent.FINANCING_DUE,
  [CalendarEventType.WALKTHROUGH]:         KernelEvent.WALKTHROUGH_DUE,
  [CalendarEventType.CLOSING]:             KernelEvent.CLOSING_SCHEDULED,
  [CalendarEventType.TASK_DUE]:            KernelEvent.TASK_DUE,
  // The fifth of the "five *_DUE events" the comment above names — see
  // lib/kernel/calendar-types.ts CLOSING_DISCLOSURE (lane Z1, 2026-09-08 hunt 2).
  [CalendarEventType.CLOSING_DISCLOSURE]:  KernelEvent.CD_DUE,
  isa_outreach_email:                      KernelEvent.ISA_OUTREACH_SENT,
  isa_followup_email:                      KernelEvent.ISA_OUTREACH_SENT,
  isa_direct_mail:                         KernelEvent.ISA_OUTREACH_SENT,
  isa_video_send:                          KernelEvent.ISA_OUTREACH_SENT,
  [CalendarEventType.ISA_APPOINTMENT]:     KernelEvent.ISA_APPOINTMENT_SCHEDULED,
  [CalendarEventType.LISTING_APPOINTMENT]: KernelEvent.LISTING_STAGE_CHANGED,
  [CalendarEventType.OPEN_HOUSE]:          KernelEvent.OPEN_HOUSE_SCHEDULED,
}

/** The contract deadlines whose reminder lead a tenant's optimization may move (wave 137E). */
const TRANSACTION_DEADLINE_TYPES: ReadonlySet<CalendarEventType> = new Set([
  CalendarEventType.INSPECTION, CalendarEventType.APPRAISAL, CalendarEventType.FINANCING_DEADLINE,
  CalendarEventType.WALKTHROUGH, CalendarEventType.CLOSING, CalendarEventType.CLOSING_DISCLOSURE,
])

// ─── SHAPE OF A CALENDAR_EVENTS ROW ──────────────────────────────────────────
interface CalendarEventRow {
  id:                  string
  brokerage_id:        string
  entity_type:         'transaction' | 'contact'
  entity_id:           string
  event_type:          CalendarEventType
  start_at:            string
  deadline_notified:   boolean
}

// ─── MAIN EXPORT ──────────────────────────────────────────────────────────────

/**
 * checkUpcomingDeadlines
 *
 * Queries calendar_events for rows with start_at within the next 24 hours
 * that have not yet been notified. Fires a KernelEvent notification for each,
 * then marks all processed rows with deadline_notified = true.
 *
 * Designed to be called from a cron route (e.g. /api/cron/deadline-watcher).
 */
export async function checkUpcomingDeadlines(
  client?: ReturnType<typeof createServiceClient>,
): Promise<void> {
  // Cron context — no user session, so the cookie-bound server client sees nothing
  // under RLS. The service client (or an injected one, for the simulator) is required.
  const supabase = client ?? createServiceClient()

  const now   = new Date()
  // Wave 137E: TRANSACTION deadlines notify on the tenant's reminder lead (optimization_tuning
  // .deadline_reminder_hours — the transaction_reminder_timing optimization class, promoted only through
  // the improvement-proposal kernel); every other event type keeps the historic 24h. The query reaches the
  // widest allowed lead; each row is then judged against ITS tenant's horizon.
  const { DEADLINE_REMINDER_DEFAULT_HOURS, DEADLINE_REMINDER_MAX_HOURS, loadDeadlineReminderHours } = await import('./self-optimization')
  const horizonEnd = new Date(now.getTime() + DEADLINE_REMINDER_MAX_HOURS * 60 * 60 * 1000)

  // ── Step 1: Query upcoming, unnotified calendar events ────────────────────
  // Lower bound at NOW: a deadline that already passed is not worth a "due soon"
  // notification (and without the floor, the first scheduled run would flood every
  // ancient unnotified event).
  const { data: events, error: fetchError } = await supabase
    .from('calendar_events')
    .select('id, brokerage_id, entity_type, entity_id, event_type, start_at, deadline_notified')
    .gte('start_at', now.toISOString())
    .lte('start_at', horizonEnd.toISOString())
    .eq('deadline_notified', false)

  if (fetchError) {
    throw new Error(`[calendar-deadline-watcher] Failed to query calendar_events: ${fetchError.message}`)
  }

  if (!events || events.length === 0) {
    return
  }

  const rows = events as CalendarEventRow[]
  const tenantLead = await loadDeadlineReminderHours(supabase, rows.filter((e) => TRANSACTION_DEADLINE_TYPES.has(e.event_type)).map((e) => e.brokerage_id))
  const leadHoursFor = (e: CalendarEventRow): number =>
    TRANSACTION_DEADLINE_TYPES.has(e.event_type) ? tenantLead.get(e.brokerage_id) ?? DEADLINE_REMINDER_DEFAULT_HOURS : DEADLINE_REMINDER_DEFAULT_HOURS

  const notifiedIds: string[] = []

  // ── Step 2: Emit one KernelEvent notification per calendar event ──────────
  for (const calEvent of rows) {
    // Not yet inside this row's reminder lead — leave it unnotified for a later run.
    if (Date.parse(calEvent.start_at) > now.getTime() + leadHoursFor(calEvent) * 60 * 60 * 1000) continue
    // A platform demo is not a tenant deadline (see the map's header) — mark
    // it seen so it stops matching, and emit nothing.
    if (calEvent.event_type === CalendarEventType.DEMO_APPOINTMENT) {
      notifiedIds.push(calEvent.id)
      continue
    }
    const kernelEventType = CALENDAR_TYPE_TO_KERNEL_EVENT[calEvent.event_type]

    if (!kernelEventType) {
      console.error(
        `[calendar-deadline-watcher] Unknown event_type "${calEvent.event_type}" for calendar_event ${calEvent.id} — skipping`
      )
      continue
    }

    try {
      await emitKernelEvent({
        event:       kernelEventType,
        brokerageId: calEvent.brokerage_id,
        entityType:  calEvent.entity_type,
        entityId:    calEvent.entity_id,
        source:      "cron",
        metadata:    { calendar_event_id: calEvent.id, start_at: calEvent.start_at, event_type: calEvent.event_type },
      })

      notifiedIds.push(calEvent.id)
    } catch (err) {
      console.error(
        `[calendar-deadline-watcher] emitKernelEvent failed for calendar_event ${calEvent.id}:`,
        err
      )
      // INTENTIONAL: skip this event and continue — do not mark as notified
    }
  }

  // ── Step 3: Mark successfully notified events ─────────────────────────────
  if (notifiedIds.length === 0) {
    return
  }

  const { error: updateError } = await supabase
    .from('calendar_events')
    .update({ deadline_notified: true })
    .in('id', notifiedIds)

  if (updateError) {
    throw new Error(
      `[calendar-deadline-watcher] Notifications fired but failed to mark deadline_notified: ${updateError.message}`
    )
  }
}
