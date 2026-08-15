/**
 * app/api/cron/campaign-orchestrator-weekly/route.ts
 *
 * Weekly cron — spawns the Campaign Orchestrator Managed Agent for every active
 * brokerage that has at least one lifetime customer OR at-risk listing.
 *
 * Scheduling: run on Monday morning, AFTER the Sunday-night sphere cron has
 * produced its weekly opportunities (the orchestrator reads them via
 * agent_outcome_evaluations during its rubric loop).
 *
 * The spawn is IDEMPOTENT — the spawn-helper checks for an already-running
 * session for (entity_type='brokerage', entity_id=brokerageId) and skips if one
 * is active.
 *
 * Auth: CRON_SECRET — same pattern as the sphere-weekly cron.
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

  const { data: brokerages, error } = await svc
    .from("brokerages")
    .select("id, name")
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const results: Array<{ brokerage_id: string; brokerage_name: string | null; result: string }> = []

  for (const b of brokerages ?? []) {
    try {
      // Skip brokerages with no orchestratable signal at all.
      const { count: lifetimeCount } = await svc
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("brokerage_id", b.id)
        .eq("lifecycle_state", "lifetime_customer")
      let atRisk = 0
      try {
        const { count } = await svc
          .from("listing_health_scores")
          .select("id", { count: "exact", head: true })
          .eq("brokerage_id", b.id)
          .lte("overall_score", 40)
        atRisk = count ?? 0
      } catch { /* optional */ }

      if ((lifetimeCount ?? 0) === 0 && atRisk === 0) {
        results.push({ brokerage_id: b.id, brokerage_name: b.name, result: "skipped:no_signal" })
        continue
      }

      const { spawnCampaignOrchestratorForBrokerage } = await import("@/lib/agents/campaign-orchestrator")
      const r = await spawnCampaignOrchestratorForBrokerage({ brokerageId: b.id })
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
