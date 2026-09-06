"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { placeCall } from "@/lib/providers/messaging"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { priceImprovementLabel } from "@/lib/listings/price-improvement-label"
// TOMBSTONE (dead-import tranche): `callConnector` was imported here and never
// called. Every outbound provider request on this lane already goes through the
// gateway one layer down — `placeCall` (lib/providers/messaging, imported above)
// and `placeOutboundAiCall` (lib/voice/twilio-outbound.ts:178, dynamically
// imported at :279) both call `callConnector` themselves. A direct call from
// here would have been a second Twilio door with none of their vendor
// selection, budget pre-flight or attribution.

/**
 * Call Whisper Bridge & AI Voice Outreach (Twilio-native)
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
    // (keyed by voice_call_id). The provider call sid is the voice_calls.vendor_call_id pointer.
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
        vendor_call_id: callResult.callSid,
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
    // The record that a CALL WAS PLACED. Every other write in this block reads
    // its error; this one is the one a compliance review would ask for.
    const { error: whisperActivityError } = await supabase.from("activities").insert({
      agent_user_id: agentUserId,
      activity_type: "whisper_bridge_initiated",
      entity_type: "contact",
      entity_id: contactId,
      description: `Whisper bridge call initiated: ${context}`,
    })
    if (whisperActivityError) {
      console.error("[Whisper Bridge] whisper_bridge_initiated activity REJECTED — the call was placed but has no activity record:", whisperActivityError.message)
    }

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

// TOMBSTONE (§1.3, lane L4 2026-08-31) — `updateWhisperBridgeStatus` moved to
// lib/voice/whisper-bridge-status.ts:updateWhisperBridgeStatus (SURVIVOR),
// invoked from its ONLY caller, the Twilio status callback
// (app/api/twiml/whisper-bridge/route.ts POST).
// WHAT WAS BROKEN: the export lived here gated on getAgentContext(), but a
// provider webhook carries no user session, so the gate refused EVERY real
// invocation with { success: false, error: "Unauthorized" } — and the route
// never read the resolved refusal, so voice_calls.status was never once
// updated from the whisper bridge. A repo-wide census (stripped source) found
// no importer besides that route, so there is no session-gated half to keep:
// the webhook half authenticates as a WEBHOOK (verified Twilio signature →
// service client → tenant resolved from the voice_calls row that
// initiateWhisperBridge above keys by vendor_call_id), the same pattern the
// route's agent_heard stamp already rides. In a "use server" file every
// export is a public HTTP endpoint, which is why the ungated version could
// not simply stay here.

// Trigger the AI voice call for hot leads (Twilio-native lane)
export async function triggerAiVoiceCall(params: {
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
        // RENDER BOUNDARY (§6) — `price_reduction_alert` is the internal trigger
        // name and stays; the sentence is SPOKEN to the contact, so it takes the
        // public word.
        case "price_reduction_alert":
          firstMessage = `Hi ${contact.first_name}, great news! A property you viewed just had a ${priceImprovementLabel("sentence")}. Want to schedule another look?`
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
      // The record that an AI voice call was placed to this contact.
      const { error: voiceActivityError } = await supabase.from("activities").insert({
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
      if (voiceActivityError) {
        console.error("[voiceCallBridge] ai_voice_initiated activity REJECTED — the call is live but unrecorded:", voiceActivityError.message)
      }
    }

    return { success: true, callId: placed.callSid, status: "initiated" }
  } catch (error: any) {
    console.error("[AI Voice] Error:", error)
    return { success: false, error: error.message }
  }
}

// Get whisper bridge call history
// TOMBSTONE (§1 keep-one, lane E2 2026-08-28) — `getWhisperBridgeCalls`
// deleted. SURVIVORS: the voice dashboard's own tenant-scoped voice_calls
// reads (app/dashboard/voice/page.tsx:75-82 → VoiceCallHistoryTable, plus the
// mobile voice page's Recent Calls) for the call history, and
// app/dashboard/voice/review/[callId]/page.tsx:152 for the
// call_whisper_logs whisper text. This twin duplicated the same ledger read
// behind an action nothing called; a stripped-source census found zero
// callers outside the app/actions/index.ts barrel, which itself has zero
// importers.

// AI voice-call history is served from voice_calls (the single ledger) via
// getWhisperBridgeCalls and the voice dashboards — the legacy getVapiVoiceCalls
// reader retired with the vapi_voice_calls table.
