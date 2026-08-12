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
    cron_name: "earnings-rollup",
    cron_path: "/app/api/cron/earnings-rollup/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[EarningsRollup] Failed to record cron start:", startRecordResult.error)
  }

  const ranAt = new Date().toISOString()
  const supabase = createServiceClient()
  const errors: string[] = []
  let processed = 0

  try {
    const now = new Date()
    const startOfYear = new Date(now.getFullYear(), 0, 1)
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    const yearLabel = `${now.getFullYear()}`
    const monthLabel = startOfMonth.toISOString().slice(0, 7) // YYYY-MM

    const { data: agents, error: agentsError } = await supabase
      .from("agents")
      .select("id, brokerage_id")
      .eq("is_active", true)

    if (agentsError) {
      errors.push(`Failed to load agents: ${agentsError.message}`)
    } else {
      const agg = (rows: Array<{ gross_commission?: number | null; agent_commission?: number | null; brokerage_commission?: number | null }>) => ({
        gross: rows.reduce((s, r) => s + (r.gross_commission ?? 0), 0),
        net: rows.reduce((s, r) => s + (r.agent_commission ?? 0), 0),
        brok: rows.reduce((s, r) => s + (r.brokerage_commission ?? 0), 0),
        count: rows.length,
      })

      for (const agent of agents ?? []) {
        try {
          // Read agent_commissions — the canonical, populated commission table (the
          // commission engine writes it on close). commission_records was a dead table
          // (never written), so the old rollup produced $0. Recognize GCI at CLOSE
          // (close_date is always set; payout via paid_at can lag).
          const { data: ytdRows } = await supabase
            .from("agent_commissions")
            .select("gross_commission, agent_commission, brokerage_commission, close_date")
            .eq("agent_id", agent.id)
            .gte("close_date", startOfYear.toISOString())

          if (!ytdRows || ytdRows.length === 0) continue
          const mtdRows = ytdRows.filter((r) => r.close_date && new Date(r.close_date) >= startOfMonth)
          const y = agg(ytdRows)
          const m = agg(mtdRows)
          const computedAt = new Date().toISOString()

          // Populate agent_earnings — THE table the earnings P&L dashboard reads
          // (period_type mtd/ytd). Without this the dashboard showed $0 on closed
          // deals because the close path never aggregated agent_commissions here.
          const upsertEarnings = (period_type: "mtd" | "ytd", period_label: string, a: ReturnType<typeof agg>) =>
            supabase.from("agent_earnings").upsert(
              {
                agent_id: agent.id,
                brokerage_id: agent.brokerage_id,
                period_type,
                period_label,
                gross_commission: a.gross,
                agent_net: a.net,
                brokerage_net: a.brok,
                total_fees: 0,
                transaction_count: a.count,
                computed_at: computedAt,
              },
              { onConflict: "agent_id,period_type,period_label" }
            )

          await Promise.all([
            upsertEarnings("ytd", yearLabel, y),
            upsertEarnings("mtd", monthLabel, m),
            // Keep agent_monthly_earnings (separate monthly history table) populated too.
            supabase.from("agent_monthly_earnings").upsert(
              {
                agent_id: agent.id,
                brokerage_id: agent.brokerage_id,
                month_year: monthLabel,
                gross_total: m.gross,
                net_total: m.net,
                transaction_count: m.count,
                updated_at: computedAt,
              },
              { onConflict: "agent_id,month_year" }
            ),
          ])
          processed++
        } catch (err: any) {
          errors.push(`Agent ${agent.id}: ${err.message}`)
        }
      }
    }
  } catch (err: any) {
    errors.push(`Earnings rollup failed: ${err.message}`)
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
    const { error: earnings_rollup_log_error } = await supabase
      .from("automation_errors")
      .insert({ brokerage_id: null, workflow_name: "earnings-rollup", error_message: err.message, severity: "error", created_at: ranAt })
    if (earnings_rollup_log_error) {
      // The ORIGINAL failure is already in `errors` and in the response body, so a
      // failure to FILE it is reported beside it and never replaces it.
      console.error("[EarningsRollup] automation_errors insert refused:", earnings_rollup_log_error.message)
    }
    await recordCronFailureAction({ context_id: contextId, error: err, stage: "main-processing" })
  }

  if (errors.length === 0) {
    await recordCronSuccessAction({ context_id: contextId, records_processed: processed, metadata: { ranAt, errors } })
  }

  return NextResponse.json({ ok: errors.length === 0, ranAt, processed, skipped: 0, errors })
}
