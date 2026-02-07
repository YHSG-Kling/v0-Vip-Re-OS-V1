"use server"

import { createServiceClient } from "@/lib/supabase/service"
import type { ReadinessEvaluation } from "./readiness-evaluator"

/**
 * Logs a readiness evaluation to the activities table for audit trail.
 * This creates a permanent record of why a lead was in a certain state at a certain time.
 */
export async function logReadinessTransition(
  leadId: string,
  evaluation: ReadinessEvaluation
): Promise<void> {
  const supabase = createServiceClient()

  console.log("[v0] Logging readiness transition for lead:", leadId, evaluation.state)

  const { error } = await supabase.from("activities").insert({
    contact_id: leadId,
    activity_type: "readiness_evaluation",
    title: `Readiness State: ${evaluation.state}`,
    description: evaluation.explanation,
    notes: JSON.stringify({
      state: evaluation.state,
      recommendedAction: evaluation.recommendedAction,
      staleDays: evaluation.staleDays,
      lastActivityDate: evaluation.lastActivityDate,
      warnings: evaluation.warnings,
      evaluatedAt: new Date().toISOString()
    }),
    status: "completed"
  })

  if (error) {
    console.error("[v0] Failed to log readiness transition:", error)
    // Log to automation_errors for visibility
    await supabase.from("automation_errors").insert({
      workflow_name: "lead_readiness_evaluation",
      error_message: `Failed to log readiness transition for lead ${leadId}: ${error.message}`,
      severity: "low",
      status: "needs_review",
      context_json: JSON.stringify({ leadId, evaluation })
    })
  }
}

/**
 * Logs unexpected or inconsistent states to automation_errors
 */
export async function logReadinessAnomaly(
  leadId: string,
  anomalyDescription: string,
  context: Record<string, any>
): Promise<void> {
  const supabase = createServiceClient()

  console.error("[v0] Readiness anomaly detected for lead:", leadId, anomalyDescription)

  await supabase.from("automation_errors").insert({
    workflow_name: "lead_readiness_evaluation",
    error_message: `Readiness anomaly: ${anomalyDescription}`,
    severity: "medium",
    status: "needs_review",
    context_json: JSON.stringify({ leadId, ...context })
  })
}
