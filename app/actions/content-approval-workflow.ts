"use server"

import { type ContentGenerationOutput } from "@/lib/content-generation"
import { type ComplianceVerdict } from "@/lib/compliance-rules"
import {
  determineApprovalDecision,
  determineRequiredApprovers,
  hasApprovalAuthority,
  logApprovalDecision,
  getApprovalDecisionHistory,
  getApprovalStats,
  getPendingApprovals,
  type ApprovalContext,
  type ApprovalDecision,
  type ApproverRole,
} from "@/lib/approval-workflow"
import { isValidUUID } from "@/lib/validations"
import { getAgentContext } from "@/lib/identity/get-agent-context"

// ============================================
// SYSTEM 4.3 – CONTENT APPROVAL WORKFLOW
// Server Actions (Public API)
// ============================================

/**
 * Resolves session-derived agent identifier for approval logging.
 * NEVER trusts caller-supplied agent_id.
 */
async function getSessionAgentId(): Promise<
  | { ok: true; agentId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { ok: false, error: "Unauthorized" }
  }
  // NOT `?? ctx.userId` (m360). This helper is the single point where agentId
  // is manufactured for every write in this file, and all of them attribute to
  // an agents-class column. Substituting the users id put a value there that
  // the foreign key rejects — so the compliance/approval log, the record of
  // what the OS decided and why, silently lost exactly the rows belonging to
  // users who had not finished setup.
  if (!ctx.agentId) {
    return { ok: false, error: "No agent profile for this user yet — finish account setup." }
  }
  return {
    ok: true,
    agentId: ctx.agentId,
    brokerageId: ctx.brokerageId,
  }
}

/**
 * Evaluate approval decision for content
 * Returns ephemeral decision (not persisted)
 */
