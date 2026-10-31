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
 * Team Optimization — weekly cron (wave 108, lane 108G; registered in lib/kernel/cron-dispatch.ts).
 *
 * For every tenant, lib/kernel/self-optimization.ts runTeamOptimizationCycle: each optimization class's owner +
 * declared co-proposers contribute evidence, the team co-proposes ONE bounded change (or co-signs a learner's open
 * proposal of that class), the proposal kernel evaluates it by replay / re-measurement, and it is promoted ONLY when
 * the class is on the tenant's autonomous list AND the owner's autonomy gate + rung allow — otherwise a human decides
 * on the Manager Trust page. Forbidden surfaces (authority / financial / compliance) are refused by the kernel.
 * The summary carries counts only — never a tenant id.
 */
const MAX_BROKERAGES = 300

export async function GET(request: NextRequest) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth
  const ctx = await createCronRunContextAction({ cron_name: "team-optimization", cron_path: "/app/api/cron/team-optimization/route.ts" })
  if (!ctx.success || !ctx.data) return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })
  const svc = createServiceClient()
  try {
    const { runTeamOptimizationCycle } = await import("@/lib/kernel/self-optimization")
    const { data: brokerages, error } = await svc.from("brokerages").select("id").is("deleted_at", null).limit(MAX_BROKERAGES)
    if (error) throw new Error(`brokerages: ${error.message}`)
    const summary = { tenants: 0, proposed: 0, adopted: 0, promoted: 0, held: 0, refused: 0, errors: 0 }
    for (const b of (brokerages ?? []) as { id: string }[]) {
      const r = await runTeamOptimizationCycle(svc, b.id)
      summary.tenants++; summary.proposed += r.proposed; summary.adopted += r.adopted; summary.promoted += r.promoted; summary.held += r.held
      summary.refused += r.classes.filter((c) => c.outcome === "refused").length
      summary.errors += r.errors.length
      if (r.errors.length) console.error(`[team-optimization] ${r.errors.slice(0, 3).join("; ")}`)
    }
    await recordCronSuccessAction({ context_id: contextId, records_processed: summary.proposed + summary.adopted, metadata: summary })
    return NextResponse.json({ message: "Team optimization complete", summary })
  } catch (e) {
    const message = (e as Error)?.message ?? String(e)
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
