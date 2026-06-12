import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runClosingWatchtower } from "@/lib/kernel/title-closing-watchtower"

/**
 * TITLE & CLOSING WATCHTOWER cron (suggest hourly — "0 * * * *"). For each
 * brokerage, sweeps the milestone audit trail (lifecycle.milestone.date_changed)
 * for chain-date MOVES on live deals (inspection / appraisal / loan commitment /
 * clear-to-close / closing), recomputes the critical path to closing (binding
 * constraint + slack + severity), proposes ONE gated Deal Coordinator alert per
 * move-set, and pushes a plain-language portal value card to BOTH represented
 * sides. Idempotent: move-set signature on the alert + per-contact daily dedupe
 * on the portal card. Deals with no recorded closing date are skipped honestly.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "closing-watchtower",
    cron_path: "/app/api/cron/closing-watchtower/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let transactionsWithMoves = 0, movesDetected = 0, alertsProposed = 0, portalCardsPushed = 0, skippedNoChain = 0

  try {
    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error
    for (const b of (rows ?? []) as Array<{ id: string }>) {
      try {
        const r = await runClosingWatchtower(b.id, {}, supabase)
        transactionsWithMoves += r.transactionsWithMoves
        movesDetected += r.movesDetected
        alertsProposed += r.alertsProposed
        portalCardsPushed += r.portalCardsPushed
        skippedNoChain += r.skippedNoChain
      } catch (e: any) { errors.push(`${b.id}: ${e?.message ?? String(e)}`) }
    }
    await recordCronSuccessAction({
      context_id: contextId, records_processed: alertsProposed,
      metadata: { transactionsWithMoves, movesDetected, alertsProposed, portalCardsPushed, skippedNoChain, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, transactionsWithMoves, movesDetected, alertsProposed, portalCardsPushed, skippedNoChain })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
