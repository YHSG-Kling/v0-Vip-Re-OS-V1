"use server"

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"
import { placeCall } from "@/lib/providers/messaging"

/**
 * Call Whisper Bridge & Vapi Voice Bot System
 * - Initiates agent calls with AI-powered context whispers
 * - Triggers autonomous AI voice outreach to hot leads
 */

// Initiate whisper bridge: Calls agent first, whispers context, then connects to contact
export async function initiateWhisperBridge(params: {
  contactId: string
  agentId: string
  context: string // e.g., "viewing 123 Main St 3 times this week"
}) {
  const { contactId, agentId, context } = params

  if (!isValidUUID(contactId) || !isValidUUID(agentId)) {
    return { success: false, error: "Invalid contact or agent ID" }
  }

  const supabase = await createClient()

  try {
    // Get contact and agent details
    const { data: contact } = await supabase
      .from("contacts")
      .select("first_name, last_name, phone, stage, last_property_viewed")
      .eq("id", contactId)
      .single()

    const { data: agent } = await supabase
      .from("profiles")
      .select("phone, first_name, last_name")
      .eq("id", agentId)
      .single()

    if (!contact || !agent) {
      return { success: false, error: "Contact or agent not found" }
    }

    if (!contact.phone || !agent.phone) {
      return { success: false, error: "Missing phone number for contact or agent" }
    }

    // Generate intelligent whisper text
    const whisperText = `This is ${contact.first_name} ${contact.last_name}, ${context}. Connecting now.`

    const appUrl = process.env.NEXT_PUBLIC_APP_URL

    if (!appUrl) {
      return {
        success: false,
        error: "NEXT_PUBLIC_APP_URL is not configured.",
      }
    }

    // Initiate whisper bridge call via messaging provider
    const callResult = await placeCall({
      to: agent.phone,
      twimlUrl: `${appUrl}/api/twiml/whisper-bridge?contactPhone=${encodeURIComponent(contact.phone)}&whisper=${encodeURIComponent(whisperText)}`,
    })

    if (!callResult.success) {
      return { success: false, error: callResult.error }
    }

    // Log whisper bridge call
    const { error: logError } = await supabase.from("call_whisper_logs").insert({
      contact_id: contactId,
      agent_id: agentId,
      whisper_text: whisperText,
      twilio_call_sid: callResult.callSid,
      agent_phone: agent.phone,
      contact_phone: contact.phone,
    })

    if (logError) {
      console.error("[Whisper Bridge] Failed to log call:", logError)
    }

    // Create activity log
    await supabase.from("activities").insert({
      user_id: agentId,
      activity_type: "whisper_bridge_initiated",
      entity_type: "contact",
      entity_id: contactId,
      description: `Whisper bridge call initiated: ${context}`,
    })

    return {
      success: true,
      callSid: callResult.callSid,
      whisperText,
    }
  } catch (error: any) {
    console.error("[Whisper Bridge] Error:", error)
    return { success: false, error: error.message }
  }
}

