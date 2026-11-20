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
  return ledgered("session", { action: "transaction.deal_health_intervention.resolve", subject: { type: "proactive_intervention", id: params.interventionId }, riskClass: "LOW_RISK_WRITE" }, async () => {

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
  })
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

  // WAVE 155 (lane 155S1) — THE SAME GATE AS THE ROUTE'S MANUAL RESCAN (app/api/cron/deal-health-scan/route.ts POST, commit
  // 119ac6b4). This action read the transaction through the row policy alone, and the live policy lets a VENDOR PARTY on the
  // deal read the transaction row — so a vendor could re-score a deal and raise DEAL_AT_RISK_DETECTED for its tenant. Now:
  // the caller is the SESSION (requireCaller); they must be able to WORK this deal (lib/auth/deal-work-ownership.ts
  // loadDealWorkAccess — owning agent, assigned coordinator, the deal agent's team lead, a tenant admin, compliance; a lender,
  // title company, vendor or Contact is not a worker of it); the transaction is read PINNED to the session's tenant. Another
  // tenant's deal, an unknown id and a deal the caller may not work all answer "Transaction not found"; a gate that cannot
  // run refuses, never passes.
  const { requireCaller } = await import("@/lib/auth/require-caller")
  const caller = await requireCaller()
  if (!caller.ok) return { success: false, error: caller.reason === "unauthenticated" ? "Unauthorized" : caller.error }
  const user = { id: caller.userId }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()
  const { loadDealWorkAccess } = await import("@/lib/auth/deal-work-ownership")
  const work = await loadDealWorkAccess(svc, { userId: caller.userId, brokerageId: caller.brokerageId, userType: caller.userType, transactionId: params.transactionId })
  if (!work.ok) return { success: false, error: "Your access to this deal could not be confirmed. Try again in a moment." }
  if (!work.access.capabilities.read) return { success: false, error: "Transaction not found" }

  const { data: tx, error: txErr } = await svc
    .from("transactions")
    .select("id, brokerage_id")
    .eq("id", params.transactionId)
    .eq("brokerage_id", caller.brokerageId)
    .maybeSingle()
  if (txErr) return { success: false, error: "The transaction could not be read. Try again in a moment." }
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

/**
 * WAVE 155 (lane 155R9, G12): ONE agent_action_ledger receipt per session write — ledgerSessionAction
 * (lib/kernel/action-ledger.ts) does the claim → run → settle. Who and which tenant come from the SESSION (CLAUDE.md §4);
 * "session" resolves them through getAgentContext. NO idempotency key: a person's second save runs again and leaves a
 * second receipt. The export's value comes back unchanged; a refused claim (only a malformed action name, caught by
 * test:action-ledger §14) throws instead of returning a value of another shape. No session tenant → the write runs exactly
 * as before, unrecorded (agent_action_ledger.brokerage_id is NOT NULL — there is no valid row to write).
 * @proofSeam scripts/ledger-receipts-transaction2-guard.ts
 */
async function ledgered<T>(
  who: { userId?: string | null; brokerageId?: string | null; agentId?: string | null } | null | undefined | "session",
  what: { action: string; subject: { type: string; id?: string | null; ref?: string | null }; riskClass: string; detail?: Record<string, unknown> },
  run: () => Promise<T>,
): Promise<T> {
  const seat = who === "session" ? await (await import("@/lib/identity/get-agent-context")).getAgentContext() : who
  if (!seat?.userId || !seat.brokerageId) return run()
  const id = what.subject.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(what.subject.id) ? what.subject.id : null
  const subject = { type: what.subject.type, id, ref: id ? what.subject.ref ?? null : what.subject.ref ?? what.subject.id ?? null }
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  let ran = false
  const r = await ledgerSessionAction({ brokerageId: seat.brokerageId, action: what.action, actor: { type: "user", userId: seat.userId, agentId: seat.agentId ?? null }, subject, riskClass: what.riskClass, reasonCode: "HUMAN_REQUESTED", detail: what.detail ?? null }, async () => { ran = true; return run() })
  if (!ran) throw new Error((r as { error?: string }).error ?? "action ledger refused the claim")
  return r as T
}
