"use server"

import { evaluateLeadReadiness, generateHandoffContext } from "@/lib/lead-readiness/readiness-evaluator"
import { logReadinessTransition, logReadinessAnomaly } from "@/lib/lead-readiness/readiness-logger"
import type { ReadinessEvaluation } from "@/lib/lead-readiness/readiness-evaluator"

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

/**
 * Batch evaluate readiness for multiple leads.
 * Useful for dashboard views showing lead pipeline status.
 */
export async function batchEvaluateLeadReadiness(leadIds: string[]): Promise<{
  evaluations: Array<{ leadId: string; evaluation: ReadinessEvaluation | null }>
  error: string | null
}> {
  try {
    console.log("[v0] Batch evaluating readiness for", leadIds.length, "leads")

    const evaluations = await Promise.all(
      leadIds.map(async (leadId) => {
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
