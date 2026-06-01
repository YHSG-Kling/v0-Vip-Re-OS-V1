/**
 * app/api/cron/sphere-weekly/route.ts
 *
 * Weekly cron — spawns the Sphere of Influence Managed Agent for every active
 * brokerage that has any lifetime customers + Anthropic environment configured.
 *
 * Cadence: once per week (typically Sunday night, before agents start their week).
 * The spawn is IDEMPOTENT — the spawn-helper checks for an already-running session
 * for (entity_type='brokerage', entity_id=brokerageId) and skips if one is active.
 *
 * Auth: CRON_SECRET — same pattern as other cron endpoints in this codebase.
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"

export const dynamic = "force-dynamic"
export const maxDuration = 300

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

export async function GET(req: NextRequest) {
  // Vercel cron sends the secret as a header; manual runs from local dev use the
  // ?secret= query param. Match the established pattern from other cron routes.
  const headerSecret = req.headers.get("authorization")?.replace("Bearer ", "")
  const querySecret  = new URL(req.url).searchParams.get("secret")
  const expected     = process.env.CRON_SECRET
  if (!expected) return NextResponse.json({ skipped: "CRON_SECRET not configured" })
  if (headerSecret !== expected && querySecret !== expected) return unauthorized()

  const svc = createServiceClient()

  // Active brokerages with at least one lifetime customer. Brokerages with zero
  // lifetime customers have nothing for the agent to do; skip.
  const { data: brokerages, error } = await svc
    .from("brokerages")
    .select("id, name")
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const results: Array<{ brokerage_id: string; brokerage_name: string | null; result: string }> = []

  for (const b of brokerages ?? []) {
    try {
      const { count } = await svc
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("brokerage_id", b.id)
        .eq("lifecycle_state", "lifetime_customer")
      if (!count || count === 0) {
        results.push({ brokerage_id: b.id, brokerage_name: b.name, result: "skipped:no_lifetime_customers" })
        continue
      }

      const { spawnSphereOfInfluenceForBrokerage } = await import("@/lib/agents/sphere-agent")
      const r = await spawnSphereOfInfluenceForBrokerage({ brokerageId: b.id })
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
