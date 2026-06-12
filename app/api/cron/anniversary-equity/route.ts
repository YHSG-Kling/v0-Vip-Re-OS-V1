import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runAnniversaryEquity } from "@/lib/kernel/anniversary-equity"

/**
 * ANNIVERSARY EQUITY REPORT cron (daily — suggested schedule "0 13 * * *").
 * For each brokerage, the Sphere Manager finds past clients whose closing
 * anniversary falls within ±7 days, computes the honest equity line from a REAL
 * valuation (RentCast-backed default; no valuation → honest skip, never a
 * fabricated value), pushes the portal value card (updateType "equity_report"),
 * proposes ONE gated agent-facing report carrying the ready-to-send anniversary
 * note, and — when the agent's avatar/voice is configured — dispatches the
 * existing D-ID + ElevenLabs anniversary video (NEVER HeyGen). Idempotent: one
 * report per contact per year.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "anniversary-equity",
    cron_path: "/app/api/cron/anniversary-equity/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let scanned = 0, anniversariesDetected = 0, reportsProposed = 0, portalCardsPushed = 0
  let videosDispatched = 0, skippedNoAvatar = 0, skippedNoValuation = 0
  let skippedNoPurchasePrice = 0, skippedWithdrawn = 0, skippedDuplicate = 0

  try {
    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error
    for (const b of (rows ?? []) as Array<{ id: string }>) {
      try {
        const r = await runAnniversaryEquity(b.id, {}, supabase)
        scanned += r.scanned
        anniversariesDetected += r.anniversariesDetected
        reportsProposed += r.reportsProposed
        portalCardsPushed += r.portalCardsPushed
        videosDispatched += r.videosDispatched
        skippedNoAvatar += r.skippedNoAvatar
        skippedNoValuation += r.skippedNoValuation
        skippedNoPurchasePrice += r.skippedNoPurchasePrice
        skippedWithdrawn += r.skippedWithdrawn
        skippedDuplicate += r.skippedDuplicate
      } catch (e: any) { errors.push(`${b.id}: ${e?.message ?? String(e)}`) }
    }
    await recordCronSuccessAction({
      context_id: contextId, records_processed: reportsProposed,
      metadata: {
        scanned, anniversariesDetected, reportsProposed, portalCardsPushed,
        videosDispatched, skippedNoAvatar, skippedNoValuation,
        skippedNoPurchasePrice, skippedWithdrawn, skippedDuplicate,
        errors: errors.slice(0, 10),
      },
    }).catch(() => {})
    return NextResponse.json({
      ok: true, scanned, anniversariesDetected, reportsProposed, portalCardsPushed,
      videosDispatched, skippedNoAvatar, skippedNoValuation,
      skippedNoPurchasePrice, skippedWithdrawn, skippedDuplicate,
    })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
