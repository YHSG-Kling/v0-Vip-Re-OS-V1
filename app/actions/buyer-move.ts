"use server"

/**
 * Buyer Move Services — agent-facing actions for the post-contract move-in concierge.
 * Thin wrappers around lib/transactions/buyer-move (the pure planner + service layer):
 *   - ensureBuyerMoveCaseAction — create-or-return the move case for a transaction
 *   - getBuyerMoveCaseAction     — load the case (+ live mode recommendation)
 *   - updateMoveTaskAction       — mark one checklist item's status, recompute friction/mode
 *   - setServiceModeAction       — switch guided-DIY ↔ handoff (handoff EXECUTION stays
 *                                  feature-flagged off until Utility Connect creds exist)
 *
 * All actions are brokerage-scoped: the transaction must belong to the caller's brokerage.
 * No new tables, no parallel task system — the checklist lives on the single buyer_move_cases row.
 */

import { createClient } from "@/lib/supabase/server"
import { requireCallerTenant } from "@/lib/auth/require-caller"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { FEATURES } from "@/lib/constants"
import {
  ensureBuyerMoveCase,
  getBuyerMoveCase,
  updateMoveTask,
  decideBuyerMode,
  daysToClose,
  type BuyerMoveCase,
  type MoveTaskType,
  type MoveTaskStatus,
  type ServiceMode,
} from "@/lib/transactions/buyer-move"

/** WAVE 155 (lane 155R12): ONE action-ledger receipt per user-initiated write, through the one helper (lib/kernel/action-ledger.ts
 *  ledgerSessionAction) with NO key — recording only, so a second save runs again and leaves a second receipt. Tenant and actor are
 *  the SESSION's (each caller resolves them). The helper answers `{ success, error }` WITHOUT running only when it refused the
 *  claim; callers here read their own result shape, so only that refusal maps through `refused` — a run's value is returned as is.
 *  A caller with NO tenant (platform staff) has no valid receipt row: never invented (CLAUDE.md §4) — it runs exactly as before. */
async function withReceipt<T, R>(rc: { brokerageId: string | null; userId: string; agentId?: string | null; action: string; subject: { type: string; id?: string | null; ref?: string | null }; riskClass: string; detail?: Record<string, unknown> }, run: () => Promise<T>, refused: (error: string) => R): Promise<T | R> {
  if (!rc.brokerageId) return run()
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  let ran = false
  const out = await ledgerSessionAction({ brokerageId: rc.brokerageId, action: rc.action, actor: { type: "user", userId: rc.userId, agentId: rc.agentId ?? null }, subject: rc.subject, riskClass: rc.riskClass, reasonCode: "HUMAN_REQUESTED", detail: rc.detail ?? null }, () => { ran = true; return run() })
  return ran ? out as T : refused((out as { error?: string }).error ?? "The action was not recorded, so it did not run.")
}

interface ScopedParams {
  transactionId: string
  brokerageId: string
}

async function authAndScope(params: ScopedParams) {
  if (!isValidUUID(params.transactionId) || !isValidUUID(params.brokerageId)) {
    return { supabase: null, userId: null, error: "Invalid id" as const }
  }
  // TENANT FROM THE SESSION (CLAUDE.md §4; wave 153, lane 153Q). The body's brokerageId is only a claim:
  // requireCallerTenant refuses one that names a different brokerage, and the session's tenant is what
  // every read and the move-case insert below are pinned to (params.brokerageId is overwritten with it).
  const caller = await requireCallerTenant(params.brokerageId)
  if (!caller.ok) return { supabase: null, userId: null, error: "Unauthorized" as const }
  params.brokerageId = caller.brokerageId
  const supabase = await createClient()
  const { data: tx, error: txErr } = await supabase
    .from("transactions")
    .select("id")
    .eq("id", params.transactionId)
    .eq("brokerage_id", caller.brokerageId)
    .maybeSingle()
  if (txErr) return { supabase: null, userId: null, error: "The deal couldn't be read just now. Try again shortly." as const }
  if (!tx) return { supabase: null, userId: null, error: "Transaction not found in your brokerage" as const }
  // WAVE 155 (lane 155R12): the session user rides along for the action-ledger receipt.
  return { supabase, userId: caller.userId, error: null }
}

