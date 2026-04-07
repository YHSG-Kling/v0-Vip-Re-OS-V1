// lib/kernel/cron-logging.ts
//
// CRON EXECUTION LOGGING KERNEL — Layer 0 ownership
//
// Canonical commands for cron execution logging, failure tracking, records processing,
// and audit trail visibility. All cron jobs must use these commands to ensure
// silent failures are eliminated and correlation IDs enable debugging.
//
// Rules:
//   - Every cron job MUST call createCronRunContext() at start
//   - recordCronStart() must be called immediately after context creation
//   - recordCronSuccess() or recordCronFailure() must be called on completion
//   - Logging failures MUST NOT crash the cron job
//   - Correlation IDs persist across all log entries for trace correlation
//   - Error messages are truncated to 2000 chars for DB safety
//   - Records processed are tracked for audit trail
//   - Status enum: 'running', 'success', 'failure', 'partial'

import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "./events"
import { processKernelEvent } from "./notification-engine"
import { v4 as uuidv4 } from "uuid"

// ─── INPUT / OUTPUT TYPES ─────────────────────────────────────────────────────

export interface CronLoggingActorContext {
  brokerageId?: string
}

export interface KernelCronLoggingResult<T = void> {
  success: boolean
  data?: T
  error?: string
}

export interface CronRunContext {
  context_id: string
  cron_name: string
  cron_path: string
  brokerage_id?: string
  started_at: string
  params?: Record<string, any>
}

// ─── COMMAND 1: createCronRunContext ──────────────────────────────────────────

export interface CreateCronRunContextInput {
  cron_name: string      // e.g., "daily-briefing"
  cron_path: string      // e.g., "/app/api/cron/daily-briefing/route.ts"
  brokerage_id?: string  // optional, for scoped logging
  params?: Record<string, any> // input parameters for debugging
}

