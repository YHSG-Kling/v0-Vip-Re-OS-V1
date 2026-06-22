/**
 * Pure helpers for the ISA "Book Appointment" form.
 *
 * No 'use server' here on purpose — these are synchronous pure functions shared
 * between the client dialog and the simulator. A "use server" file may only
 * export async functions, so form types/consts/validation live in this module.
 */

export const APPOINTMENT_TYPES = [
  { value: 'buyer_consult', label: 'Buyer Consultation', defaultMinutes: 45 },
  { value: 'listing_appt', label: 'Listing Appointment', defaultMinutes: 60 },
  { value: 'showing', label: 'Property Showing', defaultMinutes: 30 },
  { value: 'phone_followup', label: 'Phone Follow-up', defaultMinutes: 20 },
] as const

export type AppointmentTypeValue = (typeof APPOINTMENT_TYPES)[number]['value']

export function defaultDurationMinutes(type: string): number {
  const found = APPOINTMENT_TYPES.find((t) => t.value === type)
  return found?.defaultMinutes ?? 30
}

export function labelForType(type: string): string {
  return APPOINTMENT_TYPES.find((t) => t.value === type)?.label ?? type
}

/**
 * Resolve the browser timezone name, falling back to UTC where Intl is
 * unavailable (e.g. server-side rendering before hydration).
 */
export function resolveTimezoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

export type AppointmentTimes = {
  startAt: string // ISO string
  endAt: string // ISO string
}

export type AppointmentValidation =
  | { ok: true; times: AppointmentTimes }
  | { ok: false; error: string }

/**
 * Validate a datetime-local form value + appointment type and produce the
 * ISO start/end pair the server action expects.
 *
 * @param localValue value from an <input type="datetime-local"> (no tz suffix)
 * @param type appointment type value
 * @param now reference "current" time (injectable for deterministic tests)
 */
export function buildAppointmentTimes(
  localValue: string,
  type: string,
  now: Date = new Date(),
): AppointmentValidation {
  if (!localValue || !localValue.trim()) {
    return { ok: false, error: 'Please choose a date and time' }
  }

  const start = new Date(localValue)
  if (Number.isNaN(start.getTime())) {
    return { ok: false, error: 'Invalid date/time' }
  }

  if (start.getTime() <= now.getTime()) {
    return { ok: false, error: 'Appointment must be in the future' }
  }

  const minutes = defaultDurationMinutes(type)
  const end = new Date(start.getTime() + minutes * 60_000)

  return {
    ok: true,
    times: { startAt: start.toISOString(), endAt: end.toISOString() },
  }
}
