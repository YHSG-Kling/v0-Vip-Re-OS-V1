import { NextResponse } from "next/server"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { sweepStaleClosedListingSphereHandoffs } from "@/lib/transactions/stale-listing-sphere-sweep"

/**
 * GET /api/cron/stale-listing-sphere-sweep
 * (lib/kernel/cron-dispatch.ts, "0 7 * * *" — daily, after the listing/
 * transaction close activity from the prior day has settled.)
 *
 * Closes the gap named in lib/transactions/stale-listing-sphere-sweep.ts: a
 * listing whose lifecycle_stage reaches CLOSED while its LINKED transaction
 * never reaches its own terminal stage gets no "deal_closed" handoff to
 * sphere_of_influence from either existing producer (see that file's header
 * for the full account of both producers and why neither fires here).
 *
 * Owner: deal_coordinator (CRON_MANAGER, lib/kernel/manager-registry.ts) —
 * this is the transaction-linked half of the seller-to-lifetime handoff,
 * the same manager app/actions/transaction-stage-machine.ts's own producer
 * publishes as.
 */
export const dynamic = "force-dynamic"
export const maxDuration = 120

export async function GET(request: Request) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "stale-listing-sphere-sweep",
    cron_path: "/app/api/cron/stale-listing-sphere-sweep/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[StaleListingSphereSweep] Failed to record cron start:", startRecordResult.error)
  }

  try {
    const { scanned, published, handledByTransaction, alreadySignaled, errors } =
      await sweepStaleClosedListingSphereHandoffs()

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: scanned,
      output_count: published,
      metadata: { scanned, published, handledByTransaction, alreadySignaled, errors },
    })

    return NextResponse.json({ success: true, scanned, published, handledByTransaction, alreadySignaled, errors })
  } catch (err) {
    console.error("[Cron stale-listing-sphere-sweep] Error:", err)
    await recordCronFailureAction({ context_id: contextId, error: err as Error | string, stage: "main-processing" })
    return NextResponse.json(
      { error: "Cron execution failed", message: err instanceof Error ? err.message : "Unknown error", context_id: contextId },
      { status: 500 }
    )
  }
}
