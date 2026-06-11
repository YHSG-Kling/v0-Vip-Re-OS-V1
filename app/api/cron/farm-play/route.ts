import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runFarmPlays } from "@/lib/kernel/farm-play"

/**
 * FARM PLAY cron (daily 15:00 UTC via the dispatcher) — for each recently-closed deal,
 * the marketing bench convenes the geographic-farming play: neighbor farm staged
 * (seller-permission-gated), postcard + geo ad drafted, standout wins logged for
 * recruiting, one summary into the agent's gate. Nothing sends; everything idempotent.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "farm-play",
    cron_path: "/app/api/cron/farm-play/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let plays = 0, neighbor = 0, postcards = 0, ads = 0, recruiting = 0, summaries = 0

  try {
    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error
    for (const b of (rows ?? []) as Array<{ id: string }>) {
      try {
        const r = await runFarmPlays(b.id, {}, supabase)
        plays += r.plays; neighbor += r.neighborCampaigns; postcards += r.postcards
        ads += r.adsStaged; recruiting += r.recruitingProofs; summaries += r.summariesProposed
      } catch (e: any) { errors.push(`${b.id}: ${e?.message ?? String(e)}`) }
    }
    await recordCronSuccessAction({
      context_id: contextId, records_processed: plays,
      metadata: { plays, neighbor, postcards, ads, recruiting, summaries, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, plays, neighbor, postcards, ads, recruiting, summaries })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
