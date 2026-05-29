/**
 * Workflow Orchestrator — engine
 *
 * Three entry points:
 *   - startRun: create a workflow_runs row and begin executing step 0
 *   - advanceRun: execute the next pending step (called after approval, or
 *     internally after a non-approval step completes)
 *   - approveStep: mark a paused step as approved and advance
 */

import { createServiceClient } from "@/lib/supabase/service"
import { getChainByKey } from "./chains"
import { findReusableRun, type ExistingRun } from "./run-dedupe"
import type {
  WorkflowChain,
  WorkflowStep,
  WorkflowRunContext,
  WorkflowRunStatus,
} from "./types"

interface StartRunInput {
  chainKey: string
  brokerageId: string
  contactId?: string | null
  listingId?: string | null
  transactionId?: string | null
  agentUserId?: string | null
  triggerEvent?: string | null
  triggerEventId?: string | null
  metadata?: Record<string, any>
}

interface RunResult {
  success: boolean
  runId?: string
  status?: WorkflowRunStatus
  error?: string
  /** True when an existing run was reused instead of starting a duplicate (idempotency). */
  deduped?: boolean
}

// ---------------------------------------------------------------------------
// startRun — kicks off a new chain instance
// ---------------------------------------------------------------------------

export async function startRun(input: StartRunInput): Promise<RunResult> {
  const chain = getChainByKey(input.chainKey)
  if (!chain) {
    return { success: false, error: `Unknown chain: ${input.chainKey}` }
  }
  if (chain.steps.length === 0) {
    return { success: false, error: `Chain ${input.chainKey} has no steps` }
  }

  const svc = createServiceClient()

  // Idempotency: don't start a duplicate run when the same lifecycle event reaches the engine
  // more than once (retry, or a direct call + the kernel reactor firing for one occurrence). The
  // flagship chains render videos + enroll drips — double-running is expensive and visible.
  {
    let q = svc
      .from("workflow_runs")
      .select("id, status, trigger_event_id")
      .eq("chain_key", chain.key)
      .eq("brokerage_id", input.brokerageId)
      .eq("trigger_event", input.triggerEvent ?? chain.triggerEvent)
    if (input.contactId) q = q.eq("contact_id", input.contactId)
    else if (input.listingId) q = q.eq("listing_id", input.listingId)
    else if (input.transactionId) q = q.eq("transaction_id", input.transactionId)
    const { data: priorRuns } = await q.order("started_at", { ascending: false }).limit(20)
    const reuse = findReusableRun((priorRuns ?? []) as ExistingRun[], input.triggerEventId ?? null)
    if (reuse) {
      return { success: true, runId: reuse.id, status: reuse.status as WorkflowRunStatus, deduped: true }
    }
  }

  const { data: run, error } = await svc
    .from("workflow_runs")
    .insert({
      brokerage_id: input.brokerageId,
      chain_key: chain.key,
      trigger_event: input.triggerEvent ?? chain.triggerEvent,
      trigger_event_id: input.triggerEventId ?? null,
      contact_id: input.contactId ?? null,
      listing_id: input.listingId ?? null,
      transaction_id: input.transactionId ?? null,
      agent_user_id: input.agentUserId ?? null,
      status: "running",
      current_step_index: 0,
      metadata: input.metadata ?? {},
      step_outputs: {},
    })
    .select("id")
    .single()

  if (error || !run) {
    return { success: false, error: error?.message ?? "Failed to create run" }
  }

  // Pre-create step rows (pending) so the UI shows the full pipeline
  const stepRows = chain.steps.map((s, i) => ({
    run_id: run.id,
    step_index: i,
    step_key: s.key,
    step_label: s.label,
    status: "pending" as const,
  }))
  await svc.from("workflow_run_steps").insert(stepRows)

  // Begin execution
  return await advanceRun(run.id)
}

// ---------------------------------------------------------------------------
// advanceRun — executes the next pending step
// ---------------------------------------------------------------------------

