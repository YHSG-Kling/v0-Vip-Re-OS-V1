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
  let reciprocityFlagged = 0
  let reciprocityLinked = 0

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

    // REFERRAL-RECIPROCITY TRACKER (Sphere) — per brokerage, flag one-sided partner
    // relationships (they refer us, we don't reciprocate) so the agent protects their best
    // referrers. Honest: outbound is only counted for partners linked to a vendor.
    const { runReferralReciprocity } = await import("@/lib/referrals/referral-reciprocity-runner")
    const { runPartnerAgreementWatch } = await import("@/lib/referrals/partner-agreement-watch")
    const { data: brokerages } = await supabase.from("brokerages").select("id").is("deleted_at", null)
    for (const b of (brokerages ?? []) as Array<{ id: string }>) {
      try {
        const rec = await runReferralReciprocity({ brokerageId: b.id }, supabase)
        reciprocityFlagged += rec.escalated
        reciprocityLinked += rec.linked
      } catch (e: any) { errors.push(`reciprocity ${b.id}: ${e?.message ?? String(e)}`) }
      // PARTNER AGREEMENT EXPIRY WATCH — a referral fee agreement lapsing
      // silently is a commission-dispute exposure; one gated renewal
      // escalation per partner, deduped per open signal.
      try {
        await runPartnerAgreementWatch(supabase as any, { brokerageId: b.id })
      } catch (e: any) { errors.push(`agreement-watch ${b.id}: ${e?.message ?? String(e)}`) }
    }
  } catch (err: any) {
    errors.push(`Referral asks cron failed: ${err.message}`)
    // PLATFORM-WIDE FAILURE, WRITTEN DELIBERATELY UNTENANTED — the one place in
    // this wave where no tenant is the honest answer, and it is defended rather
    // than assumed.
    //
    // This catch is the OUTER catch of a sweep that runs across EVERY brokerage
    // (the per-item failures are caught inside the loop and pushed to `errors`).
    // What failed is the job, not one tenant's work, so there is no record to
    // resolve a tenant through and inventing one would attribute a platform
    // outage to whichever brokerage happened to be first.
    //
    // Writing it untenanted is not "a row nobody can read", which is the rule
    // this wave otherwise follows. Measured, not assumed: `lib/platform/ai-ops.ts:73`
    // reads `automation_errors` CROSS-TENANT on the service client with NO
    // brokerage predicate (`.not("status","in","(resolved,dismissed)")`), its row
    // type carries `brokerageId: string | null` explicitly, and
    // `app/actions/superadmin/ai-ops.ts:resolveAutomationErrorAction` resolves by
    // id with no brokerage predicate either. So this row IS visible and IS
    // resolvable — on the platform AI-ops console, which is exactly the audience
    // a platform-wide cron failure belongs to, and is invisible to tenants, which
    // is exactly right for a failure that is not theirs.
    //
    // The `void` fire-and-forget it replaces discarded the insert's own outcome,
    // so a refused error-log looked identical to a filed one.
    const { error: referral_asks_log_error } = await supabase
      .from("automation_errors")
      .insert({ brokerage_id: null, workflow_name: "referral-asks", error_message: err.message, severity: "error", created_at: ranAt })
    if (referral_asks_log_error) {
      // The ORIGINAL failure is already in `errors` and in the response body, so a
      // failure to FILE it is reported beside it and never replaces it.
      console.error("[ReferralAsks] automation_errors insert refused:", referral_asks_log_error.message)
    }
    await recordCronFailureAction({ context_id: contextId, error: err, stage: "main-processing" })
  }

  if (errors.length === 0) {
    await recordCronSuccessAction({ context_id: contextId, records_processed: processed, metadata: { ranAt, skipped, errors } })
  }

  return NextResponse.json({ ok: errors.length === 0, ranAt, processed, skipped, errors })
}
