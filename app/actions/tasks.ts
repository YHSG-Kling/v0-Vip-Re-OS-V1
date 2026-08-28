"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { handleError } from "@/lib/errors"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"
// ★ ACT-AS WRITE SEAM ★ — every WRITE below gates through resolveWriteContext()
// and writes through its `db`. Cookie (RLS) client for normal tenant users;
// service client ONLY under an active FULL impersonation grant re-validated at
// call time (read_only is refused). Before this, all four writers here used the
// cookie client bare: under act-as the staff auth.uid() has no tenant, tenant
// RLS matched zero rows, and supabase-js RESOLVED the refusal — delete reported
// success over nothing. New tenant-writing actions should adopt this seam.
import { resolveWriteContext } from "@/lib/platform/acting-context"
// The ONE way a notifications row gets its tenant — the recipient's users.brokerage_id,
// which is the exact value the badge-count reader compares against.
import { resolveRecipientBrokerageId } from "@/lib/notifications/recipient-tenant"

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
  /**
   * Due-date window (YYYY-MM-DD, inclusive) — MERGED from the calendar shell's
   * inline tasks read when that duplicate was rewired onto this survivor (lane
   * E6 2026-08-28, app/dashboard/calendar/components/os/calendar-shell.tsx).
   * Narrowing only; the session-derived tenant + assignee scope above still
   * applies first.
   */
  dueDateFrom?: string
  dueDateTo?: string
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

    // `agents` has NO first_name / last_name (verified against
    // information_schema) — the assignee's name lives on `users`, reached
    // through agents_user_id_fkey (the only agents→users FK, so an OBJECT).
    // Naming them here made PostgREST reject the ENTIRE query, so getTasks
    // threw on every call and the task list rendered as "no tasks".
    // The !tasks_assigned_to_agent_id_fkey hint stays: `tasks` has TWO FKs to
    // agents (assigned_to_agent_id and created_by_agent_id).
    let query = supabase
      .from("tasks")
      .select(
        "*, assigned_agent:agents!tasks_assigned_to_agent_id_fkey(id, users:user_id(first_name, last_name))",
      )
      .eq("brokerage_id", ctx.brokerageId)
      .order("due_date", { ascending: true })

    if (assigneeFilter) query = query.eq("assigned_to_agent_id", assigneeFilter)
    if (params?.contactId) query = query.eq("contact_id", params.contactId)
    if (params?.listingId) query = query.eq("listing_id", params.listingId)
    if (params?.transactionId) query = query.eq("transaction_id", params.transactionId)
    if (params?.status) query = query.eq("status", params.status)
    if (params?.dueDateFrom) query = query.gte("due_date", params.dueDateFrom)
    if (params?.dueDateTo) query = query.lte("due_date", params.dueDateTo)

    const { data, error } = await query

    if (error) throw error

    // Flattened back to the declared assigned_agent shape (id/first_name/
    // last_name), the form every agent-name reader in the app already uses.
    const tasks = (data ?? []).map((t: any) => {
      const a = t?.assigned_agent ?? null
      const u = a?.users ?? null
      return {
        ...t,
        assigned_agent: a
          ? { id: a.id, first_name: u?.first_name ?? null, last_name: u?.last_name ?? null }
          : null,
      }
    })

    return { success: true, tasks }
  } catch (error) {
    return handleError(error, "getTasks")
  }
}

/**
 * Tell the person who just inherited a task that they have it.
 *
 * MODULE-PRIVATE ON PURPOSE — this file is `"use server"`, so every export is a public
 * HTTP endpoint. A notification writer that anyone could call by name would let a caller
 * post an arbitrary "New Task Assigned" notice to any user.
 *
 * Returns a warning STRING when the notice could not be written, and undefined when it
 * was. The reassignment itself has already landed by then, so a failure here must not be
 * reported as a failed reassignment — nor swallowed, which is how the predecessor's
 * phantom insert stayed invisible for its whole life.
 */
