"use server"

/**
 * app/actions/leads.ts
 *
 * Full lead lifecycle server actions.
 * RBAC: admin / broker / isa roles only. Agents CANNOT access raw leads.
 * All reads: scoped to brokerage_id. Agents excluded by role check.
 *
 * Canonical leads columns (from verified Supabase schema):
 *   id, brokerage_id, agent_id, first_name, last_name, email, phone,
 *   lead_score, lifecycle_state, lead_type, lead_stage, source,
 *   ai_isa_owner, ai_outreach_paused, tcpa_consent, preferred_channel,
 *   minimum_viable_for_isa, call_stop_flag, motivation_type, urgency_level,
 *   last_activity_at, last_contacted_at, stage_entered_at, days_in_stage,
 *   contact_id, is_active, created_at, updated_at, tags, notes
 */

import { createClient } from "@/lib/supabase/server"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { getAgentContext } from "@/lib/identity"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"

// ─── RBAC helpers ────────────────────────────────────────────────────────────

// SCOPE LADDER = THE TENANT-ADMIN ROSTER, PLUS 'isa'.
//
// DERIVED, not retyped. It used to be a literal
// ["admin","broker","broker_owner","broker_admin","isa"] — the tenant roster
// MINUS team_lead, by accident rather than by decision. That mattered under the
// owner's ruling that "in team or solo agent subscription, they can have an
// admin that sees everything": on a TEAM-tier tenant the admin who sees
// everything IS the team lead, and this file refused them from every lead
// surface it exports — read, qualify, assign, the lot — while
// lib/auth/resolve-user-role.ts#TENANT_ADMIN_USER_TYPES, is_brokerage_admin()
// (m466) and every other admin gate in the tree admitted them.
//
// The subtraction that IS deliberate lives in
// BROKERAGE_FINANCE_ADMIN_USER_TYPES, and it is spelled out there. Here the
// roster is taken whole and one operational role is ADDED: 'isa', the AI ISA
// seat, which works leads and nothing else.
const ISA_ALLOWED_ROLES = new Set([...TENANT_ADMIN_USER_TYPES, "isa"])

function assertISARole(userType: string): void {
  if (!ISA_ALLOWED_ROLES.has(userType)) {
    throw new Error(`Access denied: role "${userType}" cannot access lead management`)
  }
}

// ─── READ ─────────────────────────────────────────────────────────────────────

export async function getLeads(filters?: {
  lifecycle_state?: string
  lead_type?: string
  source?: string
  urgency_level?: string
  assigned_agent_id?: string
  ai_isa_owner?: boolean
  minimum_viable_for_isa?: boolean
  limit?: number
}) {
  try {
    const { brokerageId, userType } = await getAgentContext()
    assertISARole(userType)

    if (!brokerageId) return { success: true, leads: [] }

    const supabase = await createClient()
    let query = supabase
      .from("leads")
      .select(
        `id, brokerage_id, agent_id, first_name, last_name, email, phone,
         lead_score, lifecycle_state, lead_type, lead_stage, source,
         ai_isa_owner, ai_outreach_paused, tcpa_consent, preferred_channel,
         minimum_viable_for_isa, call_stop_flag, motivation_type, urgency_level,
         last_activity_at, last_contacted_at, stage_entered_at, days_in_stage,
         contact_id, is_active, created_at, updated_at, tags, notes, status`
      )
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true)
      .order("lead_score", { ascending: false, nullsFirst: false })

    if (filters?.lifecycle_state) query = query.eq("lifecycle_state", filters.lifecycle_state)
    if (filters?.lead_type) query = query.eq("lead_type", filters.lead_type)
    if (filters?.source) query = query.eq("source", filters.source)
    if (filters?.urgency_level) query = query.eq("urgency_level", filters.urgency_level)
    if (filters?.assigned_agent_id) query = query.eq("agent_id", filters.assigned_agent_id)
    if (filters?.ai_isa_owner !== undefined) query = query.eq("ai_isa_owner", filters.ai_isa_owner)
    if (filters?.minimum_viable_for_isa !== undefined) query = query.eq("minimum_viable_for_isa", filters.minimum_viable_for_isa)
    if (filters?.limit) query = query.limit(filters.limit)

    const { data, error } = await query
    if (error) return { success: false, error: error.message, leads: [] }
    return { success: true, leads: data || [] }
  } catch (err: any) {
    console.error("[leads] getLeads:", err.message)
    return { success: false, error: err.message, leads: [] }
  }
}

