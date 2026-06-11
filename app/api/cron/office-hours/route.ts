import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runOfficeHoursDrop } from "@/lib/kernel/office-hours"

/**
 * MANAGER OFFICE HOURS cron (13:00 + 19:00 UTC via the dispatcher ≈ morning/afternoon
 * drops US time) — sweeps unread per-proposal approval pings into ONE organized drop
 * per agent, grouped by manager. CRITICAL notifications are never swept; the gate,
 * SLA escalation, and proposals themselves are untouched — only the noise collapses.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "office-hours",
    cron_path: "/app/api/cron/office-hours/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  const slot: "morning" | "afternoon" = new Date().getUTCHours() < 16 ? "morning" : "afternoon"
  let digests = 0, swept = 0

  try {
    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error
    for (const b of (rows ?? []) as Array<{ id: string }>) {
      try {
        const r = await runOfficeHoursDrop(b.id, slot, {}, supabase)
        digests += r.digests; swept += r.swept
      } catch (e: any) { errors.push(`${b.id}: ${e?.message ?? String(e)}`) }
    }
    await recordCronSuccessAction({
      context_id: contextId, records_processed: digests,
      metadata: { slot, digests, swept, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, slot, digests, swept })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
