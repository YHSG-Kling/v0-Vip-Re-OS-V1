import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runFinancingPitStop } from "@/lib/kernel/financing-pit-stop"
import { runRateLockWatch } from "@/lib/financing/rate-lock-watch-runner"
import { runLoanMilestoneSync } from "@/lib/intelligence/loan-milestone-sync-runner"

/**
 * FINANCING PIT STOP cron (suggest "0 *​/6 * * *" — every 6h). For each brokerage,
 * finds active deals in the FINANCING WINDOW (the financing milestone approaching, or a
 * buyer's pre-approval going stale — REAL stored dates only; deals with neither are
 * skipped honestly), fires a parallel rate-refresh RACE across the preferred lender bench
 * (one GATED rate-request draft per preferred lender — nothing auto-sends), ranks the
 * known/returned quotes by lowest EFFECTIVE COST, proposes ONE gated Deal Coordinator
 * agent summary, and pushes a read-only buyer-portal value card. Complementary to the
 * Title & Closing Watchtower (which watches the DATE; this works the RATE/lender side).
 * Idempotent: one race per (deal, financing-window) keyed on the window signature.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "financing-pit-stop",
    cron_path: "/app/api/cron/financing-pit-stop/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let scanned = 0, inWindow = 0, summariesProposed = 0, raceDraftsProposed = 0,
    portalCardsPushed = 0, skippedNoSignal = 0, benchMisses = 0,
    rateLockFlagged = 0, rateLockEscalated = 0, loanMilestonesSynced = 0

  try {
    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error
    for (const b of (rows ?? []) as Array<{ id: string }>) {
      try {
        const r = await runFinancingPitStop(b.id, {}, supabase)
        scanned += r.scanned
        inWindow += r.inWindow
        summariesProposed += r.summariesProposed
        raceDraftsProposed += r.raceDraftsProposed
        portalCardsPushed += r.portalCardsPushed
        skippedNoSignal += r.skippedNoSignal
        benchMisses += r.benchMisses
        for (const e of r.errors) errors.push(`${b.id}: ${e}`)
        // RATE-LOCK EXPIRATION WATCH — same financing window, the lock-vs-closing side.
        try {
          const rl = await runRateLockWatch({ brokerageId: b.id }, supabase)
          rateLockFlagged += rl.flagged
          rateLockEscalated += rl.escalated
        } catch (e: any) { errors.push(`${b.id} rate-lock: ${e?.message ?? String(e)}`) }
        // LOAN-MILESTONE SYNC — keep the buyer + agent in the loop as financing milestones land
        // (loan approved, appraisal back, CLEAR TO CLOSE). Closes the loan_milestone circuit whose
        // publisher existed but was never invoked. Same financing window; gated, idempotent.
        try {
          const lm = await runLoanMilestoneSync({ brokerageId: b.id }, supabase)
          loanMilestonesSynced += lm.synced
          for (const e of lm.errors) errors.push(`${b.id} loan-milestone: ${e}`)
        } catch (e: any) { errors.push(`${b.id} loan-milestone: ${e?.message ?? String(e)}`) }
      } catch (e: any) { errors.push(`${b.id}: ${e?.message ?? String(e)}`) }
    }
    await recordCronSuccessAction({
      context_id: contextId, records_processed: summariesProposed,
      metadata: { scanned, inWindow, summariesProposed, raceDraftsProposed, portalCardsPushed, skippedNoSignal, benchMisses, rateLockFlagged, rateLockEscalated, loanMilestonesSynced, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, scanned, inWindow, summariesProposed, raceDraftsProposed, portalCardsPushed, skippedNoSignal, benchMisses, rateLockFlagged, rateLockEscalated, loanMilestonesSynced })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
