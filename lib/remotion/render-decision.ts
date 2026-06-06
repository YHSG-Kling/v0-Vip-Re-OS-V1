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

/** Statuses the queue picker is allowed to claim. A render is pickable
 *  only while 'queued'; 'rendering' rows are in-flight, terminal rows
 *  (succeeded/failed/cancelled) are done. */
export function isPickableStatus(status: string): boolean {
  return status === "queued"
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
