import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runRegulatoryWatcher } from "@/lib/kernel/regulatory-watcher"

/**
 * REGULATORY-CHANGE WATCHER cron (weekly sweep). For each brokerage, the Data Steward
 * scans the gated external-search rail (Tavily/Exa via the connector-gateway) for recent
 * real-estate regulatory changes (TCPA, CAN-SPAM, FTC, Fair-Housing/HUD, NAR, state RE
 * commissions), matches each REAL change to the OS compliance surfaces it touches (the
 * 5-gate cascade, FAIR_HOUSING_PATTERNS, state_protected_classes, the BBA/authority
 * gate), records an idempotent observation (m224, per change-signature × ISO week), and
 * ESCALATES a GATED brief to the brokerage's compliance/broker owner (manager-signals
 * bus + notifications). It NEVER fabricates a regulation or an effective date; when the
 * search rail is unavailable it records "no changes" and escalates nothing.
 *
 * Auth: CRON_SECRET (verifyCronAuth). Registered in lib/kernel/cron-dispatch.ts (one
 * heartbeat). Weekly cadence matches the m224 idempotency period.
 */
export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 300

export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "regulatory-watcher",
    cron_path: "/app/api/cron/regulatory-watcher/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let brokeragesScanned = 0, changesScanned = 0, flagged = 0, escalated = 0

  try {
    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error
    for (const b of (rows ?? []) as Array<{ id: string }>) {
      try {
        const r = await runRegulatoryWatcher(b.id, {}, {}, supabase)
        brokeragesScanned += 1
        changesScanned += r.changesScanned
        flagged += r.flagged.length
        escalated += r.escalated
      } catch (e: any) { errors.push(`${b.id}: ${e?.message ?? String(e)}`) }
    }
    await recordCronSuccessAction({
      context_id: contextId, records_processed: escalated,
      metadata: { brokeragesScanned, changesScanned, flagged, escalated, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, brokeragesScanned, changesScanned, flagged, escalated })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
