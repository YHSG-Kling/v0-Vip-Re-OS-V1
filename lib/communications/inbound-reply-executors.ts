// lib/communications/inbound-reply-executors.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE GOVERNED EXECUTORS THE ARBITER'S INBOUND RESPONDER CALLS FOR EMAIL / TEXT / PORTAL (wave 147, lane 147G — owner ruling
// 12, contract C13). The social executors live beside their normalizers (lib/social/inbound-social.ts composeInboundReply /
// sendInboundSocialReply / proposeInboundReply); these are the private-thread twins:
//   · draftProactiveReply — a reply DRAFT a person sends (the reply-coach rail), when the decision is "reply" but the reply
//     is not sent unattended;
//   · sendInboundSmsReply — ONE unattended text through the ONE SMS chokepoint, when the tenant explicitly granted it.
// Only lib/communications/inbound-responder.ts respondToInboundCommunication calls them (lazily), so no dashboard page
// compiles them. Not server-only, no "use server": the responder's proofs inject seams in their place.

type Client = { from: (t: string) => any }

/**
 * PROACTIVE AI REPLY DRAFT — MOVED HERE (wave 147, lane 147G) from lib/voice/sms-inbound.ts, where the inbound SMS webhook
 * fired it on EVERY text. It now runs when the arbiter decided a reply is the right answer and a PERSON sends it (no grant,
 * a refused gate, a first-time texter), for email / text / portal alike. It rides the EXISTING reply-coach rail
 * (lib/ai-reply-coach/reply-draft-core.ts generateAIReplyDraftForTenant: ai_message_drafts + the accept / edit / dismiss
 * lifecycle + the inbox's draft panel + the "AI Reply Ready" suggestion); the generator enforces DNC / TCPA and brand voice.
 * The sessionless core is correct here: the tenant is the one the door verified. Nothing auto-sends from this function.
 */
export async function draftProactiveReply(input: {
  brokerageId: string
  agentUserId: string
  conversationId: string
  contactId: string
  messageId: string
  body: string
  channel: "email" | "sms" | "in_app"
}): Promise<{ success: boolean; error?: string; draftId?: string }> {
  const { generateAIReplyDraftForTenant } = await import("@/lib/ai-reply-coach/reply-draft-core")
  const d = await generateAIReplyDraftForTenant({
    brokerageId: input.brokerageId, agentUserId: input.agentUserId, conversationId: input.conversationId, contactId: input.contactId,
    inboundMessageId: input.messageId, inboundBody: input.body, channel: input.channel,
  })
  return { success: d.success, ...(d.error ? { error: d.error } : {}), ...(d.draftId ? { draftId: d.draftId } : {}) }
}

/**
 * WAVE 149 (lane 149C, owner ruling 8 — "the AI may answer when a human doesn't, through the arbiter"; C24 on every channel the
 * arbiter may use): ONE unattended EMAIL reply through the ONE email chokepoint (dispatchEmail: suppression / CAN-SPAM opt-out,
 * de-confliction, the ai_isa autonomy gate armed by managerKey, the content backstop, the budget, at-most-once per inbound on
 * the `inbound-reply:<record>` cycle), recorded on the thread. A conversation reply (channelPurpose 'conversation'), never a
 * campaign. The twin of sendInboundSmsReply below.
 */
