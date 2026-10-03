/**
 * Cron: closing-orchestration
 * Runs every 6 hours. For every active transaction, evaluates the typed
 * detector library in lib/transactions/closing-orchestration.ts and writes
 * (or supersedes) rows in transaction_pending_actions. This is the
 * orchestration engine that turns "tracked milestones" into "do this today."
 */

import { type NextRequest, NextResponse } from "next/server"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { runClosingOrchestration, runLostTransactionAutopsies } from "@/lib/transactions/closing-orchestration"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "closing-orchestration",
    cron_path: "/app/api/cron/closing-orchestration/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const result = await runClosingOrchestration({ limit: 200 })

    // THE AUTOPSY LANE HAD NO CALLER. runLostTransactionAutopsies is the
    // deal-autopsy trigger seam and nothing in app/ or lib/ invoked it, so a
    // transaction that went to status='lost' was never post-mortemed. It belongs
    // on this schedule: it reads the same table, on the same cadence, for deals
    // the orchestration deliberately stops working. Its own refusals are carried
    // into the run record below rather than being logged and forgotten.
    const autopsy = await runLostTransactionAutopsies({ limit: 50 })

    // A REFUSED READ IS NOT A SUCCESSFUL RUN. This called recordCronSuccessAction
    // unconditionally, so a run that could not read `transactions` at all — and
    // therefore did nothing — was recorded as a clean sweep with zero work. On
    // cron health that is indistinguishable from a quiet night, which is exactly
    // how a dead lane stays invisible (the earnest-money watchdog returned
    // Unauthorized on every iteration for its whole life without one alarm).
    //
    // Per-deal refusals count too: the engine SKIPS a deal whose evidence it
    // could not read rather than half-evaluating it, so a run that skipped deals
    // is a partial run, not a complete one.
    const refusedOutright  = result.outcome === "read_refused"
    const perDealRefusals  = result.refusals.length
    const autopsyRefused   = autopsy.outcome === "read_refused"
    const payload = { ...result, autopsy }

    if (refusedOutright || autopsyRefused || perDealRefusals > 0) {
      const why = refusedOutright
        ? `the transactions scan was refused: ${result.error}`
        : autopsyRefused
          ? `the lost-transaction scan was refused: ${autopsy.errors.join("; ")}`
          : `${perDealRefusals} deal(s) were skipped because their evidence could not be read`
      await recordCronFailureAction({
        context_id: contextId,
        error: new Error(`closing-orchestration ran but did not complete — ${why}`),
        stage: "main-processing",
      })
      return NextResponse.json({ success: false, incomplete: true, reason: why, ...payload }, { status: 200 })
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: result.scanned,
      output_count: result.opened + result.superseded,
      metadata: payload,
    })
    return NextResponse.json({ success: true, ...payload })
  } catch (err: any) {
    await recordCronFailureAction({ context_id: contextId, error: err, stage: "main-processing" })
    return NextResponse.json({ error: err.message ?? "Cron failed" }, { status: 500 })
  }
}
