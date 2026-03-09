import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { calibrateSystemPrompts } from "@/lib/intelligence/prompt-calibrator"

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

    // Get brokerages with underperforming metrics in last 2 weeks
    const twoWeeksAgo = new Date()
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14)

    const { data: underperformingBrokerages, error: metricsError } = await supabase
      .from("ai_improvement_metrics")
      .select("brokerage_id")
      .lt("approval_rate", 70)
      .gte("week_start", twoWeeksAgo.toISOString().split("T")[0])

    if (metricsError) {
      console.error("[PromptCalibration] Error fetching underperforming brokerages:", metricsError)
      return NextResponse.json(
        { error: "Failed to fetch metrics" },
        { status: 500 }
      )
    }

    // Get unique brokerage IDs
    const uniqueBrokerageIds = [
      ...new Set(underperformingBrokerages?.map((b) => b.brokerage_id) || []),
    ]

    let calibrationsGenerated = 0

    for (const brokerageId of uniqueBrokerageIds) {
      try {
        const result = await calibrateSystemPrompts(brokerageId)
        calibrationsGenerated += result.calibrations.length
      } catch (error) {
        console.error(`[PromptCalibration] Error calibrating brokerage ${brokerageId}:`, error)
      }
    }

    return NextResponse.json({
      ok: true,
      calibrations_generated: calibrationsGenerated,
      brokerages_checked: uniqueBrokerageIds.length,
    })
  } catch (error) {
    console.error("[PromptCalibration] Unexpected error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
