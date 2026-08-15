/**
 * app/api/cron/podcast-weekly-auto/route.ts
 *
 * Wave 15 — weekly autonomous podcast episode generator. Runs every
 * Wednesday 10:00 UTC (gives the host 4 days to review before
 * distribute-podcast-episodes syndicates on Sundays).
 *
 * For every brokerage with a configured podcast show + voice profile +
 * recent market activity, the cron:
 *   1. Resolves the host (podcast_show_settings.agent_id → users.id).
 *   2. Calls runAutoPodcast() — builds fact pack, drafts script via AI
 *      Gateway, pre-flights compliance, ElevenLabs TTS in cloned voice,
 *      inserts podcast_episodes row at status='completed' +
 *      approval_status='pending_review'.
 *   3. Records the run in podcast_auto_runs (one per brokerage × ISO week,
 *      idempotent via unique partial index on the ledger).
 *
 * The existing distribute-podcast-episodes cron syndicates approved
 * episodes to the brokerage's channels — no change to its surface needed.
 *
 * Auth: CRON_SECRET.
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { runAutoPodcast, currentIsoWeek } from "@/lib/podcast/auto-producer"

export const dynamic = "force-dynamic"
export const maxDuration = 300
export const runtime = "nodejs"

interface ShowRow {
  agent_id:     string  // podcast_show_settings.agent_id has no FK on the live
                        // schema (only a UNIQUE constraint). The auto-producer
                        // treats this as users.id since podcast_episodes.agent_id
                        // (FK target) is users.id. If a row was historically
                        // populated with agents.id by an older path, the run
                        // will skip when podcast_episodes.agent_id FK fails;
                        // the ledger captures the skip + reason.
  brokerage_id: string
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization")?.replace("Bearer ", "")
  const qs   = new URL(req.url).searchParams.get("secret")
  const expected = process.env.CRON_SECRET
  if (!expected) return NextResponse.json({ skipped: "CRON_SECRET not configured" })
  if (auth !== expected && qs !== expected) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const svc = createServiceClient()
  const isoWeek = currentIsoWeek()

  // Every active brokerage with a podcast show configured.
  const { data: shows, error } = await svc
    .from("podcast_show_settings")
    .select("agent_id, brokerage_id")
    .limit(200)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const results: Array<{ brokerage_id: string; outcome: string; reason?: string; episode_id?: string }> = []

  for (const s of (shows ?? []) as ShowRow[]) {
    try {
      // Try users.id first (canonical per podcast_episodes.agent_id FK).
      // If the stored id doesn't exist in users, try resolving via agents.id
      // (legacy populations that wrote agents.id into podcast_show_settings).
      let hostUserId: string | null = null
      const { data: u } = await svc.from("users").select("id").eq("id", s.agent_id).maybeSingle()
      if (u?.id) {
        hostUserId = s.agent_id
      } else {
        const { data: a } = await svc.from("agents").select("user_id").eq("id", s.agent_id).maybeSingle()
        hostUserId = (a?.user_id as string | null) ?? null
      }
      if (!hostUserId) {
        results.push({ brokerage_id: s.brokerage_id, outcome: "skipped", reason: "host user resolution failed for podcast_show_settings.agent_id" })
        continue
      }

      const r = await runAutoPodcast({
        brokerageId: s.brokerage_id,
        hostUserId,
        isoWeek,
      })
      results.push({
        brokerage_id: s.brokerage_id,
        outcome:      r.status,
        reason:       r.reason,
        episode_id:   r.podcast_episode_id,
      })
    } catch (e) {
      results.push({ brokerage_id: s.brokerage_id, outcome: "exception", reason: (e as Error).message })
    }
  }

  return NextResponse.json({
    ran_at: new Date().toISOString(),
    iso_week: isoWeek,
    shows_processed: results.length,
    results,
  })
}
