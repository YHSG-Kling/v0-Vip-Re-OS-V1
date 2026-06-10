import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { sweepCompletedVendorBookings } from "@/lib/agents/vendor-loop-producer"

/**
 * Daily VENDOR REVIEW-REQUEST sweep — a safety net for the vendor marketplace loop.
 * The completion path already proposes a review request inline; this catches any
 * completed booking (last 7 days) that didn't get one and proposes it into the gate.
 * Idempotent per booking (the Sphere proposal de-dupes), so re-running is safe.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "vendor-review-requests",
    cron_path: "/app/api/cron/vendor-review-requests/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let proposed = 0
  let scanned = 0

  try {
    const { data: rows, error } = await supabase
      .from("vendor_bookings")
      .select("brokerage_id")
      .eq("status", "completed")
      .not("contact_id", "is", null)
      .gte("completed_at", new Date(Date.now() - 7 * 86_400_000).toISOString())
      .limit(2000)
    if (error) throw error

    const brokerages = Array.from(new Set(((rows ?? []) as Array<{ brokerage_id: string }>).map((r) => r.brokerage_id)))
    for (const brokerageId of brokerages) {
      try {
        const r = await sweepCompletedVendorBookings(brokerageId, supabase)
        proposed += r.proposed
        scanned += r.scanned
      } catch (e: any) {
        errors.push(`${brokerageId}: ${e?.message ?? String(e)}`)
      }
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: proposed,
      metadata: { proposed, scanned, brokerages: brokerages.length, errors },
    }).catch(() => {})
    return NextResponse.json({ ok: true, proposed, scanned, brokerages: brokerages.length, errors })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
