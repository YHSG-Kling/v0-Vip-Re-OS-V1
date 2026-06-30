// lib/sphere/lifetime-touchpoint-reaper-policy.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE policy for the LIFETIME-TOUCHPOINT reaper. The post-close retention sequence inserts future
// lifetime_customer_touchpoints rows at status='scheduled' (3-day / 30-day / 6-month), but the daily
// lifetime cron delivers by DATE-COMPUTATION (anniversary / birthday / referral windows) and never reads
// those scheduled rows — so a scheduled touch can pass its date and sit 'scheduled' forever, unmanaged
// (the 6-month check-in in particular has no delivery path). That's the "stale, alone, not managed by a
// manager" pattern the rest of the system reaps (manager_signals, video, workflow_runs, stranded offers).
//
// This reaper, owned by the Sphere Manager, sweeps scheduled touchpoints whose date passed (beyond a
// short grace) and reconciles them: marks the row resolved and surfaces the MISS to the responsible
// agent so a past client's sequence never stalls silently. Pure + unit-tested; the runner does the I/O.

export const STALE_TOUCHPOINT_GRACE_DAYS = 3

export interface StuckTouchpointInput {
  status: string
  scheduledDate: string | null
  now: number
}

export type StuckTouchpointAction = "reap" | "keep"

/** PURE. A still-'scheduled' touchpoint whose scheduled_date passed by more than the grace window never
 *  got delivered → reap (reconcile + surface). Everything else (already sent/skipped, or not yet due /
 *  within grace) is kept. */
export function classifyStuckTouchpoint(i: StuckTouchpointInput): StuckTouchpointAction {
  if (i.status !== "scheduled") return "keep"
  if (!i.scheduledDate) return "keep"
  const dueMs = new Date(i.scheduledDate).getTime()
  const graceMs = STALE_TOUCHPOINT_GRACE_DAYS * 86_400_000
  return i.now - dueMs > graceMs ? "reap" : "keep"
}
