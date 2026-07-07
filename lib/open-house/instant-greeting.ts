/**
 * Open House Instant Greeting — Concierge Mobile next-level surface.
 *
 * When an attendee checks in (via QR sign-in kiosk at
 * /open-house/[eventId]/signin), this fires within seconds to send a
 * personalized welcome message in the agent's voice. TCPA consent has
 * already been captured by the kiosk so the message is gated by the
 * canonical evaluateOutbound chain (brand voice, fair housing, them-first).
 *
 * Pattern matches the auto-isa / auto-touch flows: service-client write,
 * compliance-gated body, audit row inserted via the kernel notification
 * pipeline. Never throws — failure is logged and the check-in still
 * succeeds.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export interface InstantGreetingInput {
  attendeeId:      string
  contactId:       string
  eventId:         string
  brokerageId:     string
  agentId:         string
  firstName:       string
  phone?:          string | null
  email:           string
  listingAddress?: string | null
}

export interface InstantGreetingResult {
  success:    boolean
  messageId?: string
  channel?:   "sms" | "email"
  error?:     string
  blocked?:   boolean
  reason?:    string
}

export async function sendInstantOpenHouseGreeting(
  input: InstantGreetingInput,
): Promise<InstantGreetingResult> {
  const svc = createServiceClient()

  // Resolve agent name + brand voice context
  const { data: agentUser } = await svc
    .from("users")
    .select("first_name, last_name")
    .eq("id", input.agentId)
    .maybeSingle()

  const agentName = [agentUser?.first_name, agentUser?.last_name].filter(Boolean).join(" ") || "your agent"

  // Compose the greeting — short, them-first, no investment claims.
  // Address fall-back when listing.address isn't populated (rare; address is
  // typically present on listings table).
  const address = input.listingAddress || "the property"
  const body =
    `Hi ${input.firstName}, thanks for stopping by ${address} today! ` +
    `If you'd like the disclosure packet or want to see comparable homes in the area, ` +
    `just reply here and I'll send them over. — ${agentName}`

  // Apply the canonical compliance gate. SMS preferred (faster, higher
  // read-rate); email fallback when no phone OR when TCPA SMS consent is
  // not affirmative. Contact already has tcpa_consent=true from the kiosk;
  // evaluateOutbound double-checks via contacts row.
  const channel: "sms" | "email" = input.phone ? "sms" : "email"

  try {
    const { evaluateOutbound } = await import("@/lib/kernel/compliance")
    const result = await evaluateOutbound({
      actorContext: {
        userId:      input.agentId,
        brokerageId: input.brokerageId,
        role:        "agent",
      },
      journeyType: "buyer",
      persona:     "other",
      messageType: channel,
      content:     body,
      contact: {
        id:            input.contactId,
        first_name:    input.firstName,
        last_name:     "",
        email:         input.email,
        phone:         input.phone ?? null,
        contact_type:  "buyer",
        brokerage_id:  input.brokerageId,
        tcpa_consent:  true,            // just collected at kiosk
        dnc_status:    false,
        isa_reengage_allowed: false,
      } as never,
    })

    if (!result.allowed) {
      return {
        success: false,
        blocked: true,
        reason:  result.blockedReason ?? "Compliance gate blocked instant greeting",
      }
    }
  } catch (err) {
    return {
      success: false,
      error:   err instanceof Error ? err.message : "Compliance gate failed",
    }
  }

  // Resolve agents.id (FK on messages.agent_id)
  const { data: agentRow } = await svc
    .from("agents")
    .select("id")
    .eq("user_id", input.agentId)
    .eq("brokerage_id", input.brokerageId)
    .maybeSingle()
  const agentRowId = agentRow?.id ?? null

  const now = new Date().toISOString()

  // messages.conversation_id is NOT NULL (live schema) — without resolving the
  // thread first this insert ALWAYS failed and the greeting silently never
  // queued. The ONE canonical helper fixes it (same as every other writer).
  const { ensureConversationForContact } = await import("@/lib/kernel/conversation-thread")
  const conversationId = await ensureConversationForContact(svc, {
    contactId: input.contactId, brokerageId: input.brokerageId, agentId: agentRowId,
  })
  if (!conversationId) {
    return { success: false, error: "Could not resolve the conversation thread" }
  }

  // Insert into messages — the outbound dispatcher cron picks up direction=
  // outbound + status=queued rows and sends via Twilio (sms) or SendGrid
  // (email). Status starts queued so failures are retryable.
  const { data: msg, error } = await svc
    .from("messages")
    .insert({
      conversation_id: conversationId,
      brokerage_id: input.brokerageId,
      contact_id: input.contactId,
      agent_id:   agentRowId,
      type:       channel,
      direction:  "outbound",
      subject:    channel === "email" ? `Thanks for stopping by ${address}` : null,
      body,
      status:     "queued",
      created_at: now,
      updated_at: now,
    })
    .select("id")
    .maybeSingle()

  if (error || !msg) {
    return {
      success: false,
      error:   error?.message ?? "Failed to queue instant greeting",
    }
  }

  // Stamp the attendee row so the agent dashboard shows it fired
  await svc
    .from("open_house_attendees")
    .update({
      instant_greeting_sent_at: now,
      instant_greeting_channel: channel,
      instant_greeting_message_id: msg.id,
    })
    .eq("id", input.attendeeId)
    .then(() => null, () => null)

  return { success: true, messageId: msg.id, channel }
}
