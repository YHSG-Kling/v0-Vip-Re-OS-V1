import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runVendorOrchestration } from "@/lib/kernel/vendor-orchestration"

/**
 * VENDOR ORCHESTRATION cron (daily 14:00 UTC via the dispatcher) — as transactions cross
 * milestones, the Deal Coordinator (with the Asset Manager for listing-time media) treats
 * the brokerage's vendor bench as a TEAM: for the first uncovered vendor category a stage
 * needs (inspector under contract, lender at appraisal/financing, title at closing prep,
 * stager ONLY when staging is enabled in settings), it picks the preference-first vendor
 * off the bench and PROPOSES a persona-aware quote-request draft to the agent. Nothing
 * auto-books; one proposal per (transaction, service_type); everything gated + idempotent.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "vendor-orchestration",
    cron_path: "/app/api/cron/vendor-orchestration/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let scanned = 0, proposed = 0, benchMisses = 0, stagingSkipped = 0
  let noShowsMarked = 0, backupsProposed = 0

  try {
    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error
    for (const b of (rows ?? []) as Array<{ id: string }>) {
      try {
        const r = await runVendorOrchestration(b.id, {}, supabase)
        scanned += r.scanned; proposed += r.proposed
        benchMisses += r.benchMisses; stagingSkipped += r.stagingSkipped
        if (r.errors.length) errors.push(...r.errors.map((e) => `${b.id}: ${e}`))
      } catch (e: any) { errors.push(`${b.id}: ${e?.message ?? String(e)}`) }
    }

    // NO-SHOW AUTOPILOT — the self-healing bench: mark ghosted bookings no_show + propose a gated backup.
    try {
      const { runVendorNoShowAutopilotAll } = await import("@/lib/kernel/vendor-no-show-autopilot")
      const ns = await runVendorNoShowAutopilotAll(supabase)
      noShowsMarked = ns.markedNoShow; backupsProposed = ns.backupsProposed
    } catch (e: any) { errors.push(`no-show: ${e?.message ?? String(e)}`) }

    // MARKETPLACE TAKE-RATE CAPTURE — the income stream: every completed booking earns the platform its
    // fee (idempotent per booking). Previously only a manual invoice did, and even that computed $0.
    let earningsCaptured = 0, platformRevenue = 0
    try {
      const { captureCompletedBookingEarningsAll } = await import("@/lib/vendors/marketplace-earnings-capture")
      const cap = await captureCompletedBookingEarningsAll(supabase)
      earningsCaptured = cap.captured; platformRevenue = cap.platformRevenue
    } catch (e: any) { errors.push(`earnings-capture: ${e?.message ?? String(e)}`) }

    await recordCronSuccessAction({
      context_id: contextId, records_processed: proposed,
      metadata: { scanned, proposed, benchMisses, stagingSkipped, noShowsMarked, backupsProposed, earningsCaptured, platformRevenue, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, scanned, proposed, benchMisses, stagingSkipped, noShowsMarked, backupsProposed, earningsCaptured, platformRevenue })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
