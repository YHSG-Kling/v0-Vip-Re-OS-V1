// lib/property-alerts/alert-cadence.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE snooze predicate for the buyer property-alert engine. No I/O, no
// server-only — unit-testable and importable from anywhere.
//
// Moved here from lib/alerts/, the second alert engine this one absorbed. Only
// the snooze survived the merge: that module also carried a `shouldRunNow(frequency)`
// clock, a SECOND copy of the schedule already declared in CRON_REGISTRY
// (instant */15, daily 0 8, weekly 0 8 * * 1, twice_daily 0 8,17). Two places
// deciding when an alert is due is exactly the drift this consolidation removes —
// the registry is the one clock, and /api/property-alerts/run is called with the
// frequency it is due for.

/**
 * PURE. A buyer SNOOZE is a temporary mute that auto-resumes — while snoozed_until
 * is in the future the engine skips the search; once it passes, the search resumes
 * on its own (never deactivated, so the buyer doesn't have to remember to turn it
 * back on). NULL/empty/garbage = not snoozed: a bad value must never mute a search
 * forever.
 */
export function isSnoozed(snoozedUntil: string | null | undefined, now: Date = new Date()): boolean {
  if (!snoozedUntil) return false
  const t = new Date(snoozedUntil).getTime()
  return Number.isFinite(t) && t > now.getTime()
}
