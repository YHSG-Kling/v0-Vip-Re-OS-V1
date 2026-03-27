import { createClient } from "@/lib/supabase/server"
import { initiateCall } from "@/lib/voice/vapi-client"
import { buildCallContext } from "@/lib/ai-isa/build-call-context"

/**
 * AI Inside Sales Agent (ISA) Application Service
 * All business logic lives here. Actions are thin wrappers that call these functions.
 */

// Launch AI ISA campaign
export async function launchAIISACampaignService(params: {
  campaignType: string
  campaignName?: string
  contactSegment: any
  loginId: string
}) {
  const { campaignType, campaignName, contactSegment, loginId } = params
  const supabase = await createClient()

  // Get contacts matching segment
  let query = supabase
    .from("contacts")
    .select("id, first_name, last_name, phone, lead_score, stage")
    .eq("agent_id", loginId)

  if (campaignType === "new_lead_follow_up") {
    query = query
      .eq("status", "new_lead")
      .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
  } else if (campaignType === "dormant_reactivation") {
    query = query
      .eq("status", "nurture")
      .lte("last_contact_date", new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString())
  } else if (campaignType === "showing_feedback") {
    query = query.eq("stage", "toured")
  }

  const { data: contacts } = await query

  if (!contacts || contacts.length === 0) {
    return { success: false, error: "No contacts match the criteria" }
  }

  const vapiAssistantId = process.env.VAPI_ISA_ASSISTANT_ID
  if (!vapiAssistantId) {
    return {
      success: false,
      error: "VAPI_ISA_ASSISTANT_ID not configured in environment variables",
    }
  }

  // Resolve brokerage_id from the agent's record — loginId is agent user id
  const { data: agentForCampaign } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", loginId)
    .single()

  const campaignBrokerageId = agentForCampaign?.brokerage_id
  if (!campaignBrokerageId) {
    return { success: false, error: "Could not resolve brokerage_id for campaign" }
  }

  const { data: campaign, error: campaignError } = await supabase
    .from("ai_isa_campaigns")
    .insert({
      brokerage_id:           campaignBrokerageId,
      name:                   campaignName || `${campaignType} - ${new Date().toLocaleDateString()}`,
      campaign_type:          campaignType,
      leads_targeted:         contacts.length,
      is_active:              true,
    })
    .select()
    .single()

  if (campaignError) throw campaignError

  let queuedCount = 0
  for (const contact of contacts) {
    const result = await queueAIISACallService(campaign.id, contact.id, loginId)
    if (result.success) queuedCount++
  }

  await supabase
    .from("ai_isa_campaigns")
    .update({ contacts_targeted: queuedCount })
    .eq("id", campaign.id)

  return {
    success: true,
    campaign_id: campaign.id,
    contacts_queued: queuedCount,
  }
}

