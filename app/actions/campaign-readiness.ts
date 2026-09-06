"use server"

// ============================================
// SYSTEM 4.5 – CAMPAIGN READINESS ACTIONS
// Server actions for readiness evaluation
// ============================================

import { isValidUUID } from "@/lib/validations"
import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import {
  evaluateCampaignReadiness,
  batchEvaluateCampaignReadiness,
  quickReadinessCheck,
  checkChannelReadiness,
  formatReadinessOutput,
  logReadinessEvaluation,
  batchLogReadinessEvaluations,
  getReadinessHistory,
  getReadinessStatistics,
  logChannelReadinessCheck,
  getReadinessTrends,
} from "@/lib/campaign-readiness"
import type { ReadinessInput, ReadinessOutput, ExecutionChannel } from "@/lib/campaign-readiness"
import { type ComplianceVerdict } from "@/lib/compliance-rules"
import { type ApprovalDecision } from "@/lib/approval-workflow"

/**
 * IDENTITY RESOLUTION FOR READINESS LOGGING.
 *
 * `activities` requires brokerage_id (NOT NULL) and activities.agent_id FKs
 * agents(id) — NOT users(id). Every logger in lib/campaign-readiness refuses
 * to write without both, and until now NOTHING supplied them: the only wired
 * caller (runPrelaunchCheck) passed no additional_context at all, so
 * logReadinessEvaluation returned {success:false} on every single call and
 * this action DISCARDED that failure (`if (logResult.success)`), leaving the
 * Studio's "Readiness Pass Rate" tile reading a table nothing ever wrote to.
 *
 * Resolve both from the session — never `x.agent_id ?? user.id`.
 */
