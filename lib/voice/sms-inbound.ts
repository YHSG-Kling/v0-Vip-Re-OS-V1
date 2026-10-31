// lib/voice/sms-inbound.ts
// ─────────────────────────────────────────────────────────────────────────────
// INBOUND SMS/WhatsApp → THE UNIFIED INBOX. The consolidation half of the
// owner's "conversational AI with Twilio for our unified inbox including
// social messaging surfaces": the EXISTING provider-inbound ingress
// (app/api/providers/inbound) already verified signatures, detected opt-outs,
// and handed off to the kernel — but it NEVER wrote a `messages` row, so an
// inbound text was invisible in the universal inbox the agents actually read.
// This module closes that: tenant resolution by the CALLED number (the same
// tenant_phone_numbers registry the voice lane uses), per-tenant signature
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
  const { data: num } = await svc.from("tenant_phone_numbers")
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
}, chainDeps: import("@/lib/communications/inbound-record").InboundProcessDeps = {}): Promise<{ recorded: boolean; messageId?: string; conversationId?: string; agentUserId?: string | null; chain?: import("@/lib/communications/inbound-record").InboundProcessResult }> {
  // A row written BEFORE wave 146 carries only metadata.message_sid (no provider / provider_ref) — the C1 record's own
  // dedup cannot see it, so this legacy check stays in front of it (read errors are read: a refused check is not "new").
  if (input.messageSid) {
    const { data: dup, error: dupErr } = await svc.from("messages").select("id, metadata")
      .eq("contact_id", input.contactId).eq("brokerage_id", input.brokerageId)
      .contains("metadata", { message_sid: input.messageSid })
      .limit(1).maybeSingle()
    if (dupErr) console.warn("[sms-inbound] legacy MessageSid check refused — the C1 record's (provider, provider_ref) dedup still holds:", dupErr.message)
    // Wave 147: only a PRE-146 row (no provider_ref) stops here. A C1 row goes on into the chain, which reports the retry as a
    // duplicate itself — and is the only place that can re-drive a decision the first delivery never finished (C14).
    else if (dup && !((dup as { metadata?: Record<string, unknown> | null }).metadata ?? {}).provider_ref) return { recorded: false }
  }

  let agentRowId: string | null = null
  if (input.agentUserId) {
    const { data: agent } = await svc.from("agents").select("id").eq("user_id", input.agentUserId).eq("brokerage_id", input.brokerageId).maybeSingle()
    agentRowId = (agent as any)?.id ?? null
  }

  // TOMBSTONE (orphan doctrine §1.1, wave 146 lane 146Z on lane 146B's Outside-lane 1) — REMOVED: this recorder's own
  // `messages` insert (+ its thread resolution and conversation touch). It was a SECOND recorder on the same key as the ONE
  // canonical inbound record, so a Twilio text could be written twice under two spellings. The insert now rides contract C1 —
  // lib/communications/inbound-record.ts:177 recordInboundCommunication (tenant-pinned contact, the one thread resolver,
  // idempotent on (provider 'twilio', provider_ref = MessageSid) backed by m876's unique index, and it still writes
  // metadata.message_sid for back-compat). The SMS-only side effects below (the agent's bell, the draft owner) stay here.
  // WAVE 147 (lane 147G, owner ruling 12 — "sms needs to reach the arbiter's responder"; contract C13): the text rides the
  // WHOLE C1 chain, not just the record — processInboundCommunication = the record (recordInboundCommunication, idempotent on
  // (twilio, MessageSid), m876) → the completion it owes (C14) → opt-out → the response-driven sequence stop → the kernel
  // event → intent (classifyIntent) → the owed promise → the arbiter's responder (lib/communications/inbound-responder.ts —
  // an authorized reply through dispatchSms, or a person with the draft) → the decision as completion evidence. A Twilio
  // retry is a duplicate: nothing runs twice (a stranded decision is re-driven once, at-most-once by the responder's ledger).
  const { processInboundCommunication } = await import("@/lib/communications/inbound-record")
  const chain = await processInboundCommunication({
    brokerageId: input.brokerageId,
    channel: input.channel,
    provider: "twilio",
    providerRef: input.messageSid,
    party: { kind: "contact", id: input.contactId },
    agentId: agentRowId,
    body: input.body,
    surface: input.channel,
    threadRef: { from: input.fromPhone, to: input.toPhone },
  }, { client: svc, ...chainDeps })
  const rec = chain.record
  if (!rec.recorded) {
    if (rec.error) console.error("[sms-inbound] the inbound record refused:", rec.error)
    return { recorded: false, chain }
  }
  const conversationId = rec.conversationId ?? undefined
  const inserted = { id: rec.recordId }

  // Resolve WHO the draft belongs to when the number has no agent scope —
  // the contact's assigned agent works the thread.
  let draftAgentUserId = input.agentUserId
  if (!draftAgentUserId) {
    const { data: contact } = await svc.from("contacts").select("agent_id").eq("id", input.contactId).maybeSingle()
    if ((contact as any)?.agent_id) {
      const { data: owner } = await svc.from("agents").select("user_id").eq("id", (contact as any).agent_id).maybeSingle()
      draftAgentUserId = (owner as any)?.user_id ?? null
    }
  }

  if (draftAgentUserId) {
    const { error: notifyError } = await svc.from("notifications").insert({
      user_id: draftAgentUserId,
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
    if (notifyError) console.warn("[sms-inbound.ts] notifications insert refused — the bell will not ring:", notifyError.message)
  }
  return { recorded: true, messageId: (inserted as any)?.id, conversationId, agentUserId: draftAgentUserId, chain }
}

// TOMBSTONE (orphan doctrine §1.3, wave 147 lane 147G) — MOVED: draftProactiveReply now lives at
// lib/communications/inbound-reply-executors.ts:22 (the arbiter's responder's default `replyCoach`). It used to fire the
// reply-coach generator on EVERY inbound text; the responder now DECIDES first and drafts only when a reply is the right
// answer and a person sends it — calling both would have written two drafts per text. Nothing auto-sends without the
// tenant's explicit autonomy grant (inboundReplyAutonomy there), so the build-1 rule "the agent accepts / edits / sends"
// still holds by default.

/**
 * Unknown sender texting OUR line → a consented contact assigned to the
 * number's agent (texting in IS consent for the thread — same provenance rule
 * as the inbound-call lane). Returns the contact id, or null when capture is
 * impossible (no agent scope at all).
 */
// TOMBSTONE (orphan doctrine §1.3) — this used to take a leading `svc: any` Supabase
// client and never read it. The client it needed already lives inside the survivor,
// lib/contact-pipeline/contact-capture.ts::captureContact, which opens its own and
// applies the tenant predicate there; passing a second one in only meant a caller
// could hand this function a client whose tenancy nobody here checked. The parameter
// is gone rather than wired: there is no second reader to build for it.
export async function captureTextingContact(ctx: TenantNumberContext, fromPhone: string, channel: "sms" | "whatsapp"): Promise<string | null> {
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
