// ============================================
// SYSTEM 4.5 – READINESS EVALUATOR
// Determines if content is ready for execution
// ============================================

import { ComplianceVerdict } from "@/lib/compliance-rules/compliance-engine"
import { ApprovalDecision } from "@/lib/approval-workflow/approval-engine"
import { BrandComplianceResult } from "@/lib/brand-template-registry/brand-requirements"

/**
 * Channel Types (supported execution channels)
 */
export type ExecutionChannel =
  | "email"
  | "sms"
  | "direct_mail"
  | "facebook"
  | "instagram"
  | "linkedin"
  | "twitter"
  | "tiktok"
  | "youtube"
  | "google_ads"
  | "meta_ads"
  | "newsletter"
  | "blog"
  | "listing_website"

/**
 * Content Type Definitions
 */
export type ContentType =
  | "email"
  | "sms"
  | "social_post"
  | "ad"
  | "newsletter"
  | "blog_post"
  | "listing_description"
  | "video_script"
  | "direct_mail"
  | "image_prompt"

/**
 * Audience Scope
 */
export type AudienceScope = "private" | "public"

/**
 * Readiness Input (aggregated from upstream systems)
 */
export interface ReadinessInput {
  // Content metadata (System 4.1)
  content_type: ContentType
  channel_intent: ExecutionChannel[]
  audience_scope: AudienceScope
  content_id?: string // Optional UUID for logging

  // Compliance verdict (System 4.2)
  compliance_verdict: ComplianceVerdict

  // Approval decision (System 4.3)
  approval_decision: ApprovalDecision

  // Brand registry result (System 4.4)
  brand_compliance?: BrandComplianceResult

  // Context requirements
  context: {
    listing_id?: string
    transaction_id?: string
    contact_id?: string
    contact_eligibility?: boolean
    requires_listing?: boolean
    requires_transaction?: boolean
    requires_contact?: boolean
  }
}

/**
 * Readiness Status
 */
export type ReadinessStatus = "ready" | "blocked"

/**
 * Readiness Output (ephemeral - NEVER persisted)
 */
export interface ReadinessOutput {
  readiness_status: ReadinessStatus
  blocking_reasons?: string[]
  ready_for_channels?: ExecutionChannel[]
  evaluated_at: string
  metadata: {
    content_type: ContentType
    total_checks_performed: number
    passed_checks: number
    failed_checks: number
  }
}

/**
 * Readiness Check Result
 */
interface CheckResult {
  check_name: string
  passed: boolean
  reason?: string
}

/**
 * Main readiness evaluation function
 * Determines if content is ready for execution across channels
 * 
 * THIS FUNCTION DOES NOT:
 * - Execute campaigns
 * - Send messages
 * - Post content
 * - Schedule content
 * - Persist readiness state
 */
export function evaluateCampaignReadiness(input: ReadinessInput): ReadinessOutput {
  const checks: CheckResult[] = []
  const blockingReasons: string[] = []

  // CHECK 1: Approval readiness
  const approvalCheck = checkApprovalReadiness(input.approval_decision)
  checks.push(approvalCheck)
  if (!approvalCheck.passed && approvalCheck.reason) {
    blockingReasons.push(approvalCheck.reason)
  }

  // CHECK 2: Compliance closure
  const complianceCheck = checkComplianceClosure(
    input.compliance_verdict,
    input.approval_decision
  )
  checks.push(complianceCheck)
  if (!complianceCheck.passed && complianceCheck.reason) {
    blockingReasons.push(complianceCheck.reason)
  }

  // CHECK 3: Brand completeness
  if (input.brand_compliance) {
    const brandCheck = checkBrandCompleteness(input.brand_compliance)
    checks.push(brandCheck)
    if (!brandCheck.passed && brandCheck.reason) {
      blockingReasons.push(brandCheck.reason)
    }
  }

  // CHECK 4: Channel eligibility
  const channelCheck = checkChannelEligibility(input.content_type, input.channel_intent, input.audience_scope)
  checks.push(channelCheck)
  if (!channelCheck.passed && channelCheck.reason) {
    blockingReasons.push(channelCheck.reason)
  }

  // CHECK 5: Context readiness
  const contextCheck = checkContextReadiness(input.context)
  checks.push(contextCheck)
  if (!contextCheck.passed && contextCheck.reason) {
    blockingReasons.push(contextCheck.reason)
  }

  // Determine readiness status
  const allChecksPassed = checks.every((c) => c.passed)
  const readiness_status: ReadinessStatus = allChecksPassed ? "ready" : "blocked"

  // Determine ready channels (only if ready)
  const ready_for_channels = allChecksPassed ? input.channel_intent : undefined

  // Build metadata
  const metadata = {
    content_type: input.content_type,
    total_checks_performed: checks.length,
    passed_checks: checks.filter((c) => c.passed).length,
    failed_checks: checks.filter((c) => !c.passed).length,
  }

  return {
    readiness_status,
    blocking_reasons: blockingReasons.length > 0 ? blockingReasons : undefined,
    ready_for_channels,
    evaluated_at: new Date().toISOString(),
    metadata,
  }
}

