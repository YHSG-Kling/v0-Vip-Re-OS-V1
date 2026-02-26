"use server"

// ============================================
// SYSTEM 4.5 – CAMPAIGN READINESS ACTIONS
// Server actions for readiness evaluation
// ============================================

import { isValidUUID } from "@/lib/validations"
import {
  ReadinessInput,
  ReadinessOutput,
  ExecutionChannel,
  evaluateCampaignReadiness,
  batchEvaluateCampaignReadiness,
  quickReadinessCheck,
  checkChannelReadiness,
  formatReadinessOutput,
} from "@/lib/campaign-readiness/readiness-evaluator"
import {
  logReadinessEvaluation,
  batchLogReadinessEvaluations,
  getReadinessHistory,
  getReadinessStatistics,
  logChannelReadinessCheck,
  getReadinessTrends,
} from "@/lib/campaign-readiness/readiness-logger"
import { type ComplianceVerdict } from "@/lib/compliance-rules"
import { ApprovalDecision } from "@/lib/approval-workflow/approval-engine"

/**
 * ACTION 1: Evaluate campaign readiness (main entry point)
 */
export async function evaluateContentReadiness(
  input: ReadinessInput,
  options?: {
    log_to_activities?: boolean
    additional_context?: Record<string, unknown>
  }
): Promise<{
  success: boolean
  readiness_output?: ReadinessOutput
  activity_id?: string
  error?: string
}> {
  try {
    // Validate content_id if provided
    if (input.content_id && !isValidUUID(input.content_id)) {
      return {
        success: false,
        error: "Invalid content_id format (must be UUID)",
      }
    }

    // Evaluate readiness
    const readinessOutput = evaluateCampaignReadiness(input)

    // Log to activities if requested
    let activity_id: string | undefined
    if (options?.log_to_activities && input.content_id) {
      const logResult = await logReadinessEvaluation(
        input.content_id,
        readinessOutput,
        options.additional_context
      )
      if (logResult.success) {
        activity_id = logResult.activity_id
      }
    }

    return {
      success: true,
      readiness_output: readinessOutput,
      activity_id,
    }
  } catch (err) {
    console.error("[v0] Error evaluating content readiness:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    }
  }
}

/**
 * ACTION 2: Batch evaluate readiness for multiple content pieces
 */
export async function batchEvaluateContentReadiness(
  inputs: ReadinessInput[],
  options?: {
    log_to_activities?: boolean
  }
): Promise<{
  success: boolean
  results?: Array<{
    input: ReadinessInput
    readiness_output: ReadinessOutput
  }>
  logged_count?: number
  error?: string
}> {
  try {
    // Validate all content_ids if provided
    for (const input of inputs) {
      if (input.content_id && !isValidUUID(input.content_id)) {
        return {
          success: false,
          error: `Invalid content_id format: ${input.content_id}`,
        }
      }
    }

    // Evaluate all inputs
    const readinessOutputs = batchEvaluateCampaignReadiness(inputs)

    const results = inputs.map((input, index) => ({
      input,
      readiness_output: readinessOutputs[index],
    }))

    // Log to activities if requested
    let logged_count = 0
    if (options?.log_to_activities) {
      const evaluationsToLog = results
        .filter((r) => r.input.content_id)
        .map((r) => ({
          content_id: r.input.content_id!,
          readiness_output: r.readiness_output,
        }))

      if (evaluationsToLog.length > 0) {
        const logResult = await batchLogReadinessEvaluations(evaluationsToLog)
        logged_count = logResult.logged_count
      }
    }

    return {
      success: true,
      results,
      logged_count,
    }
  } catch (err) {
    console.error("[v0] Error batch evaluating content readiness:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    }
  }
}

/**
 * ACTION 3: Quick readiness check (approval + compliance only)
 */
export async function quickCheckReadiness(
  approval: ApprovalDecision,
  compliance: ComplianceVerdict
): Promise<{
  success: boolean
  is_ready?: boolean
  reason?: string
  error?: string
}> {
  try {
    const result = quickReadinessCheck(approval, compliance)

    return {
      success: true,
      is_ready: result.is_ready,
      reason: result.reason,
    }
  } catch (err) {
    console.error("[v0] Error performing quick readiness check:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    }
  }
}

/**
 * ACTION 4: Check readiness for specific channel
 */
export async function checkSpecificChannelReadiness(
  input: ReadinessInput,
  targetChannel: ExecutionChannel,
  options?: {
    log_to_activities?: boolean
  }
): Promise<{
  success: boolean
  is_ready?: boolean
  reason?: string
  activity_id?: string
  error?: string
}> {
  try {
    if (input.content_id && !isValidUUID(input.content_id)) {
      return {
        success: false,
        error: "Invalid content_id format (must be UUID)",
      }
    }

    const result = checkChannelReadiness(input, targetChannel)

    // Log to activities if requested
    let activity_id: string | undefined
    if (options?.log_to_activities && input.content_id) {
      const logResult = await logChannelReadinessCheck(
        input.content_id,
        targetChannel,
        result.is_ready,
        result.reason
      )
      if (logResult.success) {
        activity_id = logResult.activity_id
      }
    }

    return {
      success: true,
      is_ready: result.is_ready,
      reason: result.reason,
      activity_id,
    }
  } catch (err) {
    console.error("[v0] Error checking channel readiness:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    }
  }
}

/**
 * ACTION 5: Get readiness history for content
 */
export async function fetchReadinessHistory(
  contentId: string,
  limit?: number
): Promise<{
  success: boolean
  evaluations?: Array<{
    id: string
    activity_type: string
    payload: Record<string, unknown>
    created_at: string
  }>
  error?: string
}> {
  try {
    if (!isValidUUID(contentId)) {
      return {
        success: false,
        error: "Invalid content_id format (must be UUID)",
      }
    }

    return await getReadinessHistory(contentId, limit)
  } catch (err) {
    console.error("[v0] Error fetching readiness history:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    }
  }
}

/**
 * ACTION 6: Get readiness statistics for time period
 */
export async function fetchReadinessStatistics(
  startDate: string,
  endDate: string
): Promise<{
  success: boolean
  statistics?: {
    total_evaluations: number
    ready_count: number
    blocked_count: number
    ready_percentage: number
    top_blocking_reasons: Array<{ reason: string; count: number }>
  }
  error?: string
}> {
  try {
    // Validate date format
    if (isNaN(Date.parse(startDate)) || isNaN(Date.parse(endDate))) {
      return {
        success: false,
        error: "Invalid date format (use ISO 8601)",
      }
    }

    return await getReadinessStatistics(startDate, endDate)
  } catch (err) {
    console.error("[v0] Error fetching readiness statistics:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    }
  }
}

/**
 * ACTION 7: Get readiness trends over time
 */
export async function fetchReadinessTrends(
  startDate: string,
  endDate: string
): Promise<{
  success: boolean
  trends?: Array<{
    date: string
    ready_count: number
    blocked_count: number
    ready_percentage: number
  }>
  error?: string
}> {
  try {
    // Validate date format
    if (isNaN(Date.parse(startDate)) || isNaN(Date.parse(endDate))) {
      return {
        success: false,
        error: "Invalid date format (use ISO 8601)",
      }
    }

    return await getReadinessTrends(startDate, endDate)
  } catch (err) {
    console.error("[v0] Error fetching readiness trends:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    }
  }
}

/**
 * ACTION 8: Format readiness output for display
 */
export async function formatReadinessResult(
  readinessOutput: ReadinessOutput
): Promise<{
  success: boolean
  formatted?: string
  error?: string
}> {
  try {
    const formatted = formatReadinessOutput(readinessOutput)

    return {
      success: true,
      formatted,
    }
  } catch (err) {
    console.error("[v0] Error formatting readiness output:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    }
  }
}

/**
 * ACTION 9: Validate readiness input structure
 */
export async function validateReadinessInput(
  input: Partial<ReadinessInput>
): Promise<{
  success: boolean
  is_valid?: boolean
  missing_fields?: string[]
  error?: string
}> {
  try {
    const requiredFields = [
      "content_type",
      "channel_intent",
      "audience_scope",
      "compliance_verdict",
      "approval_decision",
      "context",
    ]

    const missing_fields = requiredFields.filter(
      (field) => !(field in input) || input[field as keyof ReadinessInput] === undefined
    )

    const is_valid = missing_fields.length === 0

    return {
      success: true,
      is_valid,
      missing_fields: missing_fields.length > 0 ? missing_fields : undefined,
    }
  } catch (err) {
    console.error("[v0] Error validating readiness input:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    }
  }
}