// Queue individual AI ISA call
export async function queueAIISACallService(campaignId: string, contactId: string, loginId: string) {
  const supabase = await createClient()

  const { data: contact } = await supabase
    .from("contacts")
    .select("first_name, last_name, phone, lead_score, stage, last_property_viewed, preferred_areas, brokerage_id, agent_id")
    .eq("id", contactId)
    .single()

  if (!contact || !contact.phone) {
    return { success: false, error: "Contact has no valid phone number" }
  }

  const { data: agent } = await supabase
    .from("users")
    .select("first_name, last_name, phone, brokerage_id, brokerage:brokerages(name)")
    .eq("id", loginId)
    .single()

  if (!agent) {
    return { success: false, error: "Agent not found" }
  }

  const { data: campaign } = await supabase
    .from("ai_isa_campaigns")
    .select("vapi_assistant_id, campaign_type")
    .eq("id", campaignId)
    .single()

  if (!campaign) {
    return { success: false, error: "Campaign not found" }
  }

  const brokerageId = agent.brokerage_id ?? contact.brokerage_id
  if (!brokerageId) {
    return { success: false, error: "brokerageId could not be resolved for this call" }
  }

  // Build per-call context via Kernel OS: persona, brand voice, voice config, TCPA gate
  const ctx = await buildCallContext({
    leadId: contactId,
    agentId: loginId,
    brokerageId,
  })

  if (ctx.blocked) {
    return { success: false, error: `Call blocked: ${ctx.blockedReason ?? "TCPA or call stop flag"}` }
  }

  // Assemble assistantOverrides from buildCallContext output
  const assistantOverrides: NonNullable<Parameters<typeof initiateCall>[0]["assistantOverrides"]> = {
    name:         ctx.assistantName,
    firstMessage: ctx.firstMessage,
    model: {
      systemPrompt: ctx.systemPrompt,
    },
    variableValues: {
      contact_name:          contact.first_name,
      contact_full_name:     `${contact.first_name} ${contact.last_name}`,
      agent_name:            agent.first_name,
      agent_full_name:       `${agent.first_name} ${agent.last_name}`,
      brokerage_name:        (agent.brokerage as any)?.name ?? "your brokerage",
      lead_stage:            contact.stage            ?? "prospect",
      last_viewed_property:  contact.last_property_viewed ?? "properties in your area",
      preferred_areas:       contact.preferred_areas  ?? "your preferred areas",
    },
  }

  // Wire ElevenLabs voice config when present on the identity profile
  if (ctx.voiceConfig?.elevenlabs_voice_id) {
    assistantOverrides.voice = {
      provider:        "elevenlabs",
      voiceId:         ctx.voiceConfig.elevenlabs_voice_id,
      stability:       ctx.voiceConfig.voice_stability        ?? undefined,
      similarityBoost: ctx.voiceConfig.voice_similarity_boost ?? undefined,
    }
  }

  const callData = await initiateCall({
    phoneNumber:      contact.phone,
    assistantId:      campaign.vapi_assistant_id,
    assistantOverrides,
  })

  // Write voice_calls row first — ai_isa_calls.voice_call_id is an FK to it
  const { data: voiceCallRow } = await supabase
    .from("voice_calls")
    .insert({
      contact_id:  contactId,
      brokerage_id: brokerageId,
      agent_id:    loginId,
      vapi_call_id: callData.id,
      direction:   "outbound",
      call_type:   "isa_ai",
      status:      "initiated",
      started_at:  new Date().toISOString(),
    })
    .select("id")
    .single()
    .then((r) => r.data)
    .catch(() => null)

  // Write vapi_voice_calls billing row
  await supabase
    .from("vapi_voice_calls")
    .insert({
      voice_call_id: voiceCallRow?.id ?? null,
      brokerage_id:  brokerageId,
      vapi_call_id:  callData.id,
      assistant_id:  campaign.vapi_assistant_id ?? null,
      agent_id:      loginId,
      contact_id:    contactId,
    })
    .catch((err: any) => {
      console.error("[AI-ISA] vapi_voice_calls insert failed:", err.message)
    })

  // Write ai_isa_calls with correct build34 columns — no campaign_id/login_id/vapi_call_id/call_status/attempt_number
  const { data: isaCall, error: isaCallError } = await supabase
    .from("ai_isa_calls")
    .insert({
      voice_call_id:   voiceCallRow?.id ?? null,
      brokerage_id:    brokerageId,
      contact_id:      contactId,
      isa_campaign_id: campaignId ?? null,
      script_used:     ctx.systemPrompt?.substring(0, 500) ?? null,
    })
    .select("id")
    .single()

  if (isaCallError) {
    console.error("[AI-ISA] ai_isa_calls insert failed:", isaCallError.message)
  }

  return {
    success:      true,
    call_id:      isaCall?.id ?? null,
    voice_call_id: voiceCallRow?.id ?? null,
    vapi_call_id: callData.id,
  }
}

