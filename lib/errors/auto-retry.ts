/**
 * Auto-Retry Engine
 * Handles exponential backoff retry logic for automation errors
 * 
 * NOTE: Vercel Serverless does not support sleep() for long delays.
 * Implementation stores retry_scheduled_at in resolution_metadata.
 * A /api/cron/retry-errors cron picks up errors where:
 *   status = 'open' AND latest resolution_log shows auto_retry with failure
 *   AND next_retry_at < NOW()
 */

// SERVICE CLIENT on purpose (m483): every write here is post-authorization
// error-ops bookkeeping — the two callers gate themselves (/api/errors/retry
// requires an admin/broker session; /api/cron/retry-errors requires cron auth
// and has NO session at all, so an RLS-scoped client there was anon and every
// read/write was refused silently). The retry ledger must not depend on the
// caller's RLS seat.
import { createServiceClient } from "@/lib/supabase/service"
import { classifyError, getRetryDelay } from "./error-classifier"
import { collectError } from "./collect-error"

const MAX_RETRY_ATTEMPTS = 5

export interface RetryResult {
  success: boolean
  error?: string
  attemptNumber?: number
}

/**
 * Schedule a retry for an error
 * In serverless context, this records the next retry time for the cron to pick up
 */
export async function scheduleRetry(
  errorId: string,
  retryCallback?: () => Promise<void>
): Promise<RetryResult> {
  try {
    const supabase = createServiceClient()

    // Get the error record
    const { data: errorRecord, error: fetchError } = await supabase
      .from("automation_errors")
      .select("*")
      .eq("id", errorId)
      .single()

    if (fetchError || !errorRecord) {
      return { success: false, error: "Error not found" }
    }

    if (errorRecord.status === "resolved") {
      return { success: false, error: "Error already resolved" }
    }

    // Count current retries
    const { count: retryCount } = await supabase
      .from("error_resolution_log")
      .select("*", { count: "exact", head: true })
      .eq("error_id", errorId)
      .eq("action_type", "auto_retry")

    const currentRetryCount = retryCount || 0

    // Check if max retries exceeded
    if (currentRetryCount >= MAX_RETRY_ATTEMPTS) {
      await supabase
        .from("error_resolution_log")
        .insert({
          error_id: errorId,
          brokerage_id: errorRecord.brokerage_id,
          action_type: "escalated",
          action_by: "system",
          retry_attempt: currentRetryCount,
          notes: "Maximum retry attempts exceeded",
        })
      
      return { success: false, error: "Max retries exceeded - escalated" }
    }

    // Check if error is retryable
    const classification = classifyError(
      errorRecord.error_message,
      errorRecord.workflow_name
    )

    if (!classification.isRetryable) {
      await supabase
        .from("error_resolution_log")
        .insert({
          error_id: errorId,
          brokerage_id: errorRecord.brokerage_id,
          action_type: "escalated",
          action_by: "system",
          retry_attempt: currentRetryCount,
          notes: "Error is not retryable",
        })
      
      return { success: false, error: "Error is not retryable - escalated" }
    }

    // Calculate delay
    const delayMs = getRetryDelay(currentRetryCount)
    const nextRetryAt = new Date(Date.now() + delayMs)

    // If callback provided, execute immediately (for manual retries)
    if (retryCallback) {
      try {
        await retryCallback()
        
        // Retry succeeded
        await supabase
          .from("automation_errors")
          .update({
            status: "resolved",
            resolved_at: new Date().toISOString(),
          })
          .eq("id", errorId)

        await supabase
          .from("error_resolution_log")
          .insert({
            error_id: errorId,
            brokerage_id: errorRecord.brokerage_id,
            action_type: "auto_retry",
            action_by: "system",
            retry_attempt: currentRetryCount + 1,
            retry_result: RETRY_RESULT_SUCCESS,
          })

        return { success: true, attemptNumber: currentRetryCount + 1 }
      } catch (retryError) {
        // Retry failed
        await supabase
          .from("error_resolution_log")
          .insert({
            error_id: errorId,
            brokerage_id: errorRecord.brokerage_id,
            action_type: "auto_retry",
            action_by: "system",
            retry_attempt: currentRetryCount + 1,
            retry_result: RETRY_RESULT_FAILURE,
            notes: retryError instanceof Error ? retryError.message : "Unknown error",
            resolution_metadata: {
              next_retry_at: nextRetryAt.toISOString(),
            },
          })

        // Create new error record for the retry failure
        await collectError({
          workflowName: `${errorRecord.workflow_name}_retry`,
          errorMessage: retryError instanceof Error ? retryError.message : "Retry failed",
          brokerageId: errorRecord.brokerage_id,
          leadId: errorRecord.lead_id,
          context: { originalErrorId: errorId, retryAttempt: currentRetryCount + 1 },
        })

        // Check if we should escalate
        if (currentRetryCount + 1 >= MAX_RETRY_ATTEMPTS) {
          await supabase
            .from("error_resolution_log")
            .insert({
              error_id: errorId,
              brokerage_id: errorRecord.brokerage_id,
              action_type: "escalated",
              action_by: "system",
              retry_attempt: currentRetryCount + 1,
              notes: "Maximum retry attempts reached after failure",
            })
        }

        return { 
          success: false, 
          error: retryError instanceof Error ? retryError.message : "Retry failed",
          attemptNumber: currentRetryCount + 1 
        }
      }
    } else {
      // No callback - just schedule for cron pickup.
      // The result is CHECKED: this row IS the schedule. If it does not land
      // there is nothing for the cron to find, and returning success:true on a
      // rejected insert is how this lane stayed silently dead.
      const { error: scheduleErr } = await supabase
        .from("error_resolution_log")
        .insert({
          error_id: errorId,
          brokerage_id: errorRecord.brokerage_id,
          action_type: "auto_retry",
          action_by: "system",
          retry_attempt: currentRetryCount + 1,
          retry_result: RETRY_RESULT_SCHEDULED,
          resolution_metadata: {
            next_retry_at: nextRetryAt.toISOString(),
            scheduled_delay_ms: delayMs,
          },
        })

      if (scheduleErr) {
        console.error("[scheduleRetry] could not record the schedule:", scheduleErr.message)
        return {
          success: false,
          error: `Retry not scheduled: ${scheduleErr.message}`,
          attemptNumber: currentRetryCount + 1,
        }
      }

      return {
        success: true,
        attemptNumber: currentRetryCount + 1
      }
    }
  } catch (err) {
    console.error("[scheduleRetry] Unhandled error:", err)
    return { 
      success: false, 
      error: err instanceof Error ? err.message : "Unknown error" 
    }
  }
}

