/**
 * lib/voice/vapi-function-tools.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The ONE home for Vapi in-call function tools (book_appointment,
 * transfer_to_agent, send_properties_sms, request_showing_in_house_listing),
 * shared by BOTH webhook endpoints during the consolidation window:
 *
 *   - /api/voice/vapi-webhook  — the authoritative endpoint the dashboard
 *     serverUrl is migrating to
 *   - /api/webhooks/vapi       — remains a thin, signature-compatible endpoint
 *     until already-registered dashboard URLs are migrated
 *
 * Do NOT re-implement these handlers inside a route file — import from here.
 */
import { NextResponse } from "next/server"
import { createHmac, timingSafeEqual } from "crypto"
import { isCapabilityEnabled } from "@/app/actions/ai-isa-settings"
import type { IsaCapability } from "@/lib/ai-isa/settings-types"

/**
 * Signature: Vapi signs each request with HMAC-SHA256 of the raw body using
 * the secret set in the Vapi dashboard. The signature is sent as
 * `x-vapi-signature` (hex digest). If VAPI_WEBHOOK_SECRET is not set, the
 * endpoint REJECTS all requests — without this gate any caller could trigger
 * appointment booking, SMS to arbitrary phone numbers, and fake ISA call
 * completions (which mark contacts as qualified and trigger follow-ups).
 */
