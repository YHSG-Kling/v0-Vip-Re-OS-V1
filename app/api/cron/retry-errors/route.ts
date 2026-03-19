import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getErrorsDueForRetry, scheduleRetry } from "@/lib/errors/auto-retry"
import { collectError } from "@/lib/errors/collect-error"

/**
 * GET /api/cron/retry-errors
 * Cron job that runs every 30 minutes to retry scheduled errors
 * Add to vercel.json: { "path": "/api/cron/retry-errors", "schedule": "0 *\/30 * * * *" }
 */
export async function GET(request: NextRequest) {
  const startTime = Date.now()
  
  try {
    // Verify cron secret
    const authHeader = request.headers.get("authorization")
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const supabase = await createClient()

    // Log cron start
    const { data: cronLog } = await supabase
      .from("cron_execution_logs")
      .insert({
        cron_name: "retry-errors",
        cron_path: "/api/cron/retry-errors",
        status: "running",
        started_at: new Date().toISOString(),
      })
      .select("id")
      .single()

    const cronLogId = cronLog?.id

    // Get errors due for retry
    const errorIds = await getErrorsDueForRetry()

    let processedCount = 0
    let successCount = 0
    let failCount = 0
    const errors: string[] = []

    for (const errorId of errorIds) {
      try {
        // Get error details to determine retry callback
        const { data: errorRecord } = await supabase
          .from("automation_errors")
          .select("workflow_name, context_json, brokerage_id")
          .eq("id", errorId)
          .single()

        if (!errorRecord) continue

        // For now, we just schedule retry without callback
        // In production, you'd map workflow_name to actual retry functions
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

    // Update cron log
    if (cronLogId) {
      await supabase
        .from("cron_execution_logs")
        .update({
          status: failCount > 0 && successCount === 0 ? "failed" : "completed",
          completed_at: new Date().toISOString(),
          duration_ms: durationMs,
          records_processed: processedCount,
          metadata: {
            success_count: successCount,
            fail_count: failCount,
            errors: errors.slice(0, 10), // Limit stored errors
          },
          error_message: failCount > 0 ? `${failCount} retries failed` : null,
        })
        .eq("id", cronLogId)
    }

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
    
    // Log error
    await collectError({
      workflowName: "cron_retry_errors",
      errorMessage: err instanceof Error ? err.message : "Unknown cron error",
      stack: err instanceof Error ? err.stack : undefined,
      severity: "high",
    })

    return NextResponse.json(
      { 
        error: "Cron execution failed",
        message: err instanceof Error ? err.message : "Unknown error"
      },
      { status: 500 }
    )
  }
}
