// lib/alerts/alert-cadence.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE cadence + snooze predicates for the buyer alert engine. No I/O, no server-only — unit-testable
// and importable from anywhere. The engine (alert-engine.ts) re-exports these and applies them.

/** PURE. Returns true if an alert should run based on its frequency and the current time (UTC). */
export function shouldRunNow(frequency: string, now: Date = new Date()): boolean {
  const hour = now.getUTCHours()
  const day  = now.getUTCDay() // 0 = Sunday, 1 = Monday

  switch (frequency) {
    case "instant":     return true
    case "twice_daily": return hour === 8 || hour === 17
    case "daily":       return hour === 8
    case "weekly":      return day === 1 && hour === 8
    default:            return false
  }
}

/**
 * PURE. A buyer SNOOZE is a temporary mute that auto-resumes — while snoozed_until is in the future
 * the engine skips the search; once it passes, the search resumes on its own (never deactivated).
 * NULL/empty/garbage = not snoozed (a bad value must never mute a search forever).
 */
export function isSnoozed(snoozedUntil: string | null | undefined, now: Date = new Date()): boolean {
  if (!snoozedUntil) return false
  const t = new Date(snoozedUntil).getTime()
  return Number.isFinite(t) && t > now.getTime()
}