export function verifyVapiSignature(rawBody: string, signatureHeader: string | null): boolean {
  const secret = process.env.VAPI_WEBHOOK_SECRET
  if (!secret) {
    console.warn("[vapi-webhook] VAPI_WEBHOOK_SECRET not set — rejecting request")
    return false
  }
  if (!signatureHeader) return false

  const computed = createHmac("sha256", secret).update(rawBody, "utf-8").digest("hex")
  try {
    const a = Buffer.from(computed, "hex")
    const b = Buffer.from(signatureHeader, "hex")
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/**
 * Capability gate — every ISA function tool handler runs through this. If
 * the brokerage hasn't approved this capability in Settings, we refuse the
 * function call and instruct the AI to apologize and offer a fallback.
 */
export async function gateByCapability(
  brokerageId: string | null | undefined,
  capability: IsaCapability,
  fallbackMessage: string
): Promise<NextResponse | null> {
  if (!brokerageId) return null // Will be caught by the handler's own brokerage resolution
  const allowed = await isCapabilityEnabled(brokerageId, capability)
  if (allowed) return null
  return NextResponse.json({
    result: "capability_disabled",
    message: fallbackMessage,
  })
}

/**
 * Dispatcher for Vapi in-call function tools. Reproduces the routing that
 * previously lived inline in app/api/webhooks/vapi/route.ts — the same
 * capability keys and fallback messages, in the same order.
 *
 * `call` is optional: when provided (the webhook payload's `call` object),
 * its `metadata.brokerage_id` is used as the brokerage fallback, exactly as
 * the original inline routing did.
 *
 * Returns null for unknown function names.
 */
export async function dispatchVapiFunctionCall(
  functionCall: { name?: string; parameters?: any },
  call?: { metadata?: Record<string, any> | null } | null
): Promise<NextResponse | null> {
  const fnParams = (functionCall.parameters ?? {}) as { brokerage_id?: string }
  const callBrokerageId = fnParams.brokerage_id ?? call?.metadata?.brokerage_id

  if (functionCall.name === "book_appointment") {
    const gated = await gateByCapability(
      callBrokerageId,
      "book_appointment",
      "I'd love to schedule that for you, but agent appointments need to be booked directly. Let me have someone reach out shortly."
    )
    if (gated) return gated
    return await handleBookAppointment(functionCall.parameters)
  }
  if (functionCall.name === "transfer_to_agent") {
    const gated = await gateByCapability(
      callBrokerageId,
      "transfer_to_agent",
      "Let me take a quick message — I'll have someone call you right back."
    )
    if (gated) return gated
    return await handleTransferToAgent(functionCall.parameters)
  }
  if (functionCall.name === "send_properties_sms") {
    const gated = await gateByCapability(
      callBrokerageId,
      "send_property_listings",
      "I can have your agent put together a list and send it over — what's the best email for you?"
    )
    if (gated) return gated
    return await handleSendPropertiesSMS(functionCall.parameters)
  }
  if (functionCall.name === "request_showing_in_house_listing") {
    const gated = await gateByCapability(
      callBrokerageId,
      "request_showing_in_house_listing",
      "Great — I'll have our agent reach out directly to set up that showing."
    )
    if (gated) return gated
    return await handleRequestShowingInHouseListing(functionCall.parameters)
  }

  return null
}

// Helper: Book appointment from AI ISA
export async function handleBookAppointment(params: any) {
  // Service client — webhook has no user session; RLS would block writes.
  const { createServiceClient } = await import("@/lib/supabase/service")
  const supabase = createServiceClient()

  const { data: showing } = await supabase
    .from("showings")
    .insert({
      contact_id: params.contact_id,
      agent_id: params.agent_id,
      scheduled_at: params.date_time,
      duration_minutes: 30,
      status: "scheduled",
      notes: "Booked by AI ISA",
    })
    .select()
    .single()

  return NextResponse.json({
    success: true,
    message: `Great! I've got you scheduled for ${new Date(params.date_time).toLocaleString()}. You'll get a text confirmation.`,
    showing_id: showing?.id,
  })
}

// Helper: Transfer to agent
//
// Resolves the destination phone number using a priority chain:
//   1. The contact's assigned agent (if params.contact_id is given)
//   2. The brokerage's duty agent — Admin user → solo agent → first active agent
//   3. The brokerage's main phone (last resort)
//
// VAPI expects the response shape `{ result: "transfer", destination: { ... } }`
// for the transfer to actually fire on the carrier side. Returning a plain
// `{ success, message }` does NOT transfer the call — that bug is fixed here.
export async function handleTransferToAgent(params: {
  contact_id?: string
  brokerage_id?: string
  call_id?: string
  reason?: string
}) {
  // Service client — webhook has no user session; RLS would block writes.
  const { createServiceClient } = await import("@/lib/supabase/service")
  const supabase = createServiceClient()

  let brokerageId: string | null = params.brokerage_id ?? null
  let assignedAgentId: string | null = null

  // Resolve brokerage and assigned agent from contact (if known caller)
  if (params.contact_id) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("brokerage_id, agent_id")
      .eq("id", params.contact_id)
      .maybeSingle()
    if (contact) {
      brokerageId = brokerageId ?? contact.brokerage_id
      assignedAgentId = contact.agent_id ?? null
    }
  }

  // Fall back: resolve brokerage from the call record
  if (!brokerageId && params.call_id) {
    const { data: callRow } = await supabase
      .from("ai_isa_calls")
      .select("brokerage_id")
      .eq("id", params.call_id)
      .maybeSingle()
    brokerageId = callRow?.brokerage_id ?? null
  }

  if (!brokerageId) {
    return NextResponse.json({
      result: "transfer_failed",
      message: "I'm sorry, I couldn't reach a live agent right now. Can I take your number and have someone call you back within the hour?",
    })
  }

  // Resolve destination phone — priority chain
  let destinationNumber: string | null = null
  let destinationLabel = "your agent"

  // Tier 1: Contact's assigned agent
  if (assignedAgentId) {
    const { data: agent } = await supabase
      .from("agents")
      .select("phone_mobile, phone_office, user_id")
      .eq("id", assignedAgentId)
      .maybeSingle()
    destinationNumber = agent?.phone_mobile ?? agent?.phone_office ?? null
  }

  // Tier 2: Duty agent — brokerage Admin user
  if (!destinationNumber) {
    const { data: adminUser } = await supabase
      .from("users")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("role", "Admin")
      .limit(1)
      .maybeSingle()

    if (adminUser?.id) {
      const { data: adminAgent } = await supabase
        .from("agents")
        .select("phone_mobile, phone_office")
        .eq("user_id", adminUser.id)
        .maybeSingle()
      destinationNumber = adminAgent?.phone_mobile ?? adminAgent?.phone_office ?? null
      destinationLabel = "the brokerage admin"
    }
  }

  // Tier 3: First active agent in brokerage (solo / fallback)
  if (!destinationNumber) {
    const { data: anyAgent } = await supabase
      .from("agents")
      .select("phone_mobile, phone_office")
      .eq("brokerage_id", brokerageId)
      .limit(1)
      .maybeSingle()
    destinationNumber = anyAgent?.phone_mobile ?? anyAgent?.phone_office ?? null
  }

  // Tier 4: Brokerage main phone
  if (!destinationNumber) {
    const { data: brokerage } = await supabase
      .from("brokerages")
      .select("phone")
      .eq("id", brokerageId)
      .maybeSingle()
    destinationNumber = brokerage?.phone ?? null
    destinationLabel = "our office"
  }

  if (!destinationNumber) {
    return NextResponse.json({
      result: "transfer_failed",
      message: "Let me take a quick message — what's the best number to reach you, and I'll have someone call you back within the hour.",
    })
  }

  // Log the transfer for compliance audit
  await supabase.from("inbound_call_classifications").insert({
    call_log_id: params.call_id ?? null,
    brokerage_id: brokerageId,
    classification: assignedAgentId ? "existing_contact" : "unknown",
    resulting_contact_id: params.contact_id ?? null,
    ai_handled: false,
    transfer_reason: params.reason ?? "agent_requested",
    classified_at: new Date().toISOString(),
  })

  // VAPI transfer destination format
  return NextResponse.json({
    result: "transfer",
    destination: {
      type: "number",
      number: destinationNumber,
      message: `Connecting you to ${destinationLabel} now. One moment.`,
    },
  })
}

// Helper: Request showing on an in-house listing for an unrepresented buyer.
//
// Narrow scope by design — only valid when:
//   1. The listing belongs to the SAME brokerage taking the call (in-house)
//   2. The caller (or their existing contact) has NO assigned agent
//      (i.e., they don't have representation yet)
//
// If either condition fails the AI gracefully declines and falls back to
// "let me have an agent reach out to coordinate".
export async function handleRequestShowingInHouseListing(params: {
  listing_id?: string
  contact_id?: string
  brokerage_id?: string
  requested_date_time?: string
  caller_name?: string
}) {
  if (!params.listing_id || !params.brokerage_id) {
    return NextResponse.json({
      result: "error",
      message: "I'd love to help — let me have an agent reach out to coordinate the showing details.",
    })
  }

  // Service client — webhook has no user session; RLS would block writes.
  const { createServiceClient } = await import("@/lib/supabase/service")
  const supabase = createServiceClient()

  // 1. Verify in-house listing
  const { data: listing } = await supabase
    .from("listings")
    .select("id, agent_id, brokerage_id, status, address")
    .eq("id", params.listing_id)
    .maybeSingle()

  if (!listing || listing.brokerage_id !== params.brokerage_id) {
    return NextResponse.json({
      result: "decline",
      message: "That property is listed by another brokerage. I'll have one of our agents reach out — they can coordinate with the listing agent for you.",
    })
  }
  if (listing.status !== "active") {
    return NextResponse.json({
      result: "decline",
      message: "That listing isn't currently available for showings. Want me to find similar active properties?",
    })
  }

  // 2. Verify unrepresented buyer (no contact yet, or contact has no agent_id)
  let contactId = params.contact_id ?? null
  if (contactId) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("id, agent_id")
      .eq("id", contactId)
      .maybeSingle()

    if (contact?.agent_id && contact.agent_id !== listing.agent_id) {
      return NextResponse.json({
        result: "decline",
        message: "It looks like you're already working with another agent — they can set up the showing for you. Want me to leave a message for them?",
      })
    }
  }

  // 3. Book the showing tied to the listing's agent
  const requestedAt = params.requested_date_time ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  const { data: showing, error } = await supabase
    .from("showings")
    .insert({
      listing_id: listing.id,
      contact_id: contactId,
      agent_id: listing.agent_id,
      brokerage_id: listing.brokerage_id,
      scheduled_at: requestedAt,
      duration_minutes: 30,
      status: "requested",
      notes: `Booked by AI ISA for unrepresented caller${params.caller_name ? ` (${params.caller_name})` : ""}. Scope: in-house listing.`,
    })
    .select("id")
    .single()

  if (error || !showing) {
    return NextResponse.json({
      result: "error",
      message: "I couldn't get that booked just yet — let me have the listing agent reach out to confirm the time directly.",
    })
  }

  // 4. Notify the listing agent
  const { data: agentRow } = await supabase
    .from("agents")
    .select("user_id, users(first_name, last_name, email, phone)")
    .eq("id", listing.agent_id)
    .maybeSingle()

  if (agentRow?.user_id) {
    await supabase.from("notifications").insert({
      user_id: agentRow.user_id,
      brokerage_id: listing.brokerage_id,
      type: "showing_requested_isa",
      title: `New showing request: ${listing.address ?? "your listing"}`,
      body: `AI ISA booked a showing for ${requestedAt} (caller: ${params.caller_name ?? "unrepresented buyer"}).`,
      entity_type: "listing",
      entity_id: listing.id,
      priority: "high",
      is_read: false,
      created_at: new Date().toISOString(),
    })
  }

  return NextResponse.json({
    result: "showing_booked",
    showing_id: showing.id,
    message: `Perfect — you're set for ${new Date(requestedAt).toLocaleString()} at ${listing.address ?? "the property"}. ${(agentRow?.users as any)?.first_name ?? "The listing agent"} will text you a confirmation shortly.`,
  })
}

// Helper: Send properties via SMS
export async function handleSendPropertiesSMS(params: any) {
  const { sendTwilioSMS } = await import("@/app/actions/external-services")

  await sendTwilioSMS({
    to: params.contact_phone,
    message: `Here are some properties that match what you're looking for: ${params.properties_url}`,
    contactId: params.contact_id,
  })

  return NextResponse.json({
    success: true,
    message: "Perfect! I just texted you some great options to check out.",
  })
}
