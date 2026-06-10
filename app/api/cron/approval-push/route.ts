import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { enqueueApprovalNotifications } from "@/lib/intelligence/mobile-approval-queue"

/**
 * APPROVAL-PUSH cron (every 2h) — approval latency is the egress's critical path.
 * Two-tier: the responsible AGENT is alerted on every pending approval (front line);
 * the brokerage's MANAGERS are escalated only when a deliverable has sat unapproved for
 * 4+ hours. Idempotent per (user, message, type), so re-running won't spam.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "approval-push",
    cron_path: "/app/api/cron/approval-push/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let agentAlerts = 0
  let managerEscalations = 0

  try {
    // Brokerages with pending proposals.
    const { data: pendRows, error } = await supabase
      .from("agent_client_messages")
      .select("brokerage_id")
      .eq("status", "proposed")
      .limit(5000)
    if (error) throw error
    const brokerages = Array.from(new Set(((pendRows ?? []) as Array<{ brokerage_id: string }>).map((r) => r.brokerage_id)))

    for (const brokerageId of brokerages) {
      try {
        // Self-resolving two-tier push: agents (front line) + manager escalation at 4h.
        const r = await enqueueApprovalNotifications(brokerageId, supabase)
        agentAlerts += r.agentAlerts
        managerEscalations += r.managerEscalations
      } catch (e: any) {
        errors.push(`${brokerageId}: ${e?.message ?? String(e)}`)
      }
    }

    await recordCronSuccessAction({
      context_id: contextId, records_processed: agentAlerts + managerEscalations,
      metadata: { agentAlerts, managerEscalations, brokerages: brokerages.length, errors: errors.slice(0, 20) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, agentAlerts, managerEscalations, brokerages: brokerages.length, errors: errors.length })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
