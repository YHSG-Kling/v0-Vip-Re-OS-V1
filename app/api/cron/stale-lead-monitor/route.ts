import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { processStaleLeadsAndSLA } from "@/lib/lead-governance/stale-lead-processor"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"

export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const contextResult = await createCronRunContextAction({
    cron_name: "stale-lead-monitor",
    cron_path: "/app/api/cron/stale-lead-monitor/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[StaleLeadMonitor] Failed to record cron start:", startRecordResult.error)
  }

  try {
    const supabase = createServiceClient()

    const { data: brokerages, error } = await supabase
      .from("brokerages")
      .select("id")
      .eq("is_active", true)

    if (error) {
      await recordCronFailureAction({ context_id: contextId, error, stage: "database-fetch" })
      return NextResponse.json({ error: error.message, context_id: contextId }, { status: 500 })
    }

    const results: Array<{ brokerageId: string; breachedCount: number; staleCount: number; errors: string[] }> = []

    for (const brokerage of brokerages ?? []) {
      try {
        const result = await processStaleLeadsAndSLA(brokerage.id)
        results.push(result)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.push({ brokerageId: brokerage.id, breachedCount: 0, staleCount: 0, errors: [msg] })
      }
    }

    const totalBreached = results.reduce((sum, r) => sum + r.breachedCount, 0)
    const totalStale    = results.reduce((sum, r) => sum + r.staleCount, 0)
    const totalErrors   = results.flatMap((r) => r.errors)

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: results.length,
      metadata: { brokeragesProcessed: results.length, totalBreached, totalStale, errorCount: totalErrors.length },
    })

    return NextResponse.json({
      ok: true,
      brokeragesProcessed: results.length,
      totalBreached,
      totalStale,
      errors: totalErrors,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    console.error("[StaleLeadMonitor] Cron failed:", error)
    await recordCronFailureAction({ context_id: contextId, error: error as Error | string, stage: "main-processing" })
    return NextResponse.json({ ok: false, error: errorMessage, context_id: contextId }, { status: 500 })
  }
}
