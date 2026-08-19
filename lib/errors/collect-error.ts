/**
 * Central Error Collection Utility — the ONE writer for automation_errors.
 *
 * automation_errors.status carries a live CHECK admitting exactly
 * open / investigating / resolved / dismissed, and defaults to 'open'. Four
 * AI-ISA call sites hand-rolled their own insert with `status: 'new'`, which the
 * constraint rejects. supabase-js resolves a rejected insert with `{ error }`
 * instead of throwing, and all four discarded the result — so every AI-ISA
 * engagement failure was reported to the operator, written nowhere, and lost.
 * They also set no brokerage_id, and every console that reads this table filters
 * on it, so even an accepted row would have been invisible.
 *
 * Going through here instead gets the vocabulary, the tenant anchor, the stack
 * trace, the resolution-log entry and the critical-severity kernel alert, all of
 * which a hand-rolled insert skips.
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

import { createServiceClient } from "@/lib/supabase/service"
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
  /**
   * The Supabase client to write with. Defaults to the SERVICE client (m483):
   * error intake is a post-authorization AUDIT write — every caller has already
   * passed its own gate (route auth, action gate, cron secret) before reporting,
   * and a consumer seat reporting an error is the product working. The previous
   * RLS-scoped default silently dropped exactly those reports once the
   * automation_errors / error_stack_traces / error_resolution_log INSERT
   * policies were staff-seat-tightened. Callers may still inject a client
   * (the AI-ISA engines pass their own service client through).
   */
  client?: { from: (table: string) => any }
}

/**
 * Collects an error and stores it in the automation_errors table.
 * IMPORTANT: This function NEVER throws. All errors are caught internally.
 * @returns The error_id (uuid) if successful, null otherwise
 */
export async function collectError(params: CollectErrorParams): Promise<string | null> {
  try {
    const supabase = params.client ?? createServiceClient()

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

// TOMBSTONE (orphan burn-down, lane E): `collectErrors(errors[])` DELETED.
//
// It was a sequential `for` loop over `collectError` with zero callers, and the
// name promised something it did not do: NOTHING about it was batched. Each
// element still cost the same four round-trips collectError makes (the
// automation_errors insert, the stack trace, the resolution-log row, and the
// kernel event on critical) — there was no multi-row insert, no shared
// transaction, no single classification pass. It was `Promise` sugar that
// serialised.
//
// SURVIVOR: `collectError` (:72 above) — THE one writer for automation_errors,
// as this module's header states. A caller holding several failures loops over
// it at the call site, which is what the live intake sites already do (the
// AI-ISA engines, the cron routes, and the workflow handlers each report inside
// their own catch, where they still have the context — workflowName, brokerageId,
// leadId — that a flattened array argument would have stripped).
//
// Nothing merged: the deleted wrapper added no field, no gate and no vocabulary
// that collectError lacks. If a genuine batch ever becomes worth having, it
// belongs INSIDE collectError as a multi-row insert, not as a loop beside it.
