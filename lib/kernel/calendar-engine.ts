// lib/kernel/calendar-engine.ts
// Inserts calendar events into the calendar_events table.
// Named exports only — no default exports.

import { createClient } from '@/lib/supabase/server'
import type { KernelCalendarEvent } from './calendar-types'

// Postgres unique-constraint violation error code
const PG_UNIQUE_VIOLATION = '23505'

export async function emitCalendarEvent(event: KernelCalendarEvent): Promise<void> {
  const supabase = await createClient()

  const payload = {
    brokerage_id:         event.brokerageId,
    entity_type:          event.entityType,
    entity_id:            event.entityId,
    event_type:           event.eventType,
    start_at:             event.startAt.toISOString(),
    end_at:               event.endAt?.toISOString() ?? null,
    timezone_name:        event.timezoneName,
    is_system_generated:  event.isSystemGenerated,
    metadata:             event.metadata ?? {},
    deadline_notified:    false,
  }

  const { error } = await supabase
    .from('calendar_events')
    .insert(payload)

  if (error) {
    if (error.code === PG_UNIQUE_VIOLATION) {
      // System-generated duplicates are expected (idempotent re-runs) — swallow silently
      if (event.isSystemGenerated) return
      // Manual duplicates are a user error — surface it
      throw new Error('Duplicate manual calendar event')
    }
    throw error
  }
}
