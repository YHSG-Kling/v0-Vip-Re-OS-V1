"use server"

import { isValidUUID } from "@/lib/validations"
import {
  type ComplianceContentInput,
  type ComplianceVerdict,
  evaluateContentCompliance,
  evaluateSpecificCategory,
  quickComplianceCheck,
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

    // MERGED IN from the deleted `validateContentInput` (see its tombstone at the
    // foot of this file), which was the only place that ever required this.
    //
    // It is not cosmetic and TypeScript cannot cover it: this is a `"use server"`
    // export, so the real caller is an HTTP request and `ComplianceContentInput`
    // is not enforced at that boundary. `channel_intent` chooses the gate the
    // evaluation is FILED UNDER —
    // lib/compliance-rules/compliance-logger.ts:16 `resolveGateName` returns
    // "tcpa" only when channel_intent is 'sms' or 'call' — so an omitted value
    // silently mislabels a TCPA-relevant check as brand_voice in
    // `compliance_events`, i.e. the ledger records the wrong gate for the one
    // channel with statutory exposure.
    if (!input.channel_intent) {
      return {
        success: false,
        error: "Channel intent is required",
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

/**
 * Quick check for critical compliance issues only
 */
export async function quickCheck(
  input: ComplianceContentInput
): Promise<{ success: boolean; has_critical_issues?: boolean; critical_violations?: any[]; error?: string }> {
  try {
    const auth = await getSessionAgentId()
    if (!auth.ok) return { success: false, error: auth.error }

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

// TOMBSTONE: `validateContentInput(input)` — MERGED, then DELETED as a duplicate.
//
// SURVIVOR: `evaluateCompliance` above (app/actions/content-compliance.ts:56),
// whose inline guard already refused an empty `raw_content`, a missing
// `content_type`, and a malformed `context.listing_id` / `context.transaction_id`
// — the same four checks, in the same file, on the endpoint this one was
// supposed to be run *before*.
//
// MERGED FIRST, then deleted: the ONE check the survivor did not have was
// `channel_intent is required`, and that one matters — it is the field
// lib/compliance-rules/compliance-logger.ts:16 `resolveGateName` reads to decide
// which gate the evaluation is recorded under in `compliance_events`, so an
// omitted value files an SMS/call check as brand_voice instead of tcpa. It now
// lives in `evaluateCompliance` (see the merge note there). Nothing else here was
// carried over, because nothing else here was new.
//
// WHY DELETE RATHER THAN WIRE IT: a separate pre-validation endpoint cannot be a
// gate. It is a `"use server"` export, so the caller decides whether to invoke it
// at all, and a caller who skips it reaches `evaluateCompliance` regardless —
// which is precisely why the checks belong (and now entirely are) inside the
// endpoint that acts. A second HTTP round trip that returns advice the real
// endpoint re-derives is not validation; it is a suggestion.
