import {
type NextRequest, NextResponse } from "next/server"
import { syncDotloopDocuments } from "@/app/actions/dotloop-integration"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export async function GET(request: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

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
    const supabase = createServiceClient()

    const { data: transactions, error: txError } = await supabase
      .from("transactions")
      .select("id, external_provider_transaction_id, buyer_contact_id, seller_contact_id")
      .in("status", ["under_contract", "pending", "contingent"])
      .eq("external_provider_source", "dotloop")
      .not("external_provider_transaction_id", "is", null)

    if (txError) throw txError

    const txList = transactions ?? []
    let syncedCount = 0

    for (const txn of txList) {
      const result = await syncDotloopDocuments({
        loopId: txn.external_provider_transaction_id,
        contactId: txn.buyer_contact_id || txn.seller_contact_id,
        transactionId: txn.id,
      })

      if (result.success) syncedCount++
    }

    console.log("[DotloopSync] Cron sync completed:", syncedCount)

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: txList.length,
      output_count: syncedCount,
      metadata: { transactionsChecked: txList.length, syncedCount },
    })

    return NextResponse.json({
      success: true,
      transactionsChecked: txList.length,
      syncedCount,
    })
  } catch (error: any) {
    console.error("[DotloopSync] Cron sync error:", error)
    await recordCronFailureAction({ context_id: contextId, error, stage: "main-processing" })
    return NextResponse.json({ error: error.message, context_id: contextId }, { status: 500 })
  }
}
