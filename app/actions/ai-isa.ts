"use server"

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"

/**
 * AI Inside Sales Agent (ISA) System
 * Autonomous outbound calling with Vapi.ai for lead qualification and appointment booking
 */

// Launch AI ISA campaign
export async function launchAIISACampaign(params: {
  campaignType: string
  campaignName?: string
  contactSegment: any
  loginId: string
}) {
  const { campaignType, campaignName, contactSegment, loginId } = params

  if (!isValidUUID(loginId)) {
    return { success: false, error: "Invalid login ID" }
  }

  const supabase = await createClient()

  try {
    // Get contacts matching segment
    let query = supabase
      .from("contacts")
      .select("id, first_name, last_name, phone, lead_score, stage")
      .eq("agent_id", loginId)

    // Apply campaign type filters
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

    // Get Vapi assistant ID from env
    const vapiAssistantId = process.env.VAPI_ISA_ASSISTANT_ID

    if (!vapiAssistantId) {
      return {
        success: false,
        error: "VAPI_ISA_ASSISTANT_ID not configured in environment variables",
      }
    }

    // Create campaign
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

    // Queue calls for each contact
    let queuedCount = 0
    for (const contact of contacts) {
      const result = await queueAIISACall(campaign.id, contact.id, loginId)
      if (result.success) queuedCount++
    }

    // Update campaign with queued count
    await supabase
      .from("ai_isa_campaigns")
      .update({ contacts_targeted: queuedCount })
      .eq("id", campaign.id)

    return {
      success: true,
      campaign_id: campaign.id,
      contacts_queued: queuedCount,
    }
  } catch (error: any) {
    console.error("[AI ISA] Campaign launch failed:", error)
    return { success: false, error: error.message }
  }
}

// Queue individual AI ISA call
export async function queueAIISACall(campaignId: string, contactId: string, loginId: string) {
  const supabase = await createClient()

  try {
    // Get contact details
    const { data: contact } = await supabase
      .from("contacts")
      .select("first_name, last_name, phone, lead_score, stage, last_property_viewed, preferred_areas")
      .eq("id", contactId)
      .single()

    if (!contact || !contact.phone) {
      return { success: false, error: "Contact has no valid phone number" }
    }

    // Get agent info for context
    const { data: agent } = await supabase
      .from("profiles")
      .select("first_name, last_name, phone, brokerage:brokerages(name)")
      .eq("id", loginId)
      .single()

    if (!agent) {
      return { success: false, error: "Agent not found" }
    }

    // Get campaign details
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

    // Prepare context for AI assistant
    const brokerageName = agent.brokerage?.name || "Smart Engine"
    const greeting = `Hi ${contact.first_name}, this is the AI assistant calling on behalf of ${agent.first_name} from ${brokerageName}. Do you have a quick minute to chat about your home search?`

    // Make Vapi.ai outbound call
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

    // Log call in database
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
  } catch (error: any) {
    console.error("[AI ISA] Call queueing failed:", error)
    return { success: false, error: error.message }
  }
}

// Handle Vapi call completion webhook
export async function handleVapiCallComplete(payload: any) {
  const supabase = await createClient()

  try {
    const { call: callData, transcript, summary, analysis } = payload

    // Find call record
    const { data: call } = await supabase
      .from("ai_isa_calls")
      .select("*")
      .eq("vapi_call_id", callData.id)
      .single()

    if (!call) {
      console.warn("[AI ISA] Call not found for vapi_call_id:", callData.id)
      return { success: false, error: "Call not found" }
    }

    // Update call record
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

    // Update campaign stats
    await supabase
      .from("ai_isa_campaigns")
      .update({
        calls_completed: supabase.raw("calls_completed + 1"),
      })
      .eq("id", call.campaign_id)

    // Handle appointment booking
    if (analysis?.outcome === "appointment_booked" && analysis?.appointment_time) {
      const { data: appointment } = await supabase
        .from("appointments")
        .insert({
          agent_id: call.login_id,
          contact_id: call.contact_id,
          appointment_type: "consultation",
          scheduled_start: analysis.appointment_time,
          scheduled_end: new Date(new Date(analysis.appointment_time).getTime() + 30 * 60000).toISOString(),
          status: "scheduled",
          notes: `Booked by AI ISA - ${summary || ""}`,
        })
        .select()
        .single()

      if (appointment) {
        await supabase
          .from("ai_isa_calls")
          .update({ appointment_scheduled_id: appointment.id })
          .eq("id", call.id)

        await supabase
          .from("ai_isa_campaigns")
          .update({
            appointments_booked: supabase.raw("appointments_booked + 1"),
          })
          .eq("id", call.campaign_id)

        // Notify agent
        await supabase.from("notifications").insert({
          recipient_id: call.login_id,
          notification_type: "ai_isa_booked_appointment",
          title: "AI ISA Booked Appointment",
          message: `Appointment with ${analysis.contact_name || "contact"} scheduled for ${new Date(analysis.appointment_time).toLocaleString()}`,
          priority: "high",
        })
      }
    }

    // Create hot task for qualified leads
    if (analysis?.qualification?.qualified && analysis?.outcome !== "appointment_booked") {
      await supabase.from("tasks").insert({
        assigned_to: call.login_id,
        contact_id: call.contact_id,
        title: "Follow up - AI ISA qualified lead",
        description: `Budget: $${analysis.qualification.budget || "N/A"}, Timeline: ${analysis.qualification.timeline || "N/A"}. ${analysis.qualification.notes || ""}`,
        due_date: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(), // 4 hours
        priority: "urgent",
      })
    }

    return { success: true }
  } catch (error: any) {
    console.error("[AI ISA] Webhook handling failed:", error)
    return { success: false, error: error.message }
  }
}

// Get AI ISA campaign stats
export async function getAIISACampaigns(loginId: string) {
  if (!isValidUUID(loginId)) {
    return []
  }

  const supabase = await createClient()

  const { data: campaigns } = await supabase
    .from("ai_isa_campaigns")
    .select("*")
    .eq("login_id", loginId)
    .order("created_at", { ascending: false })

  return campaigns || []
}

// Get AI ISA call history
export async function getAIISACalls(campaignId?: string, loginId?: string) {
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

  if (campaignId) {
    query = query.eq("campaign_id", campaignId)
  }

  if (loginId && isValidUUID(loginId)) {
    query = query.eq("login_id", loginId)
  }

  const { data: calls } = await query

  return calls || []
}

// Retry failed calls
export async function retryFailedCalls(loginId: string) {
  if (!isValidUUID(loginId)) {
    return { success: false, error: "Invalid login ID" }
  }

  const supabase = await createClient()

  const { data: failedCalls } = await supabase
    .from("ai_isa_calls")
    .select("*")
    .eq("login_id", loginId)
    .in("call_status", ["no_answer", "busy", "failed"])
    .lt("attempt_number", 3)
    .lte("created_at", new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString()) // 4 hours ago

  let retriedCount = 0
  for (const call of failedCalls || []) {
    const result = await queueAIISACall(call.campaign_id, call.contact_id, loginId)

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
export async function updateCampaignStatus(campaignId: string, status: "active" | "paused" | "completed") {
  if (!isValidUUID(campaignId)) {
    return { success: false, error: "Invalid campaign ID" }
  }

  const supabase = await createClient()

  const { error } = await supabase.from("ai_isa_campaigns").update({ status }).eq("id", campaignId)

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true }
}