export async function evaluateContentApproval(params: {
  draft: ContentGenerationOutput
  complianceVerdict: ComplianceVerdict
  context: ApprovalContext
  log_signal?: boolean
  agent_id?: string // ignored — derived from session
  content_id?: string
}): Promise<{
  success: boolean
  decision?: ApprovalDecision
  error?: string
}> {
  try {
    const auth = await getSessionAgentId()
    if (!auth.ok) return { success: false, error: auth.error }

    // Validate inputs
    if (!params.draft || !params.complianceVerdict || !params.context) {
      return {
        success: false,
        error: "Missing required inputs: draft, complianceVerdict, or context",
      }
    }

    // Validate content_id if provided
    if (params.content_id && !isValidUUID(params.content_id)) {
      return { success: false, error: "Invalid content_id format" }
    }

    // Determine approval decision
    const decision = determineApprovalDecision(params.draft, params.complianceVerdict, params.context)

    // Optionally log signal to activities — attribute to authenticated agent
    if (params.log_signal) {
      const contentPreview = params.draft.raw_content.substring(0, 200)
      await logApprovalDecision({
        agent_id: auth.agentId,
        content_id: params.content_id,
        decision,
        requester_role: params.context.requester_role,
        content_preview: contentPreview,
      })
    }

    return { success: true, decision }
  } catch (error) {
    console.error("[System 4.3] Error evaluating content approval:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

// batchEvaluateContentApproval was DELETED (orphan burn-down): the batch twin of
// evaluateContentApproval. Same engine, no caller, and nothing in the product
// submits content for approval in batches — every producer routes one draft at a
// time. evaluateContentApproval survives and is what the compliance review panel
// calls after a verdict.

/**
 * Check if user has authority to approve
 */
export async function checkApprovalAuthority(params: {
  user_role: ApproverRole
  draft: ContentGenerationOutput
  complianceVerdict: ComplianceVerdict
  context: ApprovalContext
}): Promise<{
  success: boolean
  has_authority?: boolean
  required_approvers?: ApproverRole[]
  error?: string
}> {
  try {
    const auth = await getSessionAgentId()
    if (!auth.ok) return { success: false, error: auth.error }

    // Validate inputs
    if (!params.user_role || !params.draft || !params.complianceVerdict || !params.context) {
      return { success: false, error: "Missing required inputs" }
    }

    // Determine required approvers
    const required_approvers = determineRequiredApprovers(
      params.draft,
      params.complianceVerdict,
      params.context
    )

    // Check if user has authority
    const has_authority = hasApprovalAuthority(params.user_role, required_approvers)

    return { success: true, has_authority, required_approvers }
  } catch (error) {
    console.error("[System 4.3] Error checking approval authority:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

// previewContentApproval was DELETED (orphan burn-down): the guess-only twin of
// evaluateContentApproval. previewApprovalDecision infers a likely route from four
// strings, while determineApprovalDecision routes off the real draft and the real
// compliance verdict — and only the real one writes the approval_required signal
// the /dashboard/content/approvals queue reads. Keeping the guess alongside the
// evaluator gave two answers to the same question.

// formatApprovalDecisionForDisplay was DELETED (orphan burn-down): a pure string
// formatter exposed as an RPC endpoint with no caller. The approval decision is
// rendered from its structured fields (status / required_approvers /
// blocking_reason / approval_notes) wherever it is shown.

/**
 * Get approval decision history
 */
export async function getApprovalHistory(params: {
  agent_id?: string // ignored — derived from session
  limit?: number
  status_filter?: "approved" | "pending" | "rejected"
}): Promise<{
  success: boolean
  history?: Array<{
    id: string
    title: string
    description: string
    activity_type: string
    notes: any
    status: string
    completed_at: string | null
    created_at: string
  }>
  error?: string
}> {
  try {
    const auth = await getSessionAgentId()
    if (!auth.ok) return { success: false, error: auth.error }

    const history = await getApprovalDecisionHistory({
      ...params,
      agent_id: auth.agentId,
    })
    return { success: true, history }
  } catch (error) {
    console.error("[System 4.3] Error getting approval history:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Get approval statistics
 */
export async function getApprovalStatistics(params: {
  agent_id?: string // ignored — derived from session
  date_range?: { start: string; end: string }
}): Promise<{
  success: boolean
  stats?: {
    total_decisions: number
    approved_count: number
    pending_count: number
    rejected_count: number
    auto_approved_count: number
    by_content_type: Record<string, { approved: number; pending: number; rejected: number }>
    by_channel: Record<string, { approved: number; pending: number; rejected: number }>
    by_requester_role: Record<string, { approved: number; pending: number; rejected: number }>
    common_blocking_reasons: Array<{ reason: string; count: number }>
  }
  error?: string
}> {
  try {
    const auth = await getSessionAgentId()
    if (!auth.ok) return { success: false, error: auth.error }

    // Validate date range if provided
    if (params.date_range) {
      const start = new Date(params.date_range.start)
      const end = new Date(params.date_range.end)
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        return { success: false, error: "Invalid date range format" }
      }
      if (start > end) {
        return { success: false, error: "Start date must be before end date" }
      }
    }

    const stats = await getApprovalStats({
      ...params,
      agent_id: auth.agentId,
    })
    return { success: true, stats }
  } catch (error) {
    console.error("[System 4.3] Error getting approval stats:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Get pending approvals for a specific role
 */
export async function getMyPendingApprovals(params: {
  approver_role: ApproverRole
  limit?: number
}): Promise<{
  success: boolean
  pending?: Array<{
    id: string
    title: string
    description: string
    notes: any
    created_at: string
  }>
  error?: string
}> {
  try {
    const auth = await getSessionAgentId()
    if (!auth.ok) return { success: false, error: auth.error }

    // Validate inputs
    if (!params.approver_role) {
      return { success: false, error: "Missing approver_role" }
    }

    const pending = await getPendingApprovals(params)
    return { success: true, pending }
  } catch (error) {
    console.error("[System 4.3] Error getting pending approvals:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

// evaluateContentWorkflow was DELETED (orphan burn-down): a pass-through wrapper
// around evaluateContentApproval that added a second auth round-trip and echoed
// its own inputs back. It made a single decision look like two entry points.
// Callers use evaluateContentApproval directly — they already hold the draft and
// the verdict they passed in.
