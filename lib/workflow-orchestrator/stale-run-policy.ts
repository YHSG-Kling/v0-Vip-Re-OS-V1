// lib/workflow-orchestrator/stale-run-policy.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE policy for reaping STALE workflow_runs (the chain engine — listing-appt-prep, etc.). A chain
// stuck mid-execution ('running'/'pending') past a threshold has stalled and must get a manager owner
// (campaign_orchestrator owns workflow_runs) instead of falling through the cracks. Chains intentionally
// WAITING on a human ('paused'/'needs_approval') are never reaped. Mirrors the signal + video reapers.
// No I/O — unit-testable.

export type WorkflowRunReapAction = "keep" | "escalate"

/** A chain run still actively executing should complete within minutes — even with video renders,
 *  well under an hour. 2h is a conservative stalled threshold (no false-reaping a legit long chain). */
export const WORKFLOW_RUN_STALE_HOURS: Record<string, number> = {
  running: 2,
  pending: 2,
}

/** Waiting on a human / a condition — intentional, never stale. */
const BLOCKED_STATES = new Set(["paused", "needs_approval"])

/** Terminal — never reaped. */
const TERMINAL_STATES = new Set(["completed", "done", "failed", "cancelled"])

export interface WorkflowRunReapInput {
  status: string
  ageHours: number
}

/** PURE. Should this workflow_run be escalated as a stalled chain? */
export function classifyStaleWorkflowRun(input: WorkflowRunReapInput): WorkflowRunReapAction {
  if (TERMINAL_STATES.has(input.status)) return "keep"
  if (BLOCKED_STATES.has(input.status)) return "keep"
  const threshold = WORKFLOW_RUN_STALE_HOURS[input.status]
  if (threshold === undefined) return "keep" // unknown non-terminal state — don't reap blindly
  return input.ageHours >= threshold ? "escalate" : "keep"
}
