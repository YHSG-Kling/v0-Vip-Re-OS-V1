export const dynamic = "force-dynamic"

import {
NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export async function GET(request: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "automation-error-monitor",
    cron_path: "/app/api/cron/automation-error-monitor/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[AutomationErrorMonitor] Failed to record cron start:", startRecordResult.error)
  }

  try {
    const supabase = await createClient()

    const { count, error } = await supabase
      .from("automation_errors")
      .select("id", { count: "exact", head: true })
      .eq("status", "open")

    if (error) {
      await recordCronFailureAction({ context_id: contextId, error, stage: "database-query" })
      return NextResponse.json({ error: error.message, context_id: contextId }, { status: 500 })
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: count || 0,
      metadata: { unresolved_count: count || 0 },
    })

    return NextResponse.json({
      message: "Automation error monitor completed",
      unresolved_count: count || 0,
    })
  } catch (error) {
    console.error("[automation-error-monitor] error:", error)
    await recordCronFailureAction({ context_id: contextId, error: error as Error | string, stage: "main-processing" })
    return NextResponse.json(
      { error: "Monitor failed", details: error instanceof Error ? error.message : "Unknown", context_id: contextId },
      { status: 500 }
    )
  }
}
