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

/** Pure: business-hours (09:00–17:00) candidate slots in [start,end] minus overlapping busy. */
export function computeFreeSlots(
  busy: Array<{ start: number; end: number }>,
  params: FreeSlotParams,
): FreeSlot[] {
  const slots: FreeSlot[] = []
  const start = new Date(params.startDate)
  const end = new Date(params.endDate)
  const durMs = params.durationMinutes * 60_000
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    for (let hour = 9; hour < 17; hour++) {
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
