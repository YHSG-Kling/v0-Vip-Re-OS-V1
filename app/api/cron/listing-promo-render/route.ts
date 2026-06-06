/**
 * app/api/cron/listing-promo-render/route.ts
 *
 * Wave 14 — kickoff cron for the Remotion + (optional) D-ID hybrid render.
 *
 * The listing-promo reactor (lib/video/listing-promo-reactor.ts) parks
 * triggered rows at status='remotion_pending'. This cron sweeps every 5
 * minutes and POSTs each pending row to the internal Remotion render
 * endpoint. Decoupling the kickoff from the reactor (a) keeps the kernel
 * event-reactor fast (no 90s render blocking it) and (b) gives us natural
 * retry semantics — a failed render leaves the row at 'remotion_pending'
 * and the next tick picks it up.
 *
 * One row per tick → drained at the maxDuration of the render endpoint.
 * Concurrent renders would compete for the same Chromium / ffmpeg memory
 * pool on a single Vercel function instance, so we serialize.
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

  // Pick one ready row per tick.
  const { data: rows, error } = await svc.from("listing_promo_videos")
    .select("id, brokerage_id, listing_id, event_type")
    .eq("status", "remotion_pending")
    .order("created_at", { ascending: true })
    .limit(1)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!rows || rows.length === 0) return NextResponse.json({ ran_at: new Date().toISOString(), processed: 0 })

  const row = rows[0] as { id: string; brokerage_id: string; listing_id: string; event_type: string }

  // Call the internal render endpoint with the standard CRON_SECRET.
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000")

  try {
    const r = await fetch(`${baseUrl}/api/internal/remotion/render-just-listed`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${expected}`,
      },
      body: JSON.stringify({ listing_promo_video_id: row.id, hybrid: true }),
    })
    const body = await r.json().catch(() => ({}))
    return NextResponse.json({
      ran_at: new Date().toISOString(),
      processed: 1,
      promo_id: row.id,
      render_status: r.status,
      render_body: body,
    })
  } catch (e) {
    return NextResponse.json({
      ran_at: new Date().toISOString(),
      processed: 0,
      promo_id: row.id,
      error: (e as Error).message,
    }, { status: 500 })
  }
}
