// ─── CADENCE POLICY (pure "does this subscription fire today?") ──────────────
// Shared by the content auto-cadence ticks (blog, newsletter). A subscription fires
// weekly/biweekly/monthly on a chosen fire_day; the daily tick asks this per policy.
// Pure → unit-testable, no I/O.

export interface CadenceFireInput {
  cadence: string | null            // 'weekly' | 'biweekly' | 'monthly' | 'off'
  fireDay: number | null            // weekly/biweekly: day-of-week 0..6 (Sun=0); monthly: day-of-month 1..31
  skippedUntil?: string | null      // ISO date — paused through this date (inclusive)
  now: Date
}

/**
 * Should a cadence subscription produce content today?
 *   • 'off' or no fire_day → never.
 *   • paused (skipped_until >= today) → never.
 *   • weekly  → fire_day === today's day-of-week.
 *   • biweekly → fire_day === today's day-of-week AND an even ISO-week (so it lands every OTHER week).
 *   • monthly → fire_day === today's day-of-month.
 * Uses UTC consistently (the ticks run on a UTC schedule).
 */
export function shouldFireCadenceToday(input: CadenceFireInput): boolean {
  const cadence = (input.cadence ?? "off").toLowerCase()
  if (cadence === "off" || input.fireDay == null) return false

  // Paused window — skipped_until is inclusive.
  if (input.skippedUntil) {
    const today = input.now.toISOString().slice(0, 10)
    if (input.skippedUntil >= today) return false
  }

  const dow = input.now.getUTCDay()          // 0..6
  const dom = input.now.getUTCDate()         // 1..31

  if (cadence === "weekly") return input.fireDay === dow
  if (cadence === "monthly") return input.fireDay === dom
  if (cadence === "biweekly") {
    if (input.fireDay !== dow) return false
    return isoWeekNumber(input.now) % 2 === 0 // every other week
  }
  return false
}

/** ISO-8601 week number (1..53), UTC. */
export function isoWeekNumber(d: Date): number {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNum = (date.getUTCDay() + 6) % 7 // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3) // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4))
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3)
  return 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000))
}
