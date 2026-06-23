/**
 * lib/newsletter/schedule-time.ts — PURE newsletter schedule-time validation.
 *
 * Deterministic, NO I/O. Normalizes a requested send time (Date or the raw
 * string from an <input type="datetime-local">) and decides whether it is a
 * valid future send. Extracted here so it powers BOTH:
 *   1. the client-side gate on the newsletter wizard's "Schedule Send" control
 *      (disable + inline reason before the round-trip), and
 *   2. the `scheduleNewsletter` server action's authoritative future-time check
 *      before it writes the governed newsletter_scheduled_sends row.
 *
 * A "use server" file may only export async functions, so this pure fn, its
 * types, and the lead-time constant live in this plain module.
 */

/** Minimum lead time (ms) a scheduled send must sit in the future. 0 ⇒ any
 *  strictly-future instant is valid (matches the action's `<= now` reject). */
export const MIN_SCHEDULE_LEAD_MS = 0

export interface ScheduleTimeResult {
  /** True when the requested time is a valid, strictly-future instant. */
  valid: boolean
  /** Canonical ISO-8601 string for the requested time (UTC), when parseable. */
  iso: string | null
  /** Parsed Date, when the input parsed to a real instant; else null. */
  date: Date | null
  /** Human-readable reason when invalid (empty string when valid). */
  reason: string
}

/**
 * Validate + normalize a requested newsletter send time against `now`.
 *
 * Accepts a Date or a string (e.g. the value of an <input type="datetime-local">
 * such as "2026-07-01T09:30"). Returns the canonical ISO string plus a
 * valid/reason verdict. Pure: same inputs always yield the same result.
 *
 * @param input requested send time (Date or parseable string)
 * @param now   the reference "current" instant (defaults to new Date())
 */
export function validateScheduleTime(
  input: Date | string,
  now: Date = new Date(),
): ScheduleTimeResult {
  if (input === '' || input == null) {
    return { valid: false, iso: null, date: null, reason: 'Pick a send date and time' }
  }

  const date = input instanceof Date ? input : new Date(input)
  const ms = date.getTime()

  if (Number.isNaN(ms)) {
    return { valid: false, iso: null, date: null, reason: 'Invalid date or time' }
  }

  const iso = date.toISOString()

  if (ms <= now.getTime() + MIN_SCHEDULE_LEAD_MS) {
    return { valid: false, iso, date, reason: 'Send time must be in the future' }
  }

  return { valid: true, iso, date, reason: '' }
}
