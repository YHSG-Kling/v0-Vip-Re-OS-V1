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
}

export async function updateTransactionCoordinator(coordinatorId: string, data: UpdateCoordinatorData) {
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
}

export async function deleteTransactionCoordinator(coordinatorId: string) {
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
}

export async function assignTransactionToCoordinator(data: AssignTransactionData) {
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
}

export async function unassignTransactionFromCoordinator(assignmentId: string) {
  const supabase = await createClient()

  const { error } = await supabase.from("transaction_assignments").delete().eq("id", assignmentId)

  if (error) {
    console.error("Error removing assignment:", error)
    return { success: false, error: error.message }
  }

  revalidatePath("/dashboard/settings/team/tc")
  revalidatePath("/dashboard/coordinator")
  return { success: true }
}
