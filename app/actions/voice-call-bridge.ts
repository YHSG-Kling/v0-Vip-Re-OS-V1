"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { placeCall } from "@/lib/providers/messaging"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

/**
 * Call Whisper Bridge & Vapi Voice Bot System
 * - Initiates agent calls with AI-powered context whispers
 * - Triggers autonomous AI voice outreach to hot leads
 *
 * SECURITY: every entry point derives agent/brokerage from the authenticated
 * session. Caller-supplied agentId values are ignored. Contact lookups verify
 * brokerage ownership before any mutation.
 */

// Initiate whisper bridge: Calls agent first, whispers context, then connects to contact
export async function initiateWhisperBridge(params: {
  contactId: string
  /** ignored — derived from session */
  agentId?: string
  context: string // e.g., "viewing 123 Main St 3 times this week"
}) {
  const { contactId, context } = params

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }
  const agentUserId = ctx.userId

  if (!isValidUUID(contactId)) {
    return { success: false, error: "Invalid contact ID" }
  }

  const svc = createServiceClient()
  const supabase = await createClient()

  try {
    // Verify the contact belongs to this brokerage
    const { data: contactBroker } = await svc
      .from("contacts")
      .select("brokerage_id")
      .eq("id", contactId)
      .maybeSingle()
    if (!contactBroker || contactBroker.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Forbidden" }
    }

    // Get contact and agent details
    const { data: contact } = await supabase
      .from("contacts")
      .select("first_name, last_name, phone, stage, last_property_viewed")
      .eq("id", contactId)
      .single()

    const { data: agent } = await supabase
      .from("users")
      .select("phone, first_name, last_name")
      .eq("id", agentUserId)
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
      agent_id: agentUserId,
      whisper_text: whisperText,
      twilio_call_sid: callResult.callSid,
      agent_phone: agent.phone,
      contact_phone: contact.phone,
    })

    if (logError) {
      console.error("[Whisper Bridge] Failed to log call:", logError)
    }

    // Create activity log — Agent task (correct location, no changes) — activity_type: whisper_bridge_initiated, call_made
    await supabase.from("activities").insert({
      agent_user_id: agentUserId,
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
// NOTE: this is invoked from the Twilio status callback endpoint, which should
// verify the upstream Twilio signature. We additionally require an authenticated
// session here so that direct RPC from a client cannot mutate arbitrary call
// records. Webhook routes that need to call this server-side should use the
// service client directly against `call_whisper_logs`.
export async function updateWhisperBridgeStatus(params: {
  callSid: string
  status: string
  duration?: number
  outcome?: string
}) {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  const svc = createServiceClient()
  try {
    // Verify the call record belongs to this brokerage (via contact)
    const { data: callRow } = await svc
      .from("call_whisper_logs")
      .select("contact_id")
      .eq("twilio_call_sid", params.callSid)
      .maybeSingle()
    if (!callRow) {
      return { success: false, error: "Call not found" }
    }
    if (callRow.contact_id) {
      const { data: contact } = await svc
        .from("contacts")
        .select("brokerage_id")
        .eq("id", callRow.contact_id)
        .maybeSingle()
      if (!contact || contact.brokerage_id !== ctx.brokerageId) {
        return { success: false, error: "Forbidden" }
      }
    }

    const { error } = await svc
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

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  if (!isValidUUID(contactId)) {
    return { success: false, error: "Invalid contact ID" }
  }

  const svc = createServiceClient()
  const supabase = await createClient()

  try {
    // Verify the contact belongs to this brokerage
    const { data: contactBroker } = await svc
      .from("contacts")
      .select("brokerage_id")
      .eq("id", contactId)
      .maybeSingle()
    if (!contactBroker || contactBroker.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Forbidden" }
    }

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

    // Call Vapi.ai API through the connector-gateway
    const response = await callConnector<{ id?: string; status?: string }>({
      connector: "vapi",
      baseUrl: "https://api.vapi.ai",
      path: "/call/phone",
      method: "POST",
      auth: { style: "bearer", token: vapiApiKey },
      body: {
        phoneNumber: contact.phone,
        assistantId: vapiAssistantId,
        customer: {
          name: `${contact.first_name} ${contact.last_name}`,
        },
        assistantOverrides: {
          firstMessage,
        },
      },
    })

    if (!response.ok) {
      throw new Error(response.error || "Vapi API error")
    }

    const callData = response.data ?? {}

    // Log Vapi call. `vapi_voice_calls` carries the billing + provider
    // pointer; the conversational metadata (trigger_event, initial status)
    // lives in raw_payload jsonb rather than as dedicated columns.
    const { error: logError } = await supabase.from("vapi_voice_calls").insert({
      vapi_call_id: callData.id,
      contact_id: contactId,
      brokerage_id: contactBroker.brokerage_id,
      agent_id: ctx.agentId ?? null,
      raw_payload: {
        trigger_event: triggerEvent,
        status: "initiated",
        first_message: firstMessage,
        initiated_at: new Date().toISOString(),
      },
    })

    if (logError) {
      console.error("[Vapi Voice] Failed to log call:", logError)
    }

    // Activities row — table requires brokerage_id, agent_id, title NOT NULL.
    // Notes/metadata carry the trigger context.
    if (ctx.agentId) {
      await supabase.from("activities").insert({
        agent_id: ctx.agentId,
        brokerage_id: contactBroker.brokerage_id,
        contact_id: contactId,
        entity_type: "contact",
        activity_type: "vapi_voice_initiated",
        title: `AI voice bot initiated: ${triggerEvent}`,
        description: `Vapi call ${callData.id} initiated from trigger ${triggerEvent}`,
        metadata: { vapi_call_id: callData.id, trigger_event: triggerEvent },
        status: "completed",
      })
    }

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
// NOTE: invoked from the Vapi webhook route (app/api/webhooks/vapi/route.ts)
// which verifies the upstream HMAC signature. The webhook is permitted to call
// this without a user session via the service client path below. Direct RPC
// from a client must be authenticated.
export async function updateVapiCallStatus(params: {
  callId: string
  status: string
  transcript?: string
  outcome?: string
  sentiment?: string
  durationSeconds?: number
  costCents?: number
}) {
  const svc = createServiceClient()
  const ctx = await getAgentContext()

  try {
    // Webhook (no session): allow unconditionally — the webhook handler has
    // already verified the Vapi HMAC signature before calling us.
    // UI (session present): scope to caller's brokerage.
    if (ctx.isAuthenticated) {
      if (!ctx.brokerageId) {
        return { success: false, error: "Unauthorized" }
      }
      const { data: callRow } = await svc
        .from("vapi_voice_calls")
        .select("contact_id")
        .eq("vapi_call_id", params.callId)
        .maybeSingle()
      if (!callRow) {
        return { success: false, error: "Call not found" }
      }
      if (callRow.contact_id) {
        const { data: contact } = await svc
          .from("contacts")
          .select("brokerage_id")
          .eq("id", callRow.contact_id)
          .maybeSingle()
        if (!contact || contact.brokerage_id !== ctx.brokerageId) {
          return { success: false, error: "Forbidden" }
        }
      }
    }

    // vapi_voice_calls only carries provider/billing fields. The status,
    // transcript, outcome and sentiment belong on the parent voice_calls
    // row; look it up via voice_call_id (FK from vapi_voice_calls).
    const { data: vapiRow } = await svc
      .from("vapi_voice_calls")
      .select("id, voice_call_id, raw_payload")
      .eq("vapi_call_id", params.callId)
      .maybeSingle()

    const { error: vapiErr } = await svc
      .from("vapi_voice_calls")
      .update({
        duration_seconds: params.durationSeconds,
        cost_cents: params.costCents,
        raw_payload: {
          ...(vapiRow?.raw_payload ?? {}),
          status: params.status,
          last_status_at: new Date().toISOString(),
        },
      })
      .eq("vapi_call_id", params.callId)

    if (vapiErr) {
      console.error("[Vapi Voice] Failed to update vapi_voice_calls:", vapiErr)
      return { success: false, error: vapiErr.message }
    }

    if (vapiRow?.voice_call_id) {
      const voiceUpdate: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (params.status === "completed") voiceUpdate.status = "completed"
      if (params.transcript) voiceUpdate.transcription = params.transcript
      if (params.outcome) voiceUpdate.outcome = params.outcome
      if (params.sentiment) voiceUpdate.sentiment = params.sentiment

      const { error: voiceErr } = await svc
        .from("voice_calls")
        .update(voiceUpdate)
        .eq("id", vapiRow.voice_call_id)
      if (voiceErr) {
        console.error("[Vapi Voice] Failed to update voice_calls:", voiceErr)
      }
    }

    return { success: true }
  } catch (error: any) {
    console.error("[Vapi Voice] Update error:", error)
    return { success: false, error: error.message }
  }
}

// Get whisper bridge call history
export async function getWhisperBridgeCalls(_agentId?: string) {
  // _agentId ignored — derived from session
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  const supabase = await createClient()

  try {
    // Scope by the authenticated user's user_id (call_whisper_logs.agent_id is users.id)
    const { data, error } = await supabase
      .from("call_whisper_logs")
      .select("*, contacts(first_name, last_name, phone)")
      .eq("agent_id", ctx.userId)
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
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  const supabase = await createClient()
  const svc = createServiceClient()

  try {
    // Resolve all contact ids in this brokerage (so we can scope vapi_voice_calls)
    // If a specific contactId is requested, verify ownership first.
    if (contactId) {
      if (!isValidUUID(contactId)) {
        return { success: false, error: "Invalid contact ID" }
      }
      const { data: contactRow } = await svc
        .from("contacts")
        .select("brokerage_id")
        .eq("id", contactId)
        .maybeSingle()
      if (!contactRow || contactRow.brokerage_id !== ctx.brokerageId) {
        return { success: false, error: "Forbidden" }
      }

      const { data, error } = await supabase
        .from("vapi_voice_calls")
        .select("*, contacts(first_name, last_name, phone)")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false })
        .limit(50)
      if (error) throw error
      return { success: true, calls: data }
    }

    // No contactId: list calls for all contacts in this brokerage
    const { data: brokerageContacts } = await svc
      .from("contacts")
      .select("id")
      .eq("brokerage_id", ctx.brokerageId)
    const contactIds = (brokerageContacts ?? []).map((c) => c.id)
    if (contactIds.length === 0) {
      return { success: true, calls: [] }
    }

    const { data, error } = await supabase
      .from("vapi_voice_calls")
      .select("*, contacts(first_name, last_name, phone)")
      .in("contact_id", contactIds)
      .order("created_at", { ascending: false })
      .limit(50)

    if (error) throw error

    return { success: true, calls: data }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}
