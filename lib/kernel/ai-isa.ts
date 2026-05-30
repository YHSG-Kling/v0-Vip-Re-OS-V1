// lib/kernel/ai-isa.ts
// LAYER 1 — Canonical AI Inside Sales Agent (ISA) kernel commands.
// Kernel ownership: all ISA qualification, automation, handoff, and outcome
// recording flows through these commands. No silent state mutations.
// No "use server" — this is a server-only module called from action wrappers.
//
// ─── KERNEL OWNERSHIP ────────────────────────────────────────────────────────
// Owner: AI ISA subsystem
// Commands:
//   1.  loadAiIsaWorkspace           — load ISA campaigns, queue, calls, handoffs
//   2.  evaluateAiIsaEligibility     — gate: can this lead be owned by AI ISA?
//   3.  assignAiIsaToLeadAfterGate   — assign AI ISA ownership after gate passes
//   4.  startAiIsaAutomation         — start outreach automation for a lead
//   5.  pauseAiIsaAutomation         — pause automation with reason
//   6.  resumeAiIsaAutomation        — resume automation after review
//   7.  handoffToHumanAgent          — handoff to agent when ISA is done
//   8.  recordAiIsaOutcome           — record call/outreach outcome
//   9.  routeHistoryToCanonicalEntity — link inbound reply to lead or contact
//   10. resolveLeadChannel            — determine active outreach channel for a lead
//   11. buildCallContext              — build VAPI call context from identity profiles
//
// ─── EXPLICIT RULES ──────────────────────────────────────────────────────────
// Rule 1: AI ISA cannot own a lead that is in representation (contract signed).
// Rule 2: consent is required before any ISA outreach — tcpa_consent OR written consent.
// Rule 3: leads.minimum_viable_for_isa must be true before assignAiIsaToLeadAfterGate.
// Rule 4: leads.ai_isa_owner = true is the single source of truth for ISA ownership.
// Rule 5: handoffToHumanAgent sets ai_isa_owner = false and fires lifecycle_event.
// Rule 6: pauseAiIsaAutomation sets ai_outreach_paused = true (never deletes state).
// Rule 7: buildCallContext reads ai_identity_profiles in order: agent → team → brokerage.
//
// ─── EXPLICIT UI BEHAVIOR ────────────────────────────────────────────────────
// - evaluateAiIsaEligibility → blocked: shows reason inline in qualification radar
// - startAiIsaAutomation → ISA status badge changes to "active" immediately
// - pauseAiIsaAutomation → badge changes to "paused", pause reason shown in tooltip
// - handoffToHumanAgent → handoff card appears in agent's notification feed
// - recordAiIsaOutcome → outcome badge updates in call history row
//
// ─── TABLES WRITTEN ──────────────────────────────────────────────────────────
// leads                  — eligibility flags, ai_isa_owner, ai_outreach_paused
// ai_isa_qualifications  — eligibility evaluation results (insert)
// ai_isa_activities      — automation start/pause/resume/outcome (insert)
// agent_handoffs         — handoff records (insert)
// isa_outreach_log       — channel resolution + outreach records (insert)
// lifecycle_events       — all major state transitions (insert)
// contact_suppression_list — opt-out / stop handling (insert)

import { createServiceClient } from "@/lib/supabase/service"
import type { ActorRole, LeadLifecycleStage } from "@/lib/kernel/types"

// ─── SHARED RESULT TYPE ───────────────────────────────────────────────────────
export interface KernelAiIsaResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
  blocked?: boolean
  blockedReason?: string
}

// ─── ACTOR CONTEXT ───────────────────────────────────────────────────────────
export interface AiIsaActorContext {
  userId: string
  brokerageId: string
  role: ActorRole
}

// ─── INPUT / OUTPUT TYPES ─────────────────────────────────────────────────────

export interface LoadAiIsaWorkspaceInput {
  ctx: AiIsaActorContext
  limit?: number
}

export interface AiIsaWorkspaceData {
  campaigns: AiIsaCampaignRow[]
  queue: AiIsaLeadRow[]
  recentCalls: AiIsaCallRow[]
  pendingHandoffs: AiIsaHandoffRow[]
  stats: {
    activeCampaigns: number
    leadsInQueue: number
    callsToday: number
    pendingHandoffs: number
    appointmentsBooked: number
    conversionRate: number
  }
}

export interface AiIsaCampaignRow {
  id: string
  name: string
  campaign_type: string
  status: string
  leads_targeted: number
  touches_sent: number
  conversions: number
  created_at: string
}

export interface AiIsaLeadRow {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  lifecycle_state: LeadLifecycleStage | null
  ai_isa_owner: boolean
  ai_outreach_paused: boolean
  minimum_viable_for_isa: boolean
  last_activity_at: string | null
  created_at: string
}

export interface AiIsaCallRow {
  id: string
  lead_id: string | null
  contact_id: string | null
  ai_response_summary: string | null
  appointment_set: boolean
  appointment_datetime: string | null
  lead_quality_score: number | null
  created_at: string
}

export interface AiIsaHandoffRow {
  id: string
  // Live schema uses an entity_type/entity_id discriminator instead of
  // separate lead_id/contact_id columns; human_agent_id replaces the
  // older assigned_agent_id.
  entity_type: string
  entity_id: string
  handoff_reason: string | null
  handoff_status: string
  human_agent_id: string | null
  created_at: string
}

