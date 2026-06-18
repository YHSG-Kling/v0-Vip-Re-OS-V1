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
//
// Migration 1053: createCronRunContext() now immediately inserts into
// cron_execution_logs with cron_name + cron_path so the health dashboard
// can identify any cron without touching individual cron files.
// recordCronStart() becomes an UPDATE (not insert) on the same row.

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

    // Persist immediately so cron_name is stored in cron_execution_logs
    // from the very first moment. recordCronStart() then updates status to 'running'.
    const supabase = createServiceClient()
    const { error: insertError } = await supabase
      .from("cron_execution_logs")
      .insert({
        id:          context_id, // correlation key (no context_id column; id is the key)
        cron_name:   input.cron_name,
        cron_path:   input.cron_path,
        status:      "started",
        started_at,
        metadata:    input.params ? { params: input.params } : {},
      })

    if (insertError) {
      // Log but don't fail — the cron should continue even if logging breaks
      console.error("[cron-kernel] createCronRunContext insert error:", insertError.message)
    }

    return { success: true, data: context }
  } catch (error) {
    console.error("[cron-kernel] createCronRunContext error:", error)
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

    // Update the row created in createCronRunContext to 'running'.
    // Falls back to insert if the row doesn't exist (e.g. insert failed above).
    const { error: updateError } = await supabase
      .from("cron_execution_logs")
      .update({
        // 'started' is the only legal non-terminal status (CHECK: started|completed|failed|timeout)
        status:   "started",
        metadata: input.input_count != null ? { input_count: input.input_count } : {},
      })
      .eq("id", input.context_id)
      .eq("status", "started")

    if (updateError) {
      // Row may not exist if createCronRunContext insert failed — insert now
      const { error: insertError } = await supabase
        .from("cron_execution_logs")
        .insert({
          id:         input.context_id,
          cron_path:  "unknown", // NOT NULL; original context lost on this fallback path
          status:     "started",
          started_at: new Date().toISOString(),
          metadata:   { input_count: input.input_count },
        })
      if (insertError) {
        console.error("[cron-kernel] recordCronStart fallback insert error:", insertError.message)
        return { success: false, error: insertError.message }
      }
    }

    return { success: true }
  } catch (error) {
    console.error("[cron-kernel] recordCronStart error:", error)
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

    const { error } = await supabase
      .from("cron_execution_logs")
      .update({
        records_processed: input.records_processed,
        metadata:          input.metadata_delta,
      })
      .eq("id", input.context_id)
      .eq("status", "started")

    if (error) {
      console.error("[cron-kernel] recordCronProgress error:", error.message)
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (error) {
    console.error("[cron-kernel] recordCronProgress error:", error)
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

    const { data: logEntry, error: readError } = await supabase
      .from("cron_execution_logs")
      .select("*")
      .eq("id", input.context_id)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (readError || !logEntry) {
      console.error("[cron-kernel] recordCronSuccess read error:", readError?.message)
      return { success: false, error: "Could not find cron log entry" }
    }

    const duration_ms = new Date(completed_at).getTime() - new Date(logEntry.started_at).getTime()

    const { error: updateError } = await supabase
      .from("cron_execution_logs")
      .update({
        status:            "completed", // CHECK: started|completed|failed|timeout
        completed_at,
        duration_ms,
        records_processed: input.records_processed ?? logEntry.records_processed,
        metadata: {
          ...logEntry.metadata,
          output_count: input.output_count,
          ...input.metadata,
        },
      })
      .eq("id", input.context_id)

    if (updateError) {
      console.error("[cron-kernel] recordCronSuccess update error:", updateError.message)
      return { success: false, error: updateError.message }
    }

    // Upsert cron_health_snapshot so health dashboard sees the latest run
    if (logEntry.cron_name) {
      await supabase
        .from("cron_health_snapshot")
        .upsert({
          cron_name:              logEntry.cron_name,
          cron_path:              logEntry.cron_path ?? null,
          last_run_at:            completed_at,
          last_status:            "success",
          last_duration_ms:       duration_ms,
          last_records_processed: input.records_processed ?? logEntry.records_processed ?? 0,
          last_error_message:     null,
          updated_at:             completed_at,
        }, { onConflict: "cron_name" })
        .then(() => {}) // fire-and-forget; don't fail the cron
    }

    try {
      await processKernelEvent({
        event:      KernelEvent.CRON_COMPLETED_SUCCESS,
        brokerageId: logEntry.brokerage_id || "system",
        entityType: "cron",
        entityId:   input.context_id,
      })
    } catch { /* event failure must not crash logging */ }

    return { success: true, data: { completed_at, duration_ms } }
  } catch (error) {
    console.error("[cron-kernel] recordCronSuccess error:", error)
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
  stage?: string
  context_snapshot?: Record<string, any>
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

    const { data: logEntry, error: readError } = await supabase
      .from("cron_execution_logs")
      .select("*")
      .eq("id", input.context_id)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    if (readError || !logEntry) {
      console.error("[cron-kernel] recordCronFailure read error:", readError?.message)
      return { success: false, error: "Could not find cron log entry" }
    }

    const duration_ms   = new Date(completed_at).getTime() - new Date(logEntry.started_at).getTime()
    const errorMessage  = input.error instanceof Error ? input.error.message : String(input.error)
    const truncatedError = errorMessage.slice(0, 2000)
    const stack = input.error instanceof Error ? input.error.stack : undefined

    const { error: updateError } = await supabase
      .from("cron_execution_logs")
      .update({
        status:        "failed", // CHECK: started|completed|failed|timeout
        completed_at,
        duration_ms,
        error_message: truncatedError,
        metadata: {
          ...logEntry.metadata,
          stage:            input.stage,
          context_snapshot: input.context_snapshot,
          error_stack:      stack?.slice(0, 1000),
        },
      })
      .eq("id", input.context_id)

    if (updateError) {
      console.error("[cron-kernel] recordCronFailure update error:", updateError.message)
      return { success: false, error: updateError.message }
    }

    // Upsert cron_health_snapshot with failure state
    if (logEntry.cron_name) {
      await supabase
        .from("cron_health_snapshot")
        .upsert({
          cron_name:              logEntry.cron_name,
          cron_path:              logEntry.cron_path ?? null,
          last_run_at:            completed_at,
          last_status:            "failure",
          last_duration_ms:       duration_ms,
          last_records_processed: logEntry.records_processed ?? 0,
          last_error_message:     truncatedError,
          updated_at:             completed_at,
        }, { onConflict: "cron_name" })
        .then(() => {})
    }

    try {
      await processKernelEvent({
        event:       KernelEvent.CRON_FAILED,
        brokerageId: logEntry.brokerage_id || "system",
        entityType:  "cron",
        entityId:    input.context_id,
      })
    } catch { /* event failure must not crash logging */ }

    return { success: true, data: { completed_at, duration_ms } }
  } catch (error) {
    console.error("[cron-kernel] recordCronFailure error:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}
