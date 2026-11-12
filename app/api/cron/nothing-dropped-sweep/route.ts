import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runNothingDroppedSweep } from "@/lib/kernel/nothing-dropped-runner"
import { publishManagerSignal } from "@/lib/kernel/manager-signals"

/**
 * NOTHING-DROPPED sweep — daily
 * (lib/kernel/cron-dispatch.ts, "8 13 * * *").
 *
 * WHY (wave 26). lib/kernel/nothing-dropped-runner.ts:35 runNothingDroppedSweep
 * had no caller. The one composed view of "what is about to be dropped across
 * every lane" had never been computed against a live tenant.
 *
 * THE ROUTE OWNS THE ESCALATION, ON PURPOSE. The runner is READ-ONLY — its own
 * header says a sweep never writes, and its signature carries no publish option
 * (only `topN`). A cron that merely called it would compute the ranked card and
 * drop it on the floor, which is not a wire. So the digest is published HERE:
 * one gated `nothing_dropped_digest` manager signal per brokerage per day,
 * campaign_orchestrator → data_steward (the manager who already owns the
 * approvals / office-hours rail in CRON_MANAGER). Nothing is auto-actioned;
 * the signal is a ranked list a human works.
 *
 * DOUBLE IDEMPOTENCY, both cheap:
 *   · an explicit "already digested today" read on manager_signals (UTC day), so
 *     a re-run inside the day is a no-op regardless of signal status; and
 *   · publishManagerSignal's own dedupe on an OPEN (to_manager, signal_type,
 *     entity_id) — entityId is the brokerage id — so an unread digest is not
 *     duplicated even across days.
 *
 * SCOPE NOTE carried from the runner: contacts and transactions are deliberately
 * excluded from the sweep — the stale-contact monitor and the deadline watcher
 * own those lanes. This unifies the five lanes nothing else unifies (pending
 * showings, awaiting approvals, unconsumed manager signals, never-touched leads,
 * and leads whose next push is overdue).
 *
 * Tenant: platform cron on the service client, gated by the cron secret; every
 * signal is written under the swept brokerage's own id (§4).
 */
export const dynamic = "force-dynamic"
export const maxDuration = 300

const TENANT_CAP = 500
const TOP_N = 10

export async function GET(request: Request) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "nothing-dropped-sweep",
    cron_path: "/app/api/cron/nothing-dropped-sweep/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[NothingDropped] Failed to record cron start:", startRecordResult.error)
  }

  try {
    const supabase = createServiceClient()
    const dayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`

    const { data: brokerages, error: brokeragesError } = await supabase
      .from("brokerages")
      .select("id")
      .eq("is_active", true)
      .is("deleted_at", null)
      .limit(TENANT_CAP)
    if (brokeragesError) throw new Error(`brokerages read refused: ${brokeragesError.message}`)

    let tenantsScanned = 0
    let tenantsWithDrops = 0
    let totalDropping = 0
    let digestsPublished = 0
    let digestsDeduped = 0
    const byEntityTotal: Record<string, number> = {}
    const errors: Array<{ brokerageId: string; error: string }> = []

    for (const b of (brokerages ?? []) as Array<{ id: string }>) {
      try {
        const summary = await runNothingDroppedSweep(b.id, { topN: TOP_N }, supabase)
        tenantsScanned += 1
        totalDropping += summary.total
        for (const [k, v] of Object.entries(summary.byEntity)) {
          byEntityTotal[k] = (byEntityTotal[k] ?? 0) + (v ?? 0)
        }
        if (summary.total === 0) continue
        tenantsWithDrops += 1

        // Already digested today? (Explicit — status-independent.)
        const { data: priorDigest, error: priorError } = await supabase
          .from("manager_signals")
          .select("id")
          .eq("brokerage_id", b.id)
          .eq("signal_type", "nothing_dropped_digest")
          .gte("created_at", dayStart)
          .limit(1)
        if (priorError) {
          // FAIL CLOSED: an unreadable dedupe read must not license a second
          // digest — a duplicated "nothing dropped" card is how a real one stops
          // being read.
          throw new Error(`digest dedupe read refused: ${priorError.message}`)
        }
        if (priorDigest && priorDigest.length > 0) { digestsDeduped += 1; continue }

        const lines = summary.top.map(
          (d, i) => `${i + 1}. ${d.label ?? d.entityType} — ${d.reason}`,
        )
        const message =
          `${summary.total} item(s) are past SLA with no next action. Worst ${summary.top.length}:\n` +
          lines.join("\n")

        const sig = await publishManagerSignal({
          brokerageId: b.id,
          fromManager: "campaign_orchestrator",
          toManager: "data_steward",
          signalType: "nothing_dropped_digest",
          message,
          entityType: "brokerage",
          entityId: b.id,
          payload: {
            total: summary.total,
            by_entity: summary.byEntity,
            top: summary.top,
            top_n: TOP_N,
          },
        }, supabase)

        if (sig.ok && sig.reason === "already open (deduped)") digestsDeduped += 1
        else if (sig.ok) digestsPublished += 1
        else errors.push({ brokerageId: b.id, error: sig.reason ?? "digest publish refused" })
      } catch (e) {
        errors.push({ brokerageId: b.id, error: e instanceof Error ? e.message : String(e) })
      }
    }

    const payload = {
      tenants_scanned: tenantsScanned,
      tenant_cap: TENANT_CAP,
      tenant_capped: (brokerages?.length ?? 0) >= TENANT_CAP,
      tenants_with_drops: tenantsWithDrops,
      total_dropping: totalDropping,
      by_entity: byEntityTotal,
      digests_published: digestsPublished,
      digests_deduped: digestsDeduped,
      top_n: TOP_N,
      errors: errors.slice(0, 20),
      error_count: errors.length,
      // Published beside the number (§2): what this sweep does NOT look at.
      excluded_lanes: ["contact (stale-contact-monitor owns it)", "transaction (deadline-watcher owns it)"],
    }
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: tenantsScanned,
      output_count: digestsPublished,
      metadata: payload,
    })
    return NextResponse.json({ success: true, ...payload })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[NothingDropped] failed:", message)
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
