import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { aggregateMetrics } from "@/lib/territory/metrics-aggregator"
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
    cron_name: "territory-metrics",
    cron_path: "/app/api/cron/territory-metrics/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[TerritoryMetrics] Failed to record cron start:", startRecordResult.error)
  }

  try {
    const supabase = createServiceClient()
    const today = new Date().toISOString().split("T")[0]

    const { data: brokerages, error: brokeragesError } = await supabase
      .from("brokerages")
      .select("id")
      .eq("is_active", true)

    if (brokeragesError) {
      console.error("[cron/territory-metrics] Failed to load brokerages:", brokeragesError.message)
      await recordCronFailureAction({ context_id: contextId, error: brokeragesError, stage: "database-fetch" })
      return NextResponse.json({ ok: false, error: brokeragesError.message, context_id: contextId }, { status: 500 })
    }

    const results: { brokerageId: string; zipsProcessed: number; errors: string[] }[] = []

    for (const brokerage of brokerages ?? []) {
      try {
        const result = await aggregateMetrics(brokerage.id, today)
        results.push({
          brokerageId: result.brokerageId,
          zipsProcessed: result.zipsProcessed,
          errors: result.errors,
        })
      } catch (err) {
        console.error(`[cron/territory-metrics] Brokerage ${brokerage.id} failed:`, err)
        results.push({
          brokerageId: brokerage.id,
          zipsProcessed: 0,
          errors: [err instanceof Error ? err.message : String(err)],
        })
      }
    }

    const totalZips = results.reduce((s, r) => s + r.zipsProcessed, 0)
    const totalErrors = results.reduce((s, r) => s + r.errors.length, 0)

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: results.length,
      output_count: totalZips,
      metadata: { date: today, brokeragesProcessed: results.length, totalZipsProcessed: totalZips, totalErrors },
    })

    return NextResponse.json({
      ok: true,
      date: today,
      brokeragesProcessed: results.length,
      totalZipsProcessed: totalZips,
      totalErrors,
      results,
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    console.error("[TerritoryMetrics] Cron failed:", error)
    await recordCronFailureAction({ context_id: contextId, error: error as Error | string, stage: "main-processing" })
    return NextResponse.json({ ok: false, error: errorMessage, context_id: contextId }, { status: 500 })
  }
}
