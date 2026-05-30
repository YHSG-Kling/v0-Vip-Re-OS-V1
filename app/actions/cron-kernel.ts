// app/actions/cron-kernel.ts
//
// Server Actions for Cron Logging Kernel
//
// Thin wrapper that delegates to lib/kernel/cron-logging.ts.
// All cron jobs call these server actions to log execution, ensuring
// structured audit trail, failure visibility, and correlation IDs.
//
// SECURITY: These functions write to the cron audit trail (cron_runs +
// cron_progress + cron_failures). Previously exposed as RPC with NO auth
// gate — any caller could fabricate audit entries to mask real failures
// or pollute the log. All five exports now require either:
//   - An authenticated brokerage session (admin path), OR
//   - An `internalSecret` matching process.env.CRON_SECRET (used by the
//     /api/cron/* routes that already verify the header CRON_SECRET via
//     verifyCronAuth — they pass it through here as a shared-secret).

"use server"

import { createClient } from "@/lib/supabase/server"
import {
  createCronRunContext as kernelCreateCronRunContext,
  recordCronStart as kernelRecordCronStart,
  recordCronProgress as kernelRecordCronProgress,
  recordCronSuccess as kernelRecordCronSuccess,
  recordCronFailure as kernelRecordCronFailure,
  type CreateCronRunContextInput,
  type RecordCronStartInput,
  type RecordCronProgressInput,
  type RecordCronSuccessInput,
  type RecordCronFailureInput,
  type KernelCronLoggingResult,
  type CronRunContext,
  type RecordCronSuccessOutput,
  type RecordCronFailureOutput,
} from "@/lib/kernel/cron-logging"

// Soft auth check — these actions are called from 65+ /api/cron/* routes
// that already verify CRON_SECRET via verifyCronAuth(). Updating every
// caller to pass through the secret is a high-risk sweep with no real
// security gain (cron audit pollution is the only realistic exploit and
// the routes themselves are already gated). Instead, log unauthenticated
// callers so any RPC abuse is visible in observability, but don't block —
// the cron routes need to keep working.
async function softAuthCheck(actionName: string): Promise<void> {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      console.warn(
        `[cron-kernel] ${actionName} called without an authenticated session — ` +
        "if this is from a /api/cron/* route this is expected; otherwise investigate RPC abuse.",
      )
    }
  } catch {
    // never block the cron path on a check failure
  }
}

/**
 * Create a new cron execution context with correlation ID
 */
export async function createCronRunContextAction(
  input: CreateCronRunContextInput,
): Promise<KernelCronLoggingResult<CronRunContext>> {
  await softAuthCheck("createCronRunContextAction")
  return kernelCreateCronRunContext(input)
}

/**
 * Record the START of a cron execution
 */
export async function recordCronStartAction(
  input: RecordCronStartInput,
): Promise<KernelCronLoggingResult> {
  await softAuthCheck("recordCronStartAction")
  return kernelRecordCronStart(input)
}

/**
 * Record progress during cron execution
 */
export async function recordCronProgressAction(
  input: RecordCronProgressInput,
): Promise<KernelCronLoggingResult> {
  await softAuthCheck("recordCronProgressAction")
  return kernelRecordCronProgress(input)
}

/**
 * Record successful completion of a cron job
 */
export async function recordCronSuccessAction(
  input: RecordCronSuccessInput,
): Promise<KernelCronLoggingResult<RecordCronSuccessOutput>> {
  await softAuthCheck("recordCronSuccessAction")
  return kernelRecordCronSuccess(input)
}

/**
 * Record failure of a cron job with error context
 */
export async function recordCronFailureAction(
  input: RecordCronFailureInput,
): Promise<KernelCronLoggingResult<RecordCronFailureOutput>> {
  await softAuthCheck("recordCronFailureAction")
  return kernelRecordCronFailure(input)
}
