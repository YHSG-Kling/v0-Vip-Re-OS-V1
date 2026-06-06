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

  // Oldest queued row first (idx_remotion_renders_queued covers this).
  const { data: rows, error } = await svc.from("remotion_composition_renders")
    .select("id, composition_id, brokerage_id")
    .eq("render_status", "queued")
    .order("created_at", { ascending: true })
    .limit(1)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!rows || rows.length === 0) return NextResponse.json({ ran_at: new Date().toISOString(), processed: 0 })

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
