"use server"

/**
 * Deal Health — agent-facing actions used by the transaction detail page
 * to close the loop on the existing Deal Health Radar:
 *
 *   - resolveInterventionAction  — mark a proactive intervention resolved
 *   - rescanDealHealthAction     — trigger an on-demand rescan of the
 *                                  transaction's deal health
 *
 * Both reuse canonical infrastructure (proactive_interventions table,
 * /api/cron/deal-health-scan POST endpoint, calculateDealHealth). No new
 * tables, no parallel scoring logic.
 */

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"
import { revalidatePath } from "next/cache"
import { calculateDealHealth } from "@/lib/deal-health/health-scorer"
import { KernelEvent } from "@/lib/kernel/events"
import { emitKernelEvent } from "@/lib/kernel/emit"

// ─── Resolve a proactive intervention ────────────────────────────────────────

export async function resolveInterventionAction(params: {
  interventionId: string
  resolutionNote?: string
}): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(params.interventionId)) {
    return { success: false, error: "Invalid intervention id" }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  // Verify the intervention belongs to a transaction the user can access.
  // We don't enforce brokerage gating here directly — RLS does that.
  const { data: row } = await supabase
    .from("proactive_interventions")
    .select("id, transaction_id, resolved")
    .eq("id", params.interventionId)
    .maybeSingle()
  if (!row) return { success: false, error: "Intervention not found" }
  if (row.resolved) return { success: true }   // idempotent

  // Audit-confirmed columns on proactive_interventions (per cron insert):
  // transaction_id, brokerage_id, issue_detected, severity, ai_recommendation,
  // client_impacted, resolved. We only flip `resolved` — resolution audit
  // columns aren't confirmed on this table so we keep the update minimal.
  void params.resolutionNote   // reserved for a future migration
  const { error } = await supabase
    .from("proactive_interventions")
    .update({ resolved: true })
    .eq("id", params.interventionId)

  if (error) return { success: false, error: error.message }

  if (row.transaction_id) {
    revalidatePath(`/dashboard/transactions/${row.transaction_id}`)
  }
  return { success: true }
}

// ─── On-demand deal-health rescan ────────────────────────────────────────────
// The cron runs every 6h; this action lets the agent trigger a fresh score
// after they take an action (clear a deadline, upload a doc, etc.) without
// waiting for the next cron tick. Reuses calculateDealHealth directly and
// fires the same lifecycle events the cron would.

export async function rescanDealHealthAction(params: {
  transactionId: string
}): Promise<{
  success:     boolean
  error?:      string
  overallScore?: number
  riskLevel?:    string
  scoreDelta?:   number | null
}> {
  if (!isValidUUID(params.transactionId)) {
    return { success: false, error: "Invalid transaction id" }
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const { data: tx } = await supabase
    .from("transactions")
    .select("id, brokerage_id")
    .eq("id", params.transactionId)
    .maybeSingle()
  if (!tx) return { success: false, error: "Transaction not found" }

  try {
    const result = await calculateDealHealth({
      transactionId: tx.id,
      brokerageId:   tx.brokerage_id,
    })

    // Mirror the cron's lifecycle event so portals + alerts get notified —
    // emitKernelEvent does the audit row AND the reactor (a bare insert did neither
    // of "portals + alerts").
    await emitKernelEvent({
      event:       KernelEvent.DEAL_HEALTH_SCORE_UPDATED,
      entityType:  "transaction",
      entityId:    tx.id,
      brokerageId: tx.brokerage_id,
      actorUserId: user.id,
      transactionId: tx.id,
      metadata: {
        overall_score: result.overallScore,
        risk_level:    result.riskLevel,
        score_delta:   result.scoreDelta,
        manual_rescan: true,
      },
    })

    if (result.riskLevel === "critical" || result.riskLevel === "at_risk") {
      await emitKernelEvent({
        event:       KernelEvent.DEAL_AT_RISK_DETECTED,
        entityType:  "transaction",
        entityId:    tx.id,
        brokerageId: tx.brokerage_id,
        actorUserId: user.id,
        transactionId: tx.id,
        metadata: {
          overall_score: result.overallScore,
          risk_level:    result.riskLevel,
        },
      })
    }

    revalidatePath(`/dashboard/transactions/${tx.id}`)
    return {
      success:      true,
      overallScore: result.overallScore,
      riskLevel:    result.riskLevel,
      scoreDelta:   result.scoreDelta,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Rescan failed"
    return { success: false, error: message }
  }
}
