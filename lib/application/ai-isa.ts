import { createClient } from "@/lib/supabase/server"
import { buildCallContext } from "@/lib/ai-isa/build-call-context"
// (BUYER_SHOWING_FEEDBACK_STAGE import left with the deleted
// launchAIISACampaignService — see its tombstone below.)

/**
 * AI Inside Sales Agent (ISA) Application Service
 * All business logic lives here. Actions are thin wrappers that call these functions.
 */

// TOMBSTONE (§1 keep-one, lane E2 2026-08-28) — `launchAIISACampaignService`
// deleted with its only caller (the legacy launchAIISACampaign action; zero
// callers outside the importer-less app/actions/index.ts barrel). SURVIVORS:
// app/actions/ai-isa.ts:createISACampaign (campaign creation, session-
// tenanted) + the human-gated dial-batch lane
// lib/ai-isa/voice-dial-batch.ts:proposeIsaDialBatch/approveIsaDialBatch.
// This twin dialed a whole segment immediately on launch with no approval
// gate — paid autonomous outbound must go through the batch approval (§5).

// Queue individual AI ISA call — module-private since lane E2 (2026-08-28):
// its one live caller is retryFailedCallsService below (the public single-call
// door is app/api/voice/initiate-call).
async function queueAIISACallService(campaignId: string, contactId: string, loginId: string) {
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
    // users↔brokerages carries TWO foreign keys (users.brokerage_id, and
    // brokerages.ai_isa_system_user_id from migration 043), so a bare embed is
    // PGRST201 and this whole read died. Especially worth naming here: the second
    // FK is the ISA SYSTEM USER link, and this is the ISA module — the wrong one
    // is genuinely reachable, not just theoretically.
    .select("first_name, last_name, phone, brokerage_id, brokerage:brokerages!users_brokerage_id_fkey(name)")
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
    // ARMS THE AUTONOMY GATE — unattended ISA campaign dial, no human present.
    // SYSTEM_SOURCE_TO_MANAGER maps 'ai_isa' → ai_isa; without this the gate
    // resolves no manager and is a no-op.
    systemSource: "ai_isa",
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

// TOMBSTONE (§1 keep-one, lane E2 2026-08-28) — `getAIISACampaignsService` and
// `getAIISACallsService` deleted with their only callers (the legacy
// getAIISACampaigns/getAIISACalls actions; zero callers outside the
// importer-less app/actions/index.ts barrel). SURVIVORS:
// app/actions/ai-isa.ts:listISACampaigns (same ai_isa_campaigns read,
// session-tenanted; wired at app/dashboard/isa/page.tsx) and the voice ISA
// console's own tenant-scoped ai_isa_calls reads
// (app/dashboard/voice/isa/page.tsx, contact-history-sheet.tsx). The calls
// twin also mixed id spaces — its loginId "fallback" filtered contact_id by a
// users.id (§3 disjoint).

// Retry failed calls
export async function retryFailedCallsService(loginId: string) {
  const supabase = await createClient()

  // voice_calls.agent_id is an AGENTS id; loginId is a USERS id — the two
  // spaces are disjoint (§3, 23503), so the old `.eq("agent_id", loginId)`
  // matched nothing and this sweep never found a call to retry. Cross via
  // agents.user_id.
  const { data: retryAgentRow } = await supabase
    .from("agents").select("id").eq("user_id", loginId).maybeSingle()
  const retryAgentId = (retryAgentRow as { id?: string } | null)?.id ?? null
  if (!retryAgentId) {
    return { success: false, error: "No agent profile for this user — ISA calls are agent-scoped." }
  }

  // Resolve failed voice_calls for this agent, then look up ai_isa_calls via voice_call_id
  const { data: failedVoiceCalls } = await supabase
    .from("voice_calls")
    .select("id, contact_id")
    .eq("agent_id", retryAgentId)
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
    // is_active mirrors status — same rule as app/actions/ai-isa.ts writers;
    // the voice ISA page and stale-lead processor filter on is_active.
    .update({ status, is_active: status === "active" })
    .eq("id", campaignId)

  if (error) return { success: false, error: error.message }

  return { success: true }
}
