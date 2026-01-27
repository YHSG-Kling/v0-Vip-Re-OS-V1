"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { handleError } from "@/lib/errors"

/**
 * Get all tasks for a user or filtered by parameters
 */
export async function getTasks(params?: {
  assignedTo?: string
  contactId?: string
  listingId?: string
  transactionId?: string
  status?: string
}) {
  try {
    const supabase = await createClient()

    let query = supabase
      .from("tasks")
      .select("*, assigned_agent:agents!tasks_assigned_to_fkey(id, first_name, last_name)")
      .order("due_date", { ascending: true })

    if (params?.assignedTo) query = query.eq("assigned_to", params.assignedTo)
    if (params?.contactId) query = query.eq("contact_id", params.contactId)
    if (params?.listingId) query = query.eq("listing_id", params.listingId)
    if (params?.transactionId) query = query.eq("transaction_id", params.transactionId)
    if (params?.status) query = query.eq("status", params.status)

    const { data, error } = await query

    if (error) throw error

    return { success: true, tasks: data }
  } catch (error) {
    return handleError(error, "getTasks")
  }
}

/**
 * Update a task
 */
export async function updateTask(params: {
  taskId: string
  title?: string
  description?: string
  dueDate?: string
  assignedTo?: string
  priority?: "low" | "medium" | "high" | "urgent"
  status?: "pending" | "in_progress" | "completed" | "cancelled"
}) {
  try {
    const supabase = await createClient()

    const updates: any = {}
    if (params.title !== undefined) updates.title = params.title
    if (params.description !== undefined) updates.description = params.description
    if (params.dueDate !== undefined) updates.due_date = params.dueDate
    if (params.assignedTo !== undefined) updates.assigned_to = params.assignedTo
    if (params.priority !== undefined) updates.priority = params.priority
    if (params.status !== undefined) updates.status = params.status

    const { data, error } = await supabase
      .from("tasks")
      .update(updates)
      .eq("id", params.taskId)
      .select()
      .single()

    if (error) throw error

    revalidatePath("/dashboard")
    revalidatePath("/tasks")

    return { success: true, task: data }
  } catch (error) {
    return handleError(error, "updateTask")
  }
}

/**
 * Mark a task as completed
 */
export async function completeTask(taskId: string) {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("tasks")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
      })
      .eq("id", taskId)
      .select()
      .single()

    if (error) throw error

    revalidatePath("/dashboard")
    revalidatePath("/tasks")

    return { success: true, task: data }
  } catch (error) {
    return handleError(error, "completeTask")
  }
}

/**
 * Delete a task
 */
export async function deleteTask(taskId: string) {
  try {
    const supabase = await createClient()

    const { error } = await supabase.from("tasks").delete().eq("id", taskId)

    if (error) throw error

    revalidatePath("/dashboard")
    revalidatePath("/tasks")

    return { success: true }
  } catch (error) {
    return handleError(error, "deleteTask")
  }
}

export async function createTask(params: {
  title: string
  description?: string
  dueDate?: string
  assignedTo?: string
  contactId?: string
  listingId?: string
  transactionId?: string
  priority?: "low" | "medium" | "high" | "urgent"
}) {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("tasks")
      .insert({
        title: params.title,
        description: params.description,
        due_date: params.dueDate,
        assigned_to: params.assignedTo,
        contact_id: params.contactId,
        listing_id: params.listingId,
        transaction_id: params.transactionId,
        priority: params.priority || "medium",
        status: "pending",
      })
      .select()
      .single()

    if (error) throw error

    revalidatePath("/dashboard")
    revalidatePath("/tasks")

    return { success: true, task: data }
  } catch (error) {
    return handleError(error, "createTask")
  }
}
