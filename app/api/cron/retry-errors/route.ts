import { NextRequest, NextResponse } from "next/server"
import { getErrorsDueForRetry, scheduleRetry } from "@/lib/errors/auto-retry"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"

/**
 * GET /api/cron/retry-errors
 * Cron job that runs every 30 minutes to retry scheduled errors
 * Add to vercel.json: { "path": "/api/cron/retry-errors", "schedule": "0 *\/30 * * * *" }
 */
export async function GET(request: NextRequest) {
  const startTime = Date.now()

  // Verify cron secret
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const contextResult = await createCronRunContextAction({
    cron_name: "retry-errors",
    cron_path: "/app/api/cron/retry-errors/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[RetryErrors] Failed to record cron start:", startRecordResult.error)
  }

  try {
    const errorIds = await getErrorsDueForRetry()

    let processedCount = 0
    let successCount = 0
    let failCount = 0
    const errors: string[] = []

    for (const errorId of errorIds) {
      try {
        const result = await scheduleRetry(errorId)
        processedCount++
        if (result.success) {
          successCount++
        } else {
          failCount++
          if (result.error) {
            errors.push(`${errorId}: ${result.error}`)
          }
        }
      } catch (err) {
        failCount++
        errors.push(`${errorId}: ${err instanceof Error ? err.message : "Unknown error"}`)
      }
    }

    const durationMs = Date.now() - startTime

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: processedCount,
      output_count: successCount,
      metadata: { success_count: successCount, fail_count: failCount, errors: errors.slice(0, 10) },
    })

    return NextResponse.json({
      success: true,
      processed: processedCount,
      succeeded: successCount,
      failed: failCount,
      durationMs,
      errors: errors.slice(0, 5),
    })
  } catch (err) {
    console.error("[Cron retry-errors] Error:", err)
    await recordCronFailureAction({ context_id: contextId, error: err, stage: "main-processing" })
    return NextResponse.json(
      { error: "Cron execution failed", message: err instanceof Error ? err.message : "Unknown error", context_id: contextId },
      { status: 500 }
    )
  }
}
