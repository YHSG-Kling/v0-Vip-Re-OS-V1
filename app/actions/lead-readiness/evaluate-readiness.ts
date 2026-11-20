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
  // WAVE 155 (lane 155R20, G10) — THE DECISION BEFORE ANY READ OR WRITE. This public endpoint read ANY tenant's lead through the
  // service client (evaluateLeadReadiness filters on the id only) and filed activities / automation_errors rows under it, for an
  // anonymous caller. Leads belong to the BROKERAGE and only the lead desk sees them (CLAUDE.md §5): the ONE resolver
  // (lib/auth/lead-visibility.ts resolveLeadVisibility) admits the seat from the SESSION, and leadRowInScope proves this lead is in
  // the seat's scope. Outside the try on purpose: the crash path below writes too, and it must never run for a refused caller.
  const door = await leadReadinessDoor(leadId)
  if (!door.ok) return { evaluation: null, handoffContext: null, error: door.error }
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

    // Log the evaluation to activities table (and, for broker_review_required, to automation_errors) — ONE receipt.
    const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
    await ledgerSessionAction({ brokerageId: door.brokerageId, action: "lead.readiness.evaluate", actor: { type: "user", userId: door.userId }, subject: { type: "lead", id: leadId }, riskClass: "LOW_RISK_WRITE", detail: { state: evaluation.state } }, async () => {
    await logReadinessTransition(leadId, evaluation)

    // If state is broker_review_required, also log to automation_errors
    if (evaluation.state === "broker_review_required") {
      await logReadinessAnomaly(
        leadId,
        "Lead requires broker review",
        { evaluation }
      )
    }
    return { success: true }
    })

    // Generate human-readable handoff context
    const handoffContext = generateHandoffContext(evaluation)

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
 * The lead desk's admission for ONE lead (wave 155, lane 155R20). NOT EXPORTED — this module is `"use server"`, so an export
 * would mint another public endpoint. Session → profile → resolveLeadVisibility (fail closed: unresolved refuses) → the lead's
 * own row in scope. The tenant written is the LEAD's own row's, and only after the session's scope admitted that row.
 */
async function leadReadinessDoor(leadId: string): Promise<{ ok: true; userId: string; brokerageId: string } | { ok: false; error: string }> {
  if (!leadId || typeof leadId !== "string") return { ok: false, error: "Lead not found" }
  const { createClient } = await import("@/lib/supabase/server")
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user?.id) return { ok: false, error: "Unauthenticated" }
  const { data: profile, error: profileError } = await supabase
    .from("users")
    .select("brokerage_id, user_type, platform_role")
    .eq("id", user.id)
    .maybeSingle()
  if (profileError) return { ok: false, error: "Could not verify your account" }
  const { resolveLeadVisibility, leadRowInScope } = await import("@/lib/auth/lead-visibility")
  const p = (profile ?? {}) as { brokerage_id?: string | null; user_type?: string | null; platform_role?: string | null }
  const vis = await resolveLeadVisibility(supabase, { userId: user.id, userType: p.user_type, platformRole: p.platform_role ?? null, brokerageId: p.brokerage_id })
  if (!vis.allowed) return { ok: false, error: vis.reason }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { data: lead, error: leadError } = await createServiceClient()
    .from("leads")
    .select("id, brokerage_id, agent_id")
    .eq("id", leadId)
    .maybeSingle()
  if (leadError) return { ok: false, error: `Cannot verify lead ownership: ${leadError.message}` }
  const row = lead as { brokerage_id?: string | null; agent_id?: string | null } | null
  if (!row?.brokerage_id || !leadRowInScope(vis.scope, row)) return { ok: false, error: "Lead not found" }
  return { ok: true, userId: user.id, brokerageId: row.brokerage_id }
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
