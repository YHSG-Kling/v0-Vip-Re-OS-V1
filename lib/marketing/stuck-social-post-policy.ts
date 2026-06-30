// ─── STUCK-SOCIAL-POST POLICY (Marketing Manager reaper) ─────────────────────
// Pure, import-free policy for the Marketing Manager's "a post that should have
// gone out didn't" failure. The publish-social-posts cron only picks status=
// 'scheduled' + approved + due (LIMIT 20) and never reaps orphans, so two real
// failure modes fall through it:
//   1. 'publishing' — the cron flipped the post to publishing then crashed / the
//      publish hung; it now sits forever (the cron only re-scans 'scheduled').
//   2. 'scheduled' — past its slot but never picked up (backlog, approval never
//      came, or the scheduler failed) so it silently missed its window.
// Pure → unit-testable (scripts/stuck-social-post-reaper-simulator.ts).

// A post mid-publish for longer than this is hung, not working.
export const PUBLISHING_STUCK_HOURS = 1
// A scheduled post this far past its slot has missed its window.
export const SCHEDULED_OVERDUE_HOURS = 2

// keep = fine; escalate = missed its window (notify); reap = reconcile a hung row.
export type StuckSocialPostAction = "keep" | "escalate" | "reap"

export interface StuckSocialPostInput {
  status: string | null | undefined
  scheduledFor: string | null | undefined
  /** updated_at — when it last changed state (used to age a 'publishing' hang). */
  updatedAt: string | null | undefined
  /** Caller passes "now" so the policy stays deterministic/testable. */
  now: Date
}

const ageHours = (iso: string | null | undefined, now: Date): number | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return (now.getTime() - t) / (60 * 60 * 1000)
}

export function classifyStuckSocialPost(input: StuckSocialPostInput): StuckSocialPostAction {
  const status = (input.status ?? "").toLowerCase().trim()

  // Hung mid-publish → reconcile (mark failed) so it doesn't sit publishing forever.
  if (status === "publishing") {
    const age = ageHours(input.updatedAt, input.now)
    return age !== null && age >= PUBLISHING_STUCK_HOURS ? "reap" : "keep"
  }

  // Scheduled but past its slot and never published → it missed its window.
  if (status === "scheduled") {
    const age = ageHours(input.scheduledFor, input.now)
    return age !== null && age >= SCHEDULED_OVERDUE_HOURS ? "escalate" : "keep"
  }

  // draft (not ready), published (done), failed/cancelled (terminal) → keep.
  return "keep"
}
