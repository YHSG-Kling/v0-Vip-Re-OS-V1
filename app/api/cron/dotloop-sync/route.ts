import { type NextRequest, NextResponse } from "next/server"
import { syncDotloopDocuments } from "@/app/actions/dotloop-integration"
import { supabaseService } from "@/services/supabaseService"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const contextResult = await createCronRunContextAction({
    cron_name: "dotloop-sync",
    cron_path: "/app/api/cron/dotloop-sync/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[DotloopSync] Failed to record cron start:", startRecordResult.error)
  }

  try {

    const transactions = await supabaseService.query(`
      SELECT id, dotloop_loop_id, buyer_id, seller_id
      FROM transactions
      WHERE status IN ('under_contract', 'pending', 'contingent')
      AND dotloop_sync_enabled = true
      AND dotloop_loop_id IS NOT NULL
    `)

    let syncedCount = 0

    for (const txn of transactions) {
      const result = await syncDotloopDocuments({
        loopId: txn.dotloop_loop_id,
        contactId: txn.buyer_id || txn.seller_id,
        transactionId: txn.id,
      })

      if (result.success) syncedCount++
    }

    console.log("[DotloopSync] Cron sync completed:", syncedCount)

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: transactions.length,
      output_count: syncedCount,
      metadata: { transactionsChecked: transactions.length, syncedCount },
    })

    return NextResponse.json({
      success: true,
      transactionsChecked: transactions.length,
      syncedCount,
    })
  } catch (error: any) {
    console.error("[DotloopSync] Cron sync error:", error)
    await recordCronFailureAction({ context_id: contextId, error, stage: "main-processing" })
    return NextResponse.json({ error: error.message, context_id: contextId }, { status: 500 })
  }
}