async function resolveLoggingIdentity(): Promise<
  | { ok: true; brokerageId: string; agentId: string }
  | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  if (!ctx.brokerageId) return { ok: false, error: "No brokerage associated with your account." }
  if (!ctx.agentId) {
    return {
      ok: false,
      error: "No agent profile found for your account — readiness cannot be recorded.",
    }
  }
  return { ok: true, brokerageId: ctx.brokerageId, agentId: ctx.agentId }
}

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
  /** Non-fatal: readiness was evaluated but could not be RECORDED. Never swallowed. */
  log_error?: string
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
    let log_error: string | undefined
    if (options?.log_to_activities) {
      if (!input.content_id) {
        log_error = "content_id is required to record a readiness evaluation"
      } else {
        const identity = await resolveLoggingIdentity()
        if (!identity.ok) {
          log_error = identity.error
        } else {
          const logResult = await logReadinessEvaluation(input.content_id, readinessOutput, {
            ...options.additional_context,
            brokerage_id: identity.brokerageId,
            agent_id: identity.agentId,
          })
          if (logResult.success) {
            activity_id = logResult.activity_id
          } else {
            log_error = logResult.error ?? "Failed to record readiness evaluation"
          }
        }
      }
    }

    return {
      success: true,
      readiness_output: readinessOutput,
      activity_id,
      log_error,
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
  /** Non-fatal: evaluations succeeded but could not be RECORDED. Never swallowed. */
  log_error?: string
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
    let log_error: string | undefined
    if (options?.log_to_activities) {
      const identity = await resolveLoggingIdentity()
      if (!identity.ok) {
        log_error = identity.error
      } else {
        // additional_context carries the NOT NULL activities columns — without
        // it batchLogReadinessEvaluations fails every row and reports 0 logged.
        const evaluationsToLog = results
          .filter((r) => r.input.content_id)
          .map((r) => ({
            content_id: r.input.content_id!,
            readiness_output: r.readiness_output,
            additional_context: {
              brokerage_id: identity.brokerageId,
              agent_id: identity.agentId,
            },
          }))

        if (evaluationsToLog.length === 0) {
          log_error = "No inputs carried a content_id — nothing could be recorded"
        } else {
          const logResult = await batchLogReadinessEvaluations(evaluationsToLog)
          logged_count = logResult.logged_count
          if (logResult.failed_count > 0) {
            log_error = `${logResult.failed_count} of ${evaluationsToLog.length} evaluations could not be recorded: ${logResult.errors.slice(0, 2).join("; ")}`
          }
        }
      }
    }

    return {
      success: true,
      results,
      logged_count,
      log_error,
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
  /** Non-fatal: the check ran but could not be RECORDED. Never swallowed. */
  log_error?: string
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

    // Log to activities if requested. brokerage_id / agent_id used to be
    // CALLER-SUPPLIED and the write was skipped SILENTLY when either was
    // missing — a control that appeared to record and did not. Both are now
    // resolved from the session and any failure is reported to the caller.
    let activity_id: string | undefined
    let log_error: string | undefined
    if (options?.log_to_activities) {
      if (!input.content_id) {
        log_error = "content_id is required to record a channel readiness check"
      } else {
        const identity = await resolveLoggingIdentity()
        if (!identity.ok) {
          log_error = identity.error
        } else {
          const logResult = await logChannelReadinessCheck(
            input.content_id,
            targetChannel,
            result.is_ready,
            result.reason,
            { brokerageId: identity.brokerageId, agentId: identity.agentId }
          )
          if (logResult.success) {
            activity_id = logResult.activity_id
          } else {
            log_error = logResult.error ?? "Failed to record channel readiness check"
          }
        }
      }
    }

    return {
      success: true,
      is_ready: result.is_ready,
      reason: result.reason,
      activity_id,
      log_error,
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
    metadata: Record<string, unknown>
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

    // TENANT GATE. getReadinessHistory reads `activities` through the SERVICE
    // client (RLS bypassed). The lib read is now itself brokerage-filtered and
    // REFUSES without a brokerageId, so this probe is the second of two locks,
    // not the only one: it proves the content has a readiness trail inside the
    // caller's brokerage before the service-role read runs at all, and turns
    // "someone else's content id" into an empty result rather than a lookup.
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }

    const supabase = await createClient()
    const { count, error: scopeError } = await supabase
      .from("activities")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", ctx.brokerageId)
      .eq("entity_type", "content")
      .eq("entity_id", contentId)

    if (scopeError) {
      return { success: false, error: scopeError.message }
    }
    if (!count) {
      // No readiness trail for this content inside the caller's brokerage.
      return { success: true, evaluations: [] }
    }

    return await getReadinessHistory(ctx.brokerageId, contentId, limit)
  } catch (err) {
    console.error("[v0] Error fetching readiness history:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    }
  }
}

/**
 * TENANT SCOPE FOR THE AGGREGATE READS (ACTIONS 6 + 7).
 *
 * Both aggregates run on the SERVICE-ROLE client inside lib, where RLS is
 * bypassed and the explicit brokerage filter IS the boundary. These are exported
 * server actions, so the brokerageId argument arrives over the wire and is
 * therefore UNTRUSTED. It is used only as an assertion: the session's brokerage
 * is resolved independently through the identity helper, a disagreement is
 * REFUSED outright, and the value handed to lib is always the SESSION's — never
 * the argument. A caller that supplies nothing gets a refusal, not a
 * platform-wide aggregate.
 */
async function resolveReadScope(
  claimedBrokerageId: string
): Promise<{ ok: true; brokerageId: string } | { ok: false; error: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  if (!ctx.brokerageId) return { ok: false, error: "No brokerage associated with your account." }
  if (!claimedBrokerageId) {
    return { ok: false, error: "brokerageId is required — readiness reads are tenant-scoped." }
  }
  if (claimedBrokerageId !== ctx.brokerageId) {
    return { ok: false, error: "Brokerage scope mismatch — refusing to read another brokerage's readiness." }
  }
  return { ok: true, brokerageId: ctx.brokerageId }
}

/**
 * ACTION 6: Get readiness statistics for time period — ONE brokerage.
 *
 * On refusal this returns { success: false, error } with NO `statistics`
 * payload. A pass rate that could not be COMPUTED must never reach a surface as
 * 0% — see MarketingOpsSnapshot.counts.passRate (null) + passRateError.
 */
export async function fetchReadinessStatistics(
  brokerageId: string,
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
    const scope = await resolveReadScope(brokerageId)
    if (!scope.ok) return { success: false, error: scope.error }

    // Validate date format
    if (isNaN(Date.parse(startDate)) || isNaN(Date.parse(endDate))) {
      return {
        success: false,
        error: "Invalid date format (use ISO 8601)",
      }
    }

    return await getReadinessStatistics(scope.brokerageId, startDate, endDate)
  } catch (err) {
    console.error("[v0] Error fetching readiness statistics:", err)
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    }
  }
}

/**
 * ACTION 7: Get readiness trends over time — ONE brokerage.
 *
 * WIRED. This used to be held back deliberately: the lib query behind it read
 * `activities` through the SERVICE client with no brokerage filter, so it
 * aggregated every brokerage on the platform and could not be shown to a tenant.
 * lib/campaign-readiness/readiness-logger.ts::getReadinessTrends now takes a
 * REQUIRED brokerageId and filters on it, and this action resolves that
 * brokerage from the SESSION (never from the argument it is handed). It feeds
 * the Readiness Trend panel on the Marketing Studio → Ops tab, via
 * getReadinessTrendSnapshot in app/actions/marketing-ops.ts.
 */
export async function fetchReadinessTrends(
  brokerageId: string,
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
    const scope = await resolveReadScope(brokerageId)
    if (!scope.ok) return { success: false, error: scope.error }

    // Validate date format
    if (isNaN(Date.parse(startDate)) || isNaN(Date.parse(endDate))) {
      return {
        success: false,
        error: "Invalid date format (use ISO 8601)",
      }
    }

    return await getReadinessTrends(scope.brokerageId, startDate, endDate)
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
