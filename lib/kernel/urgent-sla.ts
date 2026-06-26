// lib/kernel/urgent-sla.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE URGENT-NUDGE SLA — owner's rule: anything URGENT and time-critical must be acted on within
// 6 HOURS, never left for a day. This is the policy floor for time-sensitive escalations (a hot
// new-listing match a buyer hasn't been told about, an acute recovery call, etc.). It is a NUDGE
// DELAY cap — how fast we ACT once something urgent is detected — NOT a detection lookback window
// (don't apply it to "how recent must the event be to qualify"). PURE, no I/O.

/** Urgent things get acted on within this many hours — the owner's hard ceiling. */
export const URGENT_NUDGE_MAX_HOURS = 6

/** Whole/fractional hours between an ISO timestamp and `now` (0 when missing/invalid). */
export function hoursSince(iso: string | null | undefined, now: Date): number {
  if (!iso) return 0
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return 0
  return Math.max(0, (now.getTime() - t) / 3_600_000)
}

/**
 * urgentSlaBreached — PURE. True once an urgent item proposed/created at `sinceIso` has gone
 * unactioned past the 6-hour ceiling. `maxHours` overridable for tighter-still SLAs.
 */
export function urgentSlaBreached(
  sinceIso: string | null | undefined,
  now: Date,
  maxHours: number = URGENT_NUDGE_MAX_HOURS,
): boolean {
  if (!sinceIso) return false
  return hoursSince(sinceIso, now) > maxHours
}
