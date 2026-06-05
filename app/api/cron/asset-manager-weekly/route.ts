/**
 * app/api/cron/asset-manager-weekly/route.ts
 *
 * Wave 37 — spawns the Asset Manager Agent for every active brokerage
 * each Monday morning. Snapshot + kickoff happen inside spawnAsset
 * Manager. Sessions land in managed_agent_sessions; the existing
 * Anthropic webhook fans the agent's resolutions[] into asset_manager
 * _actions via the same path marketing-agent uses for its resolutions.
 *
 * Schedule: 0 7 * * 1 — Monday 07:00 UTC, two hours BEFORE the
 * marketing-agent weekly cron (09:00 UTC). The asset manager's
 * resolutions land first so the marketing-agent's Monday snapshot
 * sees fresh per-persona variants if rerender_persona_variants
 * actions were approved and executed in the intervening time.
 *
 * Auth: CRON_SECRET. No-op when ANTHROPIC_API_KEY is absent.
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { spawnAssetManager } from "@/lib/agents/asset-manager"

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

  const svc = createServiceClient()
  const { data: brokerages } = await svc
    .from("brokerages")
    .select("id, name")
    .limit(500)

  const results = []
  for (const b of (brokerages ?? []) as Array<{ id: string; name: string | null }>) {
    try {
      const r = await spawnAssetManager({ brokerageId: b.id })
      results.push({
        brokerage_id:   b.id,
        brokerage_name: b.name,
        ok:             r.ok,
        session_id:     r.sessionId ?? null,
        reason:         r.reason ?? null,
        listings_missing_hero: r.snapshot?.listingsMissingHero ?? null,
        underperformers:        r.snapshot?.underperformingTopicPersonaCount ?? null,
      })
    } catch (e) {
      results.push({ brokerage_id: b.id, brokerage_name: b.name, ok: false, reason: (e as Error).message })
    }
  }

  return NextResponse.json({
    ran_at: new Date().toISOString(),
    spawned: results.filter((r) => r.ok).length,
    total:   results.length,
    results,
  })
}
