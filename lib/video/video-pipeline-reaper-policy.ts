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
  remotion_pending: 2,   // Director staged it but the render worker never executed it
  generating: 3,         // D-ID job submitted but poll-did-videos never saw it complete
  rendering: 2,          // composite enqueued but render-composition never finished it
}

/** Non-terminal states that are BLOCKED on a human, not stalled — never reaped (already actioned). */
const BLOCKED_STATES = new Set(["awaiting_presenter_setup"])

/**
 * A FINISHED video — one that exists and can be played, picked, counted or
 * distributed. This is the set every "show me the finished videos" reader must
 * use, and it is exported so those readers cannot each keep their own list.
 *
 * WHY IT IS NOT JUST "completed": the pipeline writes four different tokens for
 * work that is genuinely done, and readers that hard-coded `completed` made the
 * other three invisible.
 *   · published / distributed are POST-terminal — they happen AFTER completed.
 *     Filtering on `completed` alone meant a successful distribution DELETED the
 *     video from every gallery and picker: lib/kernel/video.ts writes
 *     'distributed' on success, and the row instantly stopped matching. Success
 *     caused the asset to vanish.
 *   · uploaded is a manual upload that already carries a real video_url — the
 *     agent's own finished file, refused by the distribute gate with "not yet
 *     completed" seconds after they uploaded it.
 *   · ready is the poll-status lane's success token.
 *
 * Deliberately EXCLUDES audio_ready (a slideshow mid-phase, not a video) and
 * every non-terminal state.
 */
export const VIDEO_FINISHED_STATUSES = [
  "completed",
  "ready",
  "uploaded",
  "published",
  "distributed",
] as const

/** Terminal states — never reaped. `error` is included because one writer
 *  (listing-promo-hybrid-composite) used to emit it instead of `failed`; it is
 *  kept here so any pre-existing row is not reaped as if it were still running. */
const TERMINAL_STATES = new Set<string>([
  ...VIDEO_FINISHED_STATUSES,
  "failed",
  "error",
  "cancelled",
])

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
