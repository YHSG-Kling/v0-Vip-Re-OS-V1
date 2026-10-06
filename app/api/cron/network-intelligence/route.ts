import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { verifyCronAuth } from "@/lib/cron-auth"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"

export const dynamic = "force-dynamic"

/**
 * Network Intelligence — weekly PLATFORM cron (wave 107, lane 107F; registered in lib/kernel/cron-dispatch.ts).
 *
 * 1. runNetworkBenchmarkAggregation — the ONLY writer of network_benchmarks (m726): reads each OPTED-IN tenant's
 *    aggregates through the service client (pinned per tenant), publishes only the k-anonymous cells (≥ k tenants,
 *    ≥ n events, no dominant tenant, no ids, no free text). Opted-out tenants contribute nothing.
 * 2. runStrategyLearning per tenant, AFTER (1) so the platform verdict reads this week's cells — a significant
 *    tenant verdict becomes ONE improvement proposal a human approves (recommendation mode).
 * The summary carries counts only — never a tenant id.
 */
const MAX_BROKERAGES = 300

export async function GET(request: NextRequest) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth
  const ctx = await createCronRunContextAction({ cron_name: "network-intelligence", cron_path: "/app/api/cron/network-intelligence/route.ts" })
  if (!ctx.success || !ctx.data) return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })
  const svc = createServiceClient()
  try {
    const { runNetworkBenchmarkAggregation } = await import("@/lib/intelligence/network-benchmarks")
    const aggregation = await runNetworkBenchmarkAggregation(svc)
    const { runStrategyLearning } = await import("@/lib/intelligence/strategy-learning")
    const { data: brokerages, error } = await svc.from("brokerages").select("id").is("deleted_at", null).limit(MAX_BROKERAGES)
    if (error) throw new Error(`brokerages: ${error.message}`)
    const learning = { tenants: 0, pairs: 0, proposed: 0, existing: 0, errors: 0 }
    for (const b of (brokerages ?? []) as { id: string }[]) {
      const r = await runStrategyLearning(svc, b.id)
      learning.tenants++; learning.pairs += r.pairs; learning.proposed += r.proposed; learning.existing += r.existing; learning.errors += r.errors.length
      if (r.errors.length) console.error(`[network-intelligence] strategy learning: ${r.errors.slice(0, 3).join("; ")}`)
    }
    const summary = { aggregation, learning }
    await recordCronSuccessAction({ context_id: contextId, records_processed: aggregation.written + learning.proposed, metadata: summary })
    return NextResponse.json({ message: "Network intelligence complete", summary })
  } catch (e) {
    const message = (e as Error)?.message ?? String(e)
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