export async function sendInboundEmailReply(
  svc: Client,
  p: { brokerageId: string; contactId: string; conversationId: string; agentId: string | null; recordId: string; text: string; subject?: string | null },
): Promise<{ sent: boolean; providerRef?: string | null; messageId?: string | null; error?: string }> {
  try {
    const { data: c, error } = await svc.from("contacts").select("id, email").eq("id", p.contactId).eq("brokerage_id", p.brokerageId).maybeSingle()
    if (error) return { sent: false, error: `contact read refused: ${error.message}` }
    const email = (c as { email?: string | null } | null)?.email?.trim() ?? ""
    if (!email) return { sent: false, error: "no email address on file for this person" }
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    const { dispatchEmail } = await import("@/lib/providers/dispatch")
    const r = await dispatchEmail({
      brokerageId: p.brokerageId, contactId: p.contactId, to: email,
      subject: (p.subject?.trim() ? `Re: ${p.subject.trim().replace(/^re:\s*/i, "")}` : "Re: your message").slice(0, 160),
      html: `<p>${esc(p.text).replace(/\n/g, "<br/>")}</p>`, text: p.text,
      channelPurpose: "conversation", managerKey: "ai_isa", systemSource: "ai_isa_inbound_reply",
      ledger: { reasonCode: "CONVERSATION_RESPONSE", reasonDetail: "answering an email the person sent", cycle: `inbound-reply:${p.recordId}` },
    })
    if (!r.success) return { sent: false, error: r.error ?? `${r.providerKey} refused` }
    const { data: prior, error: priorErr } = await svc.from("messages").select("id").eq("brokerage_id", p.brokerageId).eq("conversation_id", p.conversationId).eq("direction", "outbound").contains("metadata", { in_reply_to: p.recordId }).limit(1).maybeSingle()
    if (!priorErr && prior) return { sent: true, providerRef: r.messageId ?? null, messageId: (prior as { id: string }).id }
    const nowIso = new Date().toISOString()
    const { data: rec, error: recErr } = await svc.from("messages").insert({
      conversation_id: p.conversationId, brokerage_id: p.brokerageId, contact_id: p.contactId, agent_id: p.agentId,
      type: "email", direction: "outbound", sender_type: "ai", body: p.text, status: "sent",
      metadata: { provider: r.providerKey ?? "email", ...(r.messageId ? { provider_message_id: r.messageId } : {}), in_reply_to: p.recordId, autonomous: true },
      created_at: nowIso, updated_at: nowIso,
    }).select("id").single()
    if (recErr) return { sent: true, providerRef: r.messageId ?? null, messageId: null, error: `sent, but the outbound record was refused: ${recErr.message}` }
    const { touchConversation } = await import("@/lib/kernel/conversation-thread")
    await touchConversation(svc, p.conversationId, { inbound: false })
    return { sent: true, providerRef: r.messageId ?? null, messageId: (rec as { id: string }).id }
  } catch (e) {
    return { sent: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * WAVE 149 (lane 149C, ruling 8): ONE unattended answer in the client's PORTAL thread (client_portal_messages — the same surface
 * the ISA's situational note uses; agent_id NOT NULL, so a person with no assigned agent is refused, never faked). The portal
 * has no provider, so there is no delivery report: the written row IS the evidence (the supervisor closes on it).
 * At-most-once per inbound: an existing reply carrying `in_reply_to` is returned, never a second row.
 */
export async function postInboundPortalReply(
  svc: Client,
  p: { brokerageId: string; contactId: string; agentId: string | null; recordId: string; text: string },
): Promise<{ sent: boolean; providerRef?: string | null; messageId?: string | null; error?: string }> {
  try {
    if (!p.agentId) return { sent: false, error: "no assigned agent — a portal message needs the agent it comes from" }
    const { data: prior, error: priorErr } = await svc.from("client_portal_messages").select("id").eq("brokerage_id", p.brokerageId).eq("contact_id", p.contactId).contains("metadata", { in_reply_to: p.recordId }).limit(1).maybeSingle()
    if (priorErr) return { sent: false, error: `the portal thread could not be read (${priorErr.message})` }
    if (prior) return { sent: true, providerRef: null, messageId: (prior as { id: string }).id }
    const { data: rec, error } = await svc.from("client_portal_messages").insert({
      brokerage_id: p.brokerageId, contact_id: p.contactId, agent_id: p.agentId, direction: "agent_to_client", channel: "portal", body: p.text,
      metadata: { source: "ai_unattended_answer", in_reply_to: p.recordId, autonomous: true },
    }).select("id").single()
    if (error) return { sent: false, error: `the portal reply was refused: ${error.message}` }
    return { sent: true, providerRef: null, messageId: (rec as { id: string }).id }
  } catch (e) {
    return { sent: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Wave 147 (147G, C13 stages 6–8) — ONE unattended text reply through the ONE SMS chokepoint, recorded on the thread.
 * dispatchSms carries every gate (the ai_isa autonomy gate armed by managerKey, suppression, TCPA consent, de-confliction,
 * quiet hours, the content backstop, the vendor budget), the action ledger at-most-once per inbound
 * (cycle `inbound-reply:<record id>` — a replay returns the first send's sid, never a second text) and the PENDING delivery
 * claim the Twilio status callback reconciles. The outbound row carries `twilio_sid` (the key the status webhook mirrors
 * onto the thread) and `in_reply_to` (the key the completion supervisor and this function's own replay check read).
 */
export async function sendInboundSmsReply(
  svc: Client,
  p: { brokerageId: string; contactId: string; conversationId: string; agentId: string | null; recordId: string; text: string },
): Promise<{ sent: boolean; providerRef?: string | null; messageId?: string | null; error?: string }> {
  try {
    const { data: c, error } = await svc.from("contacts").select("id, phone").eq("id", p.contactId).eq("brokerage_id", p.brokerageId).maybeSingle()
    if (error) return { sent: false, error: `contact read refused: ${error.message}` }
    const phone = (c as { phone?: string | null } | null)?.phone ?? null
    if (!phone) return { sent: false, error: "no phone number on file for this person" }
    const { dispatchSms } = await import("@/lib/providers/dispatch")
    const r = await dispatchSms({
      brokerageId: p.brokerageId, contactId: p.contactId, to: phone, message: p.text,
      managerKey: "ai_isa", systemSource: "ai_isa_inbound_reply",
      ledger: { reasonCode: "CONVERSATION_RESPONSE", reasonDetail: "answering a text the person sent", cycle: `inbound-reply:${p.recordId}` },
      metadata: { in_reply_to: p.recordId },
    })
    if (!r.success) return { sent: false, error: r.error ?? `${r.providerKey} refused` }
    // A ledger REPLAY of an executed send answers success with the first sid — the thread already holds that row.
    const { data: prior, error: priorErr } = await svc.from("messages").select("id").eq("brokerage_id", p.brokerageId).eq("conversation_id", p.conversationId).eq("direction", "outbound").contains("metadata", { in_reply_to: p.recordId }).limit(1).maybeSingle()
    if (!priorErr && prior) return { sent: true, providerRef: r.messageId ?? null, messageId: (prior as { id: string }).id }
    const nowIso = new Date().toISOString()
    const { data: rec, error: recErr } = await svc.from("messages").insert({
      conversation_id: p.conversationId, brokerage_id: p.brokerageId, contact_id: p.contactId, agent_id: p.agentId,
      type: "sms", direction: "outbound", sender_type: "ai", body: p.text, status: "sent",
      metadata: { provider: "twilio", ...(r.messageId ? { twilio_sid: r.messageId } : {}), in_reply_to: p.recordId, autonomous: true },
      created_at: nowIso, updated_at: nowIso,
    }).select("id").single()
    if (recErr) return { sent: true, providerRef: r.messageId ?? null, messageId: null, error: `sent, but the outbound record was refused: ${recErr.message}` }
    const { touchConversation } = await import("@/lib/kernel/conversation-thread")
    await touchConversation(svc, p.conversationId, { inbound: false })
    return { sent: true, providerRef: r.messageId ?? null, messageId: (rec as { id: string }).id }
  } catch (e) {
    return { sent: false, error: e instanceof Error ? e.message : String(e) }
  }
}
