"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"

interface CreateCoordinatorData {
  userId: string | null
  displayName: string
  maxActiveDeals: number
  brokerageId: string
}

interface UpdateCoordinatorData {
  displayName: string
  maxActiveDeals: number
  isActive: boolean
}

interface AssignTransactionData {
  transactionId: string
  coordinatorId: string
  brokerageId: string
}

export async function createTransactionCoordinator(data: CreateCoordinatorData) {
  return ledgered("session", { action: "transaction.coordinator.create", subject: { type: "transaction_coordinator", ref: "new" }, riskClass: "LOW_RISK_WRITE", detail: { max_active_deals: data.maxActiveDeals, linked_user: !!data.userId } }, async () => {
  const supabase = await createClient()

  const { data: coordinator, error } = await supabase
    .from("transaction_coordinators")
    .insert({
      user_id: data.userId,
      display_name: data.displayName,
      max_active_deals: data.maxActiveDeals,
      brokerage_id: data.brokerageId,
      is_active: true,
    })
    .select()
    .single()

  if (error) {
    console.error("Error creating coordinator:", error)
    return { success: false, error: error.message }
  }

  revalidatePath("/dashboard/settings/team/tc")
  return { success: true, coordinator }
  })
}

export async function updateTransactionCoordinator(coordinatorId: string, data: UpdateCoordinatorData) {
  return ledgered("session", { action: "transaction.coordinator.update", subject: { type: "transaction_coordinator", id: coordinatorId }, riskClass: "LOW_RISK_WRITE", detail: { max_active_deals: data.maxActiveDeals, is_active: data.isActive } }, async () => {
  const supabase = await createClient()

  const { error } = await supabase
    .from("transaction_coordinators")
    .update({
      display_name: data.displayName,
      max_active_deals: data.maxActiveDeals,
      is_active: data.isActive,
    })
    .eq("id", coordinatorId)

  if (error) {
    console.error("Error updating coordinator:", error)
    return { success: false, error: error.message }
  }

  revalidatePath("/dashboard/settings/team/tc")
  revalidatePath("/dashboard/coordinator")
  return { success: true }
  })
}

export async function deleteTransactionCoordinator(coordinatorId: string) {
  return ledgered("session", { action: "transaction.coordinator.delete", subject: { type: "transaction_coordinator", id: coordinatorId }, riskClass: "IRREVERSIBLE" }, async () => {
  const supabase = await createClient()

  // First delete all assignments
  await supabase.from("transaction_assignments").delete().eq("coordinator_id", coordinatorId)

  // Then delete the coordinator
  const { error } = await supabase.from("transaction_coordinators").delete().eq("id", coordinatorId)

  if (error) {
    console.error("Error deleting coordinator:", error)
    return { success: false, error: error.message }
  }

  revalidatePath("/dashboard/settings/team/tc")
  revalidatePath("/dashboard/coordinator")
  return { success: true }
  })
}

export async function assignTransactionToCoordinator(data: AssignTransactionData) {
  return ledgered("session", { action: "transaction.coordinator.assign", subject: { type: "transaction", id: data.transactionId }, riskClass: "LOW_RISK_WRITE", detail: { coordinator_id: data.coordinatorId } }, async () => {
  const supabase = await createClient()

  // Check coordinator capacity
  const { data: coordinator } = await supabase
    .from("transaction_coordinators")
    .select("max_active_deals, is_active")
    .eq("id", data.coordinatorId)
    .single()

  if (!coordinator) {
    return { success: false, error: "Coordinator not found" }
  }

  if (!coordinator.is_active) {
    return { success: false, error: "Coordinator is inactive" }
  }

  // Count current assignments
  const { count } = await supabase
    .from("transaction_assignments")
    .select("*", { count: "exact", head: true })
    .eq("coordinator_id", data.coordinatorId)

  if (count !== null && count >= coordinator.max_active_deals) {
    return {
      success: false,
      error: `Coordinator has reached maximum capacity of ${coordinator.max_active_deals} deals`,
    }
  }

  // Check if already assigned
  const { data: existing } = await supabase
    .from("transaction_assignments")
    .select("id")
    .eq("transaction_id", data.transactionId)
    .eq("coordinator_id", data.coordinatorId)
    .single()

  if (existing) {
    return { success: false, error: "Transaction is already assigned to this coordinator" }
  }

  // Get current user for assigned_by
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // Create assignment
  const { data: assignment, error } = await supabase
    .from("transaction_assignments")
    .insert({
      transaction_id: data.transactionId,
      coordinator_id: data.coordinatorId,
      brokerage_id: data.brokerageId,
      assigned_by: user?.id,
      is_primary: true,
    })
    .select()
    .single()

  if (error) {
    console.error("Error assigning transaction:", error)
    return { success: false, error: error.message }
  }

  revalidatePath("/dashboard/settings/team/tc")
  revalidatePath("/dashboard/coordinator")
  return { success: true, assignment }
  })
}

export async function unassignTransactionFromCoordinator(assignmentId: string) {
  return ledgered("session", { action: "transaction.coordinator.unassign", subject: { type: "transaction_assignment", id: assignmentId }, riskClass: "LOW_RISK_WRITE" }, async () => {
  const supabase = await createClient()

  const { error } = await supabase.from("transaction_assignments").delete().eq("id", assignmentId)

  if (error) {
    console.error("Error removing assignment:", error)
    return { success: false, error: error.message }
  }

  revalidatePath("/dashboard/settings/team/tc")
  revalidatePath("/dashboard/coordinator")
  return { success: true }
  })
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
