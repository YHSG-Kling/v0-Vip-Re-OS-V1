/**
 * app/api/cron/voice-distiller-weekly/route.ts
 *
 * Wave 36.5 — weekly per-agent voice distiller. Walks active agents
 * with at least one newsletter or blog post in the last 90 days and
 * runs distillVoiceForAgent against their published writing. The
 * distiller's own internal gates (manual-row skip, 30d freshness
 * skip, min-samples skip) keep the spend bounded — each cycle only
 * re-distills the agents whose previous row is genuinely stale.
 *
 * Schedule: 0 9 * * 5 — Friday 09:00 UTC, after the marketing-agent
 * weekly cron has spawned (Monday) but before the next Monday's
 * agent kickoff reads from brand_voice_profile. Gives the agent a
 * full work week of fresh content to draw from.
 *
 * Auth: CRON_SECRET. No-op if Anthropic isn't configured (distiller
 * raises through generateTextRouted which short-circuits cleanly).
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { distillVoiceForAgent } from "@/lib/voice-distiller/per-agent-voice"

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

  const dryRun = url.searchParams.get("dry") === "1"
  const svc = createServiceClient()

  // Active agents with at least one published asset in the lookback.
  // We pull agents.user_id (the canonical user ref) + brokerage_id.
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString()
  const [newsletterCreators, blogCreators] = await Promise.all([
    svc.from("newsletter_campaigns")
      .select("brokerage_id, created_by_user_id")
      .gte("created_at", since)
      .not("created_by_user_id", "is", null)
      .limit(5000),
    svc.from("blog_posts")
      .select("brokerage_id, agent_user_id")
      .gte("created_at", since)
      .not("agent_user_id", "is", null)
      .limit(5000),
  ])
  const pairs = new Set<string>()
  for (const r of (newsletterCreators.data ?? []) as Array<{ brokerage_id: string | null; created_by_user_id: string | null }>) {
    if (r.brokerage_id && r.created_by_user_id) pairs.add(`${r.brokerage_id}|${r.created_by_user_id}`)
  }
  for (const r of (blogCreators.data ?? []) as Array<{ brokerage_id: string | null; agent_user_id: string | null }>) {
    if (r.brokerage_id && r.agent_user_id) pairs.add(`${r.brokerage_id}|${r.agent_user_id}`)
  }

  if (dryRun) {
    return NextResponse.json({
      ran_at: new Date().toISOString(),
      dry_run: true,
      eligible_pairs: pairs.size,
    })
  }

  const results = []
  for (const pair of pairs) {
    const [brokerageId, agentUserId] = pair.split("|")
    try {
      const r = await distillVoiceForAgent({ brokerageId, agentUserId })
      results.push(r)
    } catch (e) {
      results.push({ agentUserId, outcome: "failed", reason: (e as Error).message })
    }
  }

  return NextResponse.json({
    ran_at: new Date().toISOString(),
    eligible_pairs: pairs.size,
    processed: results.length,
    by_outcome: results.reduce<Record<string, number>>((acc, r) => {
      acc[r.outcome] = (acc[r.outcome] ?? 0) + 1
      return acc
    }, {}),
    results,
  })
}
