import {
type NextRequest, NextResponse } from "next/server"
// TOMBSTONE (lane 86E): this route imported app/actions/dotloop-integration.ts::syncDotloopDocuments,
// a cookie-session "use server" door that refused every cron call "Unauthorized". The body is now
// the server-only core lib/transactions/dotloop-document-sync.ts::syncDotloopLoopDocuments.
import { syncDotloopLoopDocuments } from "@/lib/transactions/dotloop-document-sync"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { TRANSACTION_STATUSES_IN_ESCROW } from "@/lib/transactions/transaction-status"

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

    // ONE VOCABULARY (§6). This filter was the hand-rolled `["under_contract"]`
    // that lib/transactions/transaction-status.ts:26-29 exists to retire: the
    // deal ladder is under_contract → pending → clear_to_close, and a deal that
    // has cleared its contingencies still has documents arriving right up to
    // funding. Filtering on the first rung alone silently stopped syncing every
    // loop the moment the deal progressed — the two later states did not exist
    // when this line was written.
    const { data: transactions, error: txError } = await supabase
      .from("transactions")
      .select("id, brokerage_id, external_provider_transaction_id, buyer_contact_id, seller_contact_id")
      .in("status", [...TRANSACTION_STATUSES_IN_ESCROW])
      .eq("external_provider_source", "dotloop")
      .not("external_provider_transaction_id", "is", null)

    if (txError) throw txError

    const txList = transactions ?? []
    let syncedCount = 0
    let documentsSynced = 0
    const failures: string[] = []

    for (const txn of txList) {
      // THE TENANT COMES FROM THE ROW THIS CRON READ (service client, no body) —
      // the core pins every read and write to it and refuses a contact or
      // transaction outside it.
      const contactId = txn.buyer_contact_id || txn.seller_contact_id
      if (!txn.brokerage_id || !contactId) {
        failures.push(`txn ${txn.id}: ${!txn.brokerage_id ? "no brokerage_id" : "no buyer/seller contact"}`)
        continue
      }
      const result = await syncDotloopLoopDocuments(supabase, {
        brokerageId: txn.brokerage_id,
        loopId: txn.external_provider_transaction_id,
        contactId,
        transactionId: txn.id,
      })

      if (result.success) { syncedCount++; documentsSynced += result.syncedCount }
      else failures.push(`txn ${txn.id}: ${result.error}`)
    }

    console.log("[DotloopSync] Cron sync completed:", syncedCount, "of", txList.length, failures.length ? `(${failures.length} failed)` : "")

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: txList.length,
      output_count: syncedCount,
      metadata: { transactionsChecked: txList.length, syncedCount, documentsSynced, failed: failures.length, failures: failures.slice(0, 20) },
    })

    return NextResponse.json({
      success: true,
      transactionsChecked: txList.length,
      syncedCount,
      documentsSynced,
      failed: failures.length,
    })
  } catch (error: any) {
    console.error("[DotloopSync] Cron sync error:", error)
    await recordCronFailureAction({ context_id: contextId, error, stage: "main-processing" })
    return NextResponse.json({ error: error.message, context_id: contextId }, { status: 500 })
  }
}
