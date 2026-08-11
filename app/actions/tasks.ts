"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { handleError } from "@/lib/errors"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

/**
 * Get all tasks for a user or filtered by parameters.
 *
 * ABSORBED (wave 16) from the retired /api/dashboard/data `tasks` branch: the
 * SESSION-DERIVED tenant filter and the session-pinned assignee scope.
 *
 * Every filter here was optional and caller-supplied and none was applied by
 * default, so `getTasks()` returned every task on the platform and
 * `getTasks({ assignedTo })` returned any agent's worklist by id. The tenant is
 * now applied unconditionally and first; `assignedTo` may only NARROW, and only
 * for a broker/admin inside their own tenant.
 */
export async function getTasks(params?: {
  assignedTo?: string
  contactId?: string
  listingId?: string
  transactionId?: string
  status?: string
}) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated", tasks: [] }
    if (!ctx.brokerageId) {
      return { success: false, error: "Your account is not linked to a brokerage yet.", tasks: [] }
    }

    // tasks.assigned_to_agent_id → agents.id. Resolved from the session, never
    // substituted from users.id.
    let assigneeFilter: string | undefined
    if (isAdminOrBroker({ user_type: ctx.userType })) {
      assigneeFilter = params?.assignedTo
    } else {
      if (!ctx.agentId) return { success: false, error: "Agent profile not found", tasks: [] }
      assigneeFilter = ctx.agentId
    }

    const supabase = await createClient()

    let query = supabase
      .from("tasks")
      .select("*, assigned_agent:agents!tasks_assigned_to_agent_id_fkey(id, first_name, last_name)")
      .eq("brokerage_id", ctx.brokerageId)
      .order("due_date", { ascending: true })

    if (assigneeFilter) query = query.eq("assigned_to_agent_id", assigneeFilter)
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
    if (params.assignedTo !== undefined) updates.assigned_to_agent_id = params.assignedTo
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

    // tasks.brokerage_id + assigned_to_agent_id are NOT NULL (pass 5 live
    // catch — this hub action failed for EVERY caller that omitted an
    // assignee, and always missed brokerage_id). Resolve both from the
    // session: the caller's own agent row is the default assignee.
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { success: false, error: "Unauthorized" }
    const { data: callerAgent } = await supabase
      .from("agents")
      .select("id, brokerage_id")
      .eq("user_id", user.id)
      .maybeSingle()
    const assignee = params.assignedTo ?? callerAgent?.id
    const brokerageId = callerAgent?.brokerage_id
    if (!assignee || !brokerageId) {
      return { success: false, error: "No agent profile for this user — cannot create the task" }
    }

    const { data, error } = await supabase
      .from("tasks")
      .insert({
        brokerage_id: brokerageId,
        title: params.title,
        description: params.description,
        due_date: params.dueDate,
        assigned_to_agent_id: assignee,
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
