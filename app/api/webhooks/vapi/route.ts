import { NextRequest, NextResponse } from "next/server"
import { updateVapiCallStatus } from "@/app/actions/voice-call-bridge"
import { handleVapiCallComplete } from "@/app/actions/ai-isa"

/**
 * Vapi Webhook Handler
 * Receives call status updates and transcripts from Vapi.ai
 * Handles both voice-call-bridge and AI ISA calls
 */

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json()

    // Vapi webhook events: call.started, call.ended, call.transcribed, function-call, end-of-call-report
    const { type, call, functionCall } = payload

    // Handle function calls from Vapi (AI ISA booking appointments, etc.)
    if (type === "function-call" && functionCall) {
      if (functionCall.name === "book_appointment") {
        return await handleBookAppointment(functionCall.parameters)
      }
      if (functionCall.name === "transfer_to_agent") {
        return await handleTransferToAgent(functionCall.parameters)
      }
      if (functionCall.name === "send_properties_sms") {
        return await handleSendPropertiesSMS(functionCall.parameters)
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
