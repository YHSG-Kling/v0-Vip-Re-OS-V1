// app/actions/cron-kernel.ts
//
// Server Actions for Cron Logging Kernel
//
// Thin wrapper that delegates to lib/kernel/cron-logging.ts.
// All cron jobs call these server actions to log execution, ensuring
// structured audit trail, failure visibility, and correlation IDs.

"use server"

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

/**
 * Create a new cron execution context with correlation ID
 */
export async function createCronRunContextAction(
  input: CreateCronRunContextInput,
): Promise<KernelCronLoggingResult<CronRunContext>> {
  return kernelCreateCronRunContext(input)
}

/**
 * Record the START of a cron execution
 */
export async function recordCronStartAction(
  input: RecordCronStartInput,
): Promise<KernelCronLoggingResult> {
  return kernelRecordCronStart(input)
}

/**
 * Record progress during cron execution
 */
export async function recordCronProgressAction(
  input: RecordCronProgressInput,
): Promise<KernelCronLoggingResult> {
  return kernelRecordCronProgress(input)
}

/**
 * Record successful completion of a cron job
 */
export async function recordCronSuccessAction(
  input: RecordCronSuccessInput,
): Promise<KernelCronLoggingResult<RecordCronSuccessOutput>> {
  return kernelRecordCronSuccess(input)
}

/**
 * Record failure of a cron job with error context
 */
export async function recordCronFailureAction(
  input: RecordCronFailureInput,
): Promise<KernelCronLoggingResult<RecordCronFailureOutput>> {
  return kernelRecordCronFailure(input)
}
