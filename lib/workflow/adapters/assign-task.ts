/**
 * Assign Task adapter — creates a CRM task assigned to any staff type.
 *
 * task_assignee_type options:
 *   'agent'               — the contact's assigned agent
 *   'staff'               — a specific brokerage staff member
 *   'tc'                  — transaction coordinator
 *   'lender'              — lender associated with the contact/transaction
 *   'vendor'              — vendor from the marketplace
 *   'compliance_officer'  — brokerage compliance officer
 *   'any_brokerage_member'— first available staff with the right role
 *
 * task_assignee_id (uuid) — specific person; null = resolve by role.
 */

import type { ChannelAdapter, StepContext, StepResult } from "../channel-registry"

export const assignTaskAdapter: ChannelAdapter = {
  channel: "assign_task",

  async execute(ctx: StepContext): Promise<StepResult> {
    const { step, contact, brokerageId, agentId, supabase, resolvedVars } = ctx

    const title = step.task_title ?? resolvedVars["task_title"] ?? "Follow-up task"
    const assigneeType = step.task_assignee_type ?? "agent"
    let assigneeUserId: string | null = step.task_assignee_id ?? null

    // Resolve assignee by role if not explicitly set
    if (!assigneeUserId) {
      switch (assigneeType) {
        case "agent":
          // Use the contact's assigned agent
          if (contact?.agent_id) {
            const { data: a } = await supabase
              .from("agents").select("user_id").eq("id", contact.agent_id).maybeSingle()
            assigneeUserId = a?.user_id ?? null
          }
          break

        case "tc": {
          // Find TC assigned to active transaction for this contact
          const { data: tx } = await supabase
            .from("transactions")
            .select("coordinator_id")
            .eq("brokerage_id", brokerageId)
            .not("coordinator_id", "is", null)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle()
          assigneeUserId = tx?.coordinator_id ?? null
          break
        }

        case "lender": {
          const { data: tx } = await supabase
            .from("transactions")
            .select("lender_id")
            .eq("brokerage_id", brokerageId)
            .not("lender_id", "is", null)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle()
          assigneeUserId = tx?.lender_id ?? null
          break
        }

        case "compliance_officer": {
          const { data: u } = await supabase
            .from("users")
            .select("id")
            .eq("brokerage_id", brokerageId)
            .eq("role", "compliance_officer")
            .limit(1)
            .maybeSingle()
          assigneeUserId = u?.id ?? null
          break
        }

        default:
          // Fall back to agent
          assigneeUserId = ctx.agentUserId
      }
    }

    // Generate AI task notes if prompt is provided
    let notes: string | null = null
    if (step.task_notes_prompt) {
      try {
        const { generateTextRouted } = await import("@/lib/ai/models")
        const { text } = await generateTextRouted({
          feature: "task_notes",
          messages: [{
            role: "user",
            content: `Write brief task notes for: "${step.task_notes_prompt}". Contact: ${contact?.first_name ?? ""} ${contact?.last_name ?? ""}. 2-3 sentences max.`,
          }],
        })
        notes = text
      } catch { /* best-effort */ }
    }

    const dueAt = new Date(
      Date.now() + (step.task_due_offset_days ?? 0) * 86_400_000
    ).toISOString()

    const { data: task, error } = await supabase.from("tasks").insert({
      brokerage_id: brokerageId,
      contact_id: contact?.id ?? null,
      assigned_to: assigneeUserId,
      title,
      notes,
      due_at: dueAt,
      assignee_type: assigneeType,
      source: "workflow_sequence",
      source_enrollment_id: ctx.enrollmentId,
      status: "pending",
      created_at: new Date().toISOString(),
    }).select("id").single()

    if (error) {
      return { status: "error", providerKey: "tasks", error: error.message }
    }

    return {
      status: "sent",
      providerKey: "tasks",
      messageId: task?.id,
      output: { task_id: task?.id, assignee_type: assigneeType, due_at: dueAt },
    }
  },
}
