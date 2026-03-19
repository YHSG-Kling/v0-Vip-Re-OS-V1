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
async function handleTransferToAgent(params: any) {
  // This would trigger a call transfer in Twilio
  return NextResponse.json({
    success: true,
    message: "Let me connect you with your agent right now. Hold for just a moment.",
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
