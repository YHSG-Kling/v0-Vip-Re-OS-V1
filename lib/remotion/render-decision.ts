/**
 * lib/remotion/render-decision.ts
 *
 * Wave 39 m172 — pure decision helpers shared by the generic render
 * endpoint (app/api/internal/remotion/render-composition), the
 * composition-render-queue cron, and the render simulator. Kept free of
 * @remotion/renderer, Chromium, and the DB so the whole dispatch contract
 * is unit-testable without egress.
 *
 * The split that matters: a composition is either a MOVING render
 * (renderMedia → mp4, runs through the coordinator's bookend + music
 * finalize) or a STILL (renderStill → png, no audio, no bookends). The
 * registry's duration_frames is the single source of truth — the
 * thumbnail / postcard / lead-magnet / newsletter-thumb compositions all
 * register at durationInFrames=1.
 */
import type { CompositionTier, RemotionCompositionRow } from "./registry"
import type { RenderIntent } from "./render-coordinator"

/** A composition with <=1 frame is a still card (renderStill → PNG):
 *  thumbnails, postcards, lead-magnet, newsletter-thumb. Everything
 *  longer is a moving render (renderMedia → MP4). */
export function isStillComposition(durationFrames: number): boolean {
  return durationFrames <= 1
}

/** Output content type for the artifact a composition produces. */
export function outputContentType(durationFrames: number): "image/png" | "video/mp4" {
  return isStillComposition(durationFrames) ? "image/png" : "video/mp4"
}

/** File extension for the artifact. */
export function outputExtension(durationFrames: number): "png" | "mp4" {
  return isStillComposition(durationFrames) ? "png" : "mp4"
}

/** THE ONE SPELLING of the pickable render_status (§6). The two SQL claims —
 *  app/api/internal/remotion/render-composition/route.ts (`queued → rendering`)
 *  and app/api/cron/composition-render-queue/route.ts (oldest queued first) —
 *  filter on this token; `isPickableStatus` is the same rule as a predicate for
 *  code that already holds a row. A status vocabulary change lands HERE and
 *  reaches both claims and the simulator together. */
export const PICKABLE_RENDER_STATUS = "queued" as const

/** Statuses the queue picker is allowed to claim. A render is pickable
 *  only while 'queued'; 'rendering' rows are in-flight, terminal rows
 *  (succeeded/failed/cancelled) are done. */
export function isPickableStatus(status: string): boolean {
  return status === PICKABLE_RENDER_STATUS
}

/** Bookends + music only ever apply to moving renders. A still has no
 *  audio track to mix under and no intro/outro to concat. The endpoint
 *  forces them off for stills regardless of the registry flag. */
export function shouldApplyBookends(composition: RemotionCompositionRow): boolean {
  if (isStillComposition(composition.duration_frames)) return false
  return composition.supports_bookends
}

/** A queued render row carries everything needed to reconstruct the
 *  RenderIntent the coordinator's finalizeCoordinatedRender expects.
 *  Pure — the endpoint resolves callerTier from the brokerage and hands
 *  it in. */
export interface QueuedRenderRow {
  brokerage_id:   string
  composition_id: string
  agent_user_id:  string | null
  entity_type:    string | null
  entity_id:      string | null
  scope_type:     "agent" | "team" | "brokerage"
  scope_id:       string | null
  input_props:    Record<string, unknown> | null
}

export function buildRenderIntent(
  row:        QueuedRenderRow,
  callerTier: CompositionTier,
): RenderIntent {
  return {
    brokerageId:  row.brokerage_id,
    callerTier,
    compositionId: row.composition_id,
    scopeType:    row.scope_type ?? "brokerage",
    scopeId:      row.scope_id ?? row.brokerage_id,
    agentUserId:  row.agent_user_id,
    entityType:   row.entity_type,
    entityId:     row.entity_id,
    // The Video Director stamps its per-situation music mood into input_props so
    // the coordinator picks a mood-matched licensed track (null = no preference).
    musicMood:    ((row.input_props as { music_mood?: unknown } | null)?.music_mood as string | undefined) ?? null,
  }
}

/** The props handed to selectComposition. Empty/absent → undefined so
 *  Remotion uses the registry defaultProps for that composition. */
export function resolveInputProps(
  inputProps: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!inputProps || Object.keys(inputProps).length === 0) return undefined
  return inputProps
}

/** A moving render gets a companion share/OG/AI-search thumbnail when the
 *  registry declares one (thumbnail_composition_id, e.g. VideoCoverThumb).
 *  Stills ARE the image — they never get a separate thumbnail pass. */
export function needsThumbnailPass(composition: RemotionCompositionRow): boolean {
  if (isStillComposition(composition.duration_frames)) return false
  return !!composition.thumbnail_composition_id
}

