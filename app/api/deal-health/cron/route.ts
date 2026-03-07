/**
 * Deal Health Cron — Daily at 6am
 * 
 * Scores all active transactions that haven't been scored in the last 20 hours.
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
  // Active = not in CLOSED or LOST stage
  const { data: transactions, error: txnError } = await supabase
    .from("transactions")
    .select(`
      id,
      brokerage_id,
      contact_id,
      stage,
      deal_health_scores(calculated_at)
    `)
    .not("stage", "in", "(CLOSED,LOST)")

  if (txnError) {
    console.error("[deal-health/cron] Error fetching transactions:", txnError)
    return NextResponse.json({ error: txnError.message }, { status: 500 })
  }

  // Filter to transactions not scored recently
  const transactionsToScore = (transactions ?? []).filter(txn => {
    const scores = txn.deal_health_scores as Array<{ calculated_at: string }> | null
    if (!scores || scores.length === 0) return true
    const lastScored = new Date(scores[0].calculated_at)
    return lastScored < twentyHoursAgo
  })

  console.log(`[deal-health/cron] Found ${transactionsToScore.length} transactions to score`)

  let scored = 0
  let errors = 0

  for (const txn of transactionsToScore) {
    try {
      await calculateDealHealth({
        transactionId: txn.id,
        brokerageId:   txn.brokerage_id,
        contactId:     txn.contact_id,
      })
      scored++
    } catch (error) {
      console.error(`[deal-health/cron] Error scoring transaction ${txn.id}:`, error)
      errors++
    }
  }

  return NextResponse.json({
    success: true,
    scored,
    errors,
    total: transactionsToScore.length,
    timestamp: new Date().toISOString(),
  })
}
