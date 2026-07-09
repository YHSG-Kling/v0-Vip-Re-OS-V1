/**
 * Central Error Collection Utility
 * 
 * Usage examples:
 * In a server action:
 *   import { collectError } from '@/lib/errors/collect-error'
 *   try { ... }
 *   catch (e) {
 *     await collectError({ workflowName: 'seller_update_cron', errorMessage: e.message,
 *                          stack: e.stack, severity: 'medium', brokerageId, context: { listingId } })
 *   }
 *
 * In a cron route:
 *   catch (e) {
 *     await collectError({ workflowName: 'cron_earnings_rollup', errorMessage: e.message,
 *                          stack: e.stack, brokerageId, context: { period } })
 *   }
 *
 * In an API route:
 *   await collectError({ workflowName: 'video_generation', errorMessage: err.message,
 *                        severity: 'medium', agentId, context: { scriptId, templateId } })
 */

import { createClient } from "@/lib/supabase/server"
import { classifyError } from "./error-classifier"
import crypto from "crypto"

export type ErrorSeverity = "critical" | "high" | "medium" | "low"

export interface CollectErrorParams {
  workflowName: string
  errorMessage: string
  stack?: string
  severity?: ErrorSeverity
  context?: Record<string, unknown>
  brokerageId?: string
  agentId?: string
  leadId?: string
  fileInfo?: { path: string; line: number; function: string }
  errorType?: string
}

/**
 * Collects an error and stores it in the automation_errors table.
 * IMPORTANT: This function NEVER throws. All errors are caught internally.
 * @returns The error_id (uuid) if successful, null otherwise
 */
export async function collectError(params: CollectErrorParams): Promise<string | null> {
  try {
    const supabase = await createClient()
    
    const {
      workflowName,
      errorMessage,
      stack,
      context,
      brokerageId,
      leadId,
      fileInfo,
      errorType,
    } = params

    // Determine severity using classifier if not provided
    let severity = params.severity
    if (!severity) {
      const classification = classifyError(errorMessage, workflowName, stack)
      severity = classification.severity
    }

    // Generate error hash for grouping
    const hashInput = `${workflowName}|${errorType || "unknown"}|${fileInfo?.path || ""}|${fileInfo?.line || ""}`
    const errorHash = crypto.createHash("md5").update(hashInput).digest("hex")

    // Insert into automation_errors
    const { data: errorRecord, error: insertError } = await supabase
      .from("automation_errors")
      .insert({
        workflow_name: workflowName,
        error_message: errorMessage,
        severity,
        status: "open",
        context_json: context ? JSON.stringify(context) : null,
        brokerage_id: brokerageId || null,
        lead_id: leadId || null,
      })
      .select("id")
      .single()

    if (insertError || !errorRecord) {
      console.error("[collectError] Failed to insert automation_error:", insertError)
      return null
    }

    const errorId = errorRecord.id

    // If stack provided, insert into error_stack_traces
    if (stack) {
      const { error: stackError } = await supabase
        .from("error_stack_traces")
        .insert({
          error_id: errorId,
          brokerage_id: brokerageId || null,
          stack_trace: stack,
          file_path: fileInfo?.path || null,
          line_number: fileInfo?.line || null,
          function_name: fileInfo?.function || null,
          error_type: errorType || null,
          error_hash: errorHash,
          runtime_context: context || null,
        })

      if (stackError) {
        console.error("[collectError] Failed to insert stack trace:", stackError)
      }
    }

    // Insert initial resolution log entry
    const { error: resolutionError } = await supabase
      .from("error_resolution_log")
      .insert({
        error_id: errorId,
        brokerage_id: brokerageId || null,
        action_type: "acknowledged",
        action_by: "system",
        retry_attempt: 0,
      })

    if (resolutionError) {
      console.error("[collectError] Failed to insert resolution log:", resolutionError)
    }

    // If severity is critical, emit SYSTEM_HEALTH_ALERT kernel event
    if (severity === "critical") {
      const { error: lifecycleError } = await supabase
        .from("lifecycle_events")
        .insert({
          brokerage_id: brokerageId || null,
          entity_type: "automation_error",
          entity_id: errorId,
          event_type: "SYSTEM_HEALTH_ALERT",
          metadata: {
            workflow_name: workflowName,
            severity,
            error_message: errorMessage.substring(0, 500),
          },
        })

      if (lifecycleError) {
        console.error("[collectError] Failed to emit kernel event:", lifecycleError)
      }
    }

    return errorId
  } catch (err) {
    // collectError must NEVER throw - log and return null
    console.error("[collectError] Unhandled error in error collection:", err)
    return null
  }
}

/**
 * Batch collect multiple errors at once
 */
export async function collectErrors(errors: CollectErrorParams[]): Promise<(string | null)[]> {
  const results: (string | null)[] = []
  for (const error of errors) {
    const id = await collectError(error)
    results.push(id)
  }
  return results
}
