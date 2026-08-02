import { createClient } from "@/lib/supabase/server"
import { buildCallContext } from "@/lib/ai-isa/build-call-context"
import { BUYER_SHOWING_FEEDBACK_STAGE } from "@/lib/contacts/buyer-stage"

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

  // IDENTITY CLASS (m354). loginId is a USERS id — every other lookup in this
  // file reads `users` by it, and the comment below says so explicitly. But
  // contacts.agent_id FKs AGENTS, so this filter matched nothing for every
  // agent, the guard below returned "No contacts match the criteria", and the
  // AI ISA — the engine that turns scraped leads into calls — could not launch
  // a single campaign. The error blamed the agent's segment for a class
  // mismatch, which is why it reads as a data problem rather than a bug.
  const { data: isaAgentRow } = await supabase
    .from("agents").select("id").eq("user_id", loginId).maybeSingle()
  const isaAgentRecordId = (isaAgentRow as { id?: string } | null)?.id ?? null
  if (!isaAgentRecordId) {
    return { success: false, error: "No agent profile for this user — an AI ISA campaign is agent-scoped." }
  }

  // Get contacts matching segment
  let query = supabase
    .from("contacts")
    .select("id, first_name, last_name, phone, lead_score, stage:buyer_stage")
    .eq("agent_id", isaAgentRecordId)

  if (campaignType === "new_lead_follow_up") {
    query = query
      .eq("status", "new_lead")
      .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
  } else if (campaignType === "dormant_reactivation") {
    query = query
      .eq("status", "nurture")
      .lte("last_contacted_at", new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString())
  } else if (campaignType === "showing_feedback") {
    // Was 'toured' — a value contacts.buyer_stage has never admitted (the ladder
    // says BUYER_TOURING), so this campaign never matched a single contact.
    query = query.eq("buyer_stage", BUYER_SHOWING_FEEDBACK_STAGE)
  }

  const { data: contacts } = await query

  if (!contacts || contacts.length === 0) {
    return { success: false, error: "No contacts match the criteria" }
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
      status:                 "active",
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
    .update({ leads_targeted: queuedCount })
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
    .select("first_name, last_name, phone, lead_score, stage:status, brokerage_id, agent_id")
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
    .select("campaign_type")
    .eq("id", campaignId)
    .single()

  if (!campaign) {
    return { success: false, error: "Campaign not found" }
  }

  const brokerageId = agent.brokerage_id ?? contact.brokerage_id
  if (!brokerageId) {
    return { success: false, error: "brokerageId could not be resolved for this call" }
  }

  // Build per-call context via Kernel OS: persona, brand voice, voice config, TCPA gate.
  // IDENTITY: this is a CONTACT (not a lead), so pass contactId — and the ASSIGNED AGENT
  // (contacts.agent_id is agents.id) so the ISA speaks in THAT agent's cloned voice/avatar.
  // (Previously passed leadId=contactId — which mis-looked-up a non-existent lead — and
  // agentId=loginId, a users.id the agents lookup never matches, so neither resolved.)
  const ctx = await buildCallContext({
    contactId,
    agentId: contact.agent_id ?? null,
    brokerageId,
    callPurpose: 'isa_followup',
  })

  if (ctx.blocked) {
    return { success: false, error: `Call blocked: ${ctx.blockReason ?? "TCPA or call stop flag"}` }
  }

  // ── ENGINE: Twilio-native (the single voice lane). The per-call ISA persona
  // (buildCallContext systemPrompt/firstMessage) rides the serverless turn
  // engine; TCPA + budget gates run inside placeOutboundAiCall, which also
  // writes its own voice_calls ledger row (the row IS the turn session).
  const { placeOutboundAiCall } = await import("@/lib/voice/twilio-outbound")
  const { createServiceClient } = await import("@/lib/supabase/service")
  const placed = await placeOutboundAiCall(createServiceClient(), {
    toNumber: contact.phone,
    contactId,
    brokerageId,
    agentUserId: loginId,
    initiatedBy: loginId,
    objective: `ISA follow-up for the "${campaign.campaign_type}" campaign: reconnect, learn where they are in their journey, and offer to book time with ${agent.first_name}.`,
    contactName: contact.first_name,
    firstMessage: ctx.firstMessage ?? null,
    systemPrompt: ctx.systemPrompt ?? null,
  })
  if (!placed.ok) return { success: false, error: placed.error }
  const callData = { id: placed.callSid, status: "initiated", createdAt: new Date().toISOString() }
  const voiceCallRow: { id: string } | null = placed.voiceCallId ? { id: placed.voiceCallId } : null

  // Write ai_isa_calls with correct build34 columns — no campaign_id/login_id/vendor_call_id/call_status/attempt_number
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
    vendor_call_id: callData.id,
  }
}

// Get AI ISA campaign stats
export async function getAIISACampaignsService(loginId: string) {
  const supabase = await createClient()

  // Resolve brokerage_id from the user then query by brokerage scope (ai_isa_campaigns has no login_id)
  const { data: userRow } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", loginId)
    .maybeSingle()

  const brokerageId = userRow?.brokerage_id
  if (!brokerageId) return []

  const { data: campaigns } = await supabase
    .from("ai_isa_campaigns")
    .select("id, name, campaign_type, is_active, status, leads_targeted, touches_sent, conversions, touch_interval_days, max_touches, created_at")
    .eq("brokerage_id", brokerageId)
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
      voice_call:voice_calls(vendor_call_id, status, duration_seconds)
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
    // Disposition lives in OUTCOME, not status — the Twilio callback closes every
    // terminated leg as status="completed". This sweep never found a call to
    // retry because it was reading the wrong column.
    .in("outcome", ["no_answer", "busy", "failed", "canceled"])
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
