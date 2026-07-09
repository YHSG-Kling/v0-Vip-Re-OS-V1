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

  const phase = new URL(req.url).searchParams.get("phase") ?? "produce"
  const contextResult = await createCronRunContextAction({
    cron_name: phase === "deliver" ? "client-pulse-deliver" : "client-pulse",
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
    // ?phase=deliver (Friday 18:00): finished Deal Room videos become ONE gated
    // client message per transaction per week — a human approves the send.
    if (phase === "deliver") {
      const { proposeDealRoomReels } = await import("@/lib/kernel/deal-room-reel")
      const delivery = await proposeDealRoomReels(supabase)
      await recordCronSuccessAction({ context_id: contextId, records_processed: delivery.proposed, metadata: delivery as any }).catch(() => {})
      return NextResponse.json({ ok: true, phase, ...delivery })
    }

    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error

    for (const b of (rows ?? []) as Array<{ id: string }>) {
      try {
        const r = await runClientPulse(b.id, {}, supabase)
        sellers += r.sellerPulses; buyers += r.buyerPulses; quiet += r.quietWeeks
      } catch (e: any) { errors.push(`${b.id}: ${e?.message ?? String(e)}`) }
    }

    // THE DEAL ROOM — under-contract clients' deals narrated on camera (queued
    // now; the render queue drains it; ?phase=deliver proposes the gated send).
    let dealRoomQueued = 0
    try {
      const { queueDealRoomReels } = await import("@/lib/kernel/deal-room-reel")
      const dr = await queueDealRoomReels(supabase)
      dealRoomQueued = dr.queued
    } catch (e: any) { errors.push(`deal-room: ${e?.message ?? String(e)}`) }

    await recordCronSuccessAction({
      context_id: contextId, records_processed: sellers + buyers,
      metadata: { sellers, buyers, quiet, dealRoomQueued, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, sellers, buyers, quiet, dealRoomQueued })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
