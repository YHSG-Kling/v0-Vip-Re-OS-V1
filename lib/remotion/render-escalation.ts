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
import { MAX_AUTO_REQUEUE_ATTEMPTS } from "./render-decision"
import { presentTenantMessage } from "@/lib/errors"

/**
 * WHAT A TENANT READS ABOUT A FAILED OR CANCELLED RENDER (wave 153, lane 153J) — PURE.
 *
 * The brokerage-admin composition library printed each row's raw error_message in red monospace: storage paths carrying
 * the tenant id, bucket names, webpack / ffmpeg / Chromium strings, the census tokens. That is the opposite of the
 * tenant-facing message contract (lib/errors/index.ts presentTenantMessage). This maps the SAME census classification the
 * queue acts on to what happened · why in plain words · whether it will be retried (only when the bounded requeue will
 * TRUE: a transient class with retries left) · who acts next · ONE action · a short reference. The raw text stays on the
 * row for platform staff; it never leaves the server for the tenant.
 */
type CensusBucket = ReturnType<typeof classifyRenderFailure>["bucket"]
const OUR_SIDE = "the rendering service hit a problem on our side"
const RENDER_FAILURE_CAUSE: Partial<Record<CensusBucket, string>> = {
  render_stalled:      "the render ran longer than the rendering service allows",
  function_timeout:    "the render ran longer than the rendering service allows",
  memory:              "the render ran out of room on the rendering service",
  asset_load_timeout:  "one of its photos or clips took too long to load",
  media_decode:        "one of its photos or clips could not be opened",
  browser_network:     "a design resource it uses could not be reached",
  unplayable_output:   "the finished file did not pass the playback check, so it was not published",
  host_refused:        "the finished file could not be stored",
  content_contract:    "some details the video needs were missing, and nothing was made up in their place",
  not_renderable:      "this template is not available for this account",
  provider:            "the voice or presenter service did not respond as expected",
}

export function presentRenderFailure(row: {
  id: string
  render_status: string | null
  error_message: string | null
  retry_count: number | null
}): { sentence: string; referenceId: string | null } | null {
  if (row.render_status !== "failed" && row.render_status !== "cancelled") return null
  const c = classifyRenderFailure(row.error_message)
  const cause = RENDER_FAILURE_CAUSE[c.bucket] ?? OUR_SIDE
  const transient = (c.signature?.retry ?? "transient") === "transient"
  const retrying = row.render_status === "failed" && transient && (row.retry_count ?? 0) < MAX_AUTO_REQUEUE_ATTEMPTS
  const fixable = c.bucket === "content_contract" ? "Add the missing details and request the video again"
    : c.bucket === "media_decode" || c.bucket === "asset_load_timeout" ? "Replace the photo or clip and request the video again"
    : c.bucket === "not_renderable" ? "Choose another template"
    : null
  const m = presentTenantMessage({
    what: row.render_status === "cancelled" ? "This video was not made" : "This video didn't finish",
    affects: `It stopped because ${cause}`,
    work: retrying ? { state: "retrying", retryRef: row.id } : null,
    next: fixable ? "you" : "platform_support",
    action: retrying ? { label: "Check back in a few minutes" } : { label: fixable ?? "Request the video again" },
    referenceId: row.id,
  })
  return { sentence: m.sentence, referenceId: m.referenceId }
}

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
