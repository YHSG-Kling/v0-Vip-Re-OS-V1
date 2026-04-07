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
    cron_name: "engagement-scores",
    cron_path: "/app/api/cron/engagement-scores/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[EngagementScores] Failed to record cron start:", startRecordResult.error)
  }

  const ranAt = new Date().toISOString()
  const supabase = createServiceClient()
  const errors: string[] = []
  let processed = 0

  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

    const { data: recentActivities } = await supabase
      .from("activities")
      .select("contact_id")
      .gte("created_at", sevenDaysAgo)
      .not("contact_id", "is", null)

    const contactIds = [
      ...new Set((recentActivities ?? []).map((a) => a.contact_id).filter(Boolean)),
    ] as string[]

    for (const contactId of contactIds.slice(0, 100)) {
      try {
        const { count } = await supabase
          .from("activities")
          .select("*", { count: "exact", head: true })
          .eq("contact_id", contactId)
          .gte("created_at", thirtyDaysAgo)

        const score = Math.min(100, (count ?? 0) * 10)

        await supabase
          .from("contacts")
          .update({ engagement_score: score, updated_at: new Date().toISOString() })
          .eq("id", contactId)

        processed++
      } catch (err: any) {
        errors.push(`Contact ${contactId}: ${err.message}`)
      }
    }
  } catch (err: any) {
    errors.push(`Engagement scores cron failed: ${err.message}`)
    void supabase
      .from("automation_errors")
      .insert({ cron_job: "engagement-scores", error_message: err.message, occurred_at: ranAt })
    await recordCronFailureAction({ context_id: contextId, error: err, stage: "main-processing" })
  }

  if (errors.length === 0) {
    await recordCronSuccessAction({ context_id: contextId, records_processed: processed, metadata: { ranAt, errors } })
  }

  return NextResponse.json({ ok: errors.length === 0, ranAt, processed, skipped: 0, errors })
}
