import { NextRequest, NextResponse } from "next/server"
import { distributePendingPlatformLeads } from "@/lib/platform/distribution-engine"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"

/**
 * PLATFORM LEAD-DISTRIBUTION SWEEP CRON (round 38).
 *
 * Engine 1 (lib/platform/distribution-engine.ts) distributes platform-origin
 * leads inline as the pipeline promotes them — but an inline attempt that finds
 * NO subscriber for the lead's zip (no_subscribers_for_zip), or that raced a
 * transient failure, leaves the lead with distribution_brokerage_id NULL and
 * NOTHING ever retried it: distributePendingPlatformLeads existed with no
 * caller. This cron is that caller — the batch sweep that re-runs distribution
 * for every still-pending platform lead, so a subscriber who joins a zip AFTER
 * the leads were scraped starts receiving them without manual intervention.
 *
 * Honest mechanics:
 *   • Every outcome is counted, never papered over: distributed / suppressed
 *     (platform DNC) / noZip / noSubscribers / failed.
 *   • PARKED, NEVER DISCARDED (owner, round 39): every non-distributed outcome
 *     leaves the lead exactly where it was — brokerage_id NULL, is_active TRUE,
 *     nothing deleted, nothing terminally marked. That parked state is what
 *     keeps the AI ISA off the lead (every ISA sweep selects by brokerage_id;
 *     initiate-engagement refuses brokerage-less leads) and keeps it in this
 *     sweep's pending set. noSubscribers means "still nobody in rotation for
 *     the zip — parked until a subscriber joins, then this sweep un-parks it
 *     (assigns the brokerage, stamps distributed_at, and speed-to-lead begins
 *     AI ISA engagement off that stamp)."
 *   • An empty sweep records success with skipped=true — nothing is faked.
 *   • The engine's own idempotent guard (distribution_brokerage_id optimistic
 *     lock) makes re-runs safe; already-distributed leads are never re-routed.
 *   • Result always lands in the cron ledger (cron-kernel actions).
 *
 * REGISTRATION (deliberately NOT wired here — cron-dispatch.ts is owned
 * centrally): registered in lib/kernel/cron-dispatch.ts at every-2-hours
 * (minute 0 of even hours — speed-to-lead without hammering rotation), owned
 * by data_steward in CRON_MANAGER (the platform lead-pipeline steward).
 */
export async function GET(request: NextRequest) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "platform-lead-distribution",
    cron_path: "/app/api/cron/platform-lead-distribution/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const result = await distributePendingPlatformLeads({ limit: 200 })

    if (result.total === 0) {
      await recordCronSuccessAction({
        context_id: contextId,
        records_processed: 0,
        metadata: { skipped: true, reason: "no pending platform-origin leads", ...result },
      })
      return NextResponse.json({ message: "Skipped — no pending platform leads", skipped: true, ...result })
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: result.distributed,
      metadata: {
        total: result.total,
        distributed: result.distributed,
        suppressed: result.suppressed,
        no_zip: result.noZip,
        no_subscribers: result.noSubscribers,
        failed: result.failed,
      },
    })
    return NextResponse.json({ message: "Platform lead distribution sweep complete", ...result })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Platform lead distribution sweep failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
