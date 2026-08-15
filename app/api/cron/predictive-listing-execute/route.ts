import {
NextResponse } from "next/server"
import { runDuePredictiveTouches } from "@/lib/predictive-listing/auto-send"
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
 * Hourly PLS auto-touch executor. Picks up actions whose review window has
 * expired and sends them after re-checking eligibility + publish gate.
 * Schedule: `0 * * * *` (top of every hour).
 */
export async function GET(request: Request) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctxResult = await createCronRunContextAction({
    cron_name: "predictive-listing-execute",
    cron_path: "/app/api/cron/predictive-listing-execute/route.ts",
  })
  if (!ctxResult.success || !ctxResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctxResult.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const summary = await runDuePredictiveTouches()
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: summary.processed,
      metadata: { sent: summary.sent, blocked: summary.blocked, cancelled: summary.cancelled },
    })
    return NextResponse.json({ success: true, ...summary })
  } catch (err: any) {
    await recordCronFailureAction({
      context_id: contextId,
      error: err?.message ?? "Unknown error in predictive-listing-execute",
      stage: "runDuePredictiveTouches",
    })
    return NextResponse.json({ error: err?.message ?? "Unknown error" }, { status: 500 })
  }
}
