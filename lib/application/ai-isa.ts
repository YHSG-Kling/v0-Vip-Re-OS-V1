import { createClient } from "@/lib/supabase/server"
import { buildCallContext } from "@/lib/ai-isa/build-call-context"
import { BUYER_SHOWING_FEEDBACK_STAGE } from "@/lib/contacts/buyer-stage"

/**
 * AI Inside Sales Agent (ISA) Application Service
 * All business logic lives here. Actions are thin wrappers that call these functions.
 */

// RESTORED (owner ruling, lane F1 2026-08-28) — `launchAIISACampaignService`
// was deleted by lane E2 as "the dial-batch twin"; the owner ruled it "wasn't
// intended for a dial batch but an actual choice of drip/ghost/nurture
// campaigns" — a DIFFERENT business process from dialing. It is restored below
// as a CAMPAIGN-TYPE LAUNCHER: the caller picks a campaign type, the matching
// contact segment is resolved, and the matched contacts are ENROLLED into the
// canonical cadence engine (campaign_sequences → sequence_enrollments,
// executed by the campaign-sequence-steps cron). It never dials — dialing
// stays the human-gated batch lane
// (lib/ai-isa/voice-dial-batch.ts:proposeIsaDialBatch/approveIsaDialBatch).

/** ai_isa_campaigns.campaign_type CHECK (live, scripts/check-vocabularies.ts). */
export type ISALaunchCampaignType =
  | "buyer_match" | "divorce" | "foreclosure" | "fsbo"
  | "ghost_recovery" | "search_intent" | "social_intent"

/**
 * campaign type → the cadence that services it.
 *
 * BUSINESS-PROCESS MAPPING (owner methodology: compare the process, not the
 * spelling). The deleted launcher's own segments map onto the live vocabulary:
 *   · dormant_reactivation (untouched ≥14d, "nurture" status) → ghost_recovery,
 *     and the cadence that re-engages a gone-quiet contact is a
 *     `re_engagement` sequence.
 *   · new_lead_follow_up (speed-to-lead, fresh contacts) → the intent types
 *     (search_intent / social_intent): fresh intent rides the fast `drip`.
 *   · showing_feedback (BUYER_SHOWING_FEEDBACK_STAGE) folds into buyer_match:
 *     an active buyer relationship rides long-term `nurture`, as do the
 *     life-event personas (fsbo / divorce / foreclosure).
 * campaign_sequences.sequence_type CHECK admits drip|nurture|post_close|
 * re_engagement|transaction; only the first three cadence kinds are campaign
 * launches (transaction/post_close are event-driven).
 */
const SEQUENCE_TYPE_FOR_CAMPAIGN_TYPE: Record<ISALaunchCampaignType, "drip" | "nurture" | "re_engagement"> = {
  ghost_recovery: "re_engagement",
  buyer_match:    "nurture",
  divorce:        "nurture",
  foreclosure:    "nurture",
  fsbo:           "nurture",
  search_intent:  "drip",
  social_intent:  "drip",
}

/** Pre-offer, actively-looking buyer stages — the buyer_match segment. */
const BUYER_MATCH_STAGES = [
  "BUYER_SEARCH_CONFIGURED",
  "BUYER_SEARCHING",
  "BUYER_TOUR_ELIGIBLE",
  BUYER_SHOWING_FEEDBACK_STAGE, // BUYER_TOURING — the old showing_feedback segment
] as const

export interface LaunchAIISACampaignResult {
  success: boolean
  campaignId?: string
  sequenceId?: string
  sequenceName?: string
  /** Contacts the segment matched before consent screening. */
  matched?: number
  /** Newly enrolled into the cadence by this launch. */
  enrolled?: number
  /** Already actively enrolled in the sequence (not double-enrolled). */
  alreadyEnrolled?: number
  /** Screened out before enrollment (DNC / outreach paused / re-engage blocked). */
  skipped?: number
  skipReasons?: Record<string, number>
  /** Per-contact enrollment refusals (first 10, verbatim). */
  errors?: string[]
  error?: string
}

/**
 * Launch an AI ISA campaign — the caller CHOOSES a campaign type; the matching
 * contact segment is resolved and enrolled into the type's cadence.
 *
 * IDENTITY (m354 fix carried forward): `userId` is a SESSION-derived users.id
 * — the action wrapper resolves it; it is never caller-supplied (§4). It is
 * crossed to agents.id via agents.user_id before touching contacts.agent_id,
 * because the two id spaces are DISJOINT (§3): the deleted version filtered
 * contacts.agent_id (FK agents) by a users.id, matched nothing for every
 * agent, and blamed the segment.
 *
 * DOES NOT DIAL. Enrollment hands the contacts to the compliance-gated
 * sequence engine; each step's send runs its own consent/compliance gates.
 * One enrollment engine, two doors (§6): this uses the same
 * lib/campaign-sequences/enrollment-engine.ts:enrollContact the queue-drain
 * uses — NOT lib/campaigns/enroll-in-sequence.ts, which never sets
 * next_step_at, and the campaign-sequence-steps cron polls
 * `next_step_at <= now`, so an enrollment written that way would never fire.
 */
