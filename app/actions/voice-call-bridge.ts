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
      .select("first_name, last_name, phone, buyer_stage")
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

    // Canonical call record lives on voice_calls; call_whisper_logs only stores the whisper text
    // (keyed by voice_call_id). The provider call sid is the voice_calls.vapi_call_id pointer.
    const { data: voiceCall, error: vcError } = await supabase
      .from("voice_calls")
      .insert({
        brokerage_id: ctx.brokerageId,
        agent_id: ctx.agentId ?? null,
        contact_id: contactId,
        direction: "outbound",
        call_type: "agent_call",
        status: "initiated",
        phone_from: agent.phone,
        phone_to: contact.phone,
        vapi_call_id: callResult.callSid,
      })
      .select("id")
      .single()

    if (vcError || !voiceCall) {
      console.error("[Whisper Bridge] Failed to create voice_calls row:", vcError)
    } else {
      const { error: logError } = await supabase.from("call_whisper_logs").insert({
        voice_call_id: voiceCall.id,
        whisper_text: whisperText,
      })
      if (logError) console.error("[Whisper Bridge] Failed to log whisper:", logError)
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
      .from("voice_calls")
      .select("id, contact_id")
      .eq("vapi_call_id", params.callSid)
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

    // voice_calls.status + outcome are enum-constrained; map provider values to the allowed sets.
    const VALID_STATUS = ["initiated","ringing","in_progress","completed","failed","no_answer","voicemail","blocked"]
    const VALID_OUTCOME = ["appointment_set","callback_requested","not_interested","voicemail_left","no_answer","transferred","completed","authority_blocked"]
    const voiceUpdate: Record<string, unknown> = {
      status: VALID_STATUS.includes(params.status) ? params.status : "in_progress",
      duration_seconds: params.duration ?? null,
    }
    if (params.outcome && VALID_OUTCOME.includes(params.outcome)) voiceUpdate.outcome = params.outcome
    const { error } = await svc
      .from("voice_calls")
      .update(voiceUpdate)
      .eq("id", callRow.id)

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
      .select("first_name, last_name, phone, budget_max, buyer_stage")
      .eq("id", contactId)
      .single()

    if (!contact) {
      return { success: false, error: "Contact not found" }
    }

    if (!contact.phone) {
      return { success: false, error: "Contact phone number not found" }
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

    // Place the outbound AI call on the TWILIO-NATIVE lane (owner: "no longer vapi").
    // TCPA + vendor-budget gates run inside placeOutboundAiCall; the tenant's own
    // number is the caller ID; the voice_calls row IS the turn session (billed via
    // the usage_logs rail on the status callback). The former Vapi path is retired.
    const { placeOutboundAiCall } = await import("@/lib/voice/twilio-outbound")
    const placed = await placeOutboundAiCall(svc, {
      toNumber: contact.phone,
      contactId,
      brokerageId: ctx.brokerageId,
      agentUserId: ctx.userId ?? null,
      initiatedBy: ctx.userId ?? null,
      objective: `Hot-lead outreach (${triggerEvent}): reconnect, learn where they are, and offer to help or book time.`,
      contactName: contact.first_name,
      firstMessage: firstMessage ?? null,
    })
    if (!placed.ok) {
      return { success: false, error: placed.error, blocked: (placed as any).blocked }
    }

    // Activity trail (engine-agnostic).
    if (ctx.agentId) {
      await supabase.from("activities").insert({
        agent_id: ctx.agentId,
        brokerage_id: contactBroker.brokerage_id,
        contact_id: contactId,
        entity_type: "contact",
        activity_type: "ai_voice_initiated",
        title: `AI voice call initiated: ${triggerEvent}`,
        description: `Twilio AI call ${placed.callSid} initiated from trigger ${triggerEvent}`,
        metadata: { call_sid: placed.callSid, trigger_event: triggerEvent },
        status: "completed",
      })
    }

    return { success: true, callId: placed.callSid, status: "initiated" }
  } catch (error: any) {
    console.error("[AI Voice] Error:", error)
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
    // Whisper-bridge calls are voice_calls of type agent_call; the whisper text is the embedded
    // call_whisper_logs child. Scope by agent (voice_calls.agent_id is agents.id).
    const { data, error } = await supabase
      .from("voice_calls")
      .select("*, contacts(first_name, last_name, phone), call_whisper_logs(whisper_text, delivered_at, agent_heard)")
      .eq("call_type", "agent_call")
      .eq("agent_id", ctx.agentId)
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
