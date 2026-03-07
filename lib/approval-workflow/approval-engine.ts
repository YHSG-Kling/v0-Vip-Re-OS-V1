// ============================================
// SYSTEM 4.3 – APPROVAL ENGINE
// Determines approval outcomes (decision logic only)
// ============================================

import { type ComplianceVerdict } from "@/lib/compliance-rules"
import { type ContentGenerationOutput } from "@/lib/content-generation"

/**
 * Content Origin Types
 */
export type ContentOrigin = "template" | "ai_generated" | "human_custom"

/**
 * Audience Scope
 */
export type AudienceScope = "private" | "public"

/**
 * Approver Roles
 */
export type ApproverRole = "agent" | "team_lead" | "broker" | "compliance_officer"

/**
 * Approval Status
 */
export type ApprovalStatus = "approved" | "pending" | "rejected"

/**
 * Approval Context (runtime input)
 */
export interface ApprovalContext {
  requester_role: ApproverRole
  content_origin: ContentOrigin
  audience_scope: AudienceScope
  brokerage_policy_level?: "standard" | "strict" | "custom"
  is_new_campaign?: boolean
}

/**
 * Approval Decision (ephemeral output - NEVER persisted)
 */
export interface ApprovalDecision {
  approval_status: ApprovalStatus
  required_approvers?: ApproverRole[]
  blocking_reason?: string
  approval_notes?: string[]
  decided_at: string
  metadata: {
    content_type: string
    channel_intent: string
    compliance_status: string
    highest_violation_severity: string | null
    auto_approved: boolean
  }
}

/**
 * Main approval decision function
 * Determines if content is approved, pending, or rejected
 * 
 * THIS FUNCTION DOES NOT:
 * - Persist approval state
 * - Queue approvals
 * - Notify approvers
 * - Publish content
 * - Modify content
 */
export function determineApprovalDecision(
  draft: ContentGenerationOutput,
  complianceVerdict: ComplianceVerdict,
  context: ApprovalContext
): ApprovalDecision {
  const notes: string[] = []
  const metadata = {
    content_type: draft.content_type,
    channel_intent: draft.channel_intent,
    compliance_status: complianceVerdict.compliance_status,
    highest_violation_severity: complianceVerdict.summary.highest_severity,
    auto_approved: false,
  }

  // RULE 1: BLOCKED if compliance failed
  if (complianceVerdict.compliance_status === "fail") {
    return {
      approval_status: "rejected",
      blocking_reason: "Compliance failure with high-severity violations",
      approval_notes: [
        `Compliance status: ${complianceVerdict.compliance_status}`,
        `Total violations: ${complianceVerdict.summary.total_violations}`,
        `Highest severity: ${complianceVerdict.summary.highest_severity}`,
        "Content must be rewritten to address compliance issues",
      ],
      decided_at: new Date().toISOString(),
      metadata,
    }
  }

  // RULE 2: BLOCKED if any high-severity violations exist
  if (complianceVerdict.summary.highest_severity === "high") {
    return {
      approval_status: "rejected",
      blocking_reason: "High-severity compliance violations detected",
      approval_notes: [
        "One or more high-severity violations found",
        "Required actions: " + complianceVerdict.required_actions.join(", "),
        "Content cannot proceed without addressing these issues",
      ],
      decided_at: new Date().toISOString(),
      metadata,
    }
  }

  // RULE 3: AUTO-APPROVED if ALL conditions met
  const isAutoApproved =
    complianceVerdict.compliance_status === "pass" &&
    context.content_origin === "template" &&
    context.audience_scope === "private"

  if (isAutoApproved) {
    metadata.auto_approved = true
    return {
      approval_status: "approved",
      approval_notes: [
        "Auto-approved: Template content for private use",
        "Compliance: PASS",
        "No manual review required",
      ],
      decided_at: new Date().toISOString(),
      metadata,
    }
  }

  // RULE 4: REVIEW REQUIRED if any condition met
  const requiresReview =
    complianceVerdict.compliance_status === "review_required" ||
    context.content_origin === "ai_generated" ||
    context.audience_scope === "public" ||
    context.is_new_campaign === true

  if (requiresReview) {
    const required_approvers = determineRequiredApprovers(draft, complianceVerdict, context)

    notes.push("Manual review required before content may proceed")

    if (complianceVerdict.compliance_status === "review_required") {
      notes.push("Compliance requires review: medium-severity violations detected")
    }

    if (context.content_origin === "ai_generated") {
      notes.push("AI-generated content requires human validation")
    }

    if (context.audience_scope === "public") {
      notes.push("Public-facing content requires additional approval")
    }

    if (context.is_new_campaign) {
      notes.push("New campaign type requires initial approval")
    }

    return {
      approval_status: "pending",
      required_approvers,
      approval_notes: notes,
      decided_at: new Date().toISOString(),
      metadata,
    }
  }

  // DEFAULT: Approve with standard review
  return {
    approval_status: "approved",
    approval_notes: [
      "Approved for use",
      `Compliance: ${complianceVerdict.compliance_status}`,
      "Standard content approval applied",
    ],
    decided_at: new Date().toISOString(),
    metadata,
  }
}

/**
 * Determine who has authority to approve
 * Based on content type, channel, scope, and policy
 */
