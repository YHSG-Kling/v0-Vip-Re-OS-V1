import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization") ?? ""
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

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
    const startOfMonth = new Date()
    startOfMonth.setDate(1)
    startOfMonth.setHours(0, 0, 0, 0)

    const { data: agents, error: agentsError } = await supabase
      .from("agents")
      .select("id, brokerage_id")
      .eq("status", "active")

    if (agentsError) {
      errors.push(`Failed to load agents: ${agentsError.message}`)
    } else {
      for (const agent of agents ?? []) {
        try {
          const { data: commissions } = await supabase
            .from("commission_records")
            .select("gross_commission, agent_net, paid_date")
            .eq("agent_id", agent.id)
            .gte("paid_date", startOfMonth.toISOString().split("T")[0])

          if (commissions && commissions.length > 0) {
            const grossTotal = commissions.reduce((sum, r) => sum + (r.gross_commission ?? 0), 0)
            const netTotal = commissions.reduce((sum, r) => sum + (r.agent_net ?? 0), 0)

            await supabase
              .from("agent_monthly_earnings")
              .upsert(
                {
                  agent_id: agent.id,
                  brokerage_id: agent.brokerage_id,
                  month_year: startOfMonth.toISOString().split("T")[0].slice(0, 7),
                  gross_total: grossTotal,
                  net_total: netTotal,
                  transaction_count: commissions.length,
                  updated_at: new Date().toISOString(),
                },
                { onConflict: "agent_id,month_year" }
              )
              .catch(() => {})

            processed++
          }
        } catch (err: any) {
          errors.push(`Agent ${agent.id}: ${err.message}`)
        }
      }
    }
  } catch (err: any) {
    errors.push(`Earnings rollup failed: ${err.message}`)
    await supabase
      .from("automation_errors")
      .insert({ cron_job: "earnings-rollup", error_message: err.message, occurred_at: ranAt })
      .catch(() => {})
    await recordCronFailureAction({ context_id: contextId, error: err, stage: "main-processing" })
  }

  if (errors.length === 0) {
    await recordCronSuccessAction({ context_id: contextId, records_processed: processed, metadata: { ranAt, errors } })
  }

  return NextResponse.json({ ok: errors.length === 0, ranAt, processed, skipped: 0, errors })
}
