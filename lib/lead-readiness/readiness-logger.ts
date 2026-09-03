// NOT a server-action module (2026-09-03, lane R3-A; template
// lib/behavior-learning/preference-updater.ts:1-9). The module-level "use server"
// that stood here published logReadinessTransition(leadId, evaluation) and
// logReadinessAnomaly(…) as public HTTP doors with no gate: a service client
// WRITING activities / automation_errors rows filed under whatever leads.id a
// session chose to name (the tenant is resolved from the lead, never checked
// against the caller). Every caller is in-process server code (re-verified
// 2026-09-03):
//   · lib/lead-readiness/index.ts:12-15 (the barrel), whose only value importer
//     is app/actions/lead-readiness/evaluate-readiness.ts:8 ("use server")
// so the directive published nothing anyone needed. `server-only` makes a future
// client import fail at build time instead of bundling the service credential.
import "server-only"

import { createServiceClient } from "@/lib/supabase/service"
import { resolveLeadBrokerageId } from "@/lib/activities/activity-tenant"
import type { ReadinessEvaluation } from "./readiness-evaluator"

/**
 * The tenant a readiness row belongs to: the LEAD it is filed against.
 *
 * `resolveLeadBrokerageId` now lives in `lib/activities/activity-tenant.ts` so
 * there is ONE lead resolver rather than one per module — this file's private
 * copy was the first of what would have been three. The properties it was written
 * for are unchanged and documented there: resolved through the record, resolved
 * BEFORE anything that can fail (the automation_errors write below sits inside an
 * error handler, and a tenant lookup performed *there* could lose the original
 * failure to the code meant to report it), and `error` destructured because
 * supabase-js RESOLVES a refused read.
 */

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

  // THE STAMP, AND WHY THE TRIGGER NEVER SUPPLIED IT.
  //
  // `activities` carries `activities_set_brokerage` (BEFORE INSERT), which is why
  // every earlier census treated this table as netted. The net has no `lead`
  // branch: `contact_id` is null by design two lines below, and `entity_type =
  // 'lead'` matches nothing in the chain. So `NEW.brokerage_id` stayed NULL — and
  // `activities.brokerage_id` is NOT NULL, so this insert was not a hidden row.
  // It was **refused, 23502**, on every readiness transition ever evaluated.
  //
  // The tenant was already being resolved four lines up for the automation_errors
  // fallback; it simply never reached the row it was about.
  if (!tenant.ok || !tenant.brokerageId) {
    console.error(
      `[ReadinessLogger] readiness transition for lead ${leadId} NOT recorded: ${
        tenant.ok ? `lead carries no brokerage_id` : tenant.reason
      } — refusing to attempt an insert that cannot satisfy activities.brokerage_id NOT NULL`,
    )
    return
  }

  const { error } = await supabase.from("activities").insert({
    // TENANT: the lead's own brokerage. `leads.brokerage_id` is NOT NULL, and it
    // is the value every `activities` reader compares (see activity-tenant.ts).
    brokerage_id: tenant.brokerageId,
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
    // No tenant re-check here: the guard above returned unless `tenant.ok` and
    // `tenant.brokerageId` both hold, so a second check is unreachable — TypeScript
    // narrows `tenant` to `never` inside it. The automations console reads
    // `.eq("brokerage_id", …)` as an OWNERSHIP CHECK (`workflows.ts:531`, returning
    // "Forbidden" on a miss), so this row must carry the tenant; it does, by
    // construction, because we cannot reach this line without one.
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
