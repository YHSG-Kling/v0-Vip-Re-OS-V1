/**
 * Workflow Orchestrator — types
 *
 * Chains are multi-step sequences triggered by a kernel event. Each step is a
 * handler that produces output for the next step. Steps can require human
 * approval (paused state) before proceeding.
 *
 * Chains are defined in code under lib/workflow-orchestrator/chains/.
 * Only INSTANCES (workflow_runs + workflow_run_steps) live in the DB.
 */

export type WorkflowRunStatus =
  | "running"
  | "paused"     // waiting for human approval on the current step
  | "completed"
  | "failed"
  | "cancelled"

export type WorkflowStepStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "skipped"
  | "needs_approval"

export interface WorkflowRunContext {
  runId: string
  chainKey: string
  brokerageId: string
  contactId?: string | null
  listingId?: string | null
  transactionId?: string | null
  agentUserId?: string | null
  metadata: Record<string, any>
  /** Outputs from previously completed steps in this run, keyed by step_key */
  previousStepOutputs: Record<string, any>
}

export interface WorkflowStepResult {
  success: boolean
  output?: Record<string, any>
  error?: string
  /** If true, the run pauses after this step until a human approves */
  requiresApproval?: boolean
}

export interface WorkflowStep {
  /** Stable identifier; used as a key in step_outputs and as the slug for the row */
  key: string
  label: string
  /** The actual work this step performs */
  handler: (ctx: WorkflowRunContext) => Promise<WorkflowStepResult>
  /** When true, run pauses after step completion until a human approves */
  requiresApproval?: boolean
  /** Optional retry policy on transient failures */
  retry?: {
    max: number
    delayMs?: number
  }
}

export interface WorkflowChain {
  /** Stable identifier; e.g. 'listing-appt-prep' */
  key: string
  label: string
  /** Kernel event that auto-starts this chain */
  triggerEvent: string
  steps: WorkflowStep[]
}