/** Thumbnail props are carried under input_props.thumbnail_props — the ONE key
 *  every producer stages the companion card on. The video's own props are NOT
 *  reused: the cover card has a different shape (kind / title / subtitle /
 *  eyebrow / seoHint).
 *
 *  ABSENT NO LONGER MEANS "USE THE DEFAULTS" (2026-09-03). This comment used to
 *  read "absent → undefined → the thumbnail composition's registry
 *  defaultProps", and that was the defect, not the design: Remotion merges `{}`
 *  over defaultProps, so a producer that staged nothing did not get a blank
 *  card, it got VideoCoverThumb's Studio fixture — "Just Listed — 123 Main
 *  Street", "$625K · 3 bd · 2 ba · Brickell, FL", "Your Agent" — published as
 *  the og:image and player poster of a real client's video. `undefined` is now
 *  the signal that the card is REFUSED: the companion pass in
 *  app/api/internal/remotion/render-composition asks missingContentProps about
 *  the thumbnail composition and skips the still rather than rendering the
 *  sample, and the producers stage a real card (gated by
 *  lib/geo/video-landing.ts companionCard) so there is one to render. */
export function resolveThumbnailProps(
  inputProps: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  const tp = inputProps?.thumbnail_props
  if (tp && typeof tp === "object" && Object.keys(tp as object).length > 0) {
    return tp as Record<string, unknown>
  }
  return undefined
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTONOMOUS FAILED-RENDER RE-QUEUE (wave 57)
// ═══════════════════════════════════════════════════════════════════════════
//
// THE GAP. `restart_failed_render` (m171, app/api/internal/remotion/render-
// composition/route.ts) already does the RIGHT thing — it refuses a "doomed"
// retry via missingContentProps rather than burning a render slot on a row
// that will fail the same way again — but the ONLY caller is
// executeAssetManagerAction, itself only reachable through
// approveAssetManagerAction (app/actions/asset-manager-resolutions.ts), a
// "use server" action a HUMAN calls from the dashboard
// (app/dashboard/admin/asset-manager-actions/client.tsx). A composition-
// render-queue drain never retries a failure on its own (its own header said
// so, verbatim, before this wave). Owner ruling: "this OS runs autonomous
// loops; every capability should run autonomously (manager signal / cron /
// kernel event) rather than waiting for a button." A render that failed on a
// transient cause (Chromium hiccup, a momentary stock-asset fetch failure)
// should not sit waiting for a broker to click "restart" in a dashboard they
// may not open for days.
//
// THE FIX. `shouldAutoRequeueFailedRender` is the SAME judgment
// `restart_failed_render` already makes (doomed retry → refuse; retries
// remaining + content-contract satisfied → requeue), reusable by a cron with
// no human in the loop. `MAX_AUTO_REQUEUE_ATTEMPTS` bounds it — the same
// "bounded, not infinite" shape app/api/cron/poll-did-videos/route.ts already
// uses for its own persist-retry loop (MAX_PERSIST_ATTEMPTS) — so a
// permanently-broken composition fails loudly after a handful of ticks rather
// than spinning forever; the row then still carries its `failed` status for a
// human (or the weekly Asset Manager digest) to see, exactly as before this
// wave for anything that exhausts its auto-retries.

/** How many times the autonomous loop will re-queue the SAME failed render
 *  row before leaving it `failed` for a human to look at. Small and bounded
 *  by design — see the header above. */
export const MAX_AUTO_REQUEUE_ATTEMPTS = 2

/** The minimal shape `shouldAutoRequeueFailedRender` needs from a
 *  `remotion_composition_renders` row. */
export interface FailedRenderRow {
  render_status: string
  /** NULL on a row from before this column existed — treated as 0 attempts. */
  retry_count:   number | null | undefined
}

export interface AutoRequeueDecision {
  requeue: boolean
  /** Human-readable reason, logged either way — a skip is not silent. */
  reason:  string
}

/**
 * Should the autonomous loop flip this failed render back to 'queued'?
 *
 * PURE — no DB, no fetch. The caller supplies `missingProps`
 * (missingContentProps(row.composition_id, row.input_props) — content-
 * contract.ts is DB-free but does its own registry lookup, which this
 * function stays free of so it is testable with a bare array).
 *
 * Refuses (never requeues) when:
 *   · the row is not actually `failed` (already requeued by someone else, or
 *     never failed at all — no-op, not an error);
 *   · MAX_AUTO_REQUEUE_ATTEMPTS is already spent;
 *   · the render is DOOMED — the same content the row failed with is still
 *     missing required props, so a retry fails the identical way.
 */
export function shouldAutoRequeueFailedRender(
  row: FailedRenderRow,
  missingProps: string[],
): AutoRequeueDecision {
  if (row.render_status !== "failed") {
    return { requeue: false, reason: `render is '${row.render_status}', not 'failed' — nothing to requeue` }
  }
  const attempts = row.retry_count ?? 0
  if (attempts >= MAX_AUTO_REQUEUE_ATTEMPTS) {
    return {
      requeue: false,
      reason: `already auto-retried ${attempts}/${MAX_AUTO_REQUEUE_ATTEMPTS} times — needs a human look, not another blind retry`,
    }
  }
  if (missingProps.length > 0) {
    return {
      requeue: false,
      reason: `doomed retry — still missing required content props (${missingProps.join(", ")}); requeueing would fail identically`,
    }
  }
  return { requeue: true, reason: `transient failure, content-contract satisfied, ${MAX_AUTO_REQUEUE_ATTEMPTS - attempts} auto-retr${MAX_AUTO_REQUEUE_ATTEMPTS - attempts === 1 ? "y" : "ies"} remaining` }
}
