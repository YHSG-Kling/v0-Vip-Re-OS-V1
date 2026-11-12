import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction, recordCronStartAction, recordCronSuccessAction, recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runLookalikeAudience, runLookalikeResearch } from "@/lib/kernel/lookalike-audience"

// Wave 143 (lane 143D): the run now reads each tenant's closings and may ask Versium for a bounded number of indicators —
// the same 300 s ceiling the other enrichment crons declare, with a wall-clock stop below so a long tenant list is reported
// as deferred (agg.deferred_tenants) instead of the platform killing the function mid-tenant.
export const maxDuration = 300
const TENANT_LOOP_BUDGET_MS = 270_000

export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth
  const ctx = await createCronRunContextAction({ cron_name: "lookalike-audience", cron_path: "/app/api/cron/lookalike-audience/route.ts" })
  if (!ctx.success || !ctx.data) return NextResponse.json({ error: "ctx" }, { status: 500 })
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})
  const supabase = createServiceClient()
  const errors: string[] = []
  const agg: Record<string, number> = {}
  try {
    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error
    const started = Date.now()
    const tenants = (rows ?? []) as Array<{ id: string }>
    for (const [i, b] of tenants.entries()) {
      if (Date.now() - started > TENANT_LOOP_BUDGET_MS) { agg.deferred_tenants = tenants.length - i; break }
      try {
        const r = await runLookalikeAudience(b.id, {}, supabase) as unknown as Record<string, unknown>
        for (const [k, v] of Object.entries(r)) if (typeof v === "number") agg[k] = (agg[k] ?? 0) + v
      } catch (e: any) { errors.push(`${b.id}: ${e?.message ?? String(e)}`) }
      // Wave 143 (lane 143D): the RESEARCH is its own capability beside the ad draft — content briefs + staged acquisition
      // inputs from the tenant's own closed customers. Isolated from the draft: either can fail without the other.
      try {
        const rs = await runLookalikeResearch(b.id, {}, supabase)
        agg.research_seed = (agg.research_seed ?? 0) + rs.seedCount
        agg.briefs_staged = (agg.briefs_staged ?? 0) + rs.briefs.staged
        agg.keywords_staged = (agg.keywords_staged ?? 0) + rs.keywords.staged
        agg.enrichment_asked = (agg.enrichment_asked ?? 0) + rs.enrichment.asked
        agg.enrichment_cost_usd = Math.round(((agg.enrichment_cost_usd ?? 0) + rs.enrichment.costUsd) * 100) / 100
        for (const e of rs.errors) errors.push(`${b.id}: research: ${e}`)
      } catch (e: any) { errors.push(`${b.id}: research: ${e?.message ?? String(e)}`) }
    }
    await recordCronSuccessAction({ context_id: contextId, records_processed: agg["seedCount"] ?? 0, metadata: { ...agg, errors: errors.slice(0, 10) } }).catch(() => {})
    return NextResponse.json({ ok: true, ...agg })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
