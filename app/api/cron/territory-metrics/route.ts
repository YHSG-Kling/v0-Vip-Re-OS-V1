import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { aggregateMetrics } from "@/lib/territory/metrics-aggregator"

export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = createServiceClient()
  const today = new Date().toISOString().split("T")[0] // YYYY-MM-DD

  // Load all active brokerages
  const { data: brokerages, error: brokeragesError } = await supabase
    .from("brokerages")
    .select("id")
    .eq("is_active", true)

  if (brokeragesError) {
    console.error("[cron/territory-metrics] Failed to load brokerages:", brokeragesError.message)
    return NextResponse.json({ ok: false, error: brokeragesError.message }, { status: 500 })
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

  return NextResponse.json({
    ok: true,
    date: today,
    brokeragesProcessed: results.length,
    totalZipsProcessed: totalZips,
    totalErrors,
    results,
  })
}
