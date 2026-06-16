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
  /** Pre-conversion LEAD recipient (mutually exclusive with recipientContactId). Leads use the
   *  approved pre-consent channels only — email + direct mail. */
  recipientLeadId?:      string | null
  audience:              "seller" | "buyer" | "lead" | "agent"
  subject?:              string | null
  body:                  string
  rationale?:            string | null
  channel?:              "portal" | "portal_push" | "email" | "sms" | "voice_drop" | "direct_mail" | null
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
    recipient_lead_id: input.recipientLeadId ?? null,
    audience: input.audience,
    subject: input.subject ?? null,
    body: input.body,
    rationale: input.rationale ?? null,
    channel: input.channel ?? "portal",
    status: "proposed",
  }).select("id").single()
  if (error || !data) return { ok: false, error: error?.message ?? "insert failed" }
  const messageId = (data as { id: string }).id

  // REAL-TIME GATE FIRING — alert the responsible agent THE MOMENT the proposal lands
  // (the approval-push cron remains the safety net + 4h manager escalation). Best-effort
  // and idempotent (the cron's alreadyNotified check covers the same key), so a failure
  // here never fails the proposal.
  try {
    const { resolveResponsibleAgentUserId } = await import("@/lib/intelligence/mobile-approval-queue")
    const { MANAGERS } = await import("@/lib/kernel/manager-registry")
    const agentUserId = await resolveResponsibleAgentUserId(supabase, {
      recipient_contact_id: input.recipientContactId ?? null,
      entity_type: input.entityType ?? null,
      entity_id: input.entityId ?? null,
    })
    if (agentUserId) {
      const label = (input.agentKind in MANAGERS)
        ? MANAGERS[input.agentKind as keyof typeof MANAGERS].label
        : "A manager"
      await supabase.from("notifications").insert({
        user_id: agentUserId, brokerage_id: input.brokerageId, type: "approval_needed",
        title: `${label} needs your approval`,
        body: input.subject ? `${input.subject} — tap to review & approve.` : "A client message is awaiting your approval — tap to review.",
        entity_type: "agent_client_message", entity_id: messageId, priority: "medium", is_read: false,
      })
    }
  } catch (e) {
    console.error("[proposeClientMessage] real-time approval alert failed:", e)
  }

  return { ok: true, id: messageId }
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
    .select("brokerage_id, entity_type, entity_id, recipient_contact_id, recipient_lead_id, audience, subject, body, channel").single()
  if (!claimed) return { status: "skipped", result: { reason: "not in proposed/approved state" } }
  const m = claimed as { brokerage_id: string; entity_type: string; entity_id: string | null; recipient_contact_id: string | null; recipient_lead_id: string | null; audience: string; subject: string | null; body: string; channel: string }

  try {
    const channel = m.channel ?? "portal"
    if (m.recipient_lead_id && !m.recipient_contact_id) {
      // LEAD recipient (pre-conversion, no contact row) — email + direct mail ONLY. Leads carry
      // no phone-consent columns and have no portal surface, so other channels are rejected.
      const { data: ld } = await supabase.from("leads")
        .select("email, first_name, last_name, email_opt_out, direct_mail_opt_out, mailing_address, mailing_address_verified, mailing_city, mailing_state, mailing_zip")
        .eq("id", m.recipient_lead_id).maybeSingle()
      const lead = ld as { email?: string | null; first_name?: string | null; last_name?: string | null; email_opt_out?: boolean | null; direct_mail_opt_out?: boolean | null; mailing_address?: string | null; mailing_address_verified?: boolean | null; mailing_city?: string | null; mailing_state?: string | null; mailing_zip?: string | null } | null
      if (!lead) return await fail(supabase, messageId, "no recipient lead for this channel")

      if (channel === "email") {
        const { canDispatchToContact } = await import("@/lib/compliance/contact-channel-gate")
        const gate = canDispatchToContact({ email_opt_out: lead.email_opt_out }, "email")
        if (!gate.allowed) return await fail(supabase, messageId, gate.reason ?? "blocked by compliance gate")
        if (!lead.email) return await fail(supabase, messageId, "lead has no email")
        const { dispatchEmail } = await import("@/lib/providers/dispatch")
        const r = await dispatchEmail({ brokerageId: m.brokerage_id, leadId: m.recipient_lead_id, from: "", to: lead.email, subject: m.subject ?? "An update from your agent", html: `<p>${m.body.replace(/\n/g, "<br/>")}</p>`, text: m.body, channelPurpose: "update", systemSource: "agent_client_message" })
        if (!r.success) return await fail(supabase, messageId, r.error ?? "email send failed")
      } else if (channel === "direct_mail") {
        if (lead.direct_mail_opt_out) return await fail(supabase, messageId, "lead opted out of direct mail")
        const presetId = (m.subject && /preset:/.test(m.subject)) ? m.subject.replace(/.*preset:/, "").trim() : null
        if (!presetId) return await fail(supabase, messageId, "direct_mail needs a preset (subject 'preset:<id>')")
        if (!lead.mailing_address || !lead.mailing_address_verified || !lead.mailing_city || !lead.mailing_state || !lead.mailing_zip)
          return await fail(supabase, messageId, "no deliverable mailing address on file")
        const { orchestratePresetSend } = await import("@/lib/direct-mail/orchestrate-preset-send")
        const r = await orchestratePresetSend({
          brokerageId: m.brokerage_id, presetId, leadId: m.recipient_lead_id,
          recipientName: `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim() || "Neighbor",
          mailingAddress: lead.mailing_address, city: lead.mailing_city, state: lead.mailing_state, zip: lead.mailing_zip,
          systemSource: "agent_client_message",
        })
        if (!r.success) return await fail(supabase, messageId, r.error ?? r.fellBackReason ?? "direct mail send failed")
      } else {
        return await fail(supabase, messageId, "leads support email + direct mail only")
      }
    } else if (channel === "sms" || channel === "voice_drop" || channel === "email") {
      // Direct channels need the contact's identifier + the canonical suppression gate
      // (TCPA consent, DNC, per-channel opt-out / unsubscribe) — one source of truth.
      const { canDispatchToContact, honorsChannelPreference, CONTACT_CONSENT_COLUMNS, CONTACT_PREFERENCE_COLUMN } = await import("@/lib/compliance/contact-channel-gate")
      const { data: c } = await supabase.from("contacts")
        .select(`email, phone, first_name, ${CONTACT_PREFERENCE_COLUMN}, ${CONTACT_CONSENT_COLUMNS}`).eq("id", m.recipient_contact_id ?? "").maybeSingle()
      const contact = c as ({ email?: string | null; phone?: string | null; first_name?: string | null; preferred_channel?: string | null } & import("@/lib/compliance/contact-channel-gate").ContactConsentState) | null
      if (!contact) return await fail(supabase, messageId, "no recipient contact for this channel")

      // HARD pre-dispatch compliance gate — blocks before any provider is called.
      const gate = canDispatchToContact(contact, channel as import("@/lib/compliance/contact-channel-gate").DispatchChannel)
      if (!gate.allowed) return await fail(supabase, messageId, gate.reason ?? "blocked by compliance gate")

      // CHANNEL PREFERENCE gate — consent says it's legal; this says the contact actually
      // wants this channel. A manager's SMS to an email-only contact is blocked here (the
      // human re-proposes on the preferred rail). Portal/social/no-preference never block.
      const prefGate = honorsChannelPreference(contact.preferred_channel ?? null, channel as import("@/lib/compliance/contact-channel-gate").DispatchChannel)
      if (!prefGate.allowed) return await fail(supabase, messageId, prefGate.reason ?? "blocked by channel preference")

      if (channel === "sms" || channel === "voice_drop") {
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
    } else if (channel === "direct_mail") {
      // DIRECT MAIL — its own gate (direct_mail_opt_out, not TCPA/CAN-SPAM): resolve the
      // deliverable mailing address, then dispatch the preset (subject 'preset:<id>') through
      // the existing Lob orchestrator. Skips cleanly when there's no preset / no good address.
      if (!m.recipient_contact_id) return await fail(supabase, messageId, "direct mail needs a recipient contact")
      const { data: dmc } = await supabase.from("contacts")
        .select("first_name, last_name, direct_mail_opt_out").eq("id", m.recipient_contact_id).maybeSingle()
      const dm = dmc as { first_name?: string | null; last_name?: string | null; direct_mail_opt_out?: boolean | null } | null
      if (!dm) return await fail(supabase, messageId, "no recipient contact for direct mail")
      if (dm.direct_mail_opt_out) return await fail(supabase, messageId, "contact opted out of direct mail")
      const presetId = (m.subject && /preset:/.test(m.subject)) ? m.subject.replace(/.*preset:/, "").trim() : null
      if (!presetId) return await fail(supabase, messageId, "direct_mail needs a preset (subject 'preset:<id>')")
      const { resolveMailingAddressForContact } = await import("@/lib/contacts/resolve-mailing-address")
      const addr = await resolveMailingAddressForContact({ contactId: m.recipient_contact_id, brokerageId: m.brokerage_id })
      if (!addr) return await fail(supabase, messageId, "no deliverable mailing address on file")
      const { orchestratePresetSend } = await import("@/lib/direct-mail/orchestrate-preset-send")
      const r = await orchestratePresetSend({
        brokerageId: m.brokerage_id, presetId, contactId: m.recipient_contact_id,
        recipientName: `${dm.first_name ?? ""} ${dm.last_name ?? ""}`.trim() || "Neighbor",
        mailingAddress: addr.street, city: addr.city, state: addr.state, zip: addr.zip,
        systemSource: "agent_client_message",
      })
      if (!r.success) return await fail(supabase, messageId, r.error ?? r.fellBackReason ?? "direct mail send failed")
    } else {
      // portal / portal_push → write the canonical portal card DIRECTLY.
      // (Previously this emitted the string "agent_message_received" — which is not a
      // KernelEvent enum member, has no PORTAL_UPDATE_TEMPLATES entry, and no portal-stream
      // translation — so an approved portal-channel message NEVER rendered for the client.
      // transparency_updates is the canonical "what happened on my deal" card the portal
      // reads; writing it directly makes the final hop provable.)
      if (!m.recipient_contact_id) {
        // INTERNAL drafts (audience 'agent' — e.g. recruiting outreach, partner thank-yous
        // with no contact): approving delivers the APPROVED DRAFT to the responsible
        // agent's notifications — the human sends it personally (recruiting mail should
        // come from the recruiter, not the machine). Client audiences still require a
        // recipient contact.
        if (m.audience === "agent") {
          const { resolveResponsibleAgentUserId } = await import("@/lib/intelligence/mobile-approval-queue")
          const agentUserId = await resolveResponsibleAgentUserId(supabase, {
            recipient_contact_id: null, entity_type: m.entity_type, entity_id: m.entity_id,
          })
          if (!agentUserId) return await fail(supabase, messageId, "no responsible agent to deliver the approved draft to")
          const { error: notifErr } = await supabase.from("notifications").insert({
            user_id: agentUserId, brokerage_id: m.brokerage_id, type: "approved_draft",
            title: m.subject ?? "Approved draft ready to send",
            body: m.body.slice(0, 2000),
            entity_type: "agent_client_message", entity_id: messageId, priority: "medium", is_read: false,
          })
          if (notifErr) return await fail(supabase, messageId, `draft delivery failed: ${notifErr.message}`)
        } else {
          return await fail(supabase, messageId, "portal channel needs a recipient contact")
        }
      } else {
      const { error: cardErr } = await supabase.from("transparency_updates").insert({
        brokerage_id:           m.brokerage_id,
        contact_id:             m.recipient_contact_id,
        title:                  m.subject ?? "An update from your agent",
        plain_language_summary: m.body,
        message:                m.body,
        update_type:            "agent_message",
        is_visible_to_client:   true,
        metadata:               { audience: m.audience, channel, human_approved: true, agent_client_message_id: messageId },
        created_at:             new Date().toISOString(),
      })
      if (cardErr) return await fail(supabase, messageId, `portal card write failed: ${cardErr.message}`)
      }
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
  /** WHY the human said no — one sentence stored on the rejection ("agent feedback: …").
   *  Outcome learning reads it so the managers learn direction, not just a score. */
  reason?: string,
): Promise<{ ok: boolean }> {
  const supabase = client ?? createServiceClient()
  const patch: Record<string, unknown> = { status: "rejected", approved_by: approverUserId, approved_at: new Date().toISOString() }
  if (reason?.trim()) patch.send_error = `agent feedback: ${reason.trim().slice(0, 300)}`
  const { data } = await supabase.from("agent_client_messages")
    .update(patch)
    .eq("id", messageId).eq("status", "proposed").select("id").maybeSingle()
  return { ok: !!data }
}