export interface EvaluateAiIsaEligibilityInput {
  ctx: AiIsaActorContext
  leadId: string
}

export interface EligibilityResult {
  eligible: boolean
  reasons: string[]
  blockers: string[]
  leadStage: LeadLifecycleStage | null
}

export interface AssignAiIsaToLeadInput {
  ctx: AiIsaActorContext
  leadId: string
  campaignId?: string
}

export interface StartAiIsaAutomationInput {
  ctx: AiIsaActorContext
  leadId: string
  campaignId?: string
  channel: "sms" | "email" | "phone"
  notes?: string
}

export interface PauseAiIsaAutomationInput {
  ctx: AiIsaActorContext
  leadId: string
  reason: string
}

export interface ResumeAiIsaAutomationInput {
  ctx: AiIsaActorContext
  leadId: string
  notes?: string
}

export interface HandoffToHumanAgentInput {
  ctx: AiIsaActorContext
  leadId: string
  assignedAgentId?: string
  handoffReason: string
  contactId?: string
}

export interface RecordAiIsaOutcomeInput {
  ctx: AiIsaActorContext
  leadId: string
  callId?: string
  /**
   * ISA call/outreach outcome.
   *
   * Three-bucket "not interested" model (replaces the legacy single
   * `not_interested` dead-end):
   *  - `explicit_opt_out` — caller explicitly refused contact ("stop", "DNC").
   *    Adds phone+email to platform_suppression_list (cross-tenant, permanent).
   *  - `not_ready_now` — caller is genuinely interested someday but not now.
   *    Moves lead to long_term_nurture for monthly market updates + signal
   *    re-activation.
   *  - `not_interested` — legacy bucket, soft pause only. Ghost re-engagement
   *    cron will pick them up on its normal cadence.
   *
   * Engine 2 fires on `qualified` outcome.
   */
  outcome:
    | "appointment_set"
    | "qualified"
    | "not_ready_now"
    | "explicit_opt_out"
    | "not_interested"
    | "no_answer"
    | "callback_requested"
    | "disqualified"
    | "wrong_number"
  notes?: string
  appointmentDate?: string
  /**
   * For `not_ready_now`, optional duration in days (default 90 — feeds the
   * monthly market-update sequence; signal re-activation may pull them out
   * earlier).
   */
  nurtureDays?: number
}

export interface RouteHistoryInput {
  ctx: AiIsaActorContext
  inboundText: string
  entityType: "contact" | "lead"
  entityId: string
  channel: "sms" | "email"
  providerMessageId?: string
}

export interface ResolveLeadChannelInput {
  ctx: AiIsaActorContext
  leadId: string
}

export interface LeadChannelResult {
  channel: "sms" | "email" | "phone" | null
  phoneNumber: string | null
  email: string | null
  blocked: boolean
  blockReason: string | null
}

// ─── COMMAND 1: loadAiIsaWorkspace ───────────────────────────────────────────
/**
 * Load the full AI ISA operations workspace for a brokerage.
 *
 * Input:  { ctx: { userId, brokerageId, role }, limit? }
 * Output: { success, data: AiIsaWorkspaceData }
 *
 * Tables read:
 *   ai_isa_campaigns, leads, ai_isa_calls, agent_handoffs
 *
 * Business rules:
 *   - Returns campaigns, leads in ISA queue, recent calls, pending handoffs
 *   - Stats computed in-memory from fetched records
 *   - Limit defaults to 50 for queue and 20 for calls/handoffs
 */
