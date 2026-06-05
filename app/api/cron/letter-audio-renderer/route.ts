/**
 * app/api/cron/letter-audio-renderer/route.ts
 *
 * Wave 38 — drains direct_mail_campaigns rows where piece_type='letter'
 * AND tts_audio_url IS NULL AND the campaign's agent has a cloned
 * voice ready. Backfill for letters that landed before the inline
 * orchestrator hook shipped, plus a safety net for cases where the
 * inline render failed transiently.
 *
 * Schedule: every 15 min (slash-15 in vercel.json cron syntax). The
 * synthesizeSpeech helper already enforces the per-brokerage vendor
 * budget gate, so the cron auto-pauses tenants over their monthly
 * ElevenLabs ceiling.
 *
 * Per-cycle cap: 30 letters. At ~$0.03/render that's ~$0.90 per
 * brokerage per cycle in the worst case — well below the per-cycle
 * vendor budget ceiling.
 *
 * Auth: CRON_SECRET dual-scheme (Bearer header OR ?secret= query).
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { renderLetterAudio } from "@/lib/direct-mail/render-letter-audio"

export const dynamic = "force-dynamic"
export const maxDuration = 300

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

export async function GET(req: NextRequest) {
  const auth     = req.headers.get("authorization")?.replace("Bearer ", "")
  const url      = new URL(req.url)
  const qs       = url.searchParams.get("secret")
  const expected = process.env.CRON_SECRET
  if (!expected) return NextResponse.json({ skipped: "CRON_SECRET not configured" })
  if (auth !== expected && qs !== expected) return unauthorized()

  if (!process.env.ELEVENLABS_API_KEY) {
    return NextResponse.json({ ran_at: new Date().toISOString(), skipped: "ELEVENLABS_API_KEY not configured" })
  }

  const svc = createServiceClient()

  // Pull the backlog. The partial index idx_direct_mail_campaigns_
  // letter_no_audio makes this a tiny scan even on a busy tenant.
  const { data: rows } = await svc.from("direct_mail_campaigns")
    .select("id")
    .eq("piece_type", "letter")
    .is("tts_audio_url", null)
    .order("created_at", { ascending: false })
    .limit(30)
  const campaigns = (rows ?? []) as Array<{ id: string }>
  if (campaigns.length === 0) {
    return NextResponse.json({ ran_at: new Date().toISOString(), rendered: 0 })
  }

  const outcomes: Array<{ campaign_id: string; result: string }> = []
  let rendered = 0
  let skipped  = 0
  let failed   = 0
  for (const c of campaigns) {
    const r = await renderLetterAudio({ campaignId: c.id })
    if (r.ok && r.audioUrl)          { rendered++; outcomes.push({ campaign_id: c.id, result: "rendered" }) }
    else if (r.ok && r.skipped)      { skipped++;  outcomes.push({ campaign_id: c.id, result: `skip:${r.skipped}` }) }
    else                             { failed++;   outcomes.push({ campaign_id: c.id, result: `err:${r.error ?? "unknown"}` }) }
  }

  return NextResponse.json({
    ran_at:    new Date().toISOString(),
    attempted: campaigns.length,
    rendered,
    skipped,
    failed,
    outcomes,
  })
}
