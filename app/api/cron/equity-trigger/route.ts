import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runEquityTrigger } from "@/lib/kernel/equity-trigger"

/**
 * PAST-CLIENT EQUITY TRIGGER cron (weekly — suggested schedule "0 14 * * 1").
 * For each brokerage, the Sphere Manager watches every past client's home value
 * (REAL valuation; no valuation → honest skip) AND the rate environment
 * (market_rate_snapshots; non-authoritative → refi angle stays off, never a
 * fabricated rate). When the math crosses a real threshold — meaningful equity
 * GAINED (cash-out) or current rates materially below the client's ORIGINAL rate
 * (refi savings) — it proposes ONE gated agent note, commissions a Director
 * equity/refi reel (EquityReportReel, D-ID + ElevenLabs, NEVER HeyGen), and pushes
 * the portal value card (updateType "equity_trigger"). Idempotent: one trigger per
 * (contact, trigger-type, quarter); withdrawn excluded.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "equity-trigger",
    cron_path: "/app/api/cron/equity-trigger/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let scanned = 0, evaluated = 0, triggersDetected = 0, notesProposed = 0
  let reelsCommissioned = 0, portalCardsPushed = 0, skippedNoValuation = 0
  let skippedNoPurchasePrice = 0, skippedBelowThreshold = 0, skippedWithdrawn = 0
  let skippedDuplicate = 0, skippedNoAgent = 0

  try {
    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error
    for (const b of (rows ?? []) as Array<{ id: string }>) {
      try {
        const r = await runEquityTrigger(b.id, {}, supabase)
        scanned += r.scanned
        evaluated += r.evaluated
        triggersDetected += r.triggersDetected
        notesProposed += r.notesProposed
        reelsCommissioned += r.reelsCommissioned
        portalCardsPushed += r.portalCardsPushed
        skippedNoValuation += r.skippedNoValuation
        skippedNoPurchasePrice += r.skippedNoPurchasePrice
        skippedBelowThreshold += r.skippedBelowThreshold
        skippedWithdrawn += r.skippedWithdrawn
        skippedDuplicate += r.skippedDuplicate
        skippedNoAgent += r.skippedNoAgent
      } catch (e: any) { errors.push(`${b.id}: ${e?.message ?? String(e)}`) }
    }
    await recordCronSuccessAction({
      context_id: contextId, records_processed: notesProposed,
      metadata: {
        scanned, evaluated, triggersDetected, notesProposed, reelsCommissioned,
        portalCardsPushed, skippedNoValuation, skippedNoPurchasePrice,
        skippedBelowThreshold, skippedWithdrawn, skippedDuplicate, skippedNoAgent,
        errors: errors.slice(0, 10),
      },
    }).catch(() => {})
    return NextResponse.json({
      ok: true, scanned, evaluated, triggersDetected, notesProposed, reelsCommissioned,
      portalCardsPushed, skippedNoValuation, skippedNoPurchasePrice,
      skippedBelowThreshold, skippedWithdrawn, skippedDuplicate, skippedNoAgent,
    })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
