import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runFireDrills } from "@/lib/kernel/fire-drills"
import { TRANSACTION_STATUSES_OPEN } from "@/lib/transactions/transaction-status"

/**
 * FIRE DRILL cron (every 30 min) — the 9pm save. Scans live deals for UNCOVERED
 * deadlines (contingency live + prerequisite missing) inside the 48h window; for each,
 * the managers convene: agent gets a CRITICAL save-plan briefing (assistant voice on
 * team+ tiers), the client-calming note is drafted into the gate, the bus gets the
 * audit line. Idempotent per transaction per 24h.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "fire-drill",
    cron_path: "/app/api/cron/fire-drill/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let drills = 0, threats = 0, drafts = 0

  try {
    const horizon = new Date(Date.now() + 48 * 3_600_000).toISOString().slice(0, 10)
    const today = new Date().toISOString().slice(0, 10)
    const { data: rows, error } = await supabase
      .from("transactions").select("brokerage_id")
      .in("status", [...TRANSACTION_STATUSES_OPEN]).is("deleted_at", null)
      .or(`and(inspection_deadline.gte.${today},inspection_deadline.lte.${horizon}),and(appraisal_deadline.gte.${today},appraisal_deadline.lte.${horizon}),and(financing_deadline.gte.${today},financing_deadline.lte.${horizon})`)
      .limit(1000)
    if (error) throw error
    const brokerages = Array.from(new Set(((rows ?? []) as Array<{ brokerage_id: string | null }>)
      .map((r) => r.brokerage_id).filter((b): b is string => !!b)))

    for (const brokerageId of brokerages) {
      try {
        const r = await runFireDrills(brokerageId, {}, supabase)
        drills += r.drills; threats += r.threats; drafts += r.clientDraftsProposed
      } catch (e: any) { errors.push(`${brokerageId}: ${e?.message ?? String(e)}`) }
    }

    await recordCronSuccessAction({
      context_id: contextId, records_processed: drills,
      metadata: { drills, threats, drafts, brokerages: brokerages.length, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, drills, threats, drafts, brokerages: brokerages.length })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
