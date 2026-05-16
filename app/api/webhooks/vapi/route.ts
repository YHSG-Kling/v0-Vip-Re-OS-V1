import { NextRequest, NextResponse } from "next/server"
import { updateVapiCallStatus } from "@/app/actions/voice-call-bridge"
import { handleVapiCallComplete } from "@/app/actions/ai-isa"
import { isCapabilityEnabled } from "@/app/actions/ai-isa-settings"
import type { IsaCapability } from "@/lib/ai-isa/settings-types"

/**
 * Vapi Webhook Handler
 * Receives call status updates and transcripts from Vapi.ai
 * Handles both voice-call-bridge and AI ISA calls
 */

/**
 * Capability gate — every ISA function tool handler runs through this. If
 * the brokerage hasn't approved this capability in Settings, we refuse the
 * function call and instruct the AI to apologize and offer a fallback.
 */
async function gateByCapability(
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

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json()

    // Vapi webhook events: call.started, call.ended, call.transcribed, function-call, end-of-call-report
    const { type, call, functionCall } = payload

    // Handle function calls from Vapi (AI ISA booking appointments, etc.)
    if (type === "function-call" && functionCall) {
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
    }

    // Handle end-of-call report (AI ISA)
    if (type === "end-of-call-report") {
      await handleVapiCallComplete(payload)
      return NextResponse.json({ success: true })
    }

    // Handle regular call status updates
    if (!call || !call.id) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 })
    }

    // Update call status in database (voice-call-bridge)
    await updateVapiCallStatus({
      callId: call.id,
      status: call.status || type.replace("call.", ""),
      transcript: call.transcript,
      outcome: call.metadata?.outcome,
      sentiment: call.analysis?.sentiment,
      durationSeconds: call.duration,
      costCents: call.cost ? Math.round(call.cost * 100) : undefined,
    })

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error("[Vapi Webhook] Error:", error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}

// Helper: Book appointment from AI ISA
async function handleBookAppointment(params: any) {
  const { createClient } = await import("@/lib/supabase/server")
  const supabase = await createClient()

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
async function handleTransferToAgent(params: {
  contact_id?: string
  brokerage_id?: string
  call_id?: string
  reason?: string
}) {
  const { createClient } = await import("@/lib/supabase/server")
  const supabase = await createClient()

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
async function handleRequestShowingInHouseListing(params: {
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

  const { createClient } = await import("@/lib/supabase/server")
  const supabase = await createClient()

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
    .select("user_id, first_name")
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
    message: `Perfect — you're set for ${new Date(requestedAt).toLocaleString()} at ${listing.address ?? "the property"}. ${agentRow?.first_name ?? "The listing agent"} will text you a confirmation shortly.`,
  })
}

// Helper: Send properties via SMS
async function handleSendPropertiesSMS(params: any) {
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
