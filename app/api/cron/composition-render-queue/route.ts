/**
 * app/api/cron/composition-render-queue/route.ts
 *
 * Wave 39 m172 — drains the generic Remotion render queue. The Asset
 * Manager's start_render / restart_failed_render actions (m171) and the
 * W40 ad creator claim remotion_composition_renders rows in 'queued'
 * state; this cron sweeps them and POSTs each to the generic render
 * endpoint (render-composition), which renders ANY registered
 * composition.
 *
 * Mirrors listing-promo-render: one row per tick, serialized — concurrent
 * renders would compete for the same Chromium / ffmpeg memory pool on a
 * single Vercel function instance.
 *
 * AUTONOMOUS FAILED-RENDER RE-QUEUE (wave 57 — owner ruling "this OS runs
 * autonomous loops... rather than waiting for a button"). Before this wave a
 * failed render sat at 'failed' until a human clicked restart_failed_render
 * in the Asset Manager dashboard — this cron never retried a failure on its
 * own. It now also re-queues a BOUNDED number of 'failed' rows itself, using
 * the SAME doomed-retry judgment restart_failed_render already makes
 * (lib/remotion/render-decision.ts shouldAutoRequeueFailedRender +
 * lib/remotion/content-contract.ts missingContentProps) so a transient
 * failure heals itself while a render that is missing required content still
 * waits for a human to supply it. See m622-composition-render-retry-count.sql
 * for the column this bounds on.
 *
 * Auth: CRON_SECRET.
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { PICKABLE_RENDER_STATUS, shouldAutoRequeueFailedRender } from "@/lib/remotion/render-decision"

export const dynamic = "force-dynamic"
export const maxDuration = 300
export const runtime = "nodejs"

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

export async function GET(req: NextRequest) {
  const headerSecret = req.headers.get("authorization")?.replace("Bearer ", "")
  const querySecret  = new URL(req.url).searchParams.get("secret")
  const expected     = process.env.CRON_SECRET
  if (!expected) return NextResponse.json({ skipped: "CRON_SECRET not configured" })
  if (headerSecret !== expected && querySecret !== expected) return unauthorized()

  const svc = createServiceClient()

  // Determinism sweep (m310) — this is the video-ops cron, so it is where the
  // Asset Manager learns that a composition can never reuse a render. Runs
  // whether or not there is a queued row, because a leak is a standing
  // condition and an empty queue is when the tick has time for it. Never
  // throws; a sweep failure must not stop the queue from draining.
  const { sweepDeterminismLeaks } = await import("@/lib/remotion/render-cache")
  const leakSweep = await sweepDeterminismLeaks({ limit: 200 })

  // LIVING-VIDEO REFRESH (m312) — a delivered video whose facts have moved is a
  // video that now says something untrue. Runs BEFORE the queue drain so a
  // refresh staged this tick is picked up on the next one. Cheap by design: a
  // few indexed reads per living video and an early exit on an unchanged key,
  // so the steady state finds nothing and costs nothing. Never throws.
  const { refreshLivingVideos } = await import("@/lib/video/living-video-sweep")
  const livingRefresh = await refreshLivingVideos({ limit: 200 })

  // AUTONOMOUS FAILED-RENDER RE-QUEUE (wave 57) — see this file's header.
  // Best-effort and wrapped whole: `retry_count` (m622) may not exist yet on
  // an environment where that migration has not been applied, and a missing
  // column must degrade this loop to a no-op, never break the queue drain
  // beneath it (§4 fail closed — but closed on THIS step, not the cron).
  const autoRequeue: { requeued: Array<{ id: string; reason: string }>; skipped: Array<{ id: string; reason: string }> } =
    { requeued: [], skipped: [] }
  try {
    const { data: failedRows } = await svc.from("remotion_composition_renders")
      .select("id, composition_id, render_status, retry_count, input_props")
      .eq("render_status", "failed")
      .order("created_at", { ascending: true })
      .limit(5)
    if (failedRows && failedRows.length > 0) {
      const { missingContentProps } = await import("@/lib/remotion/content-contract")
      for (const f of failedRows as Array<{
        id: string; composition_id: string; render_status: string;
        retry_count: number | null; input_props: Record<string, unknown> | null
      }>) {
        const missing = missingContentProps(f.composition_id, f.input_props ?? {})
        const decision = shouldAutoRequeueFailedRender(f, missing)
        if (!decision.requeue) {
          autoRequeue.skipped.push({ id: f.id, reason: decision.reason })
          continue
        }
        // Guard the flip with .eq("render_status","failed") so a row the Asset
        // Manager (or another tick) already claimed cannot be double-requeued —
        // the update simply matches zero rows in that race, which is fine.
        const { data: updated, error: rqErr } = await svc
          .from("remotion_composition_renders")
          .update({ render_status: "queued", retry_count: (f.retry_count ?? 0) + 1, error_message: null })
          .eq("id", f.id)
          .eq("render_status", "failed")
          .select("id")
        if (rqErr) {
          console.error(`[composition-render-queue] auto-requeue failed for ${f.id}: ${rqErr.message}`)
          autoRequeue.skipped.push({ id: f.id, reason: `update refused: ${rqErr.message}` })
        } else if (!updated || updated.length === 0) {
          autoRequeue.skipped.push({ id: f.id, reason: "already claimed by another tick/action" })
        } else {
          autoRequeue.requeued.push({ id: f.id, reason: decision.reason })
        }
      }
    }
  } catch (e) {
    console.error("[composition-render-queue] auto-requeue sweep failed (degrading to no-op):", (e as Error).message)
  }

  // Oldest queued row first (idx_remotion_renders_queued covers this).
  const { data: rows, error } = await svc.from("remotion_composition_renders")
    .select("id, composition_id, brokerage_id")
    .eq("render_status", PICKABLE_RENDER_STATUS)
    .order("created_at", { ascending: true })
    .limit(1)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!rows || rows.length === 0) {
    return NextResponse.json({
      ran_at: new Date().toISOString(), processed: 0,
      leak_sweep: leakSweep, living_refresh: livingRefresh, auto_requeue: autoRequeue,
    })
  }

  const row = rows[0] as { id: string; composition_id: string; brokerage_id: string }

  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000")

  try {
    const r = await fetch(`${baseUrl}/api/internal/remotion/render-composition`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${expected}`,
      },
      body: JSON.stringify({ render_id: row.id }),
    })
    const renderBody = await r.json().catch(() => ({}))
    return NextResponse.json({
      ran_at:         new Date().toISOString(),
      processed:      1,
      render_id:      row.id,
      composition_id: row.composition_id,
      render_status:  r.status,
      render_body:    renderBody,
      leak_sweep:     leakSweep,
      living_refresh: livingRefresh,
      auto_requeue:   autoRequeue,
    })
  } catch (e) {
    return NextResponse.json({
      ran_at:    new Date().toISOString(),
      processed: 0,
      render_id: row.id,
      error:     (e as Error).message,
    }, { status: 500 })
  }
}