// Handle Vapi call completion webhook
export async function handleVapiCallCompleteService(payload: any) {
  const supabase = await createClient()

  const { call: callData, transcript, summary, analysis } = payload

  // Resolve voice_calls row first — ai_isa_calls no longer stores vapi_call_id
  const { data: voiceCall } = await supabase
    .from("voice_calls")
    .select("id, contact_id, agent_id, brokerage_id")
    .eq("vapi_call_id", callData.id)
    .maybeSingle()

  if (!voiceCall) {
    console.warn("[AI ISA] voice_calls row not found for vapi_call_id:", callData.id)
    return { success: false, error: "Call not found" }
  }

  const { data: call } = await supabase
    .from("ai_isa_calls")
    .select("id, isa_campaign_id")
    .eq("voice_call_id", voiceCall.id)
    .maybeSingle()

  if (call) {
    await supabase
      .from("ai_isa_calls")
      .update({
        ai_response_summary: (summary || analysis?.outcome || "").substring(0, 500) || null,
      })
      .eq("id", call.id)
  }

  // ai_isa_campaigns still has calls_completed — use rpc to increment safely
  if (call?.isa_campaign_id) {
    await supabase.rpc("increment_campaign_calls_completed", {
      p_campaign_id: call.isa_campaign_id,
    }).catch(() => {
      // rpc may not exist yet — non-blocking
    })
  }

  if (analysis?.outcome === "appointment_booked" && analysis?.appointment_time) {
    const { data: showing } = await supabase
      .from("showings")
      .insert({
        agent_id:      voiceCall.agent_id,
        contact_id:    voiceCall.contact_id,
        brokerage_id:  voiceCall.brokerage_id,
        scheduled_at:  analysis.appointment_time,
        duration_minutes: 30,
        status: "scheduled",
        notes: `Booked by AI ISA - ${summary || ""}`,
      })
      .select()
      .single()

    if (showing) {
      if (call?.isa_campaign_id) {
        await supabase.rpc("increment_campaign_appointments_booked", {
          p_campaign_id: call.isa_campaign_id,
        }).catch(() => {})
      }

      if (voiceCall.agent_id) {
        await supabase.from("notifications").insert({
          user_id:      voiceCall.agent_id,
          brokerage_id: voiceCall.brokerage_id,
          type:         "ai_isa_booked_appointment",
          title:        "AI-ISA Booked Appointment",
          body:         `Appointment with ${analysis.contact_name || "contact"} scheduled for ${new Date(analysis.appointment_time).toLocaleString()}`,
          priority:     "high",
        }).catch(() => {})
      }
    }
  }

  if (analysis?.qualification?.qualified && analysis?.outcome !== "appointment_booked") {
    await supabase.from("tasks").insert({
      assigned_to_agent_id: voiceCall.agent_id,
      contact_id:           voiceCall.contact_id,
      brokerage_id:         voiceCall.brokerage_id,
      title:       "Follow up - AI-ISA qualified lead",
      description: `Budget: $${analysis.qualification.budget || "N/A"}, Timeline: ${analysis.qualification.timeline || "N/A"}. ${analysis.qualification.notes || ""}`,
      due_date:    new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString().split("T")[0],
      priority:    "urgent",
      status:      "pending",
    }).catch(() => {})
  }

  return { success: true }
}

// Get AI ISA campaign stats
export async function getAIISACampaignsService(loginId: string) {
  const supabase = await createClient()

  const { data: campaigns } = await supabase
    .from("ai_isa_campaigns")
    .select("*")
    .eq("login_id", loginId)
    .order("created_at", { ascending: false })

  return campaigns || []
}

// Get AI ISA call history
export async function getAIISACallsService(campaignId?: string, loginId?: string) {
  const supabase = await createClient()

  let query = supabase
    .from("ai_isa_calls")
    .select(
      `
      *,
      contact:contacts(first_name, last_name, phone),
      campaign:ai_isa_campaigns(name, campaign_type),
      voice_call:voice_calls(vapi_call_id, status, duration_seconds)
    `
    )
    .order("created_at", { ascending: false })
    .limit(100)

  if (campaignId) query = query.eq("isa_campaign_id", campaignId)
  if (loginId) query = query.eq("contact_id", loginId) // fallback — callers should pass contactId

  const { data: calls } = await query
  return calls || []
}

// Retry failed calls
export async function retryFailedCallsService(loginId: string) {
  const supabase = await createClient()

  // Resolve failed voice_calls for this agent, then look up ai_isa_calls via voice_call_id
  const { data: failedVoiceCalls } = await supabase
    .from("voice_calls")
    .select("id, contact_id")
    .eq("agent_id", loginId)
    .in("status", ["no_answer", "busy", "failed"])
    .lte("started_at", new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString())
    .limit(50)

  const { data: failedIsaCalls } = failedVoiceCalls?.length
    ? await supabase
        .from("ai_isa_calls")
        .select("id, contact_id, isa_campaign_id")
        .in("voice_call_id", failedVoiceCalls.map((v) => v.id))
    : { data: [] }

  let retriedCount = 0
  for (const call of failedIsaCalls || []) {
    const result = await queueAIISACallService(call.isa_campaign_id ?? "", call.contact_id, loginId)
    if (result.success) retriedCount++
  }

  return { success: true, retried_count: retriedCount }
}

// Pause/resume campaign
export async function updateCampaignStatusService(
  campaignId: string,
  status: "active" | "paused" | "completed"
) {
  const supabase = await createClient()

  const { error } = await supabase
    .from("ai_isa_campaigns")
    .update({ status })
    .eq("id", campaignId)

  if (error) return { success: false, error: error.message }

  return { success: true }
}
