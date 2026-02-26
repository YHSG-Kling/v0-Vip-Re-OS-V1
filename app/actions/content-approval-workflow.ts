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

// ============================================
// SYSTEM 4.3 – CONTENT APPROVAL WORKFLOW
// Server Actions (Public API)
// ============================================

/**
 * Evaluate approval decision for content
 * Returns ephemeral decision (not persisted)
 */
export async function evaluateContentApproval(params: {
  draft: ContentGenerationOutput
  complianceVerdict: ComplianceVerdict
  context: ApprovalContext
  log_signal?: boolean
  agent_id?: string
  content_id?: string
}): Promise<{
  success: boolean
  decision?: ApprovalDecision
  error?: string
}> {
  try {
    // Validate inputs
    if (!params.draft || !params.complianceVerdict || !params.context) {
      return {
        success: false,
        error: "Missing required inputs: draft, complianceVerdict, or context",
      }
    }

    // Validate agent_id if provided
    if (params.agent_id && !isValidUUID(params.agent_id)) {
      return { success: false, error: "Invalid agent_id format" }
    }

    // Validate content_id if provided
    if (params.content_id && !isValidUUID(params.content_id)) {
      return { success: false, error: "Invalid content_id format" }
    }

    // Determine approval decision
    const decision = determineApprovalDecision(params.draft, params.complianceVerdict, params.context)

    // Optionally log signal to activities
    if (params.log_signal && params.agent_id) {
      const contentPreview = params.draft.raw_content.substring(0, 200)
      await logApprovalDecision({
        agent_id: params.agent_id,
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
  agent_id?: string
}): Promise<{
  success: boolean
  decisions?: ApprovalDecision[]
  error?: string
}> {
  try {
    // Validate inputs
    if (!params.inputs || params.inputs.length === 0) {
      return { success: false, error: "No inputs provided" }
    }

    // Validate agent_id if provided
    if (params.agent_id && !isValidUUID(params.agent_id)) {
      return { success: false, error: "Invalid agent_id format" }
    }

    // Determine approval decisions
    const decisions = batchDetermineApprovalDecisions(params.inputs)

    // Optionally log signals
    if (params.log_signals && params.agent_id) {
      const loggingData = decisions.map((decision, index) => ({
        agent_id: params.agent_id,
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
  agent_id?: string
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
    // Validate agent_id if provided
    if (params.agent_id && !isValidUUID(params.agent_id)) {
      return { success: false, error: "Invalid agent_id format" }
    }

    const history = await getApprovalDecisionHistory(params)
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
  agent_id?: string
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
    // Validate agent_id if provided
    if (params.agent_id && !isValidUUID(params.agent_id)) {
      return { success: false, error: "Invalid agent_id format" }
    }

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

    const stats = await getApprovalStats(params)
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

/**
 * Complete workflow: Generate → Evaluate Compliance → Evaluate Approval
 * Returns decision only (does not execute approval)
 */
export async function evaluateContentWorkflow(params: {
  draft: ContentGenerationOutput
  complianceVerdict: ComplianceVerdict
  context: ApprovalContext
  log_signals?: boolean
  agent_id?: string
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
    // Validate inputs
    if (!params.draft || !params.complianceVerdict || !params.context) {
      return {
        success: false,
        error: "Missing required inputs: draft, complianceVerdict, or context",
      }
    }

    // Evaluate approval decision
    const approvalResult = await evaluateContentApproval({
      draft: params.draft,
      complianceVerdict: params.complianceVerdict,
      context: params.context,
      log_signal: params.log_signals,
      agent_id: params.agent_id,
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
