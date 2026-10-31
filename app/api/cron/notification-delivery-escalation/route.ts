import { NextResponse } from "next/server"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { escalateFailedNotificationDeliveries } from "@/lib/transactions/notification-service"

/**
 * GET /api/cron/notification-delivery-escalation
 * (lib/kernel/cron-dispatch.ts, "*\/30 * * * *" — every 30 min.)
 *
 * READER for `notification_log.delivery_channel` / `.status` / `.response`
 * (readerless-write-census — the columns lib/transactions/notification-
 * service.ts::logNotification writes on every send attempt and nothing read).
 * See lib/transactions/notification-service.ts::escalateFailedNotificationDeliveries
 * for why this escalates repeat channel failures rather than blind-retrying.
 *
 * Owner: deal_coordinator (CRON_MANAGER, lib/kernel/manager-registry.ts) —
 * transaction delivery outcomes are that manager's domain.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 120

export async function GET(request: Request) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "notification-delivery-escalation",
    cron_path: "/app/api/cron/notification-delivery-escalation/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[NotificationDeliveryEscalation] Failed to record cron start:", startRecordResult.error)
  }

  try {
    const { scanned, escalated } = await escalateFailedNotificationDeliveries()

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: scanned,
      output_count: escalated,
      metadata: { scanned, escalated },
    })

    return NextResponse.json({ success: true, scanned, escalated })
  } catch (err) {
    console.error("[Cron notification-delivery-escalation] Error:", err)
    await recordCronFailureAction({ context_id: contextId, error: err as Error | string, stage: "main-processing" })
    return NextResponse.json(
      { error: "Cron execution failed", message: err instanceof Error ? err.message : "Unknown error", context_id: contextId },
      { status: 500 }
    )
  }
}
