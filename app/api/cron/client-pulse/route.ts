import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runClientPulse } from "@/lib/kernel/client-pulse"

/**
 * CLIENT PULSE cron (Fridays 16:00 UTC, via the dispatcher) — every active seller and
 * buyer gets their weekly "what your team did for you," proposed into the gate (the
 * agent approves; the portal card delivers). Empty weeks stay silent; one Pulse per
 * client per week; withdrawn relationships untouched.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "client-pulse",
    cron_path: "/app/api/cron/client-pulse/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let sellers = 0, buyers = 0, quiet = 0

  try {
    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error

    for (const b of (rows ?? []) as Array<{ id: string }>) {
      try {
        const r = await runClientPulse(b.id, {}, supabase)
        sellers += r.sellerPulses; buyers += r.buyerPulses; quiet += r.quietWeeks
      } catch (e: any) { errors.push(`${b.id}: ${e?.message ?? String(e)}`) }
    }

    await recordCronSuccessAction({
      context_id: contextId, records_processed: sellers + buyers,
      metadata: { sellers, buyers, quiet, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, sellers, buyers, quiet })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
