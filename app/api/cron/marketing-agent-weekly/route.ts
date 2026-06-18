/**
 * app/api/cron/marketing-agent-weekly/route.ts
 *
 * Weekly cron — spawns the Marketing Agent for every active brokerage that
 * has any brand-marketing signal worth orchestrating:
 *   - at least one new listing published in the last 7 days, OR
 *   - at least one listing_promo_videos row in 'remotion_pending', OR
 *   - at least one listing at risk (health score ≤ 40)
 *
 * Scheduling: runs Monday 09:00 UTC, AFTER:
 *   • sphere-weekly       Sun 22:00 UTC (sphere opportunities ready)
 *   • campaign-orchestrator-weekly Mon 07:00 UTC (1:1 contact plan ready)
 *
 * The marketing_agent reads BOTH of the above as inputs (no overlap; this
 * agent owns the 1:many brand lane only). Spawn is idempotent via the
 * spawn-helper's unique-active session guard.
 *
 * Auth: CRON_SECRET.
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"

export const dynamic = "force-dynamic"
export const maxDuration = 300

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
  const { data: brokerages, error } = await svc.from("brokerages").select("id, name")
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const since7d = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const results: Array<{ brokerage_id: string; brokerage_name: string | null; result: string }> = []

  for (const b of brokerages ?? []) {
    try {
      // Skip brokerages with no brand-marketing signal at all. Four signals:
      //   1. new listings published in the last 7d
      //   2. listing promo videos pending Remotion render
      //   3. listings whose health score has dropped (≤40)
      //   4. NEWSLETTER CADENCE — a brokerage with active subscribers that
      //      hasn't sent a newsletter in the last 7d still needs the agent's
      //      attention. Without this signal a brokerage with zero listings
      //      activity but a real subscriber list would never trigger.
      const [newListings, pendingPromos, atRisk, recentSends, activeSubs] = await Promise.all([
        svc.from("listings").select("id", { count: "exact", head: true })
          .eq("brokerage_id", b.id).eq("status", "active").gte("created_at", since7d),
        svc.from("listing_promo_videos").select("id", { count: "exact", head: true })
          .eq("brokerage_id", b.id).eq("status", "remotion_pending"),
        svc.from("listing_health_scores").select("id", { count: "exact", head: true })
          .eq("brokerage_id", b.id).lte("overall_score", 40),
        svc.from("newsletter_campaigns").select("id", { count: "exact", head: true })
          .eq("brokerage_id", b.id).eq("status", "sent").gte("send_date", since7d),
        svc.from("newsletter_subscribers").select("id", { count: "exact", head: true })
          .eq("brokerage_id", b.id).eq("status", "subscribed"),
      ])
      const newsletterCadenceSignal =
        (activeSubs.count ?? 0) > 0 && (recentSends.count ?? 0) === 0 ? 1 : 0
      const totalSignal =
        (newListings.count ?? 0) +
        (pendingPromos.count ?? 0) +
        (atRisk.count ?? 0) +
        newsletterCadenceSignal
      if (totalSignal === 0) {
        results.push({ brokerage_id: b.id, brokerage_name: b.name, result: "skipped:no_signal" })
        continue
      }

      const { spawnMarketingAgentForBrokerage } = await import("@/lib/agents/marketing-agent")
      const r = await spawnMarketingAgentForBrokerage({ brokerageId: b.id })
      if (r.skipped) {
        results.push({ brokerage_id: b.id, brokerage_name: b.name, result: `skipped:${r.skipped}` })
      } else if (r.ok) {
        results.push({ brokerage_id: b.id, brokerage_name: b.name, result: `ok:${r.session?.id ?? "no-session-id"}` })
      } else {
        results.push({ brokerage_id: b.id, brokerage_name: b.name, result: `error:${r.error ?? "unknown"}` })
      }
    } catch (e) {
      results.push({ brokerage_id: b.id, brokerage_name: b.name, result: `exception:${(e as Error).message}` })
    }
  }

  return NextResponse.json({
    ran_at: new Date().toISOString(),
    brokerages_processed: results.length,
    results,
  })
}
