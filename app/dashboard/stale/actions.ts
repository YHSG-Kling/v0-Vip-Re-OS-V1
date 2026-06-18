"use server"

/**
 * Stale Lead + Stale Contact dashboard.
 *
 * Re-computes on load because the stale-lead-monitor / stale-contact-monitor
 * crons don't persist their results to a queryable table — they just trigger
 * SLA breaches + ISA re-engagement and log counts.
 *
 * Stale leads  = unassigned for 7+ days, OR assigned but no activity in 7d
 * Stale contacts = assigned, not DNC, no activity in 14d (per-brokerage tunable)
 *
 * Per-agent scope: each agent sees their assigned-but-stale rows. Brokers see
 * unassigned brokerage-wide rows too.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { initiateAIISAContactEngagement } from "@/app/actions/ai-isa/initiate-contact-engagement"

const STALE_LEAD_DAYS = 7

export interface StaleLeadRow {
  id:               string
  firstName:        string | null
  lastName:         string | null
  email:            string | null
  phone:            string | null
  leadStage:        string | null
  source:           string | null
  isAssigned:       boolean
  daysStale:        number
  lastActivityAt:   string | null
  staleReason:      "no_assignment" | "no_recent_activity"
}

export interface StaleContactRow {
  id:               string
  firstName:        string | null
  lastName:         string | null
  email:            string | null
  phone:            string | null
  status:           string | null
  contactType:      string | null
  daysStale:        number
  lastContactedAt:  string | null
  isaReengageAllowed: boolean
}

export interface StaleLoad {
  myStaleLeads:        StaleLeadRow[]
  unassignedStaleLeads: StaleLeadRow[]
  myStaleContacts:     StaleContactRow[]
  isBroker:            boolean
  staleThresholdDays:  number
}

const BROKER_ROLES = new Set(["broker", "broker_admin", "admin", "superadmin", "team_lead"])

export async function loadStaleQueue(): Promise<{ data: StaleLoad } | { error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: "Not authenticated" }

  const svc = createServiceClient()
  const [{ data: agentRow }, { data: userRow }] = await Promise.all([
    svc.from("agents").select("id, brokerage_id").eq("user_id", user.id).maybeSingle(),
    svc.from("users").select("brokerage_id, user_type").eq("id", user.id).maybeSingle(),
  ])
  if (!agentRow?.id || !agentRow.brokerage_id) return { error: "No agent profile" }
  const brokerageId = agentRow.brokerage_id
  const isBroker = BROKER_ROLES.has((userRow?.user_type ?? "") as string)

  const staleLeadCutoff = new Date(Date.now() - STALE_LEAD_DAYS * 86_400_000).toISOString()

  // Brokerage stale-contact threshold (matches the cron's source-of-truth).
  const { data: brokerageRow } = await svc
    .from("global_settings")
    .select("additional_settings")
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  const settings = brokerageRow?.additional_settings as Record<string, unknown> | null
  const staleContactDays =
    typeof settings?.isa_ghost_threshold_days === "number" ? settings.isa_ghost_threshold_days : 14
  const staleContactCutoff = new Date(Date.now() - staleContactDays * 86_400_000).toISOString()

  // ── 1. Unassigned stale leads (broker-only) ────────────────────────────────
  let unassignedStaleLeads: StaleLeadRow[] = []
  if (isBroker) {
    const { data: rows } = await svc
      .from("leads")
      .select("id, first_name, last_name, email, phone, lead_stage, source, created_at")
      .eq("brokerage_id", brokerageId)
      .is("agent_id", null)
      .eq("is_active", true)
      .lt("created_at", staleLeadCutoff)
      .order("created_at", { ascending: true })
      .limit(50)
    unassignedStaleLeads = (rows ?? []).map((r: any) => ({
      id:             r.id,
      firstName:      r.first_name,
      lastName:       r.last_name,
      email:          r.email,
      phone:          r.phone,
      leadStage:      r.lead_stage,
      source:         r.source,
      isAssigned:     false,
      daysStale:      Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86_400_000),
      lastActivityAt: r.created_at,
      staleReason:    "no_assignment" as const,
    }))
  }

  // ── 2. MY stale leads (assigned to me, no recent activity) ─────────────────
  const { data: assignedLeads } = await svc
    .from("leads")
    .select("id, first_name, last_name, email, phone, lead_stage, source, created_at")
    .eq("brokerage_id", brokerageId)
    .eq("agent_id", agentRow.id)
    .eq("is_active", true)
    .limit(200)

  const myLeadIds = (assignedLeads ?? []).map((l: any) => l.id)
  const myLeadActivityMap = new Map<string, string>()
  if (myLeadIds.length > 0) {
    const { data: activityRows } = await svc
      .from("lifecycle_events")
      .select("entity_id, created_at")
      .eq("entity_type", "lead")
      .in("entity_id", myLeadIds)
      .order("created_at", { ascending: false })
      .limit(2000)
    for (const a of (activityRows ?? []) as any[]) {
      if (!myLeadActivityMap.has(a.entity_id)) {
        myLeadActivityMap.set(a.entity_id, a.created_at)
      }
    }
  }

  const myStaleLeads: StaleLeadRow[] = []
  for (const l of (assignedLeads ?? []) as any[]) {
    const lastActivity = myLeadActivityMap.get(l.id) ?? l.created_at
    const daysSince = Math.floor((Date.now() - new Date(lastActivity).getTime()) / 86_400_000)
    if (daysSince < STALE_LEAD_DAYS) continue
    myStaleLeads.push({
      id:             l.id,
      firstName:      l.first_name,
      lastName:       l.last_name,
      email:          l.email,
      phone:          l.phone,
      leadStage:      l.lead_stage,
      source:         l.source,
      isAssigned:     true,
      daysStale:      daysSince,
      lastActivityAt: lastActivity,
      staleReason:    "no_recent_activity" as const,
    })
  }
  myStaleLeads.sort((a, b) => b.daysStale - a.daysStale)

  // ── 3. MY stale contacts (mirror of stale-contact-monitor cron query) ──────
  const { data: contactRows } = await svc
    .from("contacts")
    .select("id, first_name, last_name, email, phone, status, contact_type, dnc_status, isa_reengage_allowed, created_at, updated_at")
    .eq("brokerage_id", brokerageId)
    .eq("agent_id", agentRow.id)
    .eq("dnc_status", false)
    .neq("status", "archived")
    .neq("status", "inactive")
    .lt("updated_at", staleContactCutoff)
    .order("updated_at", { ascending: true })
    .limit(100)

  const myStaleContacts: StaleContactRow[] = (contactRows ?? []).map((c: any) => ({
    id:                 c.id,
    firstName:          c.first_name,
    lastName:           c.last_name,
    email:              c.email,
    phone:              c.phone,
    status:             c.status,
    contactType:        c.contact_type,
    daysStale:          Math.floor((Date.now() - new Date(c.updated_at ?? c.created_at).getTime()) / 86_400_000),
    lastContactedAt:    c.updated_at ?? c.created_at,
    isaReengageAllowed: c.isa_reengage_allowed !== false,
  }))

  return {
    data: { myStaleLeads, unassignedStaleLeads, myStaleContacts, isBroker, staleThresholdDays: staleContactDays },
  }
}

/**
 * Claim an unassigned stale lead — assigns to the current agent.
 * Restricted to broker/admin/team-lead roles. Agents may NOT self-assign
 * leads from the unassigned pool; lead routing is an admin responsibility.
 *
 * Canonical business process: leads are AI-ISA + brokerage owned while
 * unconsented — a human may only take ownership AFTER the ISA has qualified
 * (lead_stage='qualified' + consent), and taking ownership CONVERTS the lead
 * to a contact via the kernel handler (assignment_log + lifecycle + canonical
 * lossless conversion). This action previously stamped agent_id directly on
 * the lead with no gate and no conversion — a side door around ISA ownership.
 */
