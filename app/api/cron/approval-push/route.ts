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
 * APPROVAL-PUSH cron (every 2h) — approval latency is the egress's critical path. For
 * each brokerage with DUE/BREACHED pending approvals, push a notification to its
 * broker/admin users (deep-linked to the mobile approval queue). Idempotent per
 * (message, user), so re-running won't spam.
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
  let enqueued = 0

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
        // The brokerage's approvers (broker/admin). Push to each.
        const { data: approvers } = await supabase
          .from("users").select("id").eq("brokerage_id", brokerageId)
          .in("user_type", ["broker", "broker_admin", "admin"]).limit(20)
        for (const a of (approvers ?? []) as Array<{ id: string }>) {
          const r = await enqueueApprovalNotifications(brokerageId, a.id, supabase)
          enqueued += r.enqueued
        }
      } catch (e: any) {
        errors.push(`${brokerageId}: ${e?.message ?? String(e)}`)
      }
    }

    await recordCronSuccessAction({
      context_id: contextId, records_processed: enqueued,
      metadata: { enqueued, brokerages: brokerages.length, errors: errors.slice(0, 20) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, enqueued, brokerages: brokerages.length, errors: errors.length })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
