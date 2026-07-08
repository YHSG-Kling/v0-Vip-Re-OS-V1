import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { runBoardPackets } from "@/lib/kernel/board-packet"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/**
 * Board Packet Cron — the broker-owner's monthly one-pager per brokerage
 * (1st of month): production, pipeline, and the AI team's measured work,
 * composed from the SAME ledgers the command center reads. Stored to the
 * documents bucket; broker admins notified. Deduped per brokerage per month.
 */
export async function GET(request: NextRequest) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "board-packet",
    cron_path: "/app/api/cron/board-packet/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const summary = await runBoardPackets(createServiceClient())
    await recordCronSuccessAction({ context_id: contextId, records_processed: summary.packets, metadata: summary as any })
    return NextResponse.json({ message: "Board packets complete", summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Packet run failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
