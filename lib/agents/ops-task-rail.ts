// lib/agents/ops-task-rail.ts
//
// COMPUTER-USING OPS-TASK RAIL (cron_manager, shine #3) — the GOVERNANCE spine
// for an internal ops bot that does repetitive back-office computer work
// (pull a report, upload a doc, reconcile a portal) under human guardrails.
//
// HONESTY POSTURE (non-negotiable): a computer-using agent with stored portal
// credentials is a real security + liability surface. This rail builds the
// QUEUE, GUARDRAILS, APPROVAL, and AUDIT — everything except the browser-
// driving execution, which is DISABLED until a Playwright runner + secure
// credential vault are provisioned (per-brokerage ops_bot_execution_enabled,
// default OFF). We never fake a run: a task in a brokerage without the
// capability is BLOCKED with an explicit reason, not silently "succeeded".
//
// Pure guardrail logic here (testable); the DB writes are thin wrappers.

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

export type OpsTaskType = "pull_report" | "upload_document" | "reconcile_portal" | "other"

export interface OpsGuardrails {
  /** Hard cap on browser actions before the run aborts. */
  maxActions?: number
  /** Read-only mode — the bot may look but never submit/change. */
  readOnly?: boolean
  /** Allowed domains the bot may navigate to (empty = none until configured). */
  allowedDomains?: string[]
  /** Whether a human must approve before the run may start. */
  requiresApproval?: boolean
}

/** PURE: normalize + validate guardrails; returns safe defaults (deny-by-default). */
export function normalizeGuardrails(g: OpsGuardrails | null | undefined): Required<OpsGuardrails> {
  return {
    maxActions: Math.min(Math.max(1, Number(g?.maxActions ?? 25)), 200),
    readOnly: g?.readOnly ?? true,                 // default READ-ONLY — safest posture
    allowedDomains: Array.isArray(g?.allowedDomains) ? g!.allowedDomains.filter((d) => typeof d === "string" && d.length > 0) : [],
    requiresApproval: g?.requiresApproval ?? true, // default REQUIRES a human
  }
}

export type OpsGateDecision =
  | { canRun: true }
  | { canRun: false; status: "blocked"; reason: string }

/**
 * PURE gate — the decision to let a queued task RUN. Deny-by-default:
 * execution capability must be ON for the brokerage, guardrails must name at
 * least one allowed domain, and an approval-required task must be approved.
 */
export function evaluateOpsGate(input: {
  executionEnabled: boolean
  guardrails: Required<OpsGuardrails>
  approved: boolean
}): OpsGateDecision {
  if (!input.executionEnabled) {
    return { canRun: false, status: "blocked", reason: "Ops-bot execution is not enabled for this brokerage — a Playwright runner + credential vault must be provisioned first." }
  }
  if (input.guardrails.allowedDomains.length === 0) {
    return { canRun: false, status: "blocked", reason: "No allowed domains configured — the bot is denied every destination until a human whitelists at least one." }
  }
  if (input.guardrails.requiresApproval && !input.approved) {
    return { canRun: false, status: "blocked", reason: "This task requires human approval before it can run." }
  }
  return { canRun: true }
}

export interface QueueOpsTaskInput {
  brokerageId: string
  requestedBy: string | null
  taskType: OpsTaskType
  targetSystem: string
  instructions: string
  guardrails?: OpsGuardrails
}

/** Queue a governed ops task. Never runs it — queue + audit only. */
export async function queueOpsTask(svc: Svc, input: QueueOpsTaskInput): Promise<{ id: string | null; error?: string }> {
  if (!input.instructions?.trim() || !input.targetSystem?.trim()) {
    return { id: null, error: "A target system and instructions are required." }
  }
  const guardrails = normalizeGuardrails(input.guardrails)
  const { data, error } = await svc.from("ops_task_runs").insert({
    brokerage_id: input.brokerageId,
    requested_by: input.requestedBy,
    task_type: input.taskType,
    target_system: input.targetSystem.trim(),
    instructions: input.instructions.trim(),
    guardrails: guardrails as any,
    status: "queued",
    audit_log: [{ at: new Date().toISOString(), event: "queued", by: input.requestedBy }] as any,
  }).select("id").single()
  if (error) return { id: null, error: error.message }
  return { id: (data as any).id }
}

/**
 * Attempt to start a queued task — runs the GATE, and because execution is not
 * yet provisioned, records the honest outcome (blocked with reason) on the
 * audit log. When the capability + runner exist, this is where the dispatch
 * to the Playwright worker slots in — behind the SAME gate.
 */
export async function tryStartOpsTask(svc: Svc, taskId: string): Promise<OpsGateDecision> {
  const { data: task } = await svc.from("ops_task_runs")
    .select("id, brokerage_id, guardrails, approved_by, audit_log").eq("id", taskId).maybeSingle()
  if (!task) return { canRun: false, status: "blocked", reason: "Task not found." }

  const { data: brk } = await svc.from("brokerages")
    .select("ops_bot_execution_enabled").eq("id", (task as any).brokerage_id).maybeSingle()

  const decision = evaluateOpsGate({
    executionEnabled: !!(brk as any)?.ops_bot_execution_enabled,
    guardrails: normalizeGuardrails((task as any).guardrails),
    approved: !!(task as any).approved_by,
  })

  const auditEntry = { at: new Date().toISOString(), event: decision.canRun ? "gate_passed" : "blocked", reason: decision.canRun ? undefined : decision.reason }
  const nextLog = [...(((task as any).audit_log ?? []) as any[]), auditEntry]
  await svc.from("ops_task_runs").update({
    status: decision.canRun ? "approved" : "blocked",
    result_summary: decision.canRun ? "Gate passed — awaiting the execution runner (not yet provisioned)." : decision.reason,
    audit_log: nextLog as any,
    updated_at: new Date().toISOString(),
  }).eq("id", taskId).then(() => {}, () => {})

  return decision
}
