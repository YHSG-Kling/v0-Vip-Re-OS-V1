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
  channel?:              "portal" | "portal_push" | "email" | "sms" | "voice_drop" | null
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
    channel: input.channel ?? "portal",
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
    .select("brokerage_id, entity_type, entity_id, recipient_contact_id, audience, subject, body, channel").single()
  if (!claimed) return { status: "skipped", result: { reason: "not in proposed/approved state" } }
  const m = claimed as { brokerage_id: string; entity_type: string; entity_id: string | null; recipient_contact_id: string | null; audience: string; subject: string | null; body: string; channel: string }

  try {
    const channel = m.channel ?? "portal"
    if (channel === "sms" || channel === "voice_drop" || channel === "email") {
      // Direct channels need the contact's identifier + (for SMS/voice) TCPA consent.
      const { data: c } = await supabase.from("contacts")
        .select("email, phone, tcpa_consent, first_name").eq("id", m.recipient_contact_id ?? "").maybeSingle()
      const contact = c as { email?: string | null; phone?: string | null; tcpa_consent?: boolean; first_name?: string | null } | null
      if (!contact) return await fail(supabase, messageId, "no recipient contact for this channel")

      if (channel === "sms" || channel === "voice_drop") {
        // TCPA: SMS/voice to a client requires marketing consent — hard block (lawsuit-safe).
        if (!contact.tcpa_consent) return await fail(supabase, messageId, "TCPA consent required for SMS/voice — not sent")
        if (!contact.phone) return await fail(supabase, messageId, "contact has no phone")
        if (channel === "sms") {
          const { dispatchSms } = await import("@/lib/providers/dispatch")
          const r = await dispatchSms({ brokerageId: m.brokerage_id, contactId: m.recipient_contact_id ?? undefined, to: contact.phone, message: m.body, systemSource: "agent_client_message" })
          if (!r.success) return await fail(supabase, messageId, r.error ?? "sms send failed")
        } else {
          // voice_drop: deliver a ringless voicemail when the manager supplied a preset.
          const presetId = (m.subject && /preset:/.test(m.subject)) ? m.subject.replace(/.*preset:/, "").trim() : null
          if (!presetId) return await fail(supabase, messageId, "voice_drop needs a voicemail preset (subject 'preset:<id>')")
          const { orchestrateVoicedropSend } = await import("@/lib/voicedrop/orchestrate-voicedrop-send")
          const r = await orchestrateVoicedropSend({ brokerageId: m.brokerage_id, presetId, contactId: m.recipient_contact_id ?? undefined, toPhone: contact.phone, recipientFirstName: contact.first_name ?? null, systemSource: "agent_client_message" })
          if (!(r as { success?: boolean }).success) return await fail(supabase, messageId, "voice drop failed")
        }
      } else {
        // email
        if (!contact.email) return await fail(supabase, messageId, "contact has no email")
        const { dispatchEmail } = await import("@/lib/providers/dispatch")
        const r = await dispatchEmail({ brokerageId: m.brokerage_id, contactId: m.recipient_contact_id ?? undefined, from: "", to: contact.email, subject: m.subject ?? "An update from your agent", html: `<p>${m.body.replace(/\n/g, "<br/>")}</p>`, text: m.body, channelPurpose: "update", systemSource: "agent_client_message" })
        if (!r.success) return await fail(supabase, messageId, r.error ?? "email send failed")
      }
    } else {
      // portal / portal_push → the canonical kernel emitter (client portal card + bell).
      const { emitKernelEvent } = await import("@/lib/kernel/emit")
      await emitKernelEvent({
        event: "agent_message_received", brokerageId: m.brokerage_id, entityType: m.entity_type,
        entityId: (m.entity_id ?? m.recipient_contact_id) as string,
        metadata: { agent_message: m.body, subject: m.subject ?? "An update from your agent", audience: m.audience, recipient_contact_id: m.recipient_contact_id, channel, human_approved: true, message_preview: m.body.slice(0, 400) },
      })
    }
  } catch (e) {
    return await fail(supabase, messageId, (e as Error).message)
  }
  await supabase.from("agent_client_messages").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", messageId)
  return { status: "sent", result: { message_id: messageId, channel: m.channel } }
}

async function fail(supabase: ReturnType<typeof createServiceClient>, messageId: string, reason: string): Promise<ClientMessageResult> {
  await supabase.from("agent_client_messages").update({ status: "failed", send_error: reason }).eq("id", messageId)
  return { status: "failed", result: { error: reason } }
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
