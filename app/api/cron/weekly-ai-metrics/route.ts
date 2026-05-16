import {
NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { computeWeeklyMetrics } from "@/lib/intelligence/feedback-aggregator"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function GET(request: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "weekly-ai-metrics",
    cron_path: "/app/api/cron/weekly-ai-metrics/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[WeeklyAIMetrics] Failed to record cron start:", startRecordResult.error)
  }

  try {
    const supabase = createServiceClient()

    // Calculate last Monday as week start
    const now = new Date()
    const dayOfWeek = now.getDay()
    const daysToSubtract = dayOfWeek === 0 ? 6 : dayOfWeek - 1
    const weekStart = new Date(now)
    weekStart.setDate(now.getDate() - daysToSubtract - 7) // Last week's Monday
    weekStart.setHours(0, 0, 0, 0)

    // Get distinct brokerages with recent feedback
    const { data: brokerages, error: brokerageError } = await supabase
      .from("ai_feedback_log")
      .select("brokerage_id")
      .gte("created_at", weekStart.toISOString())

    if (brokerageError) {
      console.error("[WeeklyAIMetrics] Error fetching brokerages:", brokerageError)
      return NextResponse.json(
        { error: "Failed to fetch brokerages" },
        { status: 500 }
      )
    }

    // Get unique brokerage IDs
    const uniqueBrokerageIds = [
      ...new Set(brokerages?.map((b) => b.brokerage_id) || []),
    ]

    let processedCount = 0

    for (const brokerageId of uniqueBrokerageIds) {
      try {
        const result = await computeWeeklyMetrics(brokerageId, weekStart)
        if (result.systemsProcessed > 0) {
          processedCount++
        }
      } catch (error) {
        console.error(`[WeeklyAIMetrics] Error processing brokerage ${brokerageId}:`, error)
      }
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: processedCount,
      metadata: { brokerages_processed: processedCount, week_start: weekStart.toISOString() },
    })

    return NextResponse.json({
      ok: true,
      brokerages_processed: processedCount,
      week_start: weekStart.toISOString(),
    })
  } catch (error) {
    console.error("[WeeklyAIMetrics] Unexpected error:", error)
    await recordCronFailureAction({ context_id: contextId, error: error as Error | string, stage: "main-processing" })
    return NextResponse.json({ error: "Internal server error", context_id: contextId }, { status: 500 })
  }
}