export async function launchAIISACampaignService(params: {
  campaignType: ISALaunchCampaignType
  campaignName?: string
  /** Launch an EXISTING campaign (its stored type wins); omit to create one. */
  campaignId?: string
  /** SESSION-derived users.id (see the action wrapper). */
  userId: string
  /** SESSION-derived tenant. */
  brokerageId: string
}): Promise<LaunchAIISACampaignResult> {
  const supabase = await createClient()
  const { brokerageId } = params
  // `loginId` keeps the m354 fix's name for the users-class id, but it is now
  // SESSION-derived by the action wrapper — never caller-supplied (§4).
  const loginId = params.userId

  // users.id → agents.id (§3 disjoint spaces): contacts.agent_id FKs AGENTS.
  // The m354 identity-class fix, carried through the restore: filtering
  // contacts.agent_id by a users.id matched nothing for every agent.
  const { data: isaAgentRow, error: agentErr } = await supabase
    .from("agents").select("id").eq("user_id", loginId).maybeSingle()
  if (agentErr) return { success: false, error: agentErr.message }
  const isaAgentRecordId = (isaAgentRow as { id?: string } | null)?.id ?? null
  if (!isaAgentRecordId) {
    return { success: false, error: "No agent profile for this user — an AI ISA campaign is agent-scoped." }
  }

  // Resolve the campaign row FIRST when one is named, so its stored type (and
  // its tenant) is the truth this launch runs on.
  let campaignType = params.campaignType
  interface ExistingCampaignRow {
    id: string
    name: string
    target_segment: Record<string, unknown> | null
  }
  let existingCampaign: ExistingCampaignRow | null = null
  if (params.campaignId) {
    const { data: c, error: cErr } = await supabase
      .from("ai_isa_campaigns")
      .select("id, name, brokerage_id, campaign_type, target_segment")
      .eq("id", params.campaignId)
      .maybeSingle()
    if (cErr) return { success: false, error: cErr.message }
    if (!c) return { success: false, error: "Campaign not found" }
    if ((c as { brokerage_id: string }).brokerage_id !== brokerageId) {
      return { success: false, error: "Forbidden" }
    }
    campaignType = (c as { campaign_type: ISALaunchCampaignType }).campaign_type
    existingCampaign = c as unknown as ExistingCampaignRow
  }

  const sequenceType = SEQUENCE_TYPE_FOR_CAMPAIGN_TYPE[campaignType]
  if (!sequenceType) {
    return { success: false, error: `Unknown campaign type: ${campaignType}` }
  }

  // The cadence must EXIST before anything is created or activated — a launch
  // with no sequence would be the silent no-op this restore exists to prevent.
  // Same resolution the queue-drain uses; content is never invented here.
  const { data: sequence, error: seqErr } = await supabase
    .from("campaign_sequences")
    .select("id, name")
    .eq("brokerage_id", brokerageId)
    .eq("sequence_type", sequenceType)
    .eq("is_active", true)
    .eq("compliance_gated", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()
  if (seqErr) return { success: false, error: seqErr.message }
  if (!sequence) {
    return {
      success: false,
      error: `No active, compliance-gated '${sequenceType}' sequence exists in this brokerage — the ${campaignType} campaign enrolls contacts into that cadence, and its steps carry the message content. Build one in the Sequence Builder first; nothing is invented here.`,
    }
  }

  // ── Resolve the contact segment for the chosen type (agent-scoped) ──
  let query = supabase
    .from("contacts")
    .select("id, first_name, last_name, dnc_status, ai_outreach_paused, isa_reengage_allowed, lead_score")
    .eq("brokerage_id", brokerageId)
    .eq("agent_id", isaAgentRecordId)
    .is("deleted_at", null)

  if (campaignType === "buyer_match") {
    query = query
      .in("contact_type", ["buyer", "both"])
      .in("buyer_stage", [...BUYER_MATCH_STAGES])
  } else if (campaignType === "divorce" || campaignType === "foreclosure" || campaignType === "fsbo") {
    // contact_persona CHECK admits exactly these spellings (live vocabulary).
    query = query.eq("contact_persona", campaignType)
  } else if (campaignType === "ghost_recovery") {
    // The old dormant_reactivation window: gone quiet for 14+ days.
    query = query.lte("last_contacted_at", new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString())
  } else {
    // search_intent / social_intent — the speed-to-lead lane (old
    // new_lead_follow_up). A human-clicked launcher uses a 7-day recency
    // window rather than the old cron's 24 hours, or the button would almost
    // always find nobody.
    query = query.gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
  }

  const { data: contacts, error: contactsErr } = await query
  if (contactsErr) return { success: false, error: contactsErr.message }
  if (!contacts || contacts.length === 0) {
    return { success: false, error: "No contacts match the criteria" }
  }

  // Score threshold from the campaign's stored target_segment, when present.
  const scoreThreshold = Number((existingCampaign?.target_segment as { score_threshold?: unknown } | null)?.score_threshold)
  const thresholded = Number.isFinite(scoreThreshold) && scoreThreshold > 0
    ? (contacts as Array<{ lead_score: number | null }>).filter(
        (c) => (c.lead_score ?? 0) >= scoreThreshold,
      ) as typeof contacts
    : contacts

  // Consent screening BEFORE enrollment — enrollment drives outbound sends.
  const skipReasons: Record<string, number> = {}
  const eligible: typeof thresholded = []
  for (const c of thresholded as Array<{ id: string; dnc_status: boolean | null; ai_outreach_paused: boolean | null; isa_reengage_allowed: boolean | null }>) {
    const reason = c.dnc_status === true ? "dnc"
      : c.ai_outreach_paused === true ? "outreach_paused"
      : c.isa_reengage_allowed === false ? "reengage_blocked"
      : null
    if (reason) { skipReasons[reason] = (skipReasons[reason] ?? 0) + 1; continue }
    eligible.push(c as never)
  }
  const skipped = thresholded.length - eligible.length

  // ── Create or activate the campaign row ──
  let campaignId = existingCampaign?.id ?? null
  if (!campaignId) {
    const { data: created, error: createErr } = await supabase
      .from("ai_isa_campaigns")
      .insert({
        brokerage_id:  brokerageId,
        name:          params.campaignName || `${campaignType} — ${new Date().toLocaleDateString()}`,
        campaign_type: campaignType,
        channels:      ["email"],
        target_segment: {},
        leads_targeted: 0,
        touches_sent:   0,
        conversions:    0,
        is_active:     true, // mirrors status — the voice ISA page and stale-lead processor filter on it
        status:        "active",
      })
      .select("id")
      .single()
    if (createErr || !created) {
      return { success: false, error: createErr?.message ?? "Campaign insert returned no row" }
    }
    campaignId = (created as { id: string }).id
  } else {
    const { data: activated, error: activateErr } = await supabase
      .from("ai_isa_campaigns")
      .update({ status: "active", is_active: true, updated_at: new Date().toISOString() })
      .eq("id", campaignId)
      .eq("brokerage_id", brokerageId)
      .select("id")
    if (activateErr) return { success: false, error: activateErr.message }
    // An UPDATE matching nothing also resolves — count what came back.
    if (!activated || activated.length === 0) {
      return { success: false, error: "Campaign activation matched no row" }
    }
  }

  // ── Enroll — the SAME engine the queue-drain and step executor rail on ──
  const { enrollContact } = await import("@/lib/campaign-sequences/enrollment-engine")
  let enrolled = 0
  let alreadyEnrolled = 0
  const errors: string[] = []
  for (const contact of eligible as Array<{ id: string }>) {
    const result = await enrollContact({
      sequenceId: (sequence as { id: string }).id,
      contactId:  contact.id,
      brokerageId,
      enrolledBy: loginId,
    })
    if (result.success) enrolled++
    else if (result.alreadyEnrolled) alreadyEnrolled++
    else if (errors.length < 10) errors.push(`${contact.id}: ${result.error ?? "enrollment refused"}`)
  }

  // Honest count: the people this launch put (or found) in the cadence.
  const { error: countErr } = await supabase
    .from("ai_isa_campaigns")
    .update({ leads_targeted: enrolled + alreadyEnrolled, updated_at: new Date().toISOString() })
    .eq("id", campaignId)
    .eq("brokerage_id", brokerageId)
  if (countErr) errors.push(`leads_targeted not updated: ${countErr.message}`)

  return {
    success: enrolled + alreadyEnrolled > 0,
    campaignId,
    sequenceId: (sequence as { id: string }).id,
    sequenceName: (sequence as { name: string | null }).name ?? undefined,
    matched: contacts.length,
    enrolled,
    alreadyEnrolled,
    skipped,
    skipReasons,
    errors: errors.length ? errors : undefined,
    error: enrolled + alreadyEnrolled === 0
      ? (errors[0] ?? "No contact could be enrolled")
      : undefined,
  }
}

// Queue individual AI ISA call — the call-queue engine. Module-private from
// lane E2 until lane F1 (2026-08-28) RESTORED its public door: the
// queueAIISACall action in app/actions/ai-isa.ts (session-derived identity)
// queues a call into a campaign; retryFailedCallsService below is the retry
// path through the same engine. The immediate single-dial route remains
// app/api/voice/initiate-call — a different door for a different process.
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

  // users↔brokerages carries TWO foreign keys (users.brokerage_id, and
  // brokerages.ai_isa_system_user_id from migration 043), so a bare embed is
  // PGRST201 and this whole read died. Especially worth naming here: the second
  // FK is the ISA SYSTEM USER link, and this is the ISA module — the wrong one
  // is genuinely reachable, not just theoretically.
  const { data: agent } = await supabase
    .from("users")
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
// importer-less the actions barrel (app/actions/index, deleted this wave) barrel). SURVIVORS:
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
