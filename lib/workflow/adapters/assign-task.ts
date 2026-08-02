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
import { rawRoleVariantsFor } from "@/lib/security/types"

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
          // Lenders are vendors (external participants) — internal task assignment
          // does not target an external lender; leave unassigned for escalation.
          assigneeUserId = null
          break
        }

        case "compliance_officer": {
          const { data: u } = await supabase
            .from("users")
            .select("id")
            .eq("brokerage_id", brokerageId)
            .in("user_type", rawRoleVariantsFor(["compliance_officer"]))
            .limit(1)
            .maybeSingle()
          assigneeUserId = u?.id ?? null
          break
        }

        case "vendor": {
          // Find a vendor assigned to the contact's most recent transaction (e.g. inspector,
          // photographer, stager). vendor_assignments links vendors to listings/transactions.
          if (contact?.id) {
            const { data: tx } = await supabase
              .from("transactions")
              .select("id")
              .eq("brokerage_id", brokerageId)
              .or(`buyer_contact_id.eq.${contact.id},seller_contact_id.eq.${contact.id},contact_id.eq.${contact.id}`)
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle()
            if (tx?.id) {
              const { data: va } = await supabase
                .from("vendor_assignments")
                .select("assigned_by_agent_id")
                .eq("transaction_id", tx.id)
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle()
              assigneeUserId = (va as any)?.assigned_by_agent_id ?? null
            }
          }
          break
        }

        case "staff":
        case "any_brokerage_member": {
          // First available active staff member at the brokerage (excluding agent role)
          const { data: u } = await supabase
            .from("users")
            .select("id")
            .eq("brokerage_id", brokerageId)
            .in("user_type", rawRoleVariantsFor(["broker", "team_lead", "tc", "compliance_officer", "admin"]))
            .limit(1)
            .maybeSingle()
          assigneeUserId = u?.id ?? ctx.agentUserId
          break
        }

        default:
          // Fall back to agent (the contact's assigned agent or the workflow runner)
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

    // Resolve assignee USER id → AGENTS row id (tasks.assigned_to_agent_id is FK to agents.id)
    let assignedToAgentId: string | null = null
    if (assigneeUserId) {
      const { data: agentRow } = await supabase
        .from("agents")
        .select("id")
        .eq("user_id", assigneeUserId)
        .maybeSingle()
      assignedToAgentId = agentRow?.id ?? null
    }

    const { data: task, error } = await supabase.from("tasks").insert({
      brokerage_id: brokerageId,
      contact_id: contact?.id ?? null,
      assigned_to_agent_id: assignedToAgentId,
      title,
      description: notes,                         // tasks.description (not "notes")
      due_date: dueAt,                            // tasks.due_date (not "due_at")
      status: "pending",
      assignee_type: assigneeType,                // added by migration 1027
      source: "workflow_sequence",                // added by migration 1027
      source_enrollment_id: ctx.enrollmentId,     // added by migration 1027
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
