/**
 * lib/remotion/render-escalation.ts — A RENDER THAT FAILED IS OWNED THE MOMENT IT FAILS
 * (wave 142, lane 142F; owner: cron is a backup, never the primary way an urgent error is found).
 *
 * What already existed, and is NOT duplicated here: the row's `failed` stamp + error_message
 * (lib/remotion/registry.ts recordRenderCompleted), the bounded auto-requeue on the next
 * composition-render-queue tick (lib/remotion/render-decision.ts shouldAutoRequeueFailedRender),
 * the OS-health detector that turns failed renders into incidents on ITS sweep
 * (lib/kernel/os-health.ts media_render_failures → self-healing re_render / notify_owner_manager).
 * All of those are clocks. This is the IMMEDIATE hand-off: classify the failure
 * (render-failure-census.ts) and, for the class that would otherwise have been reported as
 * SUCCESS — an output the host refused as unplayable — raise a manager signal to the Asset
 * Manager (the registered owner of remotion_composition_renders) in the same request, so the
 * feed shows it before any cron runs. Deduped per open (asset_manager, type, render id) by
 * publishManagerSignal itself. Best-effort: never throws into a completion path.
 */
import { classifyRenderFailure } from "./render-failure-census"

/** Catalogued in lib/kernel/signal-registry.ts; classifyCoordination → "escalation".
 * @proofSeam scripts/video-pipeline-truth-guard.ts asserts the type is catalogued, feed-only and classifies as an escalation. */
export const RENDER_UNPLAYABLE_SIGNAL = "render_unplayable_escalated"

interface RenderEscalationArgs {
  brokerageId: string
  renderId: string
  compositionId: string
  error: string
}

interface RenderEscalationOutcome {
  bucket: string
  escalated: boolean
  reason?: string
}

export async function escalateRenderFailure(svc: any, args: RenderEscalationArgs): Promise<RenderEscalationOutcome> {
  const c = classifyRenderFailure(args.error)
  if (c.bucket !== "unplayable_output") return { bucket: c.bucket, escalated: false, reason: "not an unplayable-output failure — the queue's bounded retry and the OS-health sweep own it" }
  try {
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    const published = await publishManagerSignal({
      brokerageId: args.brokerageId,
      fromManager: "cron_manager",
      toManager:   "asset_manager",
      signalType:  RENDER_UNPLAYABLE_SIGNAL,
      message:     `Render ${args.compositionId} produced an output a player cannot open — it was marked failed, not succeeded. ${args.error.slice(0, 240)}`,
      entityType:  "remotion_composition_render",
      entityId:    args.renderId,
      payload:     { composition_id: args.compositionId, bucket: c.bucket, root_cause: c.signature?.rootCause ?? null, fix: c.signature?.fix ?? null },
    }, svc)
    return { bucket: c.bucket, escalated: published.ok, reason: published.ok ? undefined : published.reason }
  } catch (e) {
    return { bucket: c.bucket, escalated: false, reason: (e as Error).message }
  }
}