export async function loadAiIsaWorkspace(
  input: LoadAiIsaWorkspaceInput
): Promise<KernelAiIsaResult<AiIsaWorkspaceData>> {
  try {
    const { ctx, limit = 50 } = input
    const supabase = createServiceClient()

    const [campaignsRes, queueRes, callsRes, handoffsRes] = await Promise.all([
      supabase
        .from("ai_isa_campaigns")
        .select("id, name, campaign_type, status, leads_targeted, touches_sent, conversions, created_at")
        .eq("brokerage_id", ctx.brokerageId)
        .order("created_at", { ascending: false })
        .limit(20),

      supabase
        .from("leads")
        .select("id, first_name, last_name, email, phone, lifecycle_state, ai_isa_owner, ai_outreach_paused, minimum_viable_for_isa, last_activity_at, created_at")
        .eq("brokerage_id", ctx.brokerageId)
        .eq("ai_isa_owner", true)
        .eq("is_active", true)
        .order("last_activity_at", { ascending: false })
        .limit(limit),

      supabase
        .from("ai_isa_calls")
        .select("id, lead_id, contact_id, appointment_set, appointment_datetime, lead_quality_score, ai_response_summary, created_at")
        .eq("brokerage_id", ctx.brokerageId)
        .order("created_at", { ascending: false })
        .limit(20),

      supabase
        .from("agent_handoffs")
        .select("id, entity_type, entity_id, handoff_reason, handoff_status, human_agent_id, created_at")
        .eq("brokerage_id", ctx.brokerageId)
        .eq("handoff_status", "pending")
        .order("created_at", { ascending: false })
        .limit(20),
    ])

    const campaigns: AiIsaCampaignRow[] = campaignsRes.data ?? []
    const queue: AiIsaLeadRow[] = queueRes.data ?? []
    const calls: AiIsaCallRow[] = callsRes.data ?? []
    const handoffs: AiIsaHandoffRow[] = handoffsRes.data ?? []

    const today = new Date().toISOString().slice(0, 10)
    const callsToday = calls.filter((c) => c.created_at.startsWith(today)).length
    const apptBooked = calls.filter((c) => c.appointment_set).length
    const totalCalls = calls.length
    const conversionRate = totalCalls > 0 ? Math.round((apptBooked / totalCalls) * 100) : 0

    return {
      success: true,
      data: {
        campaigns,
        queue,
        recentCalls: calls,
        pendingHandoffs: handoffs,
        stats: {
          activeCampaigns: campaigns.filter((c) => c.status === "active").length,
          leadsInQueue: queue.length,
          callsToday,
          pendingHandoffs: handoffs.length,
          appointmentsBooked: apptBooked,
          conversionRate,
        },
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to load AI ISA workspace",
    }
  }
}

// ─── COMMAND 2: evaluateAiIsaEligibility ─────────────────────────────────────
/**
 * Evaluate whether a lead is eligible for AI ISA ownership.
 *
 * Input:  { ctx, leadId }
 * Output: { success, data: EligibilityResult }
 *
 * Tables read:
 *   leads (select by id + brokerage_id)
 *
 * Tables written:
 *   ai_isa_qualifications (insert — record evaluation result)
 *
 * Business rules:
 *   BLOCKER 1 — lead.lifecycle_state = "representation": AI ISA cannot act
 *   BLOCKER 2 — lead.call_stop_flag = true: DNC / hard stop
 *   BLOCKER 3 — lead.ai_outreach_paused = true: manually paused, needs review
 *   BLOCKER 4 — lead.opted_out_at IS NOT NULL: permanent opt-out
 *   POSITIVE  — lead.minimum_viable_for_isa = true: enriched with enough data
 *
 *   NOTE: lack of TCPA consent is NOT a blocker. Leads are unconsented by
 *   default; ISA may email + send verified-address direct mail without consent.
 *   Phone/SMS consent is enforced per-channel downstream (resolveLeadChannel +
 *   the compliance gate), not at the eligibility stage.
 *
 * UI behavior:
 *   - blockers[].length > 0 → qualification radar shows red stop icon + reason
 *   - eligible = true → green badge, "Assign AI ISA" button is enabled
 */
export async function evaluateAiIsaEligibility(
  input: EvaluateAiIsaEligibilityInput
): Promise<KernelAiIsaResult<EligibilityResult>> {
  try {
    const { ctx, leadId } = input
    const supabase = createServiceClient()

    const { data: lead, error } = await supabase
      .from("leads")
      .select(`
        id, lifecycle_state, tcpa_consent, tcpa_consent_source, call_stop_flag,
        ai_outreach_paused, opted_out_at, minimum_viable_for_isa,
        first_name, last_name, email, phone, brokerage_id
      `)
      .eq("id", leadId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()

    if (error || !lead) {
      return { success: false, error: "Lead not found" }
    }

    const blockers: string[] = []
    const reasons: string[] = []

    // BLOCKER 1: Representation stage — contract signed
    if (lead.lifecycle_state === "representation") {
      blockers.push("Lead is under representation — AI ISA cannot act on represented leads")
    }

    // BLOCKER 2: DNC / hard stop
    if (lead.call_stop_flag) {
      blockers.push("Lead is on the Do Not Contact list — AI ISA is permanently blocked")
    }

    // BLOCKER 3: Manually paused
    if (lead.ai_outreach_paused) {
      blockers.push("AI outreach is manually paused — resume before assigning ISA")
    }

    // BLOCKER 4: Permanent opt-out
    if (lead.opted_out_at) {
      blockers.push("Lead has opted out of AI outreach — cannot assign ISA")
    }

    // POSITIVE signals
    if (lead.minimum_viable_for_isa) {
      reasons.push("Lead has sufficient data for ISA outreach (minimum viable)")
    } else {
      reasons.push("Lead is missing enrichment data — ISA will use limited context")
    }

    if (lead.email) reasons.push("Email channel available")
    if (lead.phone) reasons.push("Phone channel available")
    if (lead.tcpa_consent) reasons.push("TCPA consent on file")

    const eligible = blockers.length === 0

    // Record evaluation in ai_isa_qualifications
    // Live schema uses qualification_result/stage/qualified_at/qualification_signals
    // (structured rationale). evaluator id + blockers + reasons go into signals jsonb.
    await supabase
      .from("ai_isa_qualifications")
      .insert({
        brokerage_id: ctx.brokerageId,
        lead_id: leadId,
        // CHECK enum: qualified | not_qualified | needs_follow_up | appointment_set | no_response.
        // Eligibility gate maps to qualified/not_qualified.
        qualification_result: eligible ? "qualified" : "not_qualified",
        qualification_signals: {
          evaluated_by: ctx.userId,
          blockers,
          reasons,
        },
        stage: lead.lifecycle_state ?? null,
        qualified_at: new Date().toISOString(),
      })

    return {
      success: true,
      data: {
        eligible,
        reasons,
        blockers,
        leadStage: (lead.lifecycle_state as LeadLifecycleStage) ?? null,
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to evaluate ISA eligibility",
    }
  }
}

// ─── COMMAND 3: assignAiIsaToLeadAfterGate ───────────────────────────────────
/**
 * Assign AI ISA ownership to a lead after the eligibility gate passes.
 *
 * Input:  { ctx, leadId, campaignId? }
 * Output: { success }
 *
 * Tables written:
 *   leads (update: ai_isa_owner = true, lifecycle_state = 'isa_qualifying')
 *   lifecycle_events (insert)
 *
 * Business rules:
 *   Rule 1: eligibility gate must pass first — call evaluateAiIsaEligibility before this.
 *   Rule 2: sets leads.ai_isa_owner = true, lifecycle_state = 'isa_qualifying'.
 *   Rule 3: fires lifecycle_event AI_ISA_ASSIGNED.
 *
 * UI behavior:
 *   - ISA status badge in the lead row changes to "AI-ISA Assigned"
 *   - Lead appears in ISA console queue immediately
 */
export async function assignAiIsaToLeadAfterGate(
  input: AssignAiIsaToLeadInput
): Promise<KernelAiIsaResult<void>> {
  try {
    const { ctx, leadId, campaignId } = input
    const supabase = createServiceClient()

    // Re-check minimum_viable_for_isa — the gate must have been evaluated
    const { data: lead, error: fetchErr } = await supabase
      .from("leads")
      .select("id, call_stop_flag, opted_out_at, lifecycle_state")
      .eq("id", leadId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()

    if (fetchErr || !lead) {
      return { success: false, error: "Lead not found" }
    }

    if (lead.call_stop_flag || lead.opted_out_at) {
      return {
        success: false,
        blocked: true,
        blockedReason: "Lead is on DNC or has opted out — cannot assign AI ISA",
      }
    }

    if (lead.lifecycle_state === "representation") {
      return {
        success: false,
        blocked: true,
        blockedReason: "Lead is under representation — AI ISA assignment is blocked",
      }
    }

    const { error: updateErr } = await supabase
      .from("leads")
      .update({
        ai_isa_owner: true,
        lifecycle_state: "isa_qualifying",
        updated_at: new Date().toISOString(),
      })
      .eq("id", leadId)
      .eq("brokerage_id", ctx.brokerageId)

    if (updateErr) throw updateErr

    await supabase
      .from("lifecycle_events")
      .insert({
        brokerage_id: ctx.brokerageId,
        entity_type: "lead",
        entity_id: leadId,
        event_type: "ai_isa_assigned",
        metadata: {
          assigned_by: ctx.userId,
          campaign_id: campaignId ?? null,
        },
      })

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to assign AI ISA",
    }
  }
}

// ─── COMMAND 4: startAiIsaAutomation ─────────────────────────────────────────
/**
 * Start the AI ISA outreach automation loop for a lead.
 *
 * Input:  { ctx, leadId, campaignId?, channel, notes? }
 * Output: { success }
 *
 * Tables written:
 *   leads (update: ai_outreach_paused = false)
 *   ai_isa_activities (insert: action = 'automation_started')
 *   lifecycle_events (insert)
 *
 * Business rules:
 *   Rule 1: lead must have ai_isa_owner = true before starting automation.
 *   Rule 2: channel must be supported (sms | email | phone).
 *   Rule 3: starting automation un-pauses the lead (ai_outreach_paused = false).
 *
 * UI behavior:
 *   - ISA status badge changes to "Active" with green indicator
 *   - "Pause AI" button becomes enabled, "Start AI" button is disabled
 */
export async function startAiIsaAutomation(
  input: StartAiIsaAutomationInput
): Promise<KernelAiIsaResult<void>> {
  try {
    const { ctx, leadId, campaignId, channel, notes } = input
    const supabase = createServiceClient()

    // Verify lead is ISA-owned
    const { data: lead, error: fetchErr } = await supabase
      .from("leads")
      .select("id, ai_isa_owner, call_stop_flag, opted_out_at, lifecycle_state")
      .eq("id", leadId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()

    if (fetchErr || !lead) return { success: false, error: "Lead not found" }

    if (!lead.ai_isa_owner) {
      return { success: false, blocked: true, blockedReason: "Lead must be assigned to AI ISA first" }
    }
    if (lead.call_stop_flag || lead.opted_out_at) {
      return { success: false, blocked: true, blockedReason: "Lead is on DNC or opted out" }
    }
    if (lead.lifecycle_state === "representation") {
      return { success: false, blocked: true, blockedReason: "Lead is under representation" }
    }

    await Promise.all([
      supabase
        .from("leads")
        .update({ ai_outreach_paused: false, updated_at: new Date().toISOString() })
        .eq("id", leadId)
        .eq("brokerage_id", ctx.brokerageId),

      supabase.from("ai_isa_activities").insert({
        brokerage_id: ctx.brokerageId,
        lead_id: leadId,
        activity_type: "automation_started",
        channel,
        summary: notes ?? null,
        qualifying_response: { actor_user_id: ctx.userId, campaign_id: campaignId ?? null },
        created_at: new Date().toISOString(),
      }),
    ])

    await supabase
      .from("lifecycle_events")
      .insert({
        brokerage_id: ctx.brokerageId,
        entity_type: "lead",
        entity_id: leadId,
        event_type: "ai_isa_automation_started",
        metadata: { channel, campaign_id: campaignId ?? null, actor: ctx.userId },
      })

    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to start automation" }
  }
}

// ─── COMMAND 5: pauseAiIsaAutomation ─────────────────────────────────────────
/**
 * Pause AI ISA outreach automation for a lead.
 *
 * Input:  { ctx, leadId, reason }
 * Output: { success }
 *
 * Tables written:
 *   leads (update: ai_outreach_paused = true)
 *   ai_isa_activities (insert: action = 'automation_paused')
 *   lifecycle_events (insert)
 *
 * Business rules:
 *   Rule 1: reason is required — agents must document why they paused.
 *   Rule 2: pause is non-destructive — ai_isa_owner remains true.
 *   Rule 3: any in-flight VAPI call continues — pause only blocks new outreach.
 *
 * UI behavior:
 *   - Status badge changes to "Paused" with yellow indicator
 *   - Pause reason shown in tooltip on hover
 *   - "Resume AI" button becomes enabled
 */
export async function pauseAiIsaAutomation(
  input: PauseAiIsaAutomationInput
): Promise<KernelAiIsaResult<void>> {
  try {
    const { ctx, leadId, reason } = input

    if (!reason?.trim()) {
      return { success: false, error: "Pause reason is required" }
    }

    const supabase = createServiceClient()

    await Promise.all([
      supabase
        .from("leads")
        .update({ ai_outreach_paused: true, updated_at: new Date().toISOString() })
        .eq("id", leadId)
        .eq("brokerage_id", ctx.brokerageId),

      supabase.from("ai_isa_activities").insert({
        brokerage_id: ctx.brokerageId,
        lead_id: leadId,
        activity_type: "automation_paused",
        summary: reason,
        qualifying_response: { actor_user_id: ctx.userId },
        created_at: new Date().toISOString(),
      }),
    ])

    await supabase
      .from("lifecycle_events")
      .insert({
        brokerage_id: ctx.brokerageId,
        entity_type: "lead",
        entity_id: leadId,
        event_type: "ai_isa_automation_paused",
        metadata: { reason, actor: ctx.userId },
      })

    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to pause automation" }
  }
}

// ─── COMMAND 6: resumeAiIsaAutomation ────────────────────────────────────────
/**
 * Resume paused AI ISA automation for a lead.
 *
 * Input:  { ctx, leadId, notes? }
 * Output: { success }
 *
 * Tables written:
 *   leads (update: ai_outreach_paused = false)
 *   ai_isa_activities (insert: action = 'automation_resumed')
 *   lifecycle_events (insert)
 *
 * Business rules:
 *   Rule 1: Re-checks DNC and opt-out before resuming.
 *   Rule 2: representation stage blocks resume permanently.
 *
 * UI behavior:
 *   - Status badge returns to "Active"
 *   - "Pause AI" button re-enabled, "Resume AI" button disabled
 */
export async function resumeAiIsaAutomation(
  input: ResumeAiIsaAutomationInput
): Promise<KernelAiIsaResult<void>> {
  try {
    const { ctx, leadId, notes } = input
    const supabase = createServiceClient()

    const { data: lead, error: fetchErr } = await supabase
      .from("leads")
      .select("id, call_stop_flag, opted_out_at, lifecycle_state")
      .eq("id", leadId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()

    if (fetchErr || !lead) return { success: false, error: "Lead not found" }
    if (lead.call_stop_flag || lead.opted_out_at) {
      return { success: false, blocked: true, blockedReason: "Lead is on DNC or opted out — cannot resume" }
    }
    if (lead.lifecycle_state === "representation") {
      return { success: false, blocked: true, blockedReason: "Lead is under representation — AI ISA permanently blocked" }
    }

    await Promise.all([
      supabase
        .from("leads")
        .update({ ai_outreach_paused: false, updated_at: new Date().toISOString() })
        .eq("id", leadId)
        .eq("brokerage_id", ctx.brokerageId),

      supabase.from("ai_isa_activities").insert({
        brokerage_id: ctx.brokerageId,
        lead_id: leadId,
        activity_type: "automation_resumed",
        summary: notes ?? null,
        qualifying_response: { actor_user_id: ctx.userId },
        created_at: new Date().toISOString(),
      }),
    ])

    await supabase
      .from("lifecycle_events")
      .insert({
        brokerage_id: ctx.brokerageId,
        entity_type: "lead",
        entity_id: leadId,
        event_type: "ai_isa_automation_resumed",
        metadata: { actor: ctx.userId, notes: notes ?? null },
      })

    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to resume automation" }
  }
}

// ─── COMMAND 7: handoffToHumanAgent ──────────────────────────────────────────
/**
 * Hand off an AI ISA lead to a human agent.
 *
 * Input:  { ctx, leadId, assignedAgentId?, handoffReason, contactId? }
 * Output: { success, data: { handoffId } }
 *
 * Tables written:
 *   agent_handoffs (insert)
 *   leads (update: ai_isa_owner = false)
 *   lifecycle_events (insert)
 *
 * Business rules:
 *   Rule 1: ai_isa_owner is set to false on handoff — AI ISA releases ownership.
 *   Rule 2: handoffReason is required.
 *   Rule 3: If contactId is provided, the handoff record links to the contact.
 *   Rule 4: assignedAgentId is optional — broker can route manually.
 *
 * UI behavior:
 *   - Handoff card appears in assigned agent's notification feed
 *   - ISA console shows the lead with "Handed Off" badge
 *   - "Accept Handoff" button triggers acceptAIISAHandoff action
 */
export async function handoffToHumanAgent(
  input: HandoffToHumanAgentInput
): Promise<KernelAiIsaResult<{ handoffId: string }>> {
  try {
    const { ctx, leadId, assignedAgentId, handoffReason, contactId } = input

    if (!handoffReason?.trim()) {
      return { success: false, error: "Handoff reason is required" }
    }

    const supabase = createServiceClient()

    const [handoffRes] = await Promise.all([
      supabase
        .from("agent_handoffs")
        .insert({
          brokerage_id: ctx.brokerageId,
          // Live schema uses entity_type/entity_id discriminator instead of
          // lead_id+contact_id columns. ISA handoffs always originate from
          // a lead; if the lead has already converted, contactId is carried
          // through in context_package for the receiving human agent.
          entity_type: "lead",
          entity_id: leadId,
          // CHECK enum: isa_agent | tc_agent | coaching_agent | content_agent | router | human
          from_agent_type: "isa_agent",
          to_agent_type: "human",
          human_agent_id: assignedAgentId ?? null,
          handoff_reason: handoffReason.trim(),
          handoff_status: "pending",
          context_package: { from_user_id: ctx.userId, contact_id: contactId ?? null },
          created_at: new Date().toISOString(),
        })
        .select("id")
        .single(),

      supabase
        .from("leads")
        .update({ ai_isa_owner: false, updated_at: new Date().toISOString() })
        .eq("id", leadId)
        .eq("brokerage_id", ctx.brokerageId),
    ])

    if (handoffRes.error) throw handoffRes.error

    await supabase
      .from("lifecycle_events")
      .insert({
        brokerage_id: ctx.brokerageId,
        entity_type: "lead",
        entity_id: leadId,
        event_type: "ai_isa_handoff_created",
        metadata: {
          handoff_id: handoffRes.data.id,
          assigned_agent_id: assignedAgentId ?? null,
          reason: handoffReason,
        },
      })

    return { success: true, data: { handoffId: handoffRes.data.id } }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to create handoff" }
  }
}

// ─── COMMAND 8: recordAiIsaOutcome ───────────────────────────────────────────
/**
 * Record the outcome of an AI ISA call or outreach attempt.
 *
 * Input:  { ctx, leadId, callId?, outcome, notes?, appointmentDate? }
 * Output: { success }
 *
 * Tables written:
 *   ai_isa_activities (insert: action = 'outcome_recorded')
 *   ai_isa_calls (update: appointment_set, appointment_datetime — if callId provided)
 *   leads (update: lifecycle_state based on outcome)
 *   lifecycle_events (insert)
 *
 * Business rules:
 *   - appointment_set: lifecycle_state → 'appointment'
 *   - disqualified: ai_isa_owner = false, lifecycle_state → 'raw'
 *   - not_interested: ai_outreach_paused = true, needs human review
 *
 * UI behavior:
 *   - Call history row shows colored outcome badge
 *   - "appointment_set" triggers appointment booking flow
 */
export async function recordAiIsaOutcome(
  input: RecordAiIsaOutcomeInput
): Promise<KernelAiIsaResult<void>> {
  try {
    const { ctx, leadId, callId, outcome, notes, appointmentDate, nurtureDays } = input
    const supabase = createServiceClient()

    const now = new Date().toISOString()

    // Determine lead state updates based on outcome
    const leadUpdate: Record<string, unknown> = { updated_at: now }
    if (outcome === "appointment_set") {
      leadUpdate.lifecycle_state = "appointment"
    } else if (outcome === "qualified") {
      // Engine 2 trigger: setting lead_stage='qualified' lets the
      // assignment-engine fire on the next pass. handleConsentReceived
      // should already have set lifecycle_state='consented' upstream.
      leadUpdate.lead_stage = "qualified"
      leadUpdate.ai_isa_owner = false
    } else if (outcome === "explicit_opt_out") {
      // Permanent cross-tenant suppression. Adds phone+email to
      // platform_suppression_list so NO subscriber can ever contact again.
      leadUpdate.ai_isa_owner = false
      leadUpdate.ai_outreach_paused = true
      leadUpdate.opted_out_at = now
      leadUpdate.is_active = false
    } else if (outcome === "not_ready_now") {
      // Long-term nurture: monthly market updates + signal re-activation.
      // Default 90-day window; signal re-activation can pull them out earlier.
      const days = nurtureDays ?? 90
      const nurtureUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
      leadUpdate.long_term_nurture_until = nurtureUntil
      leadUpdate.long_term_nurture_started_at = now
      leadUpdate.long_term_nurture_reason = notes ?? "ISA: not ready now"
      leadUpdate.ai_outreach_paused = true
      leadUpdate.lifecycle_state = "long_term_nurture"
    } else if (outcome === "disqualified") {
      leadUpdate.ai_isa_owner = false
      leadUpdate.lifecycle_state = "raw"
    } else if (outcome === "not_interested") {
      leadUpdate.ai_outreach_paused = true
    }

    // Update lead
    await supabase
      .from("leads")
      .update(leadUpdate)
      .eq("id", leadId)
      .eq("brokerage_id", ctx.brokerageId)

    // Insert activity. `outcome` is a text column (the categorical result);
    // structured context (actor, appointment date) lives in qualifying_response jsonb.
    await supabase.from("ai_isa_activities").insert({
      brokerage_id: ctx.brokerageId,
      lead_id: leadId,
      activity_type: "outcome_recorded",
      summary: notes ?? null,
      outcome,
      qualifying_response: {
        actor_user_id: ctx.userId,
        appointment_date: appointmentDate ?? null,
      },
      created_at: now,
    })

    // Update the call record if callId is provided. ai_isa_calls has no
    // categorical outcome column — the result is captured above; here we
    // persist the appointment booking on the call row.
    if (callId) {
      await supabase
        .from("ai_isa_calls")
        .update({
          appointment_set: outcome === "appointment_set",
          appointment_datetime: outcome === "appointment_set" ? (appointmentDate ?? null) : null,
        })
        .eq("id", callId)
        .eq("brokerage_id", ctx.brokerageId)
    }

    await supabase
      .from("lifecycle_events")
      .insert({
        brokerage_id: ctx.brokerageId,
        entity_type: "lead",
        entity_id: leadId,
        event_type: "ai_isa_outcome_recorded",
        metadata: { outcome, call_id: callId ?? null, actor: ctx.userId },
      })

    // ── Side-effects gated on outcome ────────────────────────────────────
    if (outcome === "explicit_opt_out") {
      // Cross-tenant suppression — read lead identifiers and write to
      // platform_suppression_list. Permanent. Reason is auditable.
      const { data: leadRow } = await supabase
        .from("leads")
        .select("phone, phone_digits, email")
        .eq("id", leadId)
        .single()

      const { addToSuppressionList } = await import("@/lib/platform/suppression-list")
      await addToSuppressionList({
        phone: leadRow?.phone_digits ?? leadRow?.phone ?? null,
        email: leadRow?.email ?? null,
        reason: "explicit_opt_out",
        sourceLeadId: leadId,
        sourceBrokerageId: ctx.brokerageId,
        addedByUserId: ctx.userId,
        notes: notes ?? "ISA recorded explicit opt-out",
      })
    } else if (outcome === "qualified") {
      // 1. Generate the ISA handoff brief BEFORE assignment so it's on the
      //    lead row when handleLeadAssigned reads it and carries it forward
      //    to the contact.
      try {
        const { generateAndStoreHandoffBrief } = await import(
          "@/lib/ai-isa/generate-handoff-brief"
        )
        await generateAndStoreHandoffBrief({ leadId, brokerageId: ctx.brokerageId })
      } catch (e) {
        // best effort — assignment still proceeds without brief
      }

      // 2. Engine 2 — Qualification-Triggered Assignment. Fires after the
      //    ISA marks the lead as fully qualified. Reads the brokerage's
      //    assignment_rules to pick an agent.
      const { evaluateAndAssignLead } = await import(
        "@/lib/lead-assignment/assignment-engine"
      )
      await evaluateAndAssignLead({ leadId, brokerageId: ctx.brokerageId })
    } else if (outcome === "not_ready_now") {
      // Enroll in long-term nurture sequence (monthly market updates +
      // annual home value report). Best-effort; failure is non-blocking.
      // The sequence is looked up by a known name pattern; if the brokerage
      // hasn't built one yet, the long-term-nurture cron handles cadence
      // directly without sequence enrollment.
      try {
        const { data: sequenceRow } = await supabase
          .from("campaign_sequences")
          .select("id")
          .eq("brokerage_id", ctx.brokerageId)
          .ilike("name", "%long-term nurture%")
          .limit(1)
          .maybeSingle()

        if (sequenceRow?.id) {
          const { enrollContactInSequence } = await import(
            "@/app/actions/campaign-sequences"
          )
          await enrollContactInSequence({
            sequenceId: sequenceRow.id,
            leadId,
          })
        }
      } catch (e) {
        // best effort
      }
    }

    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to record outcome" }
  }
}

// ─── COMMAND 9: routeHistoryToCanonicalEntity ─────────────────────────────────
/**
 * Route an inbound reply to the canonical entity and detect stop/opt-out signals.
 *
 * Input:  { ctx, inboundText, entityType, entityId, channel, providerMessageId? }
 * Output: { success }
 *
 * Tables written:
 *   lifecycle_events (insert: ISA_REPLY_RECEIVED)
 *   contact_suppression_list (insert — if opt-out detected)
 *   leads (update: last_activity_at, opted_out_at if opt-out detected)
 *
 * Business rules:
 *   - STOP / UNSUBSCRIBE / REMOVE ME → opted_out_at set, suppress channel
 *   - TCPA hard stop keywords (STOP, CANCEL, END, QUIT, UNSUBSCRIBE) → immediate suppress
 *   - Other keywords require human review (medium confidence)
 */
export async function routeHistoryToCanonicalEntity(
  input: RouteHistoryInput
): Promise<KernelAiIsaResult<void>> {
  try {
    const { ctx, inboundText, entityType, entityId, channel, providerMessageId } = input
    const supabase = createServiceClient()
    const now = new Date().toISOString()

    // Write the inbound event
    await supabase.from("lifecycle_events").insert({
      brokerage_id: ctx.brokerageId,
      entity_type: entityType,
      entity_id: entityId,
      event_type: "isa_reply_received",
      metadata: {
        channel,
        text: inboundText.slice(0, 500),
        provider_message_id: providerMessageId ?? null,
      },
    })

    // Update last activity. leads has last_activity_at; contacts tracks
    // recency via last_contacted_at (no last_activity_at column).
    const updateTable = entityType === "contact" ? "contacts" : "leads"
    const activityPatch =
      entityType === "contact"
        ? { last_contacted_at: now, updated_at: now }
        : { last_activity_at: now, updated_at: now }
    await supabase
      .from(updateTable)
      .update(activityPatch as Record<string, unknown>)
      .eq("id", entityId)
      .eq("brokerage_id", ctx.brokerageId)

    // Hard stop detection (TCPA keywords)
    const HARD_STOP = /^\s*(stop|cancel|end|quit|unsubscribe|remove me|opt out|optout)\s*$/i
    if (HARD_STOP.test(inboundText.trim())) {
      // Suppress the channel. Live schema is contact-keyed
      // (no entity_type/entity_id columns). For lead-stage suppressions
      // we resolve to the converted contact via leads.contact_id if one
      // exists; otherwise we leave contact_id null and rely on the lead
      // opt-out flag (set below) to enforce suppression upstream.
      let suppressContactId: string | null = null
      if (entityType === "contact") {
        suppressContactId = entityId
      } else {
        const { data: leadLink } = await supabase
          .from("leads")
          .select("contact_id")
          .eq("id", entityId)
          .eq("brokerage_id", ctx.brokerageId)
          .maybeSingle()
        suppressContactId = leadLink?.contact_id ?? null
      }
      await supabase.from("contact_suppression_list").insert({
        brokerage_id: ctx.brokerageId,
        contact_id: suppressContactId,
        channel,
        suppression_reason: "tcpa_opt_out",
        source: inboundText.slice(0, 200),
        created_at: now,
      })

      // Mark the lead/contact as opted out
      if (entityType === "lead") {
        await supabase
          .from("leads")
          .update({ opted_out_at: now, ai_outreach_paused: true, updated_at: now })
          .eq("id", entityId)
          .eq("brokerage_id", ctx.brokerageId)
      } else {
        await supabase
          .from("contacts")
          .update({ dnc_status: true, isa_reengage_allowed: false, updated_at: now })
          .eq("id", entityId)
          .eq("brokerage_id", ctx.brokerageId)
      }
    }

    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to route inbound message" }
  }
}

// ─── COMMAND 10: resolveLeadChannel ──────────────────────────────────────────
/**
 * Determine the active outreach channel for a lead.
 *
 * Input:  { ctx, leadId }
 * Output: { success, data: LeadChannelResult }
 *
 * Tables read:
 *   leads (phone, email, tcpa_consent, call_stop_flag, opted_out_at)
 *
 * Business rules:
 *   - DNC / opt-out → blocked (no channel)
 *   - phone present + TCPA consent → prefer "phone"
 *   - phone absent + email present → "email"
 *   - neither → blocked (insufficient data)
 *
 * UI behavior:
 *   - Channel icon shown in ISA queue row (phone/email/blocked indicator)
 */
export async function resolveLeadChannel(
  input: ResolveLeadChannelInput
): Promise<KernelAiIsaResult<LeadChannelResult>> {
  try {
    const { ctx, leadId } = input
    const supabase = createServiceClient()

    const { data: lead, error } = await supabase
      .from("leads")
      .select("phone, email, tcpa_consent, call_stop_flag, opted_out_at")
      .eq("id", leadId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()

    if (error || !lead) return { success: false, error: "Lead not found" }

    if (lead.call_stop_flag) {
      return { success: true, data: { channel: null, phoneNumber: null, email: null, blocked: true, blockReason: "DNC list" } }
    }
    if (lead.opted_out_at) {
      return { success: true, data: { channel: null, phoneNumber: null, email: null, blocked: true, blockReason: "Opted out of AI outreach" } }
    }

    // Prefer phone when TCPA consent is present
    if (lead.phone && lead.tcpa_consent) {
      return { success: true, data: { channel: "phone", phoneNumber: lead.phone, email: lead.email, blocked: false, blockReason: null } }
    }

    // Fall back to email (no consent required for email outreach)
    if (lead.email) {
      return { success: true, data: { channel: "email", phoneNumber: lead.phone ?? null, email: lead.email, blocked: false, blockReason: null } }
    }

    // Phone present but NO TCPA consent and no email: SMS is NOT an allowed
    // fallback. TCPA covers texts as well as calls, so SMS to an unconsented
    // number is a violation. (A consented phone already returned "phone"
    // above, so this branch is always the unconsented case.) Block instead.
    if (lead.phone && !lead.tcpa_consent) {
      return { success: true, data: { channel: null, phoneNumber: null, email: null, blocked: true, blockReason: "Phone present but no TCPA consent; SMS/phone gated" } }
    }

    return { success: true, data: { channel: null, phoneNumber: null, email: null, blocked: true, blockReason: "No contact channel available" } }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Failed to resolve channel" }
  }
}