export async function getLeadById(leadId: string) {
  try {
    const { brokerageId, userType } = await getAgentContext()
    assertISARole(userType)

    if (!brokerageId) return { success: false, error: "No brokerage context", lead: null }

    const supabase = await createClient()
    const { data, error } = await supabase
      .from("leads")
      .select("*")
      .eq("id", leadId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    if (error) return { success: false, error: error.message, lead: null }
    if (!data) return { success: false, error: "Lead not found", lead: null }
    return { success: true, lead: data }
  } catch (err: any) {
    console.error("[leads] getLeadById:", err.message)
    return { success: false, error: err.message, lead: null }
  }
}

export async function getISAQueueLeads() {
  try {
    const { brokerageId, userType } = await getAgentContext()
    assertISARole(userType)

    if (!brokerageId) return { success: true, leads: [] }

    const supabase = await createClient()

    // ISA urgency queue: AI-owned, unassigned, viable, sorted by urgency + score
    const { data, error } = await supabase
      .from("leads")
      .select(
        `id, brokerage_id, agent_id, first_name, last_name, email, phone,
         lead_score, lifecycle_state, lead_type, source,
         ai_isa_owner, ai_outreach_paused, tcpa_consent, preferred_channel,
         minimum_viable_for_isa, call_stop_flag, motivation_type, urgency_level,
         last_activity_at, last_contacted_at, stage_entered_at, days_in_stage,
         contact_id, is_active, created_at, updated_at, tags, notes, status`
      )
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true)
      .eq("ai_isa_owner", true)
      .is("agent_id", null)
      .order("urgency_level", { ascending: true, nullsFirst: false })
      .order("lead_score", { ascending: false, nullsFirst: false })
      .limit(100)

    if (error) return { success: false, error: error.message, leads: [] }
    return { success: true, leads: data || [] }
  } catch (err: any) {
    console.error("[leads] getISAQueueLeads:", err.message)
    return { success: false, error: err.message, leads: [] }
  }
}

// ─── LIFECYCLE ACTIONS ───────────────────────────────────────────────────────