export async function advanceRun(runId: string): Promise<RunResult> {
  const svc = createServiceClient()

  const { data: run } = await svc
    .from("workflow_runs")
    .select("*")
    .eq("id", runId)
    .single()

  if (!run) return { success: false, error: "Run not found" }

  const chain = getChainByKey(run.chain_key)
  if (!chain) return { success: false, error: `Chain ${run.chain_key} not registered` }

  // If chain already done/failed/cancelled, no-op
  if (run.status !== "running" && run.status !== "paused") {
    return { success: true, runId, status: run.status as WorkflowRunStatus }
  }

  // Find next pending step
  const stepIndex = run.current_step_index as number
  if (stepIndex >= chain.steps.length) {
    return await completeRun(runId)
  }

  const step = chain.steps[stepIndex]
  if (!step) {
    return await completeRun(runId)
  }

  // Mark step running
  await svc
    .from("workflow_run_steps")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("run_id", runId)
    .eq("step_index", stepIndex)

  await svc
    .from("workflow_runs")
    .update({ status: "running" })
    .eq("id", runId)

  // Build context
  const ctx: WorkflowRunContext = {
    runId,
    chainKey: chain.key,
    brokerageId: run.brokerage_id,
    contactId: run.contact_id,
    listingId: run.listing_id,
    transactionId: run.transaction_id,
    agentUserId: run.agent_user_id,
    metadata: (run.metadata ?? {}) as Record<string, any>,
    previousStepOutputs: (run.step_outputs ?? {}) as Record<string, any>,
  }

  // Execute step with retry
  const maxAttempts = (step.retry?.max ?? 0) + 1
  let attempt = 0
  let lastError: string | undefined
  let result: { success: boolean; output?: Record<string, any>; error?: string; requiresApproval?: boolean } | undefined

  while (attempt < maxAttempts) {
    attempt++
    try {
      result = await step.handler(ctx)
      if (result.success) break
      lastError = result.error
    } catch (err: any) {
      lastError = err?.message ?? String(err)
    }
    if (attempt < maxAttempts && step.retry?.delayMs) {
      await new Promise((r) => setTimeout(r, step.retry!.delayMs))
    }
  }

  await svc
    .from("workflow_run_steps")
    .update({ attempt_count: attempt })
    .eq("run_id", runId)
    .eq("step_index", stepIndex)

  // Failure: mark step + run as failed
  if (!result?.success) {
    await svc
      .from("workflow_run_steps")
      .update({
        status: "failed",
        error_message: lastError ?? "Unknown error",
        completed_at: new Date().toISOString(),
      })
      .eq("run_id", runId)
      .eq("step_index", stepIndex)

    await svc
      .from("workflow_runs")
      .update({
        status: "failed",
        failed_at: new Date().toISOString(),
        error_message: `Step '${step.key}' failed: ${lastError}`,
      })
      .eq("id", runId)

    return { success: false, runId, status: "failed", error: lastError }
  }

  // Success: persist output
  const newOutputs = { ...ctx.previousStepOutputs, [step.key]: result.output ?? {} }

  // Determine if step (or chain definition) requires approval before next step
  const needsApproval = result.requiresApproval || step.requiresApproval

  if (needsApproval) {
    await svc
      .from("workflow_run_steps")
      .update({
        status: "needs_approval",
        output: result.output ?? {},
        completed_at: new Date().toISOString(),
      })
      .eq("run_id", runId)
      .eq("step_index", stepIndex)

    await svc
      .from("workflow_runs")
      .update({
        status: "paused",
        step_outputs: newOutputs,
      })
      .eq("id", runId)

    return { success: true, runId, status: "paused" }
  }

  // Completed successfully — advance to next step
  await svc
    .from("workflow_run_steps")
    .update({
      status: "done",
      output: result.output ?? {},
      completed_at: new Date().toISOString(),
    })
    .eq("run_id", runId)
    .eq("step_index", stepIndex)

  await svc
    .from("workflow_runs")
    .update({
      step_outputs: newOutputs,
      current_step_index: stepIndex + 1,
    })
    .eq("id", runId)

  // If more steps remain, recurse to run the next one
  if (stepIndex + 1 < chain.steps.length) {
    return await advanceRun(runId)
  }

  return await completeRun(runId)
}

// ---------------------------------------------------------------------------
// approveStep — for steps that paused awaiting approval
// ---------------------------------------------------------------------------

export async function approveStep(params: {
  runId: string
  stepKey: string
}): Promise<RunResult> {
  const svc = createServiceClient()

  // Mark the paused step as done
  const { data: step } = await svc
    .from("workflow_run_steps")
    .select("step_index, status")
    .eq("run_id", params.runId)
    .eq("step_key", params.stepKey)
    .single()

  if (!step) return { success: false, error: "Step not found" }
  if (step.status !== "needs_approval") {
    return { success: false, error: `Step is ${step.status}, cannot approve` }
  }

  await svc
    .from("workflow_run_steps")
    .update({ status: "done" })
    .eq("run_id", params.runId)
    .eq("step_index", step.step_index)

  await svc
    .from("workflow_runs")
    .update({
      status: "running",
      current_step_index: step.step_index + 1,
    })
    .eq("id", params.runId)

  return await advanceRun(params.runId)
}

// ---------------------------------------------------------------------------
// cancelRun
// ---------------------------------------------------------------------------

export async function cancelRun(runId: string, reason?: string): Promise<RunResult> {
  const svc = createServiceClient()
  await svc
    .from("workflow_runs")
    .update({
      status: "cancelled",
      completed_at: new Date().toISOString(),
      error_message: reason ?? "Cancelled by user",
    })
    .eq("id", runId)
  return { success: true, runId, status: "cancelled" }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function completeRun(runId: string): Promise<RunResult> {
  const svc = createServiceClient()
  await svc
    .from("workflow_runs")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
    })
    .eq("id", runId)
  return { success: true, runId, status: "completed" }
}
