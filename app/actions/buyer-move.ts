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

interface ScopedParams {
  transactionId: string
  brokerageId: string
}

async function authAndScope(params: ScopedParams) {
  if (!isValidUUID(params.transactionId) || !isValidUUID(params.brokerageId)) {
    return { supabase: null, error: "Invalid id" as const }
  }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { supabase: null, error: "Unauthorized" as const }
  const { data: tx } = await supabase
    .from("transactions")
    .select("id")
    .eq("id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()
  if (!tx) return { supabase: null, error: "Transaction not found in your brokerage" as const }
  return { supabase, error: null }
}

export async function ensureBuyerMoveCaseAction(
  params: ScopedParams,
): Promise<{ success: boolean; case?: BuyerMoveCase | null; error?: string }> {
  const { supabase, error } = await authAndScope(params)
  if (!supabase) return { success: false, error }
  try {
    const { case: moveCase } = await ensureBuyerMoveCase(supabase as any, params)
    revalidatePath(`/dashboard/transactions/${params.transactionId}`)
    return { success: true, case: moveCase }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Failed to prepare move case" }
  }
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
  const { supabase, error } = await authAndScope(params)
  if (!supabase) return { success: false, error }
  const { ok, case: moveCase } = await updateMoveTask(supabase as any, params)
  if (!ok) return { success: false, error: "Move case not found" }
  revalidatePath(`/dashboard/transactions/${params.transactionId}`)
  return { success: true, case: moveCase }
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
  const { supabase, error } = await authAndScope(params)
  if (!supabase) return { success: false, error }

  const { data: row } = await supabase
    .from("buyer_move_cases")
    .select("id")
    .eq("transaction_id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()
  if (!row) return { success: false, error: "Move case not found" }

  const wantsHandoff = params.mode === "handoff"
  const canFireHandoff = wantsHandoff && FEATURES.BUYER_MOVE_UTILITY_CONNECT
  const { data: updated } = await supabase
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

  revalidatePath(`/dashboard/transactions/${params.transactionId}`)
  const moveCase = updated ? await getBuyerMoveCase(supabase as any, params) : null
  return { success: true, case: moveCase, handoffPending: wantsHandoff && !FEATURES.BUYER_MOVE_UTILITY_CONNECT }
}
