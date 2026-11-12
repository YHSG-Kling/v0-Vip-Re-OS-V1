import { NextResponse } from "next/server"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runVendorFollowUpCadence } from "@/lib/communications/vendor-follow-up-cadence"

/**
 * GET /api/cron/vendor-follow-up-cadence
 * (lib/kernel/cron-dispatch.ts, "0 14 * * *" — daily.)
 *
 * READER for vendor_communications.sent_at / .communication_type / .service_id
 * (readerless-write-census). See lib/communications/vendor-follow-up-cadence.ts
 * for the cadence rule.
 *
 * Owner: asset_manager (CRON_MANAGER, lib/kernel/manager-registry.ts).
 */
export const dynamic = "force-dynamic"
export const maxDuration = 120

export async function GET(request: Request) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "vendor-follow-up-cadence",
    cron_path: "/app/api/cron/vendor-follow-up-cadence/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[VendorFollowUpCadence] Failed to record cron start:", startRecordResult.error)
  }

  try {
    const { scanned, reminded, skippedCooldown, errors } = await runVendorFollowUpCadence()

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: scanned,
      output_count: reminded,
      metadata: { scanned, reminded, skippedCooldown, errors },
    })

    return NextResponse.json({ success: true, scanned, reminded, skippedCooldown, errors })
  } catch (err) {
    console.error("[Cron vendor-follow-up-cadence] Error:", err)
    await recordCronFailureAction({ context_id: contextId, error: err as Error | string, stage: "main-processing" })
    return NextResponse.json(
      { error: "Cron execution failed", message: err instanceof Error ? err.message : "Unknown error", context_id: contextId },
      { status: 500 }
    )
  }
}
