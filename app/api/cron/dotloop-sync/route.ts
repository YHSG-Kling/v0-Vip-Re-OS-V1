import { type NextRequest, NextResponse } from "next/server"
import { syncDotloopDocuments } from "@/app/actions/dotloop-integration"
import { supabaseService } from "@/services/supabaseService"

export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get("authorization")
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

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

    console.log("[v0] Dotloop cron sync completed:", syncedCount)

    return NextResponse.json({
      success: true,
      transactionsChecked: transactions.length,
      syncedCount,
    })
  } catch (error: any) {
    console.error("[v0] Dotloop cron sync error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
