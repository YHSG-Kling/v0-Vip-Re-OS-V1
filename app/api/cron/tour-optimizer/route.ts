import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runTourOptimizer } from "@/lib/kernel/tour-optimizer"

/**
 * BUYER TOUR DAY OPTIMIZER cron. Two Shopping-Agent moves the existing tour flow is
 * missing, per brokerage:
 *   (a) ROUTE SEQUENCING — planned tours not yet optimized get their stops ordered by
 *       drive time (nearest-neighbor over real coordinates; honest degradation to null
 *       drives for stops without coordinates), written back to tour_stops + tours, and
 *       persisted to showing_routes.
 *   (b) SAME-DAY RECAP — completed tours with no recap yet push ONE buyer-portal value
 *       card (loved/liked counts + per-home feedback + a warm next step) and stamp the
 *       tour as reported.
 * Idempotent at the per-tour level (total_drive_time_minutes / report_sent_at stamps).
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "tour-optimizer",
    cron_path: "/app/api/cron/tour-optimizer/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let toursOptimized = 0, recapsPushed = 0, routesPersisted = 0

  try {
    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error
    for (const b of (rows ?? []) as Array<{ id: string }>) {
      try {
        const r = await runTourOptimizer(b.id, {}, supabase)
        toursOptimized += r.toursOptimized
        recapsPushed += r.recapsPushed
        routesPersisted += r.routesPersisted
      } catch (e: any) {
        errors.push(`${b.id}: ${e?.message ?? String(e)}`)
      }
    }
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: toursOptimized + recapsPushed,
      metadata: { toursOptimized, recapsPushed, routesPersisted, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, toursOptimized, recapsPushed, routesPersisted })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