export async function createCronRunContext(
  input: CreateCronRunContextInput,
): Promise<KernelCronLoggingResult<CronRunContext>> {
  try {
    const context_id = uuidv4()
    const started_at = new Date().toISOString()

    const context: CronRunContext = {
      context_id,
      cron_name: input.cron_name,
      cron_path: input.cron_path,
      brokerage_id: input.brokerage_id,
      started_at,
      params: input.params,
    }

    return {
      success: true,
      data: context,
    }
  } catch (error) {
    console.error("[v0] createCronRunContext error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

// ─── COMMAND 2: recordCronStart ───────────────────────────────────────────────

export interface RecordCronStartInput {
  context_id: string
  input_count?: number  // optional: number of items to process
}

export async function recordCronStart(
  input: RecordCronStartInput,
): Promise<KernelCronLoggingResult> {
  try {
    const supabase = createServiceClient()

    // Retrieve context from in-memory context map (if available)
    // For now, we'll just insert a log entry with the context_id
    const { error } = await supabase
      .from("cron_execution_logs")
      .insert([
        {
          id: uuidv4(),
          context_id: input.context_id,
          status: "running",
          started_at: new Date().toISOString(),
          metadata: {
            input_count: input.input_count,
          },
        },
      ])

    if (error) {
      console.error("[v0] recordCronStart DB error:", error)
      // Don't throw — logging failure should not crash cron
      return {
        success: false,
        error: error.message,
      }
    }

    return { success: true }
  } catch (error) {
    console.error("[v0] recordCronStart error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

// ─── COMMAND 3: recordCronProgress ────────────────────────────────────────────

export interface RecordCronProgressInput {
  context_id: string
  records_processed?: number
  metadata_delta?: Record<string, any>
}

export async function recordCronProgress(
  input: RecordCronProgressInput,
): Promise<KernelCronLoggingResult> {
  try {
    const supabase = createServiceClient()

    // Update the running log entry with progress
    const { error } = await supabase
      .from("cron_execution_logs")
      .update({
        records_processed: input.records_processed,
        metadata: input.metadata_delta,
      })
      .eq("context_id", input.context_id)
      .eq("status", "running")

    if (error) {
      console.error("[v0] recordCronProgress DB error:", error)
      return {
        success: false,
        error: error.message,
      }
    }

    return { success: true }
  } catch (error) {
    console.error("[v0] recordCronProgress error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

// ─── COMMAND 4: recordCronSuccess ────────────────────────────────────────────

export interface RecordCronSuccessInput {
  context_id: string
  output_count?: number
  records_processed?: number
  metadata?: Record<string, any>
}

export interface RecordCronSuccessOutput {
  completed_at: string
  duration_ms: number
}

export async function recordCronSuccess(
  input: RecordCronSuccessInput,
): Promise<KernelCronLoggingResult<RecordCronSuccessOutput>> {
  try {
    const supabase = createServiceClient()
    const completed_at = new Date().toISOString()

    // Retrieve the start log entry to calculate duration
    const { data: logEntry, error: readError } = await supabase
      .from("cron_execution_logs")
      .select("*")
      .eq("context_id", input.context_id)
      .eq("status", "running")
      .single()

    if (readError || !logEntry) {
      console.error("[v0] recordCronSuccess read error:", readError)
      return {
        success: false,
        error: "Could not find running cron log entry",
      }
    }

    const started_at = new Date(logEntry.started_at).getTime()
    const completed_at_ms = new Date(completed_at).getTime()
    const duration_ms = completed_at_ms - started_at

    // Update log entry with success state
    const { error: updateError } = await supabase
      .from("cron_execution_logs")
      .update({
        status: "success",
        completed_at,
        duration_ms,
        records_processed: input.records_processed ?? logEntry.records_processed,
        metadata: {
          ...logEntry.metadata,
          output_count: input.output_count,
          ...input.metadata,
        },
      })
      .eq("context_id", input.context_id)
      .eq("status", "running")

    if (updateError) {
      console.error("[v0] recordCronSuccess update error:", updateError)
      return {
        success: false,
        error: updateError.message,
      }
    }

    // Emit KernelEvent for success
    try {
      await processKernelEvent({
        event: KernelEvent.CRON_COMPLETED_SUCCESS,
        brokerageId: logEntry.brokerage_id || "system",
        entityType: "cron",
        entityId: input.context_id,
      })
    } catch (eventError) {
      console.error("[v0] Failed to emit CRON_COMPLETED_SUCCESS event:", eventError)
      // Continue — event failure should not crash logging
    }

    return {
      success: true,
      data: {
        completed_at,
        duration_ms,
      },
    }
  } catch (error) {
    console.error("[v0] recordCronSuccess error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

// ─── COMMAND 5: recordCronFailure ────────────────────────────────────────────

export interface RecordCronFailureInput {
  context_id: string
  error: Error | string
  stage?: string  // which stage of cron failed
  context_snapshot?: Record<string, any> // debug context at failure
}

export interface RecordCronFailureOutput {
  completed_at: string
  duration_ms: number
}

export async function recordCronFailure(
  input: RecordCronFailureInput,
): Promise<KernelCronLoggingResult<RecordCronFailureOutput>> {
  try {
    const supabase = createServiceClient()
    const completed_at = new Date().toISOString()

    // Retrieve the start log entry to calculate duration
    const { data: logEntry, error: readError } = await supabase
      .from("cron_execution_logs")
      .select("*")
      .eq("context_id", input.context_id)
      .single()

    if (readError || !logEntry) {
      console.error("[v0] recordCronFailure read error:", readError)
      return {
        success: false,
        error: "Could not find cron log entry",
      }
    }

    const started_at = new Date(logEntry.started_at).getTime()
    const completed_at_ms = new Date(completed_at).getTime()
    const duration_ms = completed_at_ms - started_at

    // Format error message (truncate to 2000 chars for DB safety)
    const errorMessage = input.error instanceof Error ? input.error.message : String(input.error)
    const truncatedError = errorMessage.slice(0, 2000)

    // Capture error stack if available
    const stack = input.error instanceof Error ? input.error.stack : undefined

    // Update log entry with failure state
    const { error: updateError } = await supabase
      .from("cron_execution_logs")
      .update({
        status: "failure",
        completed_at,
        duration_ms,
        error_message: truncatedError,
        metadata: {
          ...logEntry.metadata,
          stage: input.stage,
          context_snapshot: input.context_snapshot,
          error_stack: stack?.slice(0, 1000), // truncate stack to 1000 chars
        },
      })
      .eq("context_id", input.context_id)

    if (updateError) {
      console.error("[v0] recordCronFailure update error:", updateError)
      return {
        success: false,
        error: updateError.message,
      }
    }

    // Emit KernelEvent for failure
    try {
      await processKernelEvent({
        event: KernelEvent.CRON_FAILED,
        brokerageId: logEntry.brokerage_id || "system",
        entityType: "cron",
        entityId: input.context_id,
      })
    } catch (eventError) {
      console.error("[v0] Failed to emit CRON_FAILED event:", eventError)
      // Continue — event failure should not crash logging
    }

    return {
      success: true,
      data: {
        completed_at,
        duration_ms,
      },
    }
  } catch (error) {
    console.error("[v0] recordCronFailure error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}