async function notifyNewAssignee(
  supabase: any,
  newAgentId: string,
  task: { id: string; title?: string | null },
): Promise<string | undefined> {
  // tasks.assigned_to_agent_id is an agents.id; notifications.user_id is a users.id.
  // The two spaces are DISJOINT — the translation is not optional.
  const { data: agent, error: agentError } = await supabase
    .from("agents")
    .select("user_id")
    .eq("id", newAgentId)
    .maybeSingle()
  if (agentError || !agent?.user_id) {
    console.error(
      `[tasks] updateTask: could not resolve a user for agent ${newAgentId} (${agentError?.message ?? "no user_id"}) — assignment notice NOT written`,
    )
    return "Task reassigned, but the new assignee could not be notified"
  }

  // TENANT — the RECIPIENT's users.brokerage_id, which is the value the badge-count
  // reader ANDs against. Unstamped or stamped from the actor, the row exists and the
  // bell stays dark. See lib/notifications/recipient-tenant.ts.
  const tenant = await resolveRecipientBrokerageId(supabase, agent.user_id)
  if (!tenant.ok || !tenant.brokerageId) {
    console.error(
      `[tasks] updateTask: ${tenant.ok ? `recipient ${agent.user_id} has no brokerage` : tenant.reason} — assignment notice NOT written rather than written where the bell cannot count it`,
    )
    return "Task reassigned, but the new assignee could not be notified"
  }

  const { error: notifyError } = await supabase.from("notifications").insert({
    user_id: agent.user_id,
    brokerage_id: tenant.brokerageId,
    type: "task_delegated",
    title: "New Task Assigned",
    body: `You've been assigned: ${task.title ?? "a task"}`,
    entity_type: "task",
    entity_id: task.id,
  })
  if (notifyError) {
    console.error("[tasks] task_delegated notification insert refused:", notifyError.message)
    return "Task reassigned, but the new assignee could not be notified"
  }
  return undefined
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
    const ctx = await resolveWriteContext()
    if (!ctx.ok) return { success: false, error: ctx.error }
    if (!ctx.brokerageId) return { success: false, error: "Your account is not linked to a brokerage yet." }
    const supabase = ctx.db

    const updates: any = {}
    if (params.title !== undefined) updates.title = params.title
    if (params.description !== undefined) updates.description = params.description
    if (params.dueDate !== undefined) updates.due_date = params.dueDate
    if (params.assignedTo !== undefined) updates.assigned_to_agent_id = params.assignedTo
    if (params.priority !== undefined) updates.priority = params.priority
    if (params.status !== undefined) updates.status = params.status

    // ── MERGED FROM app/actions/assistant.ts:handleTaskDelegated (now deleted) ──
    // That duplicate wrote the same column (assigned_to_agent_id) and held two things
    // this survivor did not: an OWNERSHIP TEST before a reassignment, and a notice to
    // the person who inherits the task. Both are carried here; the tenant predicate
    // this function already had is what the duplicate lacked.
    //
    // The read is scoped by brokerage too, so "not found" means the same thing at both
    // steps and a cross-tenant task id cannot even be probed for its assignee.
    const { data: before, error: beforeError } = await supabase
      .from("tasks")
      .select("id, title, assigned_to_agent_id, created_by_agent_id")
      .eq("id", params.taskId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()
    if (beforeError) throw beforeError
    if (!before) return { success: false, error: "Task not found in your brokerage" }

    const reassigning =
      params.assignedTo !== undefined && params.assignedTo !== before.assigned_to_agent_id
    if (reassigning) {
      // Scoped to REASSIGNMENT alone, which is the write the duplicate performed.
      // Editing a task's own fields stays a tenant-level permission; handing it to
      // someone else is the act that needs standing, exactly as the duplicate had it:
      // the current assignee, the creator, or a broker/admin.
      const isOwner =
        !!ctx.agentId &&
        (before.assigned_to_agent_id === ctx.agentId || before.created_by_agent_id === ctx.agentId)
      if (!isOwner && !isAdminOrBroker({ user_type: ctx.userType })) {
        return { success: false, error: "Forbidden: not your task to reassign" }
      }
    }

    const { data, error } = await supabase
      .from("tasks")
      .update(updates)
      .eq("id", params.taskId)
      .eq("brokerage_id", ctx.brokerageId)
      .select()
      .maybeSingle()

    if (error) throw error
    if (!data) return { success: false, error: "Task not found in your brokerage" }

    let warning: string | undefined
    if (reassigning) warning = await notifyNewAssignee(supabase, params.assignedTo!, data)

    revalidatePath("/dashboard")
    revalidatePath("/tasks")

    return warning ? { success: true, task: data, warning } : { success: true, task: data }
  } catch (error) {
    return handleError(error, "updateTask")
  }
}

/**
 * Mark a task as completed
 */
export async function completeTask(taskId: string) {
  try {
    const ctx = await resolveWriteContext() // ACT-AS WRITE SEAM — see header
    if (!ctx.ok) return { success: false, error: ctx.error }
    if (!ctx.brokerageId) return { success: false, error: "Your account is not linked to a brokerage yet." }
    const supabase = ctx.db

    const { data, error } = await supabase
      .from("tasks")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
      })
      .eq("id", taskId)
      .eq("brokerage_id", ctx.brokerageId)
      .select()
      .maybeSingle()

    if (error) throw error
    if (!data) return { success: false, error: "Task not found in your brokerage" }

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
    const ctx = await resolveWriteContext() // ACT-AS WRITE SEAM — see header
    if (!ctx.ok) return { success: false, error: ctx.error }
    if (!ctx.brokerageId) return { success: false, error: "Your account is not linked to a brokerage yet." }
    const supabase = ctx.db

    // `.select("id")` makes the affected rows observable: a zero-row DELETE
    // resolves with `error: null`, and this action used to report success on it.
    const { data: deleted, error } = await supabase
      .from("tasks")
      .delete()
      .eq("id", taskId)
      .eq("brokerage_id", ctx.brokerageId)
      .select("id")

    if (error) throw error
    if (!deleted || deleted.length === 0) {
      return { success: false, error: "Task not found in your brokerage" }
    }

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
    // ACT-AS WRITE SEAM — see header. Identity comes from the seam's context
    // (the IMPERSONATED tenant identity under act-as), not from a bare cookie
    // read of the caller's own agents row, which for acting staff has no row
    // at all and refused every create.
    const ctx = await resolveWriteContext()
    if (!ctx.ok) return { success: false, error: ctx.error }
    const supabase = ctx.db

    // tasks.brokerage_id + assigned_to_agent_id are NOT NULL (pass 5 live
    // catch — this hub action failed for EVERY caller that omitted an
    // assignee, and always missed brokerage_id). Resolve both from the
    // session context: the effective identity's agent row is the default assignee.
    const assignee = params.assignedTo ?? ctx.agentId
    const brokerageId = ctx.brokerageId
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
