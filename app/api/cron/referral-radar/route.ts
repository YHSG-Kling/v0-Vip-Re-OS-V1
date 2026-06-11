import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runReferralRadar } from "@/lib/kernel/referral-radar"

/**
 * SPHERE REFERRAL RADAR cron — for each brokerage, scans PAST clients for fresh
 * life-event signals (job change, new baby, marriage, kids outgrowing the home, equity
 * milestone) the Data Steward derived, and for each surfaces BOTH a NUDGE (notification
 * to the responsible agent — who to reach out to + why) AND a drafted TOUCHPOINT
 * (persona-aware client message proposed into the gate). Nothing auto-sends; withdrawn
 * contacts excluded; one touch per (contact, event) per 90 days. Does NOT duplicate the
 * closing-anniversary play.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "referral-radar",
    cron_path: "/app/api/cron/referral-radar/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let scanned = 0, detected = 0, nudges = 0, touchpoints = 0, skippedWithdrawn = 0, skippedDuplicate = 0

  try {
    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error
    for (const b of (rows ?? []) as Array<{ id: string }>) {
      try {
        const r = await runReferralRadar(b.id, {}, supabase)
        scanned += r.scanned; detected += r.detected; nudges += r.nudges
        touchpoints += r.touchpoints; skippedWithdrawn += r.skippedWithdrawn; skippedDuplicate += r.skippedDuplicate
      } catch (e: any) { errors.push(`${b.id}: ${e?.message ?? String(e)}`) }
    }
    await recordCronSuccessAction({
      context_id: contextId, records_processed: detected,
      metadata: { scanned, detected, nudges, touchpoints, skippedWithdrawn, skippedDuplicate, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, scanned, detected, nudges, touchpoints, skippedWithdrawn, skippedDuplicate })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
