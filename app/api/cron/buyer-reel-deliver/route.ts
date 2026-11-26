/**
 * app/api/cron/buyer-reel-deliver/route.ts
 *
 * Wave 64 — sweeps finished buyer property-match reels and proposes each to its buyer as a
 * Shopping-Agent-owned client message on the Command Center (human-released before send).
 * Closes the buyer egress loop: render queue → finished reel → governed delivery.
 *
 * CRON_SECRET auth, service client, idempotent (per-buyer weekly guard).
 */
import { NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { createCronRunContextAction, recordCronSuccessAction, recordCronFailureAction } from "@/app/actions/cron-kernel"
import { createServiceClient } from "@/lib/supabase/service"
import { deliverFinishedBuyerReels } from "@/lib/agents/buyer-reel-delivery"

export const dynamic = "force-dynamic"
export const maxDuration = 120

export async function GET(request: Request) {
  const unauthorized = verifyCronAuth(request)
  if (unauthorized) return unauthorized
  const cronRun = await createCronRunContextAction({ cron_name: "buyer-reel-deliver", cron_path: "/app/api/cron/buyer-reel-deliver/route.ts" }) // run row + cron decision door (155R1)
  if (cronRun.data?.held) return NextResponse.json({ success: true, held: true, decision: cronRun.data.decision })
  const svc = createServiceClient()
  const ranAt = new Date().toISOString()
  try {
    const r = await deliverFinishedBuyerReels(svc)
    if (cronRun.data) await recordCronSuccessAction({ context_id: cronRun.data.context_id, metadata: { ...r } })
    return NextResponse.json({ ran_at: ranAt, ...r })
  } catch (e) {
    if (cronRun.data) await recordCronFailureAction({ context_id: cronRun.data.context_id, error: e as Error, stage: "main-processing" })
    return NextResponse.json({ ran_at: ranAt, error: (e as Error).message }, { status: 500 })
  }
}