/**
 * error_resolution_log.retry_result values. The column's CHECK is
 * (success | failure | pending) — there is no 'scheduled'.
 *
 * The deferred lane wrote retry_result='scheduled' and the cron sweep filtered
 * for it, so the lane was dead at BOTH ends: the insert was rejected (its error
 * discarded, the function still returned success:true) and getErrorsDueForRetry
 * matched nothing. Nothing was ever scheduled and nothing was ever retried.
 * 'pending' is the admitted value that means exactly "queued, not yet run".
 */
export const RETRY_RESULT_SCHEDULED = "pending" as const
export const RETRY_RESULT_SUCCESS = "success" as const
export const RETRY_RESULT_FAILURE = "failure" as const

/**
 * Get errors that are due for retry (called by cron)
 */
export async function getErrorsDueForRetry(): Promise<string[]> {
  try {
    const supabase = createServiceClient()

    // Find errors with scheduled retries that are due
    const { data: resolutionLogs } = await supabase
      .from("error_resolution_log")
      .select("error_id, resolution_metadata")
      .eq("action_type", "auto_retry")
      .eq("retry_result", RETRY_RESULT_SCHEDULED)
      .order("created_at", { ascending: false })

    if (!resolutionLogs || resolutionLogs.length === 0) {
      return []
    }

    const now = new Date()
    const dueErrorIds: string[] = []

    for (const log of resolutionLogs) {
      const metadata = log.resolution_metadata as { next_retry_at?: string } | null
      if (metadata?.next_retry_at) {
        const nextRetryAt = new Date(metadata.next_retry_at)
        if (nextRetryAt <= now) {
          dueErrorIds.push(log.error_id)
        }
      }
    }

    // Dedupe
    return [...new Set(dueErrorIds)]
  } catch (err) {
    console.error("[getErrorsDueForRetry] Error:", err)
    return []
  }
}

/**
 * Get retry status for an error
 */
export async function getRetryStatus(errorId: string): Promise<{
  totalAttempts: number
  lastResult: string | null
  nextRetryAt: Date | null
  isEscalated: boolean
}> {
  try {
    const supabase = createServiceClient()

    const { data: logs } = await supabase
      .from("error_resolution_log")
      .select("action_type, retry_result, resolution_metadata, created_at")
      .eq("error_id", errorId)
      .order("created_at", { ascending: false })

    if (!logs || logs.length === 0) {
      return {
        totalAttempts: 0,
        lastResult: null,
        nextRetryAt: null,
        isEscalated: false,
      }
    }

    const retryLogs = logs.filter(l => l.action_type === "auto_retry")
    const isEscalated = logs.some(l => l.action_type === "escalated")
    
    const lastRetry = retryLogs[0]
    let nextRetryAt: Date | null = null
    
    if (lastRetry?.retry_result === RETRY_RESULT_SCHEDULED) {
      const metadata = lastRetry.resolution_metadata as { next_retry_at?: string } | null
      if (metadata?.next_retry_at) {
        nextRetryAt = new Date(metadata.next_retry_at)
      }
    }

    return {
      totalAttempts: retryLogs.length,
      lastResult: lastRetry?.retry_result || null,
      nextRetryAt,
      isEscalated,
    }
  } catch (err) {
    console.error("[getRetryStatus] Error:", err)
    return {
      totalAttempts: 0,
      lastResult: null,
      nextRetryAt: null,
      isEscalated: false,
    }
  }
}
