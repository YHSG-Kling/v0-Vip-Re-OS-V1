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

    // COVERAGE FORECAST — the forward-looking bench: forecast upcoming vendor demand from the pipeline and
    // propose a gated brief on any category with demand but no reliable vendor (a gap), before deals stall.
    let coverageGaps = 0
    try {
      const { runVendorCoverageForecastAll } = await import("@/lib/kernel/vendor-coverage-forecast")
      const cf = await runVendorCoverageForecastAll(supabase)
      coverageGaps = cf.gaps
    } catch (e: any) { errors.push(`coverage-forecast: ${e?.message ?? String(e)}`) }

    // PRICE INTELLIGENCE — benchmark vendor costs vs category peers; flag the ones charging above peers.
    let overpricedVendors = 0
    try {
      const { runVendorPriceIntelligenceAll } = await import("@/lib/kernel/vendor-price-intelligence")
      const pi = await runVendorPriceIntelligenceAll(supabase)
      overpricedVendors = pi.overpriced
    } catch (e: any) { errors.push(`price-intel: ${e?.message ?? String(e)}`) }

    // RATING GOVERNANCE — the quality gate: suppress poorly-rated vendors from auto-surfacing + a gated
    // admin brief on the suppressed/flagged/badged (VendorInsightManager). Reuses vendor_ratings.
    let suppressedVendors = 0, flaggedVendors = 0
    try {
      const { runVendorRatingGovernanceAll } = await import("@/lib/kernel/vendor-rating-governance")
      const rg = await runVendorRatingGovernanceAll(supabase)
      suppressedVendors = rg.suppressed; flaggedVendors = rg.flagged
    } catch (e: any) { errors.push(`rating-governance: ${e?.message ?? String(e)}`) }

    // APPROVAL QUEUE — score pending vendors + a gated admin brief so nothing surfaces unvetted
    // (VendorVerificationManager). No vendor self-activates.
    let pendingVendors = 0
    try {
      const { runVendorApprovalQueueAll } = await import("@/lib/kernel/vendor-verification")
      const aq = await runVendorApprovalQueueAll(supabase)
      pendingVendors = aq.pending
    } catch (e: any) { errors.push(`approval-queue: ${e?.message ?? String(e)}`) }

    await recordCronSuccessAction({
      context_id: contextId, records_processed: proposed,
      metadata: { scanned, proposed, benchMisses, stagingSkipped, noShowsMarked, backupsProposed, coverageGaps, overpricedVendors, suppressedVendors, flaggedVendors, pendingVendors, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, scanned, proposed, benchMisses, stagingSkipped, noShowsMarked, backupsProposed, coverageGaps, overpricedVendors, suppressedVendors, flaggedVendors, pendingVendors })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
