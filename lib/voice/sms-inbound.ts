// lib/voice/sms-inbound.ts
// ─────────────────────────────────────────────────────────────────────────────
// INBOUND SMS/WhatsApp → THE UNIFIED INBOX. The consolidation half of the
// owner's "conversational AI with Twilio for our unified inbox including
// social messaging surfaces": the EXISTING provider-inbound ingress
// (app/api/providers/inbound) already verified signatures, detected opt-outs,
// and handed off to the kernel — but it NEVER wrote a `messages` row, so an
// inbound text was invisible in the universal inbox the agents actually read.
// This module closes that: tenant resolution by the CALLED number (the same
// vapi_phone_numbers registry the voice lane uses), per-tenant signature
// tokens (subaccounts sign with their OWN token), the messages-row writer the
// inbox renders, and consent-provenance contact capture for unknown senders
// (texting the office line IS consent for the thread — the inbound-call rule).

export interface TenantNumberContext {
  brokerageId: string
  agentUserId: string | null
  authToken: string
}

/** Resolve which tenant owns one of OUR numbers (digits-matched). */
export async function resolveTenantByOwnNumber(svc: any, phone: string | null | undefined): Promise<TenantNumberContext | null> {
  const digits = (phone ?? "").replace(/\D/g, "")
  if (!digits) return null
  const { data: num } = await svc.from("vapi_phone_numbers")
    .select("brokerage_id, agent_user_id")
    .eq("phone_digits", digits).eq("is_active", true).maybeSingle()
  if (!num) return null
  const { resolveTenantTwilioCreds } = await import("@/lib/voice/twilio-tenancy")
  const creds = await resolveTenantTwilioCreds(svc, (num as any).brokerage_id)
  if (!creds) return null
  return { brokerageId: (num as any).brokerage_id, agentUserId: (num as any).agent_user_id ?? null, authToken: creds.authToken }
}

/** Candidate Twilio signature tokens for a webhook: the owning tenant's token
 *  (subaccount/BYO) first, the master env token last. */
export async function twilioTokenCandidates(svc: any, params: Record<string, string>): Promise<string[]> {
  const to = (params.To ?? "").replace(/^whatsapp:/, "")
  const tokens: string[] = []
  const tenant = await resolveTenantByOwnNumber(svc, to)
  if (tenant?.authToken) tokens.push(tenant.authToken)
  if (process.env.TWILIO_AUTH_TOKEN) tokens.push(process.env.TWILIO_AUTH_TOKEN)
  return tokens
}

/**
 * Land an inbound text in the unified inbox: the `messages` row the universal
 * inbox reads (type = the surface; status unread) + a heads-up to the owning
 * agent. Idempotent by MessageSid (a Twilio retry never double-inserts).
 */
export async function recordInboundMessage(svc: any, input: {
  brokerageId: string
  contactId: string
  agentUserId: string | null
  channel: "sms" | "whatsapp"
  body: string
  messageSid: string | null
  fromPhone: string | null
  toPhone: string | null
}): Promise<{ recorded: boolean }> {
  if (input.messageSid) {
    const { data: dup } = await svc.from("messages").select("id")
      .eq("contact_id", input.contactId)
      .contains("metadata", { message_sid: input.messageSid })
      .maybeSingle()
    if (dup) return { recorded: false }
  }

  let agentRowId: string | null = null
  if (input.agentUserId) {
    const { data: agent } = await svc.from("agents").select("id").eq("user_id", input.agentUserId).maybeSingle()
    agentRowId = (agent as any)?.id ?? null
  }

  // messages.conversation_id is NOT NULL — resolve the thread first (keep-one).
  const { ensureConversationForContact, touchConversation } = await import("@/lib/kernel/conversation-thread")
  const conversationId = await ensureConversationForContact(svc, {
    contactId: input.contactId, brokerageId: input.brokerageId, agentId: agentRowId,
  })
  if (!conversationId) return { recorded: false }

  const { error } = await svc.from("messages").insert({
    conversation_id: conversationId,
    brokerage_id: input.brokerageId,
    contact_id: input.contactId,
    agent_id: agentRowId,
    type: "sms", // the inbox's channel key; the surface (sms vs whatsapp) rides metadata
    direction: "inbound",
    body: input.body.slice(0, 4000),
    status: "unread",
    metadata: { surface: input.channel, message_sid: input.messageSid, from: input.fromPhone, to: input.toPhone },
  })
  if (error) {
    console.error("[sms-inbound] messages insert failed:", error.message)
    return { recorded: false }
  }
  await touchConversation(svc, conversationId, { inbound: true })

  if (input.agentUserId) {
    await svc.from("notifications").insert({
      user_id: input.agentUserId,
      brokerage_id: input.brokerageId,
      type: "inbound_text_received",
      title: input.channel === "whatsapp" ? "New WhatsApp message" : "New text message",
      body: `"${input.body.slice(0, 140)}" — reply from the inbox.`,
      entity_type: "contact",
      entity_id: input.contactId,
      priority: "high",
      channel: "in_app",
      is_read: false,
    }).then(undefined, () => {})
  }
  return { recorded: true }
}

/**
 * Unknown sender texting OUR line → a consented contact assigned to the
 * number's agent (texting in IS consent for the thread — same provenance rule
 * as the inbound-call lane). Returns the contact id, or null when capture is
 * impossible (no agent scope at all).
 */
export async function captureTextingContact(svc: any, ctx: TenantNumberContext, fromPhone: string, channel: "sms" | "whatsapp"): Promise<string | null> {
  try {
    const digits = fromPhone.replace(/\D/g, "")
    const { captureContact } = await import("@/lib/contact-pipeline/contact-capture")
    const r = await captureContact({
      brokerageId: ctx.brokerageId,
      agentUserId: ctx.agentUserId,
      source: "inbound_sms",
      first_name: channel === "whatsapp" ? "WhatsApp" : "Texter",
      last_name: digits.slice(-4),
      phone: fromPhone,
      tcpa_consent: true,
      tcpa_consent_date: new Date().toISOString(),
      tcpa_consent_source: "inbound_sms",
      tcpa_consent_text: "Texted the office line first — express consent to reply in-thread.",
    })
    return r.contactId ?? null
  } catch {
    return null
  }
}
