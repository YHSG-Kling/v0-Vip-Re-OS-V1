import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { runSupportSlaSweep } from "@/lib/support/support-sla"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"

/**
 * Support SLA Cron — hourly breach detection over open tickets. Escalates each
 * (ticket, breach kind) to platform staff exactly once. See lib/support/support-sla.ts.
 */
export async function GET(request: NextRequest) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "support-sla",
    cron_path: "/app/api/cron/support-sla/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const svc = createServiceClient()
    const summary = await runSupportSlaSweep(svc)
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: summary.escalated,
      metadata: summary as any,
    })
    return NextResponse.json({ message: "Support SLA sweep complete", summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "SLA sweep failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
