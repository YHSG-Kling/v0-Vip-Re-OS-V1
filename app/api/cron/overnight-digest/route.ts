import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { runOvernightDigest } from "@/lib/kernel/overnight-digest"
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
 * Overnight Digest Cron — "your AI answered while you slept": per-agent
 * morning notification folding the last 12h of autonomous work (calls
 * answered, bookings, RSVPs, seller hand-raises, hot callbacks, inbound
 * texts). Deduped per day; silent nights send nothing.
 */
export async function GET(request: NextRequest) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "overnight-digest",
    cron_path: "/app/api/cron/overnight-digest/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const summary = await runOvernightDigest(createServiceClient())
    await recordCronSuccessAction({ context_id: contextId, records_processed: summary.digested, metadata: summary as any })
    return NextResponse.json({ message: "Overnight digest complete", summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Digest failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
