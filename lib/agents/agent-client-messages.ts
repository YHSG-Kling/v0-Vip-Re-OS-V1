/**
 * lib/agents/agent-client-messages.ts
 *
 * Wave 45 — governed client-message loop for the managed agents. The deal-critical
 * managers (Listing Concierge, Deal Coordinator) PROPOSE a seller/buyer update
 * here instead of sending it autonomously; a human approves (or edits) it in the
 * Command Center; APPROVING sends it (portal card) and records the audit trail.
 * Nothing reaches a client without a human in the loop.
 */
import { createServiceClient } from "@/lib/supabase/service"

export interface ProposeClientMessageInput {
  brokerageId:           string
  managedAgentSessionId?: string | null
  agentKind:             string
  entityType:            string
  entityId?:             string | null
  recipientContactId?:   string | null
  audience:              "seller" | "buyer" | "lead" | "agent"
  subject?:              string | null
  body:                  string
  rationale?:            string | null
}

export async function proposeClientMessage(
  input: ProposeClientMessageInput, client?: ReturnType<typeof createServiceClient>,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const supabase = client ?? createServiceClient()
  if (!input.brokerageId || !input.body?.trim()) return { ok: false, error: "brokerageId + body required" }
  const { data, error } = await supabase.from("agent_client_messages").insert({
    brokerage_id: input.brokerageId,
    managed_agent_session_id: input.managedAgentSessionId ?? null,
    agent_kind: input.agentKind,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    recipient_contact_id: input.recipientContactId ?? null,
    audience: input.audience,
    subject: input.subject ?? null,
    body: input.body,
    rationale: input.rationale ?? null,
    status: "proposed",
  }).select("id").single()
  if (error || !data) return { ok: false, error: error?.message ?? "insert failed" }
  return { ok: true, id: (data as { id: string }).id }
}

export interface ClientMessageResult { status: "sent" | "skipped" | "failed"; result: Record<string, unknown> }

/**
 * Approve + SEND a proposed client message. Claims the row (proposed → approved),
 * delivers it to the recipient's portal (best-effort), stamps sent. `editedBody`
 * lets the human revise before it goes out. Idempotent — only proposed/approved
 * rows send. Never throws.
 */
export async function approveClientMessage(
  messageId: string, approverUserId: string, editedBody?: string,
  client?: ReturnType<typeof createServiceClient>,
): Promise<ClientMessageResult> {
  const supabase = client ?? createServiceClient()
  const patch: Record<string, unknown> = { status: "approved", approved_by: approverUserId, approved_at: new Date().toISOString() }
  if (editedBody?.trim()) patch.body = editedBody
  const { data: claimed } = await supabase.from("agent_client_messages")
    .update(patch).eq("id", messageId).in("status", ["proposed", "approved"])
    .select("brokerage_id, entity_type, entity_id, recipient_contact_id, audience, subject, body").single()
  if (!claimed) return { status: "skipped", result: { reason: "not in proposed/approved state" } }
  const m = claimed as { brokerage_id: string; entity_type: string; entity_id: string | null; recipient_contact_id: string | null; audience: string; subject: string | null; body: string }

  // Deliver via the SAME canonical pipeline the autonomous path used — now fired
  // only on human approval (agent_message_received fans out to the client portal).
  try {
    const { emitKernelEvent } = await import("@/lib/kernel/emit")
    await emitKernelEvent({
      event:       "agent_message_received",
      brokerageId: m.brokerage_id,
      entityType:  m.entity_type,
      entityId:    (m.entity_id ?? m.recipient_contact_id) as string,
      metadata: {
        agent_message: m.body, subject: m.subject ?? "An update from your agent",
        audience: m.audience, recipient_contact_id: m.recipient_contact_id,
        human_approved: true, message_preview: m.body.slice(0, 400),
      },
    })
  } catch (e) {
    await supabase.from("agent_client_messages").update({ status: "failed", send_error: (e as Error).message }).eq("id", messageId)
    return { status: "failed", result: { error: (e as Error).message } }
  }
  await supabase.from("agent_client_messages").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", messageId)
  return { status: "sent", result: { message_id: messageId } }
}

export async function rejectClientMessage(
  messageId: string, approverUserId: string, client?: ReturnType<typeof createServiceClient>,
): Promise<{ ok: boolean }> {
  const supabase = client ?? createServiceClient()
  const { data } = await supabase.from("agent_client_messages")
    .update({ status: "rejected", approved_by: approverUserId, approved_at: new Date().toISOString() })
    .eq("id", messageId).eq("status", "proposed").select("id").maybeSingle()
  return { ok: !!data }
}
