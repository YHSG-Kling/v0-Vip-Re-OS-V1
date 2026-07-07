import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { runShowingLifecycle } from "@/lib/kernel/showing-lifecycle"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"

/**
 * Showing Lifecycle Cron — hourly: feedback auto-requests for completed
 * showings + T-24h buyer reminders (portal + transactional SMS), virtual-tour
 * aware. See lib/kernel/showing-lifecycle.ts.
 */
export async function GET(request: NextRequest) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "showing-lifecycle",
    cron_path: "/app/api/cron/showing-lifecycle/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const svc = createServiceClient()
    const summary = await runShowingLifecycle(svc)
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: summary.feedbackRequested + summary.remindersSent,
      metadata: summary as any,
    })
    return NextResponse.json({ message: "Showing lifecycle sweep complete", summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Sweep failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
