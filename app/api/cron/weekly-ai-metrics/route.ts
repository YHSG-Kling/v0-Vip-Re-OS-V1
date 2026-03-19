import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { computeWeeklyMetrics } from "@/lib/intelligence/feedback-aggregator"

export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function GET(request: NextRequest) {
  try {
    // Verify CRON_SECRET
    const authHeader = request.headers.get("authorization")
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

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

    return NextResponse.json({
      ok: true,
      brokerages_processed: processedCount,
      week_start: weekStart.toISOString(),
    })
  } catch (error) {
    console.error("[WeeklyAIMetrics] Unexpected error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