export function determineRequiredApprovers(
  draft: ContentGenerationOutput,
  complianceVerdict: ComplianceVerdict,
  context: ApprovalContext
): ApproverRole[] {
  const approvers: ApproverRole[] = []

  // High-severity requires compliance manager
  if (complianceVerdict.summary.highest_severity === "high") {
    approvers.push("compliance_officer")
    approvers.push("broker")
    return approvers
  }

  // Medium-severity requires team leader or higher
  if (complianceVerdict.summary.highest_severity === "medium") {
    approvers.push("team_lead")
  }

  // Public content requires broker/admin approval
  if (context.audience_scope === "public") {
    if (!approvers.includes("broker")) {
      approvers.push("broker")
    }
  }

  // High-value channels require team leader
  const highValueChannels = ["google_ads", "meta_ads", "email", "newsletter"]
  if (highValueChannels.includes(draft.channel_intent)) {
    if (!approvers.includes("team_lead")) {
      approvers.push("team_lead")
    }
  }

  // Strict policy level requires broker
  if (context.brokerage_policy_level === "strict") {
    if (!approvers.includes("broker")) {
      approvers.push("broker")
    }
  }

  // New campaigns require team leader
  if (context.is_new_campaign) {
    if (!approvers.includes("team_lead")) {
      approvers.push("team_lead")
    }
  }

  // Default: Agent can approve if no other approvers required
  if (approvers.length === 0) {
    approvers.push("agent")
  }

  return approvers
}

/**
 * Check if a specific user role has authority to approve
 */
export function hasApprovalAuthority(
  userRole: ApproverRole,
  requiredApprovers: ApproverRole[]
): boolean {
  // Role hierarchy
  const roleHierarchy: Record<ApproverRole, number> = {
    agent: 1,
  team_lead: 2,
  broker: 3,
  compliance_officer: 4,
  }

  const userLevel = roleHierarchy[userRole]
  const requiredLevel = Math.max(...requiredApprovers.map((r) => roleHierarchy[r]))

  return userLevel >= requiredLevel
}

/**
 * Batch approval decisions
 */
export function batchDetermineApprovalDecisions(
  inputs: Array<{
    draft: ContentGenerationOutput
    complianceVerdict: ComplianceVerdict
    context: ApprovalContext
  }>
): ApprovalDecision[] {
  return inputs.map(({ draft, complianceVerdict, context }) =>
    determineApprovalDecision(draft, complianceVerdict, context)
  )
}

/**
 * Simulate approval decision for preview (without executing)
 */
export function previewApprovalDecision(
  contentType: string,
  channelIntent: string,
  complianceStatus: "pass" | "fail" | "review_required",
  context: ApprovalContext
): {
  likely_status: ApprovalStatus
  likely_approvers: ApproverRole[]
  reasoning: string[]
} {
  const reasoning: string[] = []

  // Check for auto-rejection
  if (complianceStatus === "fail") {
    return {
      likely_status: "rejected",
      likely_approvers: [],
      reasoning: ["Compliance failure will result in automatic rejection"],
    }
  }

  // Check for auto-approval
  if (
    complianceStatus === "pass" &&
    context.content_origin === "template" &&
    context.audience_scope === "private"
  ) {
    return {
      likely_status: "approved",
      likely_approvers: [],
      reasoning: ["Template content for private use is auto-approved"],
    }
  }

  // Determine likely approvers
  const likely_approvers: ApproverRole[] = []

  if (context.audience_scope === "public") {
    likely_approvers.push("broker")
    reasoning.push("Public content requires broker/admin approval")
  }

  if (context.content_origin === "ai_generated") {
    if (!likely_approvers.includes("team_lead")) {
      likely_approvers.push("team_lead")
    }
    reasoning.push("AI-generated content requires human validation")
  }

  if (complianceStatus === "review_required") {
    if (!likely_approvers.includes("team_lead")) {
      likely_approvers.push("team_lead")
    }
    reasoning.push("Compliance review required")
  }

  if (likely_approvers.length === 0) {
    likely_approvers.push("agent")
    reasoning.push("Standard agent approval sufficient")
  }

  return {
    likely_status: "pending",
    likely_approvers,
    reasoning,
  }
}

/**
 * Format approval decision for display
 */
export function formatApprovalDecision(decision: ApprovalDecision): string {
  let output = `Approval Status: ${decision.approval_status.toUpperCase()}\n`
  output += `Decided: ${new Date(decision.decided_at).toLocaleString()}\n`
  output += `Auto-Approved: ${decision.metadata.auto_approved ? "Yes" : "No"}\n\n`

  if (decision.required_approvers && decision.required_approvers.length > 0) {
    output += `Required Approvers:\n`
    for (const approver of decision.required_approvers) {
      output += `- ${approver.replace(/_/g, " ").toUpperCase()}\n`
    }
    output += `\n`
  }

  if (decision.blocking_reason) {
    output += `Blocking Reason:\n${decision.blocking_reason}\n\n`
  }

  if (decision.approval_notes && decision.approval_notes.length > 0) {
    output += `Notes:\n`
    for (const note of decision.approval_notes) {
      output += `- ${note}\n`
    }
  }

  output += `\nMetadata:\n`
  output += `- Content Type: ${decision.metadata.content_type}\n`
  output += `- Channel: ${decision.metadata.channel_intent}\n`
  output += `- Compliance: ${decision.metadata.compliance_status}\n`
  output += `- Highest Severity: ${decision.metadata.highest_violation_severity || "None"}\n`

  return output
}
