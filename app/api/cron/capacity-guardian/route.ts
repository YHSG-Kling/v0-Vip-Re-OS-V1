import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runCapacityGuardian } from "@/lib/kernel/capacity-guardian-runner"

/**
 * CAPACITY GUARDIAN sweep — daily
 * (lib/kernel/cron-dispatch.ts, "50 6 * * *").
 *
 * WHY (wave 26). lib/kernel/capacity-guardian-runner.ts:46 runCapacityGuardian
 * had no caller — the guardian that protects the human from an overloaded book
 * had never run against a real brokerage. This is the trigger.
 *
 * DAILY BY RULING: workload is a daily-grain fact. Contacts, leads and open
 * deals do not move fast enough for an hourly tick to see anything new, and the
 * output is a GATED rebalance recommendation a broker reads once a day.
 *
 * The runner does the work per brokerage and publishes an `agent_overloaded`
 * manager signal itself. This route supplies the tenant loop and the ONE thing
 * the runner has no notion of: not re-signalling the same agent tomorrow and
 * every day after. Agents already signalled in the last 24 hours are removed
 * from `opts.agentIds` BEFORE the scan, so a still-overloaded agent produces one
 * signal per day rather than an unread pile.
 *
 * dryRun is deliberately NOT passed: it exists so the proof cannot pollute
 * (capacity-guardian-runner.ts:90), and production must actually publish.
 *
 * Tenant: platform cron on the service client, gated by the cron secret; every
 * signal is written under the scanned brokerage's own id (§4).
 */
export const dynamic = "force-dynamic"
export const maxDuration = 300

const TENANT_CAP = 500
const SUPPRESS_HOURS = 24

export async function GET(request: Request) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "capacity-guardian",
    cron_path: "/app/api/cron/capacity-guardian/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[CapacityGuardian] Failed to record cron start:", startRecordResult.error)
  }

  try {
    const supabase = createServiceClient()
    const suppressSince = new Date(Date.now() - SUPPRESS_HOURS * 3_600_000).toISOString()

    const { data: brokerages, error: brokeragesError } = await supabase
      .from("brokerages")
      .select("id")
      .eq("is_active", true)
      .is("deleted_at", null)
      .limit(TENANT_CAP)
    if (brokeragesError) throw new Error(`brokerages read refused: ${brokeragesError.message}`)

    let tenantsScanned = 0
    let agentsScanned = 0
    let overloaded = 0
    let proposals = 0
    let suppressedRecent = 0
    const errors: Array<{ brokerageId: string; error: string }> = []

    for (const b of (brokerages ?? []) as Array<{ id: string }>) {
      try {
        // Every ACTIVE agent in this tenant, minus the ones already told today.
        const { data: agents, error: agentsError } = await supabase
          .from("agents")
          .select("id")
          .eq("brokerage_id", b.id)
          .eq("is_active", true)
        if (agentsError) throw new Error(`agents read refused: ${agentsError.message}`)
        const allAgentIds = ((agents ?? []) as Array<{ id: string }>).map((a) => a.id)
        if (allAgentIds.length === 0) { tenantsScanned += 1; continue }

        const { data: recent, error: recentError } = await supabase
          .from("manager_signals")
          .select("entity_id")
          .eq("brokerage_id", b.id)
          .eq("signal_type", "agent_overloaded")
          .gte("created_at", suppressSince)
          .limit(1000)
        if (recentError) throw new Error(`manager_signals read refused: ${recentError.message}`)
        const alreadyTold = new Set(
          ((recent ?? []) as Array<{ entity_id: string | null }>)
            .map((s) => s.entity_id).filter((v): v is string => !!v),
        )

        const agentIds = allAgentIds.filter((id) => !alreadyTold.has(id))
        suppressedRecent += allAgentIds.length - agentIds.length
        if (agentIds.length === 0) { tenantsScanned += 1; continue }

        const r = await runCapacityGuardian(b.id, { staleDays: 14, agentIds }, supabase)
        tenantsScanned += 1
        agentsScanned += r.scanned
        overloaded += r.overloaded
        proposals += r.proposals.length
      } catch (e) {
        errors.push({ brokerageId: b.id, error: e instanceof Error ? e.message : String(e) })
      }
    }

    const payload = {
      tenants_scanned: tenantsScanned,
      tenant_cap: TENANT_CAP,
      tenant_capped: (brokerages?.length ?? 0) >= TENANT_CAP,
      agents_scanned: agentsScanned,
      overloaded,
      proposals,
      suppressed_signalled_within_hours: SUPPRESS_HOURS,
      suppressed_recent: suppressedRecent,
      errors: errors.slice(0, 20),
      error_count: errors.length,
    }
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: agentsScanned,
      output_count: proposals,
      metadata: payload,
    })
    return NextResponse.json({ success: true, ...payload })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[CapacityGuardian] failed:", message)
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
