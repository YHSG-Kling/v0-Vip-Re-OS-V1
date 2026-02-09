"use server"

import { isValidUUID } from "@/lib/validations"
import {
  ComplianceContentInput,
  evaluateContentCompliance,
  evaluateSpecificCategory,
  quickComplianceCheck,
  batchEvaluateCompliance,
  ComplianceVerdict,
  formatComplianceVerdict,
} from "@/lib/compliance-rules/compliance-engine"
import {
  logComplianceEvaluation,
  logBatchComplianceEvaluations,
  getComplianceEvaluationHistory,
  getComplianceStats,
} from "@/lib/compliance-rules/compliance-logger"

// ============================================
// SYSTEM 4.2 – COMPLIANCE RULES ENGINE
// Public Server Actions (Evaluation-Only)
// ============================================

/**
 * Evaluate content for compliance (Main API)
 * Returns ephemeral verdict (not persisted)
 */
export async function evaluateCompliance(
  input: ComplianceContentInput,
  options?: {
    log_to_activities?: boolean
    agent_id?: string
    content_id?: string
  }
): Promise<{ success: boolean; verdict?: ComplianceVerdict; error?: string }> {
  try {
    // Validate input
    if (!input.raw_content || input.raw_content.trim().length === 0) {
      return {
        success: false,
        error: "Content is required for compliance evaluation",
      }
    }

    if (!input.content_type) {
      return {
        success: false,
        error: "Content type is required",
      }
    }

    // Validate UUIDs if provided
    if (options?.content_id && !isValidUUID(options.content_id)) {
      return {
        success: false,
        error: "Invalid content_id format",
      }
    }

    if (options?.agent_id && !isValidUUID(options.agent_id)) {
      return {
        success: false,
        error: "Invalid agent_id format",
      }
    }

    // Validate context UUIDs
    if (input.context?.listing_id && !isValidUUID(input.context.listing_id)) {
      return {
        success: false,
        error: "Invalid listing_id format",
      }
    }

    if (input.context?.transaction_id && !isValidUUID(input.context.transaction_id)) {
      return {
        success: false,
        error: "Invalid transaction_id format",
      }
    }

    // Evaluate compliance
    const verdict = await evaluateContentCompliance(input)

    // Optionally log to activities
    if (options?.log_to_activities) {
      await logComplianceEvaluation({
        agent_id: options.agent_id,
        content_id: options.content_id,
        content_type: input.content_type,
        channel_intent: input.channel_intent,
        verdict,
        content_preview: input.raw_content.substring(0, 200),
      })
    }

    return {
      success: true,
      verdict,
    }
  } catch (error) {
    console.error("[System 4.2] Error evaluating compliance:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Evaluate content against specific category only
 */
export async function evaluateCategory(
  input: ComplianceContentInput,
  category: "regulatory" | "brokerage" | "brand" | "ai_safety"
): Promise<{ success: boolean; violations?: any[]; error?: string }> {
  try {
    if (!input.raw_content || input.raw_content.trim().length === 0) {
      return {
        success: false,
        error: "Content is required",
      }
    }

    const violations = await evaluateSpecificCategory(input, category)

    return {
      success: true,
      violations,
    }
  } catch (error) {
    console.error("[System 4.2] Error evaluating category:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Quick check for critical compliance issues only
 */
export async function quickCheck(
  input: ComplianceContentInput
): Promise<{ success: boolean; has_critical_issues?: boolean; critical_violations?: any[]; error?: string }> {
  try {
    if (!input.raw_content || input.raw_content.trim().length === 0) {
      return {
        success: false,
        error: "Content is required",
      }
    }

    const result = await quickComplianceCheck(input)

    return {
      success: true,
      has_critical_issues: result.has_critical_issues,
      critical_violations: result.critical_violations,
    }
  } catch (error) {
    console.error("[System 4.2] Error in quick check:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Batch evaluate multiple content pieces
 */
export async function batchEvaluate(
  inputs: ComplianceContentInput[],
  options?: {
    log_to_activities?: boolean
    agent_id?: string
  }
): Promise<{
  success: boolean
  results?: Array<{ input: ComplianceContentInput; verdict: ComplianceVerdict }>
  error?: string
}> {
  try {
    if (!inputs || inputs.length === 0) {
      return {
        success: false,
        error: "At least one content input is required",
      }
    }

    if (inputs.length > 50) {
      return {
        success: false,
        error: "Maximum 50 content pieces per batch",
      }
    }

    // Validate all inputs
    for (const input of inputs) {
      if (!input.raw_content || input.raw_content.trim().length === 0) {
        return {
          success: false,
          error: "All content inputs must have raw_content",
        }
      }
    }

    const results = await batchEvaluateCompliance(inputs)

    // Optionally log all to activities
    if (options?.log_to_activities) {
      const evaluations = results.map((result) => ({
        agent_id: options.agent_id,
        content_type: result.input.content_type,
        channel_intent: result.input.channel_intent,
        verdict: result.verdict,
        content_preview: result.input.raw_content.substring(0, 200),
      }))

      await logBatchComplianceEvaluations(evaluations)
    }

    return {
      success: true,
      results,
    }
  } catch (error) {
    console.error("[System 4.2] Error in batch evaluation:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Get formatted compliance report (human-readable)
 */
export async function getComplianceReport(
  input: ComplianceContentInput
): Promise<{ success: boolean; report?: string; verdict?: ComplianceVerdict; error?: string }> {
  try {
    if (!input.raw_content || input.raw_content.trim().length === 0) {
      return {
        success: false,
        error: "Content is required",
      }
    }

    const verdict = await evaluateContentCompliance(input)
    const report = formatComplianceVerdict(verdict)

    return {
      success: true,
      report,
      verdict,
    }
  } catch (error) {
    console.error("[System 4.2] Error generating report:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Get compliance evaluation history
 */
export async function getEvaluationHistory(params: {
  agent_id?: string
  limit?: number
  status_filter?: "pass" | "fail" | "review_required"
}): Promise<{ success: boolean; history?: any[]; error?: string }> {
  try {
    // Validate agent_id if provided
    if (params.agent_id && !isValidUUID(params.agent_id)) {
      return {
        success: false,
        error: "Invalid agent_id format",
      }
    }

    const history = await getComplianceEvaluationHistory(params)

    return {
      success: true,
      history,
    }
  } catch (error) {
    console.error("[System 4.2] Error getting history:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Get compliance statistics
 */
export async function getComplianceStatistics(params: {
  agent_id?: string
  date_range?: { start: string; end: string }
}): Promise<{ success: boolean; stats?: any; error?: string }> {
  try {
    // Validate agent_id if provided
    if (params.agent_id && !isValidUUID(params.agent_id)) {
      return {
        success: false,
        error: "Invalid agent_id format",
      }
    }

    const stats = await getComplianceStats(params)

    return {
      success: true,
      stats,
    }
  } catch (error) {
    console.error("[System 4.2] Error getting stats:", error)
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

/**
 * Validate content input structure (pre-evaluation validation)
 */
export async function validateContentInput(
  input: Partial<ComplianceContentInput>
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = []

  if (!input.raw_content || input.raw_content.trim().length === 0) {
    errors.push("raw_content is required")
  }

  if (!input.content_type) {
    errors.push("content_type is required")
  }

  if (!input.channel_intent) {
    errors.push("channel_intent is required")
  }

  if (input.context?.listing_id && !isValidUUID(input.context.listing_id)) {
    errors.push("Invalid listing_id format")
  }

  if (input.context?.transaction_id && !isValidUUID(input.context.transaction_id)) {
    errors.push("Invalid transaction_id format")
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}