// Update whisper bridge call status (webhook handler)
export async function updateWhisperBridgeStatus(params: {
  callSid: string
  status: string
  duration?: number
  outcome?: string
}) {
  const supabase = await createClient()

  try {
    const { error } = await supabase
      .from("call_whisper_logs")
      .update({
        call_connected: params.status === "completed",
        call_duration_seconds: params.duration,
        outcome: params.outcome || params.status,
        updated_at: new Date().toISOString(),
      })
      .eq("twilio_call_sid", params.callSid)

    if (error) {
      console.error("[Whisper Bridge] Failed to update status:", error)
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (error: any) {
    console.error("[Whisper Bridge] Update error:", error)
    return { success: false, error: error.message }
  }
}

// Trigger Vapi AI voice bot for hot leads
export async function triggerVapiVoiceBot(params: {
  contactId: string
  triggerEvent: string // behavioral_spike, hot_lead_score, showing_reminder, price_reduction_alert
  customMessage?: string
}) {
  const { contactId, triggerEvent, customMessage } = params

  if (!isValidUUID(contactId)) {
    return { success: false, error: "Invalid contact ID" }
  }

  const supabase = await createClient()

  try {
    // Get contact details
    const { data: contact } = await supabase
      .from("contacts")
      .select("first_name, last_name, phone, last_property_viewed, preferred_price_max, stage")
      .eq("id", contactId)
      .single()

    if (!contact) {
      return { success: false, error: "Contact not found" }
    }

    if (!contact.phone) {
      return { success: false, error: "Contact phone number not found" }
    }

    const vapiApiKey = process.env.VAPI_API_KEY
    const vapiAssistantId = process.env.VAPI_ASSISTANT_ID

    if (!vapiApiKey || !vapiAssistantId) {
      return {
        success: false,
        error: "Vapi not configured. Add VAPI_API_KEY and VAPI_ASSISTANT_ID to environment variables.",
      }
    }

    // Generate context-aware first message
    let firstMessage = customMessage
    if (!firstMessage) {
      switch (triggerEvent) {
        case "behavioral_spike":
          firstMessage = `Hi ${contact.first_name}, I noticed you've been looking closely at properties in your area. I'm the AI assistant for your agent. Would you like to schedule a showing this weekend?`
          break
        case "hot_lead_score":
          firstMessage = `Hi ${contact.first_name}, your agent wanted me to reach out. I see you're actively searching. Can I help schedule some showings for you?`
          break
        case "showing_reminder":
          firstMessage = `Hi ${contact.first_name}, just calling to confirm your showing tomorrow. Are we still good for the scheduled time?`
          break
        case "price_reduction_alert":
          firstMessage = `Hi ${contact.first_name}, great news! A property you viewed just had a price reduction. Want to schedule another look?`
          break
        default:
          firstMessage = `Hi ${contact.first_name}, I'm the AI assistant for your real estate agent. How can I help you today?`
      }
    }

    // Call Vapi.ai API
    const response = await fetch("https://api.vapi.ai/call/phone", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${vapiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        phoneNumber: contact.phone,
        assistantId: vapiAssistantId,
        customer: {
          name: `${contact.first_name} ${contact.last_name}`,
        },
        assistantOverrides: {
          firstMessage,
        },
      }),
    })

    const callData = await response.json()

    if (!response.ok) {
      throw new Error(callData.message || "Vapi API error")
    }

    // Log Vapi call
    const { error: logError } = await supabase.from("vapi_voice_calls").insert({
      contact_id: contactId,
      trigger_event: triggerEvent,
      vapi_call_id: callData.id,
      call_status: "initiated",
    })

    if (logError) {
      console.error("[Vapi Voice] Failed to log call:", logError)
    }

    // Create activity log
    await supabase.from("activities").insert({
      user_id: contactId,
      activity_type: "vapi_voice_initiated",
      entity_type: "contact",
      entity_id: contactId,
      description: `AI voice bot initiated: ${triggerEvent}`,
    })

    return {
      success: true,
      callId: callData.id,
      status: callData.status,
    }
  } catch (error: any) {
    console.error("[Vapi Voice] Error:", error)
    return { success: false, error: error.message }
  }
}

// Update Vapi call status (webhook handler)
export async function updateVapiCallStatus(params: {
  callId: string
  status: string
  transcript?: string
  outcome?: string
  sentiment?: string
  durationSeconds?: number
  costCents?: number
}) {
  const supabase = await createClient()

  try {
    const { error } = await supabase
      .from("vapi_voice_calls")
      .update({
        call_status: params.status,
        conversation_transcript: params.transcript,
        outcome: params.outcome,
        sentiment: params.sentiment,
        duration_seconds: params.durationSeconds,
        cost_cents: params.costCents,
        updated_at: new Date().toISOString(),
      })
      .eq("vapi_call_id", params.callId)

    if (error) {
      console.error("[Vapi Voice] Failed to update status:", error)
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (error: any) {
    console.error("[Vapi Voice] Update error:", error)
    return { success: false, error: error.message }
  }
}

// Get whisper bridge call history
export async function getWhisperBridgeCalls(agentId: string) {
  if (!isValidUUID(agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    const { data, error } = await supabase
      .from("call_whisper_logs")
      .select("*, contacts(first_name, last_name, phone)")
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false })
      .limit(50)

    if (error) throw error

    return { success: true, calls: data }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

// Get Vapi voice call history
export async function getVapiVoiceCalls(contactId?: string) {
  const supabase = await createClient()

  try {
    let query = supabase
      .from("vapi_voice_calls")
      .select("*, contacts(first_name, last_name, phone)")
      .order("created_at", { ascending: false })

    if (contactId && isValidUUID(contactId)) {
      query = query.eq("contact_id", contactId)
    }

    const { data, error } = await query.limit(50)

    if (error) throw error

    return { success: true, calls: data }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}
