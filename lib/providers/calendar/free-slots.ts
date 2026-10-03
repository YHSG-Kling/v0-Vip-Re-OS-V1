// lib/providers/calendar/free-slots.ts
// Pure availability computation, extracted so it's unit-testable without the server-only
// calendar client. Given busy windows (epoch ms) + a requested window/duration, returns the
// open business-hours slots. Shared by personal-calendar (Google freeBusy / Graph events).

export interface FreeSlot {
  startTime: string // ISO 8601
  endTime: string   // ISO 8601
}

export interface FreeSlotParams {
  startDate: string
  endDate: string
  durationMinutes: number
}

/** Agent working-hours window (local clock hours, 0-23). Defaults to 09:00-17:00 —
 *  the same window this module has always used — when no override is supplied. */
export interface WorkingHours {
  startHour: number
  endHour: number
}

export const DEFAULT_WORKING_HOURS: WorkingHours = { startHour: 9, endHour: 17 }

/** Pure: business-hours candidate slots in [start,end] minus overlapping busy.
 *  `hours` overrides the default 09:00-17:00 window (lib/ai-isa/listing-appointment.ts
 *  reads it from the agent's ai_identity_profiles.business_hours cascade); every
 *  existing caller that omits it keeps the exact behavior it always had. */
export function computeFreeSlots(
  busy: Array<{ start: number; end: number }>,
  params: FreeSlotParams,
  hours: WorkingHours = DEFAULT_WORKING_HOURS,
): FreeSlot[] {
  const slots: FreeSlot[] = []
  const start = new Date(params.startDate)
  const end = new Date(params.endDate)
  const durMs = params.durationMinutes * 60_000
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    for (let hour = hours.startHour; hour < hours.endHour; hour++) {
      const s = new Date(d); s.setHours(hour, 0, 0, 0)
      const e = new Date(s.getTime() + durMs)
      const sMs = s.getTime(), eMs = e.getTime()
      if (sMs < start.getTime() || eMs > end.getTime()) continue
      const overlaps = busy.some((b) => sMs < b.end && eMs > b.start)
      if (!overlaps) slots.push({ startTime: s.toISOString(), endTime: e.toISOString() })
    }
  }
  return slots
}