export async function claimStaleLead(leadId: string): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  const svc = createServiceClient()
  const [{ data: agentRow }, { data: userRow }] = await Promise.all([
    svc.from("agents").select("id, brokerage_id").eq("user_id", user.id).maybeSingle(),
    svc.from("users").select("user_type").eq("id", user.id).maybeSingle(),
  ])
  if (!agentRow?.id) return { success: false, error: "No agent profile" }
  if (!BROKER_ROLES.has((userRow?.user_type ?? "") as string)) {
    return { success: false, error: "Only brokers / admins can assign leads" }
  }

  const { data: lead } = await svc
    .from("leads")
    .select("id, brokerage_id, agent_id, lead_stage, lifecycle_state, lead_score")
    .eq("id", leadId)
    .eq("brokerage_id", agentRow.brokerage_id)
    .maybeSingle()
  if (!lead) return { success: false, error: "Lead not found in your brokerage" }
  if (lead.agent_id) return { success: false, error: "Lead already has an assigned agent" }

  const isQualified = lead.lead_stage === "qualified"
  const isConsented = ["consented", "qualified", "assigned"].includes(lead.lifecycle_state ?? "")
  if (!isQualified || !isConsented) {
    return {
      success: false,
      error:
        "This lead is still owned by the AI ISA (not yet qualified + consented). " +
        "It will be assigned automatically when qualification completes.",
    }
  }

  try {
    const { handleLeadAssigned } = await import("@/lib/kernel/lead-acquisition-handlers")
    await handleLeadAssigned({
      leadId,
      brokerageId: agentRow.brokerage_id,
      agentId: agentRow.id, // agents.id
      method: "stale_claim",
      scoreAtAssignment: lead.lead_score ?? 0,
    })
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
  return { success: true }
}

/**
 * Trigger AI ISA re-engagement on a stale contact. Wraps the existing
 * initiateAIISAContactEngagement action so the UI gets a unified path.
 */
export async function reengageStaleContact(contactId: string): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  const result = await initiateAIISAContactEngagement(contactId)
  if (result.success) return { success: true }
  return { success: false, error: result.reason ?? "Re-engagement failed" }
}

/**
 * Mark a contact as freshly touched — bumps updated_at so it falls out of
 * the stale window. Use after the agent has called/texted/emailed manually.
 */
export async function markContactTouched(contactId: string): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  const svc = createServiceClient()
  const { data: agentRow } = await svc.from("agents").select("id, brokerage_id").eq("user_id", user.id).maybeSingle()
  if (!agentRow?.id) return { success: false, error: "No agent profile" }

  const { error } = await svc
    .from("contacts")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", contactId)
    .eq("agent_id", agentRow.id)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

/**
 * Stop AI re-engagement for a contact (sets isa_reengage_allowed=false).
 * Use when the agent prefers to handle this contact manually.
 */
export async function disableReengagementForContact(contactId: string): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  const svc = createServiceClient()
  const { data: agentRow } = await svc.from("agents").select("id").eq("user_id", user.id).maybeSingle()
  if (!agentRow?.id) return { success: false, error: "No agent profile" }

  const { error } = await svc
    .from("contacts")
    .update({ isa_reengage_allowed: false })
    .eq("id", contactId)
    .eq("agent_id", agentRow.id)
  if (error) return { success: false, error: error.message }
  return { success: true }
}
