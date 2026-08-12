"use server"

import { createServiceClient } from "@/lib/supabase/service"
import type { ReadinessEvaluation } from "./readiness-evaluator"

/**
 * The tenant a readiness row belongs to: the LEAD it is filed against.
 *
 * Resolved through the record, once per call, and — critically — BEFORE anything
 * that can fail. The automation_errors write in `logReadinessTransition` sits
 * inside an error handler, and a tenant lookup performed *there* is the trap this
 * wave was warned about: if it is refused or throws, the original failure is lost
 * to the code that was supposed to report it. Resolving up front makes that
 * impossible rather than merely unlikely.
 *
 * `error` is destructured because supabase-js RESOLVES a refused read, so
 * `{ data }` alone cannot tell "this lead has no brokerage" from "you may not
 * look" — and one of those is a fact about the row while the other is a fact
 * about the caller.
 */
async function resolveLeadBrokerageId(
  supabase: { from: (table: string) => any },
  leadId: string,
): Promise<{ ok: true; brokerageId: string | null } | { ok: false; reason: string }> {
  const { data, error } = await supabase
    .from("leads")
    .select("brokerage_id")
    .eq("id", leadId)
    .maybeSingle()
  if (error) return { ok: false, reason: `leads lookup refused: ${error.message}` }
  return { ok: true, brokerageId: ((data as { brokerage_id: string | null } | null)?.brokerage_id as string | null) ?? null }
}

/**
 * Logs a readiness evaluation to the activities table for audit trail.
 * This creates a permanent record of why a lead was in a certain state at a certain time.
 */
export async function logReadinessTransition(
  leadId: string,
  evaluation: ReadinessEvaluation
): Promise<void> {
  const supabase = createServiceClient()

  // Agent task (correct location, no changes) — activity_type: readiness_evaluation
  console.log("[ReadinessLogger] Logging readiness transition for lead:", leadId, evaluation.state)

  // Resolved BEFORE the write that can fail, so the failure handler below never
  // has to ask a question that could fail in its turn.
  const tenant = await resolveLeadBrokerageId(supabase, leadId)

  const { error } = await supabase.from("activities").insert({
    // activities.contact_id FKs contacts(id) — leadId is a LEAD id, so every
    // readiness transition was FK-rejected and never logged. entity_type/entity_id
    // carry the lead; contact_id stays honestly null.
    contact_id: null,
    entity_type: "lead",
    entity_id: leadId,
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
    console.error("[ReadinessLogger] Failed to log readiness transition:", error)
    // Log to automation_errors for visibility. TENANT: the lead's brokerage,
    // resolved above. Unstamped this row is not merely absent from the
    // automations console — `app/actions/workflows.ts:531` reads the same
    // predicate as an OWNERSHIP CHECK and returns "Forbidden" on a miss, so the
    // failure could never be acknowledged either.
    if (!tenant.ok || !tenant.brokerageId) {
      console.error(
        `[ReadinessLogger] ${tenant.ok ? `lead ${leadId} carries no brokerage_id` : tenant.reason} — automation_errors row NOT written rather than written where the console can neither see nor resolve it`,
      )
      return
    }
    const { error: readinessLogError } = await supabase.from("automation_errors").insert({
      brokerage_id: tenant.brokerageId,
      workflow_name: "lead_readiness_evaluation",
      error_message: `Failed to log readiness transition for lead ${leadId}: ${error.message}`,
      severity: "low",
      status: "open",
      context_json: JSON.stringify({ leadId, evaluation })
    })
    if (readinessLogError) {
      // The original activities failure is already on the console above and is
      // never replaced by a failure to file it.
      console.error("[ReadinessLogger] automation_errors insert refused:", readinessLogError.message)
    }
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

  console.error("[ReadinessLogger] Readiness anomaly detected for lead:", leadId, anomalyDescription)

  // TENANT — the lead this anomaly is about, through the one resolver in this
  // module. Unstamped, the anomaly is invisible AND un-resolvable in the
  // automations console (`workflows.ts:531` uses the same predicate as an
  // ownership check), which for a function whose entire purpose is "log this so a
  // human sees it" means it did nothing at all.
  const tenant = await resolveLeadBrokerageId(supabase, leadId)
  if (!tenant.ok || !tenant.brokerageId) {
    console.error(
      `[ReadinessLogger] ${tenant.ok ? `lead ${leadId} carries no brokerage_id` : tenant.reason} — anomaly row NOT written rather than written where the console can neither see nor resolve it`,
    )
    return
  }
  const { error: anomalyLogError } = await supabase.from("automation_errors").insert({
    brokerage_id: tenant.brokerageId,
    workflow_name: "lead_readiness_evaluation",
    error_message: `Readiness anomaly: ${anomalyDescription}`,
    severity: "medium",
    status: "open",
    context_json: JSON.stringify({ leadId, ...context })
  })
  if (anomalyLogError) {
    console.error("[ReadinessLogger] automation_errors insert refused:", anomalyLogError.message)
  }
}
