"use server"

import { type ContentGenerationOutput } from "@/lib/content-generation"
import { type ComplianceVerdict } from "@/lib/compliance-rules"
import {
  determineApprovalDecision,
  determineRequiredApprovers,
  hasApprovalAuthority,
  batchDetermineApprovalDecisions,
  previewApprovalDecision,
  formatApprovalDecision,
  logApprovalDecision,
  logBatchApprovalDecisions,
  getApprovalDecisionHistory,
  getApprovalStats,
  getPendingApprovals,
  type ApprovalContext,
  type ApprovalDecision,
  type ApproverRole,
} from "@/lib/approval-workflow"
import { isValidUUID } from "@/lib/validations"
import { requireSessionAgentId as getSessionAgentId } from "@/lib/identity/get-agent-context"

// ============================================
// SYSTEM 4.3 – CONTENT APPROVAL WORKFLOW
// Server Actions (Public API)
// ============================================

// TOMBSTONE: local getSessionAgentId merged onto
// lib/identity/get-agent-context.ts requireSessionAgentId (imported above as
// `getSessionAgentId`) — §1/§6 SAME BODY census round 3, 2026-09-09.

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

/**
 * Batch evaluate approval decisions
 */
export async function batchEvaluateContentApproval(params: {
  inputs: Array<{
    draft: ContentGenerationOutput
    complianceVerdict: ComplianceVerdict
    context: ApprovalContext
  }>
  log_signals?: boolean
  agent_id?: string // ignored — derived from session
}): Promise<{
  success: boolean
  decisions?: ApprovalDecision[]
  error?: string
}> {
  try {
    const auth = await getSessionAgentId()
    if (!auth.ok) return { success: false, error: auth.error }

    // Validate inputs
    if (!params.inputs || params.inputs.length === 0) {
      return { success: false, error: "No inputs provided" }
    }

    // Determine approval decisions
    const decisions = batchDetermineApprovalDecisions(params.inputs)

    // Optionally log signals — attribute to authenticated agent
    if (params.log_signals) {
      const loggingData = decisions.map((decision, index) => ({
        agent_id: auth.agentId,
        decision,
        requester_role: params.inputs[index].context.requester_role,
        content_preview: params.inputs[index].draft.raw_content.substring(0, 200),
      }))

      await logBatchApprovalDecisions(loggingData)
    }

    return { success: true, decisions }
  } catch (error) {
    console.error("[System 4.3] Error batch evaluating approvals:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

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

/**
 * Preview approval decision (without executing)
 */
export async function previewContentApproval(params: {
  content_type: string
  channel_intent: string
  compliance_status: "pass" | "fail" | "review_required"
  context: ApprovalContext
}): Promise<{
  success: boolean
  preview?: {
    likely_status: "approved" | "pending" | "rejected"
    likely_approvers: ApproverRole[]
    reasoning: string[]
  }
  error?: string
}> {
  try {
    const auth = await getSessionAgentId()
    if (!auth.ok) return { success: false, error: auth.error }

    // Validate inputs
    if (!params.content_type || !params.channel_intent || !params.compliance_status || !params.context) {
      return { success: false, error: "Missing required inputs" }
    }

    // Preview approval decision
    const preview = previewApprovalDecision(
      params.content_type,
      params.channel_intent,
      params.compliance_status,
      params.context
    )

    return { success: true, preview }
  } catch (error) {
    console.error("[System 4.3] Error previewing approval:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Format approval decision for display
 */
export async function formatApprovalDecisionForDisplay(
  decision: ApprovalDecision
): Promise<{
  success: boolean
  formatted?: string
  error?: string
}> {
  try {
    // This was the one export in the file with no gate. It reads no tenant
    // data, but a "use server" export is a public HTTP endpoint and every
    // other action here is gated; an ungated sibling is the seam an audit
    // misses.
    const auth = await getSessionAgentId()
    if (!auth.ok) return { success: false, error: auth.error }

    if (!decision) {
      return { success: false, error: "No decision provided" }
    }

    const formatted = formatApprovalDecision(decision)
    return { success: true, formatted }
  } catch (error) {
    console.error("[System 4.3] Error formatting approval decision:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

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
    // THE ROLE COMES FROM THE SESSION (wave 146, lane 146Z on lane 146H's Outside-lane 4 / 146E Outside-lane 7 — CLAUDE.md
    // §4): this read took `approver_role` from the caller, so any signed-in seat could read the broker's (or compliance's)
    // queue by asking for it. A requested role the session does not HOLD is refused (fail closed).
    const { getAgentContext } = await import("@/lib/identity/get-agent-context")
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Unauthorized" }

    // Validate inputs
    if (!params.approver_role) {
      return { success: false, error: "Missing approver_role" }
    }
    if (!sessionApproverRoles(ctx.userType).includes(params.approver_role)) {
      return { success: false, error: `you do not hold the ${params.approver_role} approval role` }
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

/** The approval engine's four approver roles the SESSION's seat holds (lib/approval-workflow/approval-engine.ts ApproverRole). */
function sessionApproverRoles(userType: string | null | undefined): ApproverRole[] {
  const t = String(userType ?? "")
  if (t === "broker" || t === "broker_owner" || t === "broker_admin" || t === "admin") return ["broker"]
  if (t === "team_lead") return ["team_lead", "agent"]
  if (t === "compliance_officer") return ["compliance_officer"]
  if (t === "agent") return ["agent"]
  return []
}

/**
 * DECIDE A CONTENT APPROVAL — on the SERVER, with authority, evidence and a row count (wave 146, lane 146Z on lane 146H's
 * Outside-lane 4; laws 4–5). The Content Approvals page used to write the decision from the BROWSER straight into
 * `activities`. Here: the tenant is the session's; the item is read on the service client pinned to that tenant and to a
 * still-PENDING approval_required row; the caller must hold one of the item's required approver roles (an `agent`
 * approves only an item that is their own); the decision is written under withActionLedger and COUNTED (0 rows = someone
 * decided it first, said so).
 */
export async function decideContentApproval(params: { activityId: string; decision: "approved" | "rejected" }): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isValidUUID(params.activityId)) return { success: false, error: "Invalid approval id" }
    if (params.decision !== "approved" && params.decision !== "rejected") return { success: false, error: "Invalid decision" }
    const { getAgentContext } = await import("@/lib/identity/get-agent-context")
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId || !ctx.userId) return { success: false, error: "Unauthorized" }
    const { createServiceClient } = await import("@/lib/supabase/service")
    const svc = createServiceClient()
    const { data: item, error: readErr } = await svc.from("activities")
      .select("id, agent_id, notes, status, activity_type")
      .eq("id", params.activityId).eq("brokerage_id", ctx.brokerageId).eq("activity_type", "approval_required").eq("status", "pending")
      .maybeSingle()
    if (readErr) return { success: false, error: `approval read refused: ${readErr.message}` }
    if (!item) return { success: false, error: "Not saved — this item is not pending in your brokerage (already decided, or not yours to decide)" }
    const row = item as { id: string; agent_id: string | null; notes: unknown }
    let notes: Record<string, unknown> = {}
    try { notes = (typeof row.notes === "string" ? JSON.parse(row.notes) : (row.notes ?? {})) as Record<string, unknown> } catch { notes = {} }
    const required = Array.isArray(notes.required_approvers) ? (notes.required_approvers as string[]) : []
    const held = sessionApproverRoles(ctx.userType)
    const asRole = held.find((r) => required.includes(r) && (r !== "agent" || (!!ctx.agentId && row.agent_id === ctx.agentId)))
    if (!asRole) return { success: false, error: "Not saved — you are not one of this item's required approvers" }

    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    const nowIso = new Date().toISOString()
    const decided = await withActionLedger(
      {
        brokerageId: ctx.brokerageId, action: "content.approval.decide", actor: { type: "user", userId: ctx.userId },
        subject: { type: "activity", id: row.id }, reasonCode: "HUMAN_REQUESTED", systemSource: "content_approvals_page",
        reasonDetail: `content ${params.decision} as ${asRole} (owner ruling 9 — the tenant's authorized person approves its own assets)`,
        cycle: `content_approval:${row.id}`,
        detail: { decision: params.decision, as_role: asRole, required_approvers: required },
      },
      async () => {
        const { data, error } = await svc.from("activities")
          .update({ status: params.decision === "approved" ? "completed" : "rejected", completed_at: nowIso, notes: { ...notes, approval_status: params.decision, decided_by: ctx.userId, decided_as: asRole } })
          .eq("id", row.id).eq("brokerage_id", ctx.brokerageId).eq("status", "pending")
          .select("id")
        if (error) return { n: 0, error: error.message as string }
        return { n: (data ?? []).length, error: null as string | null }
      },
      {
        settle: (r) => r.n === 1 ? { status: "executed", outcome: `content_${params.decision}` } : { status: "failed", outcome: "decision_matched_nothing", error: r.error ?? "0 rows matched" },
        replay: () => ({ n: 0, error: "this decision was already recorded" }),
      },
      { client: svc },
    )
    if (decided.n !== 1) return { success: false, error: `Not saved — ${decided.error ?? "someone decided this item first"}` }
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Unknown error" }
  }
}

/**
 * Complete workflow: Generate → Evaluate Compliance → Evaluate Approval
 * Returns decision only (does not execute approval)
 */
export async function evaluateContentWorkflow(params: {
  draft: ContentGenerationOutput
  complianceVerdict: ComplianceVerdict
  context: ApprovalContext
  log_signals?: boolean
  agent_id?: string // ignored — derived from session
  content_id?: string
}): Promise<{
  success: boolean
  workflow_result?: {
    draft: ContentGenerationOutput
    compliance: ComplianceVerdict
    approval: ApprovalDecision
  }
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

    // Evaluate approval decision — agent_id is session-derived inside the callee
    const approvalResult = await evaluateContentApproval({
      draft: params.draft,
      complianceVerdict: params.complianceVerdict,
      context: params.context,
      log_signal: params.log_signals,
      content_id: params.content_id,
    })

    if (!approvalResult.success || !approvalResult.decision) {
      return {
        success: false,
        error: approvalResult.error || "Failed to evaluate approval",
      }
    }

    return {
      success: true,
      workflow_result: {
        draft: params.draft,
        compliance: params.complianceVerdict,
        approval: approvalResult.decision,
      },
    }
  } catch (error) {
    console.error("[System 4.3] Error in content workflow:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}
