import { createClient } from "@/lib/supabase/server"

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

  const { data: campaign, error: campaignError } = await supabase
    .from("ai_isa_campaigns")
    .insert({
      login_id: loginId,
      campaign_name: campaignName || `${campaignType} - ${new Date().toLocaleDateString()}`,
      campaign_type: campaignType,
      vapi_assistant_id: vapiAssistantId,
      target_contact_segment: contactSegment,
      contacts_targeted: contacts.length,
      status: "active",
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
    .select("first_name, last_name, phone, lead_score, stage, last_property_viewed, preferred_areas")
    .eq("id", contactId)
    .single()

  if (!contact || !contact.phone) {
    return { success: false, error: "Contact has no valid phone number" }
  }

  const { data: agent } = await supabase
    .from("users")
    .select("first_name, last_name, phone, brokerage:brokerages(name)")
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

  const vapiApiKey = process.env.VAPI_API_KEY
  if (!vapiApiKey) {
    return { success: false, error: "VAPI_API_KEY not configured" }
  }

  const brokerageName = agent.brokerage?.name || "Smart Engine"
  const greeting = `Hi ${contact.first_name}, this is the AI assistant calling on behalf of ${agent.first_name} from ${brokerageName}. Do you have a quick minute to chat about your home search?`

  const vapiResponse = await fetch("https://api.vapi.ai/call/phone", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${vapiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      phoneNumber: contact.phone,
      assistantId: campaign.vapi_assistant_id,
      customer: {
        name: `${contact.first_name} ${contact.last_name}`,
        number: contact.phone,
      },
      assistantOverrides: {
        variableValues: {
          contact_name: contact.first_name,
          contact_full_name: `${contact.first_name} ${contact.last_name}`,
          agent_name: agent.first_name,
          agent_full_name: `${agent.first_name} ${agent.last_name}`,
          brokerage_name: brokerageName,
          lead_stage: contact.stage || "prospect",
          last_viewed_property: contact.last_property_viewed || "properties in your area",
          preferred_areas: contact.preferred_areas || "your preferred areas",
        },
        firstMessage: greeting,
      },
    }),
  })

  const callData = await vapiResponse.json()

  if (!vapiResponse.ok) {
    throw new Error(callData.message || "Vapi API error")
  }

  const { data: call, error: callError } = await supabase
    .from("ai_isa_calls")
    .insert({
      campaign_id: campaignId,
      contact_id: contactId,
      login_id: loginId,
      vapi_call_id: callData.id,
      call_status: "initiated",
      attempt_number: 1,
    })
    .select()
    .single()

  if (callError) throw callError

  return { success: true, call_id: call.id, vapi_call_id: callData.id }
}

// Handle Vapi call completion webhook
export async function handleVapiCallCompleteService(payload: any) {
  const supabase = await createClient()

  const { call: callData, transcript, summary, analysis } = payload

  const { data: call } = await supabase
    .from("ai_isa_calls")
    .select("*")
    .eq("vapi_call_id", callData.id)
    .single()

  if (!call) {
    console.warn("[AI ISA] Call not found for vapi_call_id:", callData.id)
    return { success: false, error: "Call not found" }
  }

  await supabase
    .from("ai_isa_calls")
    .update({
      call_status: callData.status || "completed",
      call_duration_seconds: callData.duration,
      conversation_transcript: transcript?.text || null,
      qualification_result: analysis?.qualification || null,
      outcome: analysis?.outcome || "completed",
      recording_url: callData.recordingUrl || null,
    })
    .eq("id", call.id)

  await supabase
    .from("ai_isa_campaigns")
    .update({ calls_completed: supabase.raw("calls_completed + 1") })
    .eq("id", call.campaign_id)

  if (analysis?.outcome === "appointment_booked" && analysis?.appointment_time) {
    const { data: showing } = await supabase
      .from("showings")
      .insert({
        agent_id: call.login_id,
        contact_id: call.contact_id,
        scheduled_at: analysis.appointment_time,
        duration_minutes: 30,
        status: "scheduled",
        notes: `Booked by AI ISA - ${summary || ""}`,
      })
      .select()
      .single()

    if (showing) {
      await supabase
        .from("ai_isa_calls")
        .update({ showing_scheduled_id: showing.id })
        .eq("id", call.id)

      await supabase
        .from("ai_isa_campaigns")
        .update({ appointments_booked: supabase.raw("appointments_booked + 1") })
        .eq("id", call.campaign_id)

      await supabase.from("notifications").insert({
        recipient_id: call.login_id,
        notification_type: "ai_isa_booked_appointment",
        title: "AI ISA Booked Appointment",
        message: `Appointment with ${analysis.contact_name || "contact"} scheduled for ${new Date(analysis.appointment_time).toLocaleString()}`,
        priority: "high",
      })
    }
  }

  if (analysis?.qualification?.qualified && analysis?.outcome !== "appointment_booked") {
    await supabase.from("tasks").insert({
      assigned_to: call.login_id,
      contact_id: call.contact_id,
      title: "Follow up - AI ISA qualified lead",
      description: `Budget: $${analysis.qualification.budget || "N/A"}, Timeline: ${analysis.qualification.timeline || "N/A"}. ${analysis.qualification.notes || ""}`,
      due_date: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
      priority: "urgent",
    })
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
      campaign:ai_isa_campaigns(campaign_name, campaign_type)
    `
    )
    .order("created_at", { ascending: false })
    .limit(100)

  if (campaignId) query = query.eq("campaign_id", campaignId)
  if (loginId) query = query.eq("login_id", loginId)

  const { data: calls } = await query
  return calls || []
}

// Retry failed calls
export async function retryFailedCallsService(loginId: string) {
  const supabase = await createClient()

  const { data: failedCalls } = await supabase
    .from("ai_isa_calls")
    .select("*")
    .eq("login_id", loginId)
    .in("call_status", ["no_answer", "busy", "failed"])
    .lt("attempt_number", 3)
    .lte("created_at", new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString())

  let retriedCount = 0
  for (const call of failedCalls || []) {
    const result = await queueAIISACallService(call.campaign_id, call.contact_id, loginId)
    if (result.success) {
      await supabase
        .from("ai_isa_calls")
        .update({ attempt_number: call.attempt_number + 1 })
        .eq("id", call.id)
      retriedCount++
    }
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
