"use server"

import { isValidUUID } from "@/lib/validations"
import {
  type ComplianceContentInput,
  type ComplianceVerdict,
  evaluateContentCompliance,
  evaluateSpecificCategory,
  batchEvaluateCompliance,
  formatComplianceVerdict,
  logComplianceEvaluation,
  logBatchComplianceEvaluations,
  getComplianceEvaluationHistory,
  getComplianceStats,
} from "@/lib/compliance-rules"
import { getAgentContext } from "@/lib/identity/get-agent-context"

/**
 * Resolves session-derived agent identifier for compliance logging/queries.
 * Returns null if unauthenticated. NEVER trusts caller-supplied agent_id.
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
    agent_id?: string // ignored — derived from session
    content_id?: string
  }
): Promise<{ success: boolean; verdict?: ComplianceVerdict; error?: string }> {
  try {
    const auth = await getSessionAgentId()
    if (!auth.ok) return { success: false, error: auth.error }

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

    // Optionally log to activities — attribute to authenticated agent (NOT caller)
    if (options?.log_to_activities) {
      await logComplianceEvaluation({
        agent_id: auth.agentId,
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
    const auth = await getSessionAgentId()
    if (!auth.ok) return { success: false, error: auth.error }

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

// `quickCheck` (critical-violations-only wrapper over quickComplianceCheck) was
// deleted here. It was the SIMPLER TWIN of evaluateCompliance: same auth gate,
// same input, but it discarded the score, the recommendations and every
// non-critical violation, and — unlike evaluateCompliance — it could never feed
// the approval router, because approval routing needs the full verdict. Keeping
// two entry points where one returns a strictly poorer answer invites a caller
// to pick the poor one and ship content that "passed". evaluateCompliance
// survives; a caller that only cares about criticals filters
// verdict.violations by severity.

/**
 * Batch evaluate multiple content pieces
 */
export async function batchEvaluate(
  inputs: ComplianceContentInput[],
  options?: {
    log_to_activities?: boolean
    agent_id?: string // ignored — derived from session
  }
): Promise<{
  success: boolean
  results?: Array<{ input: ComplianceContentInput; verdict: ComplianceVerdict }>
  error?: string
}> {
  try {
    const auth = await getSessionAgentId()
    if (!auth.ok) return { success: false, error: auth.error }

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

    // Optionally log all to activities — attribute to authenticated agent (NOT caller)
    if (options?.log_to_activities) {
      const evaluations = results.map((result) => ({
        agent_id: auth.agentId,
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
    const auth = await getSessionAgentId()
    if (!auth.ok) return { success: false, error: auth.error }

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
  agent_id?: string // ignored — derived from session
  limit?: number
  status_filter?: "pass" | "fail" | "review_required"
}): Promise<{ success: boolean; history?: any[]; error?: string }> {
  try {
    const auth = await getSessionAgentId()
    if (!auth.ok) return { success: false, error: auth.error }

    const history = await getComplianceEvaluationHistory({
      ...params,
      agent_id: auth.agentId,
    })

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
  agent_id?: string // ignored — derived from session
  date_range?: { start: string; end: string }
}): Promise<{ success: boolean; stats?: any; error?: string }> {
  try {
    const auth = await getSessionAgentId()
    if (!auth.ok) return { success: false, error: auth.error }

    const stats = await getComplianceStats({
      ...params,
      agent_id: auth.agentId,
    })

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

// `validateContentInput` was deleted here. It was a second, drifting copy of the
// field checks evaluateCompliance already performs inline (raw_content present,
// content_type present, listing_id / transaction_id well-formed UUIDs) — an
// unauthenticated "use server" boundary whose only value was telling a caller
// what evaluateCompliance was about to tell it anyway. Two copies of a
// validation rule is one copy that will silently stop matching the other.
// evaluateCompliance's inline validation survives and is the only gate.