export async function qualifyLead(leadId: string) {
  try {
    const { userId, brokerageId, userType } = await getAgentContext()
    assertISARole(userType)
    if (!brokerageId) return { success: false, error: "No brokerage context" }

    const supabase = await createClient()

    const { data: lead, error: fetchError } = await supabase
      .from("leads")
      .select("id, lifecycle_state, brokerage_id")
      .eq("id", leadId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    if (fetchError || !lead) return { success: false, error: "Lead not found" }

    const { error } = await supabase
      .from("leads")
      .update({
        lifecycle_state: "isa_qualifying",
        stage_entered_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", leadId)
      .eq("brokerage_id", brokerageId)

    if (error) return { success: false, error: error.message }

    // Log activity
    await supabase.from("activities").insert({
      activity_type: "lead_qualified",
      entity_type: "lead",
      contact_id: null, // leads are NOT contacts — activities.contact_id FKs contacts(id)
      entity_id: lead.id,
      agent_id: await resolveAgentId(supabase as any, userId),
      brokerage_id: brokerageId,
      title: "Lead qualified",
      description: `Lifecycle moved to isa_qualifying`,
      status: "completed",
      created_at: new Date().toISOString(),
    }).then(() => {}, () => {})

    return { success: true }
  } catch (err: any) {
    console.error("[leads] qualifyLead:", err.message)
    return { success: false, error: err.message }
  }
}

/**
 * ISA/ADMIN MANUAL HANDOFF — a named person hands a specific lead to a specific
 * agent. Allowed by the owner's ruling ("brokerage admins can auto assign to
 * team leads and/or agents manually"); what is NOT allowed is the shape this
 * used to have.
 *
 * ── THE THIRD IMPLEMENTATION, AND WHY IT LEFT THE AGENT WITH NOTHING ────────
 *
 * This was a hand-rolled assignment: it updated `leads` directly, inserted its
 * own partial `assignment_log` row, and stopped. It never called
 * handleLeadAssigned, so it never ran the LEAD→CONTACT conversion — and under
 * the same ruling, "agents can only see contacts". The lead got an agent_id and
 * an 'assigned' lifecycle_state, the ledger got a row, the ISA's screen said it
 * worked … and the receiving agent's CRM showed nothing at all, forever. It also
 * skipped the SLA close, the LEAD_ASSIGNED kernel event and the agent
 * notification, all of which live in the canonical handler.
 *
 * It now rides the SAME handler as every other assignment path. That brings the
 * consent gate with it — handleLeadAssigned opens with
 * assertValidTransition('consented','assigned'), which THROWS on a lead that has
 * not consented, where this path previously assigned it silently.
 */
export async function assignLeadToAgent(leadId: string, agentId: string) {
  try {
    const { userId, brokerageId, userType } = await getAgentContext()
    assertISARole(userType)
    if (!brokerageId) return { success: false, error: "No brokerage context" }

    const supabase = await createClient()

    // The recipient must be an ACTIVE agent of THIS brokerage. `agentId` arrives
    // from the browser, and agents.id / users.id are disjoint spaces.
    const { data: agentRow, error: agentLookupError } = await supabase
      .from("agents")
      .select("id")
      .eq("id", agentId)
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true)
      .maybeSingle()

    // supabase-js RESOLVES a refused query: a swallowed error is
    // indistinguishable from "no such agent", and both must refuse.
    if (agentLookupError) return { success: false, error: "Could not verify that agent" }
    if (!agentRow) return { success: false, error: "Agent not found in brokerage" }

    // The lead must be in THIS brokerage — proved before anything is written,
    // through the cookie client so RLS applies to the check itself.
    const { data: leadRow, error: leadLookupError } = await supabase
      .from("leads")
      .select("id, agent_id, lead_score")
      .eq("id", leadId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (leadLookupError) return { success: false, error: "Could not read that lead" }
    if (!leadRow) return { success: false, error: "Lead not found in brokerage" }
    if (leadRow.agent_id) return { success: false, error: "Lead already has an assigned agent" }

    // THE canonical handoff: leads.agent_id + handed_to_agent_at, lifecycle
    // advance, assignment_log row, SLA close, LEAD_ASSIGNED, and the lossless
    // lead→contact conversion that is the only reason the agent can see it.
    const { handleLeadAssigned } = await import("@/lib/kernel/lead-acquisition-handlers")
    await handleLeadAssigned({
      leadId,
      brokerageId,
      agentId,
      method: "manual",
      scoreAtAssignment: leadRow.lead_score ?? 0,
    })

    // m489 keeps assignment_method to the METHOD alone; WHO decided goes here.
    await supabase
      .from("assignment_log")
      .update({ routing_reason: `[admin_manual] handed off by user ${userId} (${userType})` })
      .eq("lead_id", leadId)
      .eq("brokerage_id", brokerageId)
      .is("routing_reason", null)
      .then(() => {}, () => {})

    await supabase.from("activities").insert({
      activity_type: "lead_assigned",
      entity_type: "lead",
      contact_id: null, // leads are NOT contacts — activities.contact_id FKs contacts(id)
      entity_id: leadId,
      agent_id: await resolveAgentId(supabase as any, userId),
      brokerage_id: brokerageId,
      title: "Lead assigned to agent",
      description: `Agent ID: ${agentId}`,
      status: "completed",
      created_at: new Date().toISOString(),
    }).then(() => {}, () => {})

    return { success: true }
  } catch (err: any) {
    console.error("[leads] assignLeadToAgent:", err.message)
    return { success: false, error: err.message }
  }
}

// ─── AI-ISA CONTROLS ─────────────────────────────────────────────────────────

export async function pauseAIISA(leadId: string) {
  try {
    const { userId, brokerageId, userType } = await getAgentContext()
    assertISARole(userType)
    if (!brokerageId) return { success: false, error: "No brokerage context" }

    const supabase = await createClient()
    const { error } = await supabase
      .from("leads")
      .update({ ai_outreach_paused: true, updated_at: new Date().toISOString() })
      .eq("id", leadId)
      .eq("brokerage_id", brokerageId)

    if (error) return { success: false, error: error.message }

    await supabase.from("activities").insert({
      activity_type: "ai_isa_paused",
      entity_type: "lead",
      contact_id: null, // leads are NOT contacts — activities.contact_id FKs contacts(id)
      entity_id: leadId,
      agent_id: await resolveAgentId(supabase as any, userId),
      brokerage_id: brokerageId,
      title: "AI-ISA outreach paused",
      status: "completed",
      created_at: new Date().toISOString(),
    }).then(() => {}, () => {})

    return { success: true }
  } catch (err: any) {
    console.error("[leads] pauseAIISA:", err.message)
    return { success: false, error: err.message }
  }
}

export async function resumeAIISA(leadId: string) {
  try {
    const { userId, brokerageId, userType } = await getAgentContext()
    assertISARole(userType)
    if (!brokerageId) return { success: false, error: "No brokerage context" }

    const supabase = await createClient()
    const { error } = await supabase
      .from("leads")
      .update({ ai_outreach_paused: false, updated_at: new Date().toISOString() })
      .eq("id", leadId)
      .eq("brokerage_id", brokerageId)

    if (error) return { success: false, error: error.message }

    await supabase.from("activities").insert({
      activity_type: "ai_isa_resumed",
      entity_type: "lead",
      contact_id: null, // leads are NOT contacts — activities.contact_id FKs contacts(id)
      entity_id: leadId,
      agent_id: await resolveAgentId(supabase as any, userId),
      brokerage_id: brokerageId,
      title: "AI-ISA outreach resumed",
      status: "completed",
      created_at: new Date().toISOString(),
    }).then(() => {}, () => {})

    return { success: true }
  } catch (err: any) {
    console.error("[leads] resumeAIISA:", err.message)
    return { success: false, error: err.message }
  }
}

export async function handOffToHumanAgent(leadId: string, targetAgentId?: string) {
  try {
    const { userId, brokerageId, userType, agentId } = await getAgentContext()
    assertISARole(userType)
    if (!brokerageId) return { success: false, error: "No brokerage context" }

    const supabase = await createClient()

    // If a specific agent is given, verify they belong to the brokerage
    let resolvedAgentId = targetAgentId ?? null
    if (targetAgentId) {
      const { data: agentRow } = await supabase
        .from("agents")
        .select("id")
        .eq("id", targetAgentId)
        .eq("brokerage_id", brokerageId)
        .maybeSingle()
      if (!agentRow) return { success: false, error: "Target agent not found in brokerage" }
    }

    const { error } = await supabase
      .from("leads")
      .update({
        ai_isa_owner: false,
        ai_outreach_paused: true,
        agent_id: resolvedAgentId,
        lifecycle_state: resolvedAgentId ? "assigned" : "isa_qualifying",
        handed_to_agent_at: resolvedAgentId ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", leadId)
      .eq("brokerage_id", brokerageId)

    if (error) return { success: false, error: error.message }

    // Log the handoff
    await supabase.from("agent_handoffs").insert({
      brokerage_id: brokerageId,
      entity_type: "lead",
      entity_id: leadId,
      // CHECK enum: isa_agent | tc_agent | coaching_agent | content_agent | router | human
      from_agent_type: "isa_agent",
      to_agent_type: "human",
      human_agent_id: resolvedAgentId,
      handoff_reason: "manual_handoff",
      handoff_status: "completed",
      completed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }).then(() => {}, () => {})

    await supabase.from("activities").insert({
      activity_type: "ai_isa_handoff",
      entity_type: "lead",
      contact_id: null, // leads are NOT contacts — activities.contact_id FKs contacts(id)
      entity_id: leadId,
      agent_id: await resolveAgentId(supabase as any, userId),
      brokerage_id: brokerageId,
      title: "AI-ISA handed off to human agent",
      description: resolvedAgentId ? `Assigned to agent: ${resolvedAgentId}` : "Queued for manual assignment",
      status: "completed",
      created_at: new Date().toISOString(),
    }).then(() => {}, () => {})

    return { success: true }
  } catch (err: any) {
    console.error("[leads] handOffToHumanAgent:", err.message)
    return { success: false, error: err.message }
  }
}

// ─── AI OUTREACH TRIGGER ─────────────────────────────────────────────────────

export async function initiateAIOutreach(leadId: string) {
  try {
    const { brokerageId, userType } = await getAgentContext()
    assertISARole(userType)
    if (!brokerageId) return { success: false, error: "No brokerage context" }

    // Delegate to the full AI-ISA engagement action
    const { initiateAIISAEngagement } = await import("@/app/actions/ai-isa/initiate-engagement")
    const result = await initiateAIISAEngagement(leadId)
    return result
  } catch (err: any) {
    console.error("[leads] initiateAIOutreach:", err.message)
    return { success: false, error: err.message }
  }
}

// ─── AGENTS LIST (for assignment dropdown) ───────────────────────────────────

export async function getBrokerageAgents() {
  try {
    const { brokerageId, userType } = await getAgentContext()
    assertISARole(userType)
    if (!brokerageId) return { success: true, agents: [] }

    const supabase = await createClient()
    const { data, error } = await supabase
      .from("agents")
      .select("id, brokerage_id, user_id, is_active")
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true)
      .order("created_at", { ascending: false })

    if (error) return { success: false, error: error.message, agents: [] }

    // Get names from users table
    const userIds = (data || []).map((a) => a.user_id).filter(Boolean)
    let usersMap: Record<string, { first_name: string; last_name: string; email: string }> = {}

    if (userIds.length > 0) {
      const { data: usersData } = await supabase
        .from("users")
        .select("id, first_name, last_name, email")
        .in("id", userIds)

      usersMap = Object.fromEntries((usersData || []).map((u) => [u.id, u]))
    }

    const agents = (data || []).map((a) => ({
      id: a.id,
      user_id: a.user_id,
      first_name: usersMap[a.user_id]?.first_name ?? "",
      last_name: usersMap[a.user_id]?.last_name ?? "",
      email: usersMap[a.user_id]?.email ?? "",
    }))

    return { success: true, agents }
  } catch (err: any) {
    console.error("[leads] getBrokerageAgents:", err.message)
    return { success: false, error: err.message, agents: [] }
  }
}

// ─── ISA OUTREACH HISTORY ─────────────────────────────────────────────────────

export async function getLeadOutreachHistory(leadId: string) {
  try {
    const { brokerageId, userType } = await getAgentContext()
    assertISARole(userType)
    if (!brokerageId) return { success: true, history: [] }

    const supabase = await createClient()
    const { data, error } = await supabase
      .from("isa_outreach_log")
      .select("id, lead_id, channel, subject, body_snippet, status, sent_at, opened_at, replied_at, compliance_passed, created_at")
      .eq("lead_id", leadId)
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false })
      .limit(20)

    if (error) return { success: false, error: error.message, history: [] }
    return { success: true, history: data || [] }
  } catch (err: any) {
    console.error("[leads] getLeadOutreachHistory:", err.message)
    return { success: false, error: err.message, history: [] }
  }
}

// ─── LEAD STATS ──────────────────────────────────────────────────────────────

export async function getLeadStats() {
  try {
    const { brokerageId, userType } = await getAgentContext()
    assertISARole(userType)
    if (!brokerageId) return { success: true, stats: null }

    const supabase = await createClient()

    const [
      { count: total },
      { count: active_isa },
      { count: paused },
      { count: assigned },
      { count: hot },
    ] = await Promise.all([
      supabase.from("leads").select("*", { count: "exact", head: true }).eq("brokerage_id", brokerageId).eq("is_active", true),
      supabase.from("leads").select("*", { count: "exact", head: true }).eq("brokerage_id", brokerageId).eq("is_active", true).eq("ai_isa_owner", true).is("agent_id", null),
      supabase.from("leads").select("*", { count: "exact", head: true }).eq("brokerage_id", brokerageId).eq("is_active", true).eq("ai_outreach_paused", true),
      supabase.from("leads").select("*", { count: "exact", head: true }).eq("brokerage_id", brokerageId).eq("is_active", true).not("agent_id", "is", null),
      supabase.from("leads").select("*", { count: "exact", head: true }).eq("brokerage_id", brokerageId).eq("is_active", true).eq("urgency_level", "hot"),
    ])

    return {
      success: true,
      stats: {
        total: total ?? 0,
        active_isa: active_isa ?? 0,
        paused: paused ?? 0,
        assigned: assigned ?? 0,
        hot: hot ?? 0,
      },
    }
  } catch (err: any) {
    console.error("[leads] getLeadStats:", err.message)
    return { success: false, error: err.message, stats: null }
  }
}