/**
 * CHECK 1: Approval Readiness
 * Content must be approved with no blocking reasons
 */
function checkApprovalReadiness(approval: ApprovalDecision): CheckResult {
  if (approval.approval_status !== "approved") {
    return {
      check_name: "approval_readiness",
      passed: false,
      reason: `Content approval status is ${approval.approval_status}, not approved`,
    }
  }

  if (approval.blocking_reason) {
    return {
      check_name: "approval_readiness",
      passed: false,
      reason: `Approval blocked: ${approval.blocking_reason}`,
    }
  }

  return {
    check_name: "approval_readiness",
    passed: true,
  }
}

/**
 * CHECK 2: Compliance Closure
 * Compliance must be pass OR review_required + approved
 * No high-severity violations allowed
 */
function checkComplianceClosure(
  compliance: ComplianceVerdict,
  approval: ApprovalDecision
): CheckResult {
  // High-severity violations always block
  if (compliance.summary.highest_severity === "high") {
    return {
      check_name: "compliance_closure",
      passed: false,
      reason: "High-severity compliance violations detected",
    }
  }

  // Fail status blocks execution
  if (compliance.compliance_status === "fail") {
    return {
      check_name: "compliance_closure",
      passed: false,
      reason: "Compliance status is FAIL",
    }
  }

  // Review required + approved = OK
  if (
    compliance.compliance_status === "review_required" &&
    approval.approval_status === "approved"
  ) {
    return {
      check_name: "compliance_closure",
      passed: true,
    }
  }

  // Pass status = OK
  if (compliance.compliance_status === "pass") {
    return {
      check_name: "compliance_closure",
      passed: true,
    }
  }

  return {
    check_name: "compliance_closure",
    passed: false,
    reason: `Compliance status ${compliance.compliance_status} not resolved`,
  }
}

/**
 * CHECK 3: Brand Completeness
 * All required brand elements must be satisfied
 */
function checkBrandCompleteness(brandCompliance: BrandComplianceResult): CheckResult {
  if (!brandCompliance.is_compliant) {
    const missingCount = brandCompliance.missing_elements?.length || 0
    return {
      check_name: "brand_completeness",
      passed: false,
      reason: `Missing ${missingCount} required brand elements`,
    }
  }

  return {
    check_name: "brand_completeness",
    passed: true,
  }
}

/**
 * CHECK 4: Channel Eligibility
 * Content type must support intended channels
 * Audience scope must be allowed for channels
 */
function checkChannelEligibility(
  contentType: ContentType,
  channels: ExecutionChannel[],
  audienceScope: AudienceScope
): CheckResult {
  // Map content types to allowed channels
  const contentChannelMap: Record<ContentType, ExecutionChannel[]> = {
    email: ["email", "newsletter"],
    sms: ["sms"],
    social_post: ["facebook", "instagram", "linkedin", "twitter", "tiktok"],
    ad: ["google_ads", "meta_ads", "facebook", "instagram"],
    newsletter: ["email", "newsletter"],
    blog_post: ["blog", "listing_website"],
    listing_description: ["listing_website"],
    video_script: ["youtube", "tiktok", "instagram", "facebook"],
    direct_mail: ["direct_mail"],
    image_prompt: ["facebook", "instagram", "linkedin", "twitter", "google_ads", "meta_ads"],
  }

  const allowedChannels = contentChannelMap[contentType] || []
  const invalidChannels = channels.filter((c) => !allowedChannels.includes(c))

  if (invalidChannels.length > 0) {
    return {
      check_name: "channel_eligibility",
      passed: false,
      reason: `Content type ${contentType} not compatible with channels: ${invalidChannels.join(", ")}`,
    }
  }

  // Public content requires public-safe channels
  if (audienceScope === "public") {
    const privateOnlyChannels = ["sms", "direct_mail"]
    const hasPrivateChannels = channels.some((c) => privateOnlyChannels.includes(c))

    if (hasPrivateChannels) {
      return {
        check_name: "channel_eligibility",
        passed: false,
        reason: "Public-scoped content cannot use private channels (SMS, direct mail)",
      }
    }
  }

  return {
    check_name: "channel_eligibility",
    passed: true,
  }
}

