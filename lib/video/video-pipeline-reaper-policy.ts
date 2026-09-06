// lib/video/video-pipeline-reaper-policy.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE policy for reaping STALE video-pipeline workflows. The Director-commissioned reel pipeline
// (commissionVideo → director-reel-render → poll-did-videos → render-composition → delivery) has
// non-terminal states that should always make progress within minutes. If one sits too long, the
// workflow stalled (D-ID never finished, a render died, the worker never picked it up) and a manager
// must own it instead of letting it fall through the cracks. This decides keep vs escalate by state +
// age. No I/O — unit-testable; the runner feeds it the live rows.

export type VideoReapAction = "keep" | "escalate"

// How long each non-terminal state may sit before it's considered STALLED.
// Tuned to the crons: director-reel-render + composition-render-queue run every 5m; poll-did-videos
// every 2m; a healthy D-ID talk finishes in ~3-5m.
export const VIDEO_STALE_HOURS: Record<string, number> = {
  // m374 renamed these onto the canonical vocabulary. The two thresholds are
  // kept apart on purpose: `queued` means the Director staged it and no worker
  // ever picked it up, `generating` means a provider has it and never finished.
  // Collapsing them would lose the reaper's ability to say which half broke —
  // which is the whole reason it escalates to a named manager.
  queued: 2,      // staged, but no render worker ever executed it (was remotion_pending)
  generating: 3,  // the job is in flight and never reported completion (was
                  // rendering too, which carried a 2h threshold — folding it in
                  // here costs that lane an hour before it escalates, and says
                  // "in flight" rather than "never picked up". Accepted and
                  // recorded rather than papered over.)
}

/** Non-terminal states that are BLOCKED on a human, not stalled — never reaped (already actioned). */
const BLOCKED_STATES = new Set(["awaiting_presenter_setup"])

/**
 * Re-exported so the many readers that already import it from this module keep
 * working. THE LIST ITSELF LIVES IN lib/video/video-status.ts — a second copy
 * here is precisely the drift m374 removed, and the reaper is a CONSUMER of the
 * vocabulary, not its owner.
 *
 * It is now ["completed","published"] rather than five tokens: ready,
 * video_ready and uploaded all collapsed into `completed`, and `distributed`
 * into `published`.
 */
export { VIDEO_FINISHED_STATUSES } from "./video-status"
import { VIDEO_FINISHED_STATUSES as FINISHED } from "./video-status"

/** Terminal states — never reaped. `error` is included because one writer
 *  (listing-promo-hybrid-composite) used to emit it instead of `failed`; it is
 *  kept here so any pre-existing row is not reaped as if it were still running. */
// `error` and `cancelled` were listed here because one writer emitted them
// instead of `failed`. m374 retired both spellings and the CHECK now refuses
// them, so the only terminal failure token is `failed`.
const TERMINAL_STATES = new Set<string>([...FINISHED, "failed"])

export interface VideoReapInput {
  status: string
  ageHours: number
}

/** PURE. Should this video-pipeline row be escalated as a stalled workflow? */
export function classifyStaleVideo(input: VideoReapInput): VideoReapAction {
  if (TERMINAL_STATES.has(input.status)) return "keep"
  if (BLOCKED_STATES.has(input.status)) return "keep"
  const threshold = VIDEO_STALE_HOURS[input.status]
  if (threshold === undefined) return "keep" // unknown non-terminal state — don't reap blindly
  return input.ageHours >= threshold ? "escalate" : "keep"
}
