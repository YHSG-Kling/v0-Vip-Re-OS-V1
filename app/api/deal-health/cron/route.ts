/**
 * Deal Health Cron — Layer 6 Transaction Orchestration
 * 
 * Daily cron job that scores all active transactions.
 * - Runs at 6am UTC via Vercel Cron
 * - Only processes active deals (not CLOSED, CANCELLED, or deleted)
 * - Idempotent: skips transactions scored in the last 20 hours
 * - Writes to: deal_health_scores, deal_health_components, transactions.health_score
 */

import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { calculateDealHealth } from "@/lib/deal-health/health-scorer"

export const runtime = "nodejs"
export const maxDuration = 300

export async function GET(request: Request) {
  // Verify cron secret
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = createServiceClient()
  const twentyHoursAgo = new Date()
  twentyHoursAgo.setHours(twentyHoursAgo.getHours() - 20)

  // Get active transactions not scored in last 20 hours
  // Active = status not in (closed, cancelled, lost) AND deleted_at is null
  // Schema source: transactions table
  const { data: transactions, error: txnError } = await supabase
    .from("transactions")
    .select(`
      id,
      brokerage_id,
      status,
      stage,
      deal_health_scores(scored_at)
    `)
    .is("deleted_at", null)
    .not("status", "in", "(closed,cancelled,lost)")

  if (txnError) {
    console.error("[deal-health/cron] Error fetching transactions:", txnError)
    return NextResponse.json({ error: txnError.message }, { status: 500 })
  }

  // Idempotent scoring: skip if recently scored (within 20 hours)
  const transactionsToScore = (transactions ?? []).filter(txn => {
    const scores = txn.deal_health_scores as Array<{ scored_at: string }> | null
    if (!scores || scores.length === 0) return true
    const lastScored = new Date(scores[0].scored_at)
    return lastScored < twentyHoursAgo
  })

  console.log(`[deal-health/cron] Found ${transactionsToScore.length} transactions to score out of ${transactions?.length ?? 0} active`)

  let scored = 0
  let errors = 0
  const errorDetails: Array<{ id: string; error: string }> = []

  for (const txn of transactionsToScore) {
    try {
      // calculateDealHealth only requires transactionId and brokerageId
      await calculateDealHealth({
        transactionId: txn.id,
        brokerageId:   txn.brokerage_id,
      })
      scored++
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      console.error(`[deal-health/cron] Error scoring transaction ${txn.id}:`, errorMsg)
      errorDetails.push({ id: txn.id, error: errorMsg })
      errors++
    }
  }

  return NextResponse.json({
    success: errors === 0,
    scored,
    errors,
    total: transactionsToScore.length,
    activeTransactions: transactions?.length ?? 0,
    errorDetails: errorDetails.slice(0, 10), // Limit error details
    timestamp: new Date().toISOString(),
  })
}
