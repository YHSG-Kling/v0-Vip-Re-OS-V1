import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization") ?? ""
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  const ranAt = new Date().toISOString()
  const supabase = createServiceClient()
  const errors: string[] = []
  let processed = 0

  try {
    const { data: brokerages } = await supabase
      .from("brokerages")
      .select("id")
      .eq("status", "active")

    for (const brokerage of brokerages ?? []) {
      try {
        const today = new Date().toISOString().split("T")[0]

        const { data: agents } = await supabase
          .from("agents")
          .select("id")
          .eq("brokerage_id", brokerage.id)
          .eq("status", "active")

        const agentIds = (agents ?? []).map((a) => a.id)
        if (agentIds.length === 0) continue

        const { data: activities } = await supabase
          .from("activities")
          .select("agent_id")
          .in("agent_id", agentIds)
          .gte("created_at", today)

        const activityCount = activities?.length ?? 0

        await supabase
          .from("team_activity_snapshots")
          .upsert(
            {
              brokerage_id: brokerage.id,
              snapshot_date: today,
              agent_count: agentIds.length,
              total_activities: activityCount,
              avg_per_agent: agentIds.length > 0 ? activityCount / agentIds.length : 0,
              created_at: ranAt,
            },
            { onConflict: "brokerage_id,snapshot_date" }
          )
          .catch(() => {})

        processed++
      } catch (err: any) {
        errors.push(`Brokerage ${brokerage.id}: ${err.message}`)
      }
    }
  } catch (err: any) {
    errors.push(`Team heatmap snapshot failed: ${err.message}`)
    await supabase
      .from("automation_errors")
      .insert({ cron_job: "team-heatmap-snapshot", error_message: err.message, occurred_at: ranAt })
      .catch(() => {})
  }

  return NextResponse.json({ ok: errors.length === 0, ranAt, processed, skipped: 0, errors })
}