/**
 * CHECK 5: Context Readiness
 * Required context entities must be present
 */
function checkContextReadiness(context: ReadinessInput["context"]): CheckResult {
  const missing: string[] = []

  if (context.requires_listing && !context.listing_id) {
    missing.push("listing_id")
  }

  if (context.requires_transaction && !context.transaction_id) {
    missing.push("transaction_id")
  }

  if (context.requires_contact && !context.contact_id) {
    missing.push("contact_id")
  }

  if (context.requires_contact && context.contact_eligibility === false) {
    missing.push("contact_eligibility")
  }

  if (missing.length > 0) {
    return {
      check_name: "context_readiness",
      passed: false,
      reason: `Missing required context: ${missing.join(", ")}`,
    }
  }

  return {
    check_name: "context_readiness",
    passed: true,
  }
}

/**
 * Batch evaluate readiness for multiple content pieces
 */
export function batchEvaluateCampaignReadiness(inputs: ReadinessInput[]): ReadinessOutput[] {
  return inputs.map((input) => evaluateCampaignReadiness(input))
}

/**
 * Quick readiness check (approval + compliance only)
 */
export function quickReadinessCheck(
  approval: ApprovalDecision,
  compliance: ComplianceVerdict
): { is_ready: boolean; reason?: string } {
  if (approval.approval_status !== "approved") {
    return { is_ready: false, reason: "Not approved" }
  }

  if (compliance.compliance_status === "fail") {
    return { is_ready: false, reason: "Compliance failure" }
  }

  if (compliance.summary.highest_severity === "high") {
    return { is_ready: false, reason: "High-severity violations" }
  }

  return { is_ready: true }
}

/**
 * Check readiness for specific channel only
 */
export function checkChannelReadiness(
  input: ReadinessInput,
  targetChannel: ExecutionChannel
): { is_ready: boolean; reason?: string } {
  // Run full readiness check
  const fullCheck = evaluateCampaignReadiness(input)

  if (fullCheck.readiness_status === "blocked") {
    return {
      is_ready: false,
      reason: fullCheck.blocking_reasons?.join("; "),
    }
  }

  // Check if channel is in ready list
  const isChannelReady = fullCheck.ready_for_channels?.includes(targetChannel)

  if (!isChannelReady) {
    return {
      is_ready: false,
      reason: `Channel ${targetChannel} not in ready channels list`,
    }
  }

  return { is_ready: true }
}

/**
 * Format readiness output for display
 */
export function formatReadinessOutput(output: ReadinessOutput): string {
  let result = `Readiness Status: ${output.readiness_status.toUpperCase()}\n`
  result += `Evaluated: ${new Date(output.evaluated_at).toLocaleString()}\n\n`

  result += `Check Results:\n`
  result += `- Total Checks: ${output.metadata.total_checks_performed}\n`
  result += `- Passed: ${output.metadata.passed_checks}\n`
  result += `- Failed: ${output.metadata.failed_checks}\n\n`

  if (output.readiness_status === "ready" && output.ready_for_channels) {
    result += `Ready for Channels:\n`
    for (const channel of output.ready_for_channels) {
      result += `- ${channel}\n`
    }
  }

  if (output.blocking_reasons && output.blocking_reasons.length > 0) {
    result += `\nBlocking Reasons:\n`
    for (const reason of output.blocking_reasons) {
      result += `- ${reason}\n`
    }
  }

  return result
}
