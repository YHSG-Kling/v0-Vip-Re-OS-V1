import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { runSupportSlaSweep, runSupportLoopSweep } from "@/lib/support/support-sla"
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
 * (ticket, breach kind) to the side that answers its lane exactly once. See lib/support/support-sla.ts.
 *
 * Then the CLOSED-LOOP RECOVERY sweep (wave 147, lane 147H — owner ruling 15): re-triage a ticket the in-request
 * triage never reached, the second-tier page, the evidenced close of a long-resolved ticket, a missing resolved_at.
 * Cron is RECOVERY here (ruling 13) — the event path (the door's in-request triage → the owner's inbox; lane 147G's
 * C14 completion supervision) drives the loop, and every act this sweep takes is stamped recovered_by: "cron".
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
    const sla = await runSupportSlaSweep(svc)
    const loop = await runSupportLoopSweep(svc)
    const summary = { ...sla, loop }
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: sla.escalated + loop.retriaged + loop.secondTier + loop.autoClosed + loop.repaired,
      metadata: summary as any,
    })
    return NextResponse.json({ message: "Support SLA sweep complete", summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "SLA sweep failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
