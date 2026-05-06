import { NextResponse } from "next/server"
import { runDailyPredictiveListingScoring } from "@/lib/predictive-listing/run-scoring"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"

export const dynamic = "force-dynamic"
export const maxDuration = 600  // up to 10 minutes for large brokerages

/**
 * Daily PLS scoring cron. Walks the active sphere, applies signals via the
 * existing pipeline, upserts the rollup, and queues auto-send touches when
 * eligible. Schedule: `0 6 * * *` (6am UTC).
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const ctxResult = await createCronRunContextAction({
    cron_name: "predictive-listing-scoring",
    cron_path: "/app/api/cron/predictive-listing-scoring/route.ts",
  })
  if (!ctxResult.success || !ctxResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctxResult.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const summary = await runDailyPredictiveListingScoring({ maxContactsPerBrokerage: 500 })

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: summary.contactsProcessed,
      metadata: {
        brokeragesProcessed: summary.brokeragesProcessed,
        signalsApplied: summary.signalsApplied,
        scoresAboveThreshold: summary.scoresAboveThreshold,
        autoSendQueued: summary.autoSendQueued,
        errors: summary.errors,
      },
    })

    return NextResponse.json({ success: true, ...summary })
  } catch (err: any) {
    await recordCronFailureAction({
      context_id: contextId,
      error: err?.message ?? "Unknown error in predictive-listing-scoring",
      stage: "runDailyPredictiveListingScoring",
    })
    return NextResponse.json({ error: err?.message ?? "Unknown error" }, { status: 500 })
  }
}
