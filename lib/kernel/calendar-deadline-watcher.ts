// lib/kernel/calendar-deadline-watcher.ts
//
// Polls calendar_events for upcoming deadlines (within 24h) and emits
// a KernelEvent notification for each unnotified event.
//
// Constraints:
// - No any
// - TypeScript strict
// - Uses existing processKernelEvent signature
// - deadline_notified is set to true AFTER all notifications fire

import { createClient } from '@/lib/supabase/server'
import { KernelEvent } from './events'
import { processKernelEvent } from './notification-engine'
import { CalendarEventType } from './calendar-types'

// ─── CALENDAR EVENT TYPE → KERNEL EVENT MAP ───────────────────────────────────
const CALENDAR_TYPE_TO_KERNEL_EVENT: Record<CalendarEventType, KernelEvent> = {
  [CalendarEventType.INSPECTION]:          KernelEvent.INSPECTION_DUE,
  [CalendarEventType.APPRAISAL]:           KernelEvent.APPRAISAL_DUE,
  [CalendarEventType.FINANCING_DEADLINE]:  KernelEvent.FINANCING_DUE,
  [CalendarEventType.WALKTHROUGH]:         KernelEvent.WALKTHROUGH_DUE,
  [CalendarEventType.CLOSING]:             KernelEvent.CLOSING_SCHEDULED,
  [CalendarEventType.TASK_DUE]:            KernelEvent.TASK_DUE,
}

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
export async function checkUpcomingDeadlines(): Promise<void> {
  const supabase = await createClient()

  const now   = new Date()
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000)

  // ── Step 1: Query upcoming, unnotified calendar events ────────────────────
  const { data: events, error: fetchError } = await supabase
    .from('calendar_events')
    .select('id, brokerage_id, entity_type, entity_id, event_type, start_at, deadline_notified')
    .lte('start_at', in24h.toISOString())
    .eq('deadline_notified', false)

  if (fetchError) {
    throw new Error(`[calendar-deadline-watcher] Failed to query calendar_events: ${fetchError.message}`)
  }

  if (!events || events.length === 0) {
    return
  }

  const notifiedIds: string[] = []

  // ── Step 2: Emit one KernelEvent notification per calendar event ──────────
  for (const calEvent of events as CalendarEventRow[]) {
    const kernelEventType = CALENDAR_TYPE_TO_KERNEL_EVENT[calEvent.event_type]

    if (!kernelEventType) {
      console.error(
        `[calendar-deadline-watcher] Unknown event_type "${calEvent.event_type}" for calendar_event ${calEvent.id} — skipping`
      )
      continue
    }

    try {
      await processKernelEvent({
        event:       kernelEventType,
        brokerageId: calEvent.brokerage_id,
        entityType:  calEvent.entity_type,
        entityId:    calEvent.entity_id,
      })

      notifiedIds.push(calEvent.id)
    } catch (err) {
      console.error(
        `[calendar-deadline-watcher] processKernelEvent failed for calendar_event ${calEvent.id}:`,
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
