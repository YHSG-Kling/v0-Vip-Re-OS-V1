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
 * single Vercel function instance. A failed render leaves the row at
 * 'failed' (NOT requeued automatically — the Asset Manager decides
 * whether to propose restart_failed_render), so this cron never retries a
 * failure on its own; it only drains fresh 'queued' rows.
 *
 * Auth: CRON_SECRET.
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { PICKABLE_RENDER_STATUS } from "@/lib/remotion/render-decision"

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
      leak_sweep: leakSweep, living_refresh: livingRefresh,
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
