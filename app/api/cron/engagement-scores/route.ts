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
      .insert({ workflow_name: "engagement-scores", error_message: err.message, severity: "error", created_at: ranAt })
    await recordCronFailureAction({ context_id: contextId, error: err, stage: "main-processing" })
  }

  if (errors.length === 0) {
    await recordCronSuccessAction({ context_id: contextId, records_processed: processed, metadata: { ranAt, errors } })
  }

  return NextResponse.json({ ok: errors.length === 0, ranAt, processed, skipped: 0, errors })
}
