export const dynamic = "force-dynamic"

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
    const supabase = createServiceClient()

    const { count, error } = await supabase
      .from("automation_errors")
      .select("id", { count: "exact", head: true })
      .eq("status", "open")

    if (error) {
      await recordCronFailureAction({ context_id: contextId, error, stage: "database-query" })
      return NextResponse.json({ error: error.message, context_id: contextId }, { status: 500 })
    }

    // OS Sentinel reflex — escalate an overall-breach state + fold in the
    // credential-rotation escalation. Best-effort; never fails the monitor.
    let sentinel: Awaited<ReturnType<typeof import("@/lib/platform/os-sentinel").runOsSentinelSweep>> | null = null
    try {
      const { runOsSentinelSweep } = await import("@/lib/platform/os-sentinel")
      sentinel = await runOsSentinelSweep(supabase)
    } catch (err) {
      console.warn("[automation-error-monitor] os-sentinel sweep failed:", (err as any)?.message)
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: count || 0,
      metadata: { unresolved_count: count || 0, os_sentinel: sentinel },
    })

    return NextResponse.json({
      message: "Automation error monitor completed",
      unresolved_count: count || 0,
      os_sentinel: sentinel,
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
