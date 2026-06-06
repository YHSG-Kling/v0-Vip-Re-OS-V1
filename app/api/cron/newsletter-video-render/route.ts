/**
 * app/api/cron/newsletter-video-render/route.ts
 *
 * Wave 15 — kickoff cron for newsletter campaign videos.
 *
 * Sweeps every 5 minutes:
 *   1. For each newsletter_campaigns row with approval_status='approved' AND
 *      status IN ('draft','scheduled') AND is_ai_generated=true AND no
 *      newsletter_video_renders row yet — insert the ledger row (queued).
 *      The unique index on (newsletter_campaign_id) makes this idempotent.
 *   2. Pick the oldest 'queued' ledger row and POST it to the render
 *      endpoint. Serialized one-per-tick to keep Chromium memory bounded.
 *
 * The publish-newsletters cron (Wave 4) joins newsletter_video_renders by
 * (newsletter_campaign_id) when assembling each recipient's body — when
 * video_url is populated, it embeds the same URL in every recipient's email
 * (cost-bounded: $0.30 ÷ N).
 *
 * Auth: CRON_SECRET.
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"

export const dynamic = "force-dynamic"
export const maxDuration = 300
export const runtime = "nodejs"

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization")?.replace("Bearer ", "")
  const qs   = new URL(req.url).searchParams.get("secret")
  const expected = process.env.CRON_SECRET
  if (!expected) return NextResponse.json({ skipped: "CRON_SECRET not configured" })
  if (auth !== expected && qs !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const svc = createServiceClient()

  // 1. Stage: create ledger rows for any newly-approved AI newsletters.
  //    Limit 25 per tick (the unique index handles idempotency).
  const { data: candidates } = await svc
    .from("newsletter_campaigns")
    .select("id, brokerage_id, agent_id, created_by")
    .eq("approval_status", "approved")
    .eq("is_ai_generated", true)
    .in("status", ["draft", "scheduled"])
    .limit(25)

  let staged = 0
  for (const c of (candidates ?? []) as { id: string; brokerage_id: string; agent_id: string | null; created_by: string | null }[]) {
    const ownerUserId = c.created_by ?? c.agent_id
    if (!ownerUserId) continue
    try {
      const { error } = await svc.from("newsletter_video_renders").insert({
        brokerage_id:           c.brokerage_id,
        newsletter_campaign_id: c.id,
        agent_id:               ownerUserId,
        status:                 "queued",
      })
      if (!error) staged++
      // 23505 unique_violation = already staged; not an error.
    } catch { /* duplicate or transient — best-effort */ }
  }

  // 2. Dispatch one queued ledger row to the render endpoint per tick.
  const { data: oneQueued } = await svc
    .from("newsletter_video_renders")
    .select("id, newsletter_campaign_id")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!oneQueued) {
    return NextResponse.json({ ran_at: new Date().toISOString(), staged, dispatched: 0 })
  }

  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000")

  try {
    const r = await fetch(`${baseUrl}/api/internal/remotion/render-newsletter-video`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${expected}` },
      body: JSON.stringify({ newsletter_campaign_id: (oneQueued as { newsletter_campaign_id: string }).newsletter_campaign_id }),
    })
    const body = await r.json().catch(() => ({}))
    return NextResponse.json({
      ran_at:    new Date().toISOString(),
      staged,
      dispatched: 1,
      ledger_id:  (oneQueued as { id: string }).id,
      render_status: r.status,
      render_body:   body,
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
