// lib/video/video-status.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE VOCABULARY FOR ai_video_projects.status.
//
// The column had NO CHECK constraint and 22 distinct values written or read
// across the codebase. That is not a vocabulary, it is 22 private opinions, and
// the cost was not cosmetic — a reader and a writer that disagree is a feature
// that silently does nothing:
//
//   · FOUR values were READ by filters that NOTHING ever writes —
//     video_ready, script_generating, script_ready, submitting.
//     VideosDashboard's "Recent Videos" panel filters
//     .eq("status","video_ready"), so it was permanently, structurally empty.
//     Not "empty because pre-launch" — empty forever, for every brokerage.
//     (An earlier draft of this header listed awaiting_provider as a fifth.
//     That was wrong: avatar-explainer.ts DID write it. Corrected rather than
//     left standing, because a header that miscounts the evidence is the same
//     class of defect as the drift it documents.)
//
//   · FIVE values all meant "this video is finished" — completed, ready,
//     uploaded, published, distributed — so a reader that hard-coded one made
//     the other four invisible. The worst was `distributed`: succeeding at
//     distribution removed the video from every gallery and picker.
//
//   · Three spellings meant "not started yet" (draft/pending/setup/planning)
//     and three meant "in flight" (generating/rendering/submitting).
//
// This module is the single source. The CHECK constraint added in m374 refuses
// anything outside CANONICAL_VIDEO_STATUSES at the database, so a new private
// spelling can no longer be introduced by a writer that never told a reader.
//
// ── WHY NINE AND NOT EIGHT ───────────────────────────────────────────────────
// Two distinctions look mergeable and are not:
//
//   awaiting_presenter_setup is BLOCKED ON A HUMAN, not stalled. The reaper
//   keeps it deliberately (BLOCKED_STATES in video-pipeline-reaper-policy).
//   Folding it into `queued` would make the reaper escalate a row that is
//   correctly waiting for someone to configure a presenter.
//
//   queued vs generating are different FAILURE MODES with different stale
//   thresholds — `queued` (2h) means staged but no worker ever picked it up,
//   `generating` (3h) means a provider has it and never finished. Collapsing
//   them would throw away the reaper's ability to say which half broke.
//
// Rounder numbers were available. They were not true.

/** Every value ai_video_projects.status may hold. Mirrored by the m374 CHECK. */
export const CANONICAL_VIDEO_STATUSES = [
  "draft",
  "scripting",
  "script_ready",
  "queued",
  "generating",
  "awaiting_presenter_setup",
  "completed",
  "published",
  "failed",
] as const

export type CanonicalVideoStatus = (typeof CANONICAL_VIDEO_STATUSES)[number]

export function isCanonicalVideoStatus(v: string): v is CanonicalVideoStatus {
  return (CANONICAL_VIDEO_STATUSES as readonly string[]).includes(v)
}

/**
 * Retired spelling → the canonical value that replaced it.
 *
 * Kept as code rather than deleted so the mapping is auditable and so anything
 * reading a historic export or an external mirror can still be normalised.
 * ai_video_projects held ZERO rows when this landed (verified against the live
 * database), so no backfill was required — but this table is what makes that
 * claim checkable instead of asserted.
 */
export const RETIRED_VIDEO_STATUS: Record<string, CanonicalVideoStatus> = {
  // ── all meant "created, nothing started" ──
  pending:  "draft",
  setup:    "draft",
  planning: "draft",

  // ── the script lane ──
  script_generating: "scripting",

  // ── staged for a render worker ──
  remotion_pending: "queued",

  // ── in flight at a provider ──
  rendering:         "generating",
  submitting:        "generating",
  awaiting_provider: "generating",
  // audio_ready was a slideshow MID-phase: the voiceover exists, the video does
  // not. It was excluded from the finished set for exactly that reason, and it
  // had no stale threshold at all, so a slideshow stuck here was never reaped.
  audio_ready:       "generating",

  // ── finished, an asset exists ──
  ready:       "completed",
  video_ready: "completed",
  uploaded:    "completed",
  // preview_ready was only ever COMPARED against, never written — the videos
  // board tested `status === "preview_ready"` and its own mapStatusToColumn
  // already bucketed it alongside completed/ready/uploaded. It is listed here
  // for auditability, but deliberately has NO entry in the m374 SQL backfill:
  // no writer ever persisted it, so there is nothing in the column to migrate.
  // (`preview_ready` still exists in that page as a display COLUMN id, which is
  // a different thing from a status value and is left alone.)
  preview_ready: "completed",

  // ── finished AND sent out ──
  distributed: "published",

  // ── terminal failure ──
  error:     "failed",
  cancelled: "failed",
}

/** Normalise any historic value. Unknown input is returned unchanged. */
export function normalizeVideoStatus(v: string): string {
  return RETIRED_VIDEO_STATUS[v] ?? v
}

/**
 * A FINISHED video — one that exists and can be played, picked, counted or
 * distributed. Every "show me the finished videos" reader must use this, so
 * they cannot each keep a private list again.
 *
 * `published` is POST-terminal: it happens AFTER completed and still means the
 * asset exists, which is why filtering on `completed` alone used to make a
 * successful distribution delete the video from its own gallery.
 */
export const VIDEO_FINISHED_STATUSES = ["completed", "published"] as const

/** Terminal — the pipeline will not move this row again. */
export const VIDEO_TERMINAL_STATUSES = [...VIDEO_FINISHED_STATUSES, "failed"] as const

/** In flight — work is happening or waiting to happen. */
export const VIDEO_IN_PROGRESS_STATUSES = [
  "scripting",
  "script_ready",
  "queued",
  "generating",
] as const
