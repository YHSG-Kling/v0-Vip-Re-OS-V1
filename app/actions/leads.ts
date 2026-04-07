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
import { getAgentContext } from "@/lib/identity"

// ─── RBAC helpers ────────────────────────────────────────────────────────────

const ISA_ALLOWED_ROLES = new Set(["admin", "broker", "broker_admin", "superadmin", "isa"])

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
      contact_id: lead.id, // activities.contact_id stores entity ref
      agent_id: userId,
      brokerage_id: brokerageId,
      title: "Lead qualified",
      description: `Lifecycle moved to isa_qualifying`,
      status: "completed",
      created_at: new Date().toISOString(),
    }).catch(() => {})

    return { success: true }
  } catch (err: any) {
    console.error("[leads] qualifyLead:", err.message)
    return { success: false, error: err.message }
  }
}

export async function assignLeadToAgent(leadId: string, agentId: string) {
  try {
    const { userId, brokerageId, userType } = await getAgentContext()
    assertISARole(userType)
    if (!brokerageId) return { success: false, error: "No brokerage context" }

    const supabase = await createClient()

    // Verify agent belongs to brokerage
    const { data: agentRow } = await supabase
      .from("agents")
      .select("id")
      .eq("id", agentId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    if (!agentRow) return { success: false, error: "Agent not found in brokerage" }

    const { error } = await supabase
      .from("leads")
      .update({
        agent_id: agentId,
        lifecycle_state: "assigned",
        ai_isa_owner: false,
        handed_to_agent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", leadId)
      .eq("brokerage_id", brokerageId)

    if (error) return { success: false, error: error.message }

    await supabase.from("assignment_log").insert({
      lead_id: leadId,
      agent_id: agentId,
      brokerage_id: brokerageId,
      assignment_method: "manual",
      claimed: false,
      created_at: new Date().toISOString(),
    }).catch(() => {})

    await supabase.from("activities").insert({
      activity_type: "lead_assigned",
      entity_type: "lead",
      contact_id: leadId,
      agent_id: userId,
      brokerage_id: brokerageId,
      title: "Lead assigned to agent",
      description: `Agent ID: ${agentId}`,
      status: "completed",
      created_at: new Date().toISOString(),
    }).catch(() => {})

    return { success: true }
  } catch (err: any) {
    console.error("[leads] assignLeadToAgent:", err.message)
    return { success: false, error: err.message }
  }
}

export async function convertLeadToContact(leadId: string) {
  try {
    const { userId, brokerageId, userType, agentId } = await getAgentContext()
    assertISARole(userType)
    if (!brokerageId) return { success: false, error: "No brokerage context" }

    const supabase = await createClient()

    const { data: lead, error: fetchErr } = await supabase
      .from("leads")
      .select("*")
      .eq("id", leadId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    if (fetchErr || !lead) return { success: false, error: "Lead not found" }
    if (lead.contact_id) return { success: false, error: "Lead already converted", contactId: lead.contact_id }

    // Create contact row
    const { data: contact, error: contactErr } = await supabase
      .from("contacts")
      .insert({
        first_name: lead.first_name ?? null,
        last_name: lead.last_name ?? null,
        email: lead.email ?? null,
        phone: lead.phone ?? null,
        contact_type: lead.lead_type === "seller" ? "seller" : "buyer",
        status: "active",
        source: lead.source ?? null,
        brokerage_id: brokerageId,
        agent_id: lead.agent_id ?? agentId ?? null,
        tcpa_consent: lead.tcpa_consent ?? false,
        tcpa_consent_date: lead.tcpa_consent_at ?? null,
        preferred_channel: lead.preferred_channel ?? "email",
        call_stop_flag: lead.call_stop_flag ?? false,
        isa_reengage_allowed: true,
        dnc_status: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select("id")
      .single()

    if (contactErr || !contact) return { success: false, error: contactErr?.message ?? "Failed to create contact" }

    // Link lead → contact and mark converted
    await supabase
      .from("leads")
      .update({
        contact_id: contact.id,
        lifecycle_state: "representation",
        converted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", leadId)

    await supabase.from("activities").insert({
      activity_type: "lead_converted",
      entity_type: "lead",
      contact_id: contact.id,
      agent_id: userId,
      brokerage_id: brokerageId,
      title: "Lead converted to contact",
      description: `Contact ID: ${contact.id}`,
      status: "completed",
      created_at: new Date().toISOString(),
    }).catch(() => {})

    return { success: true, contactId: contact.id }
  } catch (err: any) {
    console.error("[leads] convertLeadToContact:", err.message)
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
      contact_id: leadId,
      agent_id: userId,
      brokerage_id: brokerageId,
      title: "AI-ISA outreach paused",
      status: "completed",
      created_at: new Date().toISOString(),
    }).catch(() => {})

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
      contact_id: leadId,
      agent_id: userId,
      brokerage_id: brokerageId,
      title: "AI-ISA outreach resumed",
      status: "completed",
      created_at: new Date().toISOString(),
    }).catch(() => {})

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
      from_agent_type: "ai_isa",
      to_agent_type: "human",
      human_agent_id: resolvedAgentId,
      handoff_reason: "manual_handoff",
      handoff_status: "completed",
      completed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }).catch(() => {})

    await supabase.from("activities").insert({
      activity_type: "ai_isa_handoff",
      entity_type: "lead",
      contact_id: leadId,
      agent_id: userId,
      brokerage_id: brokerageId,
      title: "AI-ISA handed off to human agent",
      description: resolvedAgentId ? `Assigned to agent: ${resolvedAgentId}` : "Queued for manual assignment",
      status: "completed",
      created_at: new Date().toISOString(),
    }).catch(() => {})

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
      .select("id, brokerage_id, user_id, active")
      .eq("brokerage_id", brokerageId)
      .eq("active", true)
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
