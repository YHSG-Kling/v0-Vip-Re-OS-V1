import {
NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export async function GET(req: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "referral-asks",
    cron_path: "/app/api/cron/referral-asks/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[ReferralAsks] Failed to record cron start:", startRecordResult.error)
  }

  const ranAt = new Date().toISOString()
  const supabase = createServiceClient()
  const errors: string[] = []
  let processed = 0
  let skipped = 0

  try {
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

    const { data: transactions, error } = await supabase
      .from("transactions")
      .select("id, agent_id, contact_id, property_address, close_date")
      .eq("status", "closed")
      .gte("close_date", thirtyDaysAgo.split("T")[0])
      .lte("close_date", fourteenDaysAgo.split("T")[0])
      .limit(30)

    if (error) {
      errors.push(`Transactions query failed: ${error.message}`)
    } else {
      for (const tx of transactions ?? []) {
        try {
          await supabase.from("activities").insert({
            agent_id: tx.agent_id,
            contact_id: tx.contact_id,
            activity_type: "referral_ask_due",
            title: `Request a referral from your recent closing`,
            description: `${tx.property_address} closed recently. Great time to ask for referrals.`,
            status: "pending",
            priority: "medium",
            metadata: { transaction_id: tx.id },
          })
          processed++
        } catch (err: any) {
          skipped++
          errors.push(`Tx ${tx.id}: ${err.message}`)
        }
      }
    }
  } catch (err: any) {
    errors.push(`Referral asks cron failed: ${err.message}`)
    void supabase
      .from("automation_errors")
      .insert({ workflow_name: "referral-asks", error_message: err.message, severity: "error", created_at: ranAt })
    await recordCronFailureAction({ context_id: contextId, error: err, stage: "main-processing" })
  }

  if (errors.length === 0) {
    await recordCronSuccessAction({ context_id: contextId, records_processed: processed, metadata: { ranAt, skipped, errors } })
  }

  return NextResponse.json({ ok: errors.length === 0, ranAt, processed, skipped, errors })
}
