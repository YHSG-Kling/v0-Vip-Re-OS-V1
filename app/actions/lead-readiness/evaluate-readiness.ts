"use server"

import {
  evaluateLeadReadiness,
  generateHandoffContext,
  logReadinessTransition,
  logReadinessAnomaly,
} from "@/lib/lead-readiness"
import type { ReadinessEvaluation } from "@/lib/lead-readiness"

/**
 * Server action to evaluate a lead's readiness state and log the result.
 * Returns the evaluation and handoff context for UI display.
 * 
 * This action does NOT:
 * - Contact the lead
 * - Assign agents
 * - Modify lead stages
 * - Trigger AI loops
 * 
 * It ONLY:
 * - Derives readiness state from existing data
 * - Logs the evaluation to activities
 * - Returns context for human decision-making
 */
export async function evaluateAndLogLeadReadiness(leadId: string): Promise<{
  evaluation: ReadinessEvaluation | null
  handoffContext: string | null
  error: string | null
}> {
  try {
    console.log("[v0] Evaluating readiness for lead:", leadId)

    // Evaluate readiness (pure function, no side effects)
    const evaluation = await evaluateLeadReadiness(leadId)

    if (!evaluation) {
      return {
        evaluation: null,
        handoffContext: null,
        error: "Lead not found or evaluation failed"
      }
    }

    // Log the evaluation to activities table
    await logReadinessTransition(leadId, evaluation)

    // Generate human-readable handoff context
    const handoffContext = generateHandoffContext(evaluation)

    // If state is broker_review_required, also log to automation_errors
    if (evaluation.state === "broker_review_required") {
      await logReadinessAnomaly(
        leadId,
        "Lead requires broker review",
        { evaluation }
      )
    }

    console.log("[v0] Readiness evaluation complete:", evaluation.state)

    return {
      evaluation,
      handoffContext,
      error: null
    }
  } catch (error) {
    console.error("[v0] Readiness evaluation error:", error)
    
    await logReadinessAnomaly(
      leadId,
      "Readiness evaluation crashed",
      { error: error instanceof Error ? error.message : String(error) }
    )

    return {
      evaluation: null,
      handoffContext: null,
      error: error instanceof Error ? error.message : "Unknown error during readiness evaluation"
    }
  }
}

/** Ceiling on one batch. A pipeline view asks about a page of leads, not a table. */
const MAX_BATCH = 200

/**
 * Batch evaluate readiness for multiple leads.
 * Useful for dashboard views showing lead pipeline status.
 *
 * THREE THINGS THIS HAD TO GAIN BEFORE IT COULD BE WIRED (it is a `"use server"`
 * export, so it is a public HTTP endpoint):
 *
 *   1. AUTHENTICATION. It had none.
 *   2. TENANT SCOPE. evaluateLeadReadiness reads with the SERVICE client and
 *      filters on `.eq("id", leadId)` only — it does not scope by brokerage. An
 *      anonymous caller passing arbitrary lead ids therefore read other
 *      tenants' lead scores and stages straight through RLS. The ids are now
 *      intersected with the caller's brokerage first, and ids that do not belong
 *      to it are simply not evaluated.
 *   3. A CEILING. `Promise.all` over a caller-supplied array is an amplification
 *      lever: one request of N ids became 2N concurrent service-role queries.
 */
export async function batchEvaluateLeadReadiness(leadIds: string[]): Promise<{
  evaluations: Array<{ leadId: string; evaluation: ReadinessEvaluation | null }>
  error: string | null
}> {
  try {
    if (!Array.isArray(leadIds) || leadIds.length === 0) {
      return { evaluations: [], error: null }
    }
    if (leadIds.length > MAX_BATCH) {
      return { evaluations: [], error: `Too many leads in one batch (max ${MAX_BATCH})` }
    }

    const { getAgentContext } = await import("@/lib/identity/get-agent-context")
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { evaluations: [], error: "Unauthenticated" }
    }

    // Keep only leads that belong to the caller's brokerage. Destructure the
    // error: a read we could not perform is a REFUSAL, not "none of these leads
    // are yours" — silently returning an empty evaluation set would read as
    // "nothing is ready", which is a claim about the pipeline we cannot make.
    const { createServiceClient } = await import("@/lib/supabase/service")
    const svc = createServiceClient()
    const { data: ownLeads, error: scopeError } = await svc
      .from("leads")
      .select("id")
      .eq("brokerage_id", ctx.brokerageId)
      .in("id", leadIds)

    if (scopeError) {
      return { evaluations: [], error: `Cannot verify lead ownership: ${scopeError.message}` }
    }

    const scopedIds = (ownLeads ?? []).map((r: { id: string }) => r.id)
    console.log("[v0] Batch evaluating readiness for", scopedIds.length, "leads")

    const evaluations = await Promise.all(
      scopedIds.map(async (leadId) => {
        const evaluation = await evaluateLeadReadiness(leadId)
        return { leadId, evaluation }
      })
    )

    return { evaluations, error: null }
  } catch (error) {
    console.error("[v0] Batch readiness evaluation error:", error)
    return {
      evaluations: [],
      error: error instanceof Error ? error.message : "Unknown error during batch evaluation"
    }
  }
}