export async function ensureBuyerMoveCaseAction(
  params: ScopedParams,
): Promise<{ success: boolean; case?: BuyerMoveCase | null; error?: string }> {
  const { supabase, error, userId } = await authAndScope(params)
  if (!supabase || !userId) return { success: false, error: error ?? "Unauthorized" }
  return withReceipt({ brokerageId: params.brokerageId, userId, action: "transaction.buyer_move_case.ensure", subject: { type: "transaction", id: params.transactionId }, riskClass: "LOW_RISK_WRITE" }, async () => {
  try {
    const { case: moveCase } = await ensureBuyerMoveCase(supabase as any, params)
    revalidatePath(`/dashboard/transactions/${params.transactionId}`)
    return { success: true, case: moveCase }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Failed to prepare move case" }
  }
  }, (error) => ({ success: false as const, error }))
}

export async function getBuyerMoveCaseAction(
  params: ScopedParams,
): Promise<{ success: boolean; case?: BuyerMoveCase | null; recommendation?: ReturnType<typeof decideBuyerMode>; utilityConnectEnabled?: boolean; error?: string }> {
  const { supabase, error } = await authAndScope(params)
  if (!supabase) return { success: false, error }
  const moveCase = await getBuyerMoveCase(supabase as any, params)
  if (!moveCase) return { success: true, case: null }
  const recommendation = decideBuyerMode({
    tasks: moveCase.tasks,
    daysToClose: daysToClose(moveCase.closing_date),
    buyerRequestedHelp: moveCase.service_mode === "handoff",
  })
  return { success: true, case: moveCase, recommendation, utilityConnectEnabled: FEATURES.BUYER_MOVE_UTILITY_CONNECT }
}

export async function updateMoveTaskAction(
  params: ScopedParams & { taskType: MoveTaskType; status: MoveTaskStatus },
): Promise<{ success: boolean; case?: BuyerMoveCase | null; error?: string }> {
  const { supabase, error, userId } = await authAndScope(params)
  if (!supabase || !userId) return { success: false, error: error ?? "Unauthorized" }
  return withReceipt({ brokerageId: params.brokerageId, userId, action: "transaction.buyer_move_task.update", subject: { type: "transaction", id: params.transactionId }, riskClass: "LOW_RISK_WRITE", detail: { task_type: params.taskType, status: params.status } }, async () => {
  const { ok, case: moveCase } = await updateMoveTask(supabase as any, params)
  if (!ok) return { success: false, error: "Move case not found" }
  revalidatePath(`/dashboard/transactions/${params.transactionId}`)
  return { success: true, case: moveCase }
  }, (error) => ({ success: false as const, error }))
}

/**
 * Switch the service mode. Guided-DIY is always available. Selecting 'handoff' records the buyer's
 * PREFERENCE and computes the recommendation, but the EXTERNAL Utility Connect push is gated: while
 * FEATURES.BUYER_MOVE_UTILITY_CONNECT is false the case is marked as handoff-preferred without firing
 * any partner lead — the agent coordinates manually until the integration is live.
 */
export async function setServiceModeAction(
  params: ScopedParams & { mode: ServiceMode; notes?: string },
): Promise<{ success: boolean; case?: BuyerMoveCase | null; handoffPending?: boolean; error?: string }> {
  const { supabase, error, userId } = await authAndScope(params)
  if (!supabase || !userId) return { success: false, error: error ?? "Unauthorized" }
  return withReceipt({ brokerageId: params.brokerageId, userId, action: "transaction.buyer_move_case.set_mode", subject: { type: "transaction", id: params.transactionId }, riskClass: "LOW_RISK_WRITE", detail: { mode: params.mode } }, async () => {

  const { data: row } = await supabase
    .from("buyer_move_cases")
    .select("id")
    .eq("transaction_id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()
  if (!row) return { success: false, error: "Move case not found" }

  const wantsHandoff = params.mode === "handoff"
  const canFireHandoff = wantsHandoff && FEATURES.BUYER_MOVE_UTILITY_CONNECT
  const { data: updated, error: moveModeErr } = await supabase
    .from("buyer_move_cases")
    .update({
      service_mode: params.mode,
      // Only advance to handoff_started when the integration is actually live; otherwise the case stays
      // active and the agent coordinates the setup manually (no external lead is pushed).
      case_status: canFireHandoff ? "handoff_started" : "active",
      buyer_preference_notes: params.notes ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", (row as any).id)
    .select("*")
    .maybeSingle()
  if (moveModeErr) return { success: false, error: `Could not update the move plan: ${moveModeErr.message}` }

  revalidatePath(`/dashboard/transactions/${params.transactionId}`)
  const moveCase = updated ? await getBuyerMoveCase(supabase as any, params) : null
  return { success: true, case: moveCase, handoffPending: wantsHandoff && !FEATURES.BUYER_MOVE_UTILITY_CONNECT }
  }, (error) => ({ success: false as const, error }))
}
