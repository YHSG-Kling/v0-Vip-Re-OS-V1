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
import { toggleContactAIISA } from "@/app/actions/ai-isa/engage-contact"
import { detectStaleContacts } from "@/lib/ai-isa/stale-contact-detector"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

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
  const isBroker = isAdminOrBroker({ user_type: (userRow?.user_type ?? "") as string })

  const staleLeadCutoff = new Date(Date.now() - STALE_LEAD_DAYS * 86_400_000).toISOString()

  // Brokerage stale-contact threshold (matches the cron's source-of-truth).
  const { data: brokerageRow } = await svc
    .from("global_settings")
    .select("additional_settings")
    .eq("brokerage_id", brokerageId)
    .maybeSingle()
  const settings = brokerageRow?.additional_settings as Record<string, unknown> | null
  // The cutoff itself is no longer computed here — detectStaleContacts derives it
  // from staleDays, and applies the LONGER lifetime-customer horizon per contact,
  // which a single hand-computed cutoff could not express.
  const staleContactDays =
    typeof settings?.isa_ghost_threshold_days === "number" ? settings.isa_ghost_threshold_days : 14

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

  // ── 3. MY stale contacts — THE SAME DETECTOR THE CRON RUNS ─────────────────
  //
  // This block used to be a third hand-written copy of the stale rule, under a
  // comment calling itself a "mirror of stale-contact-monitor cron query". It was
  // not a mirror: it filtered on contacts.updated_at while the cron filtered on
  // contacts.created_at and the canonical detector filtered on
  // contacts.last_contacted_at — three columns, three different answers to one
  // question. The divergence was visible to users: markContactTouched below
  // bumped updated_at, so pressing "I just touched" removed the row from THIS
  // list while the cron, reading created_at, auto-messaged the contact anyway.
  //
  // Both exclusions this copy owned (status archived/inactive, per-agent scope)
  // were merged into the shared policy + detector before it was removed.
  const detected = await detectStaleContacts(brokerageId, {
    staleDays: staleContactDays,
    agentId: agentRow.id, // contacts.agent_id is an agents.id, which agentRow.id is
    maxBatch: 100,
    // The agent console, unlike the cron, must still SEE contacts whose ISA switch
    // is off — the UI badges them "ISA off" and resumeReengagementForContact below
    // is only reachable from a row that is on screen.
    includeIsaDisabled: true,
  })

  const myStaleContacts: StaleContactRow[] = detected.map((c) => ({
    id:                 c.id,
    firstName:          c.first_name,
    lastName:           c.last_name,
    email:              c.email,
    phone:              c.phone,
    status:             null, // the detector filters status; it is not a display field
    contactType:        c.contact_type,
    daysStale:          c.days_since_contact,
    lastContactedAt:    c.last_contacted_at,
    isaReengageAllowed: c.isa_reengage_allowed,
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
  if (!isAdminOrBroker({ user_type: (userRow?.user_type ?? "") as string })) {
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
 * Mark a contact as freshly touched. Use after the agent has called/texted/emailed
 * manually.
 *
 * ── IT MUST STAMP THE COLUMN STALENESS IS MEASURED ON ───────────────────────
 *
 * This wrote `updated_at` alone, because the list above used to be filtered on
 * `updated_at`. The CRON was filtered on `created_at` and the canonical detector
 * on `last_contacted_at`, so the button cleared the row from the agent's screen
 * and changed nothing the automated sender looked at: the agent recorded a
 * personal call, watched the row disappear, and the ISA emailed the same contact
 * that night anyway. Now that every reader is the one detector, the write has to
 * move `last_contacted_at` or the button is decorative.
 *
 * `updated_at` is kept alongside it — it is an ordinary row-modified stamp that
 * other surfaces read, and dropping it would be a second silent divergence.
 */
export async function markContactTouched(contactId: string): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  const svc = createServiceClient()
  const { data: agentRow, error: agentErr } = await svc
    .from("agents").select("id, brokerage_id").eq("user_id", user.id).maybeSingle()
  if (agentErr) return { success: false, error: agentErr.message }
  if (!agentRow?.id) return { success: false, error: "No agent profile" }

  const now = new Date().toISOString()
  // .select("id") because a zero-row update — a contact this agent does not own —
  // comes back as error:null, which would report a write that never happened as a
  // success and leave the row on screen with no explanation.
  const { data: updated, error } = await svc
    .from("contacts")
    .update({ last_contacted_at: now, updated_at: now })
    .eq("id", contactId)
    .eq("agent_id", agentRow.id)
    .select("id")
  if (error) return { success: false, error: error.message }
  if (!updated || updated.length === 0) {
    return { success: false, error: "Contact not found among the ones assigned to you" }
  }
  return { success: true }
}

/**
 * Stop AI re-engagement for a contact. Use when the agent prefers to handle this
 * contact manually.
 *
 * ── WHY THIS IS NOW A DELEGATION ────────────────────────────────────────────
 *
 * It used to write `isa_reengage_allowed: false` directly, and that was a partial
 * copy of app/actions/ai-isa/engage-contact.ts:toggleContactAIISA — which had no
 * caller anywhere and was the STRICTLY MORE COMPLETE of the two. Everything the
 * inline write did not do:
 *
 *   · it left `ai_outreach_paused` alone, so the OTHER half of the ISA switch
 *     stayed armed. staleContactEligibility treats those two flags separately,
 *     and engageContact stops on `ai_outreach_paused` independently — so "Stop
 *     AI" set one flag and left the contact half-suppressed.
 *   · it stamped no `isa_reengage_set_at` / `isa_reengage_marked_by`, so the
 *     accountability columns on a suppression-adjacent decision stayed empty.
 *   · it emitted no lifecycle event, so the pause was invisible to the kernel.
 *   · it verified a zero-row update as success. `.eq("agent_id", agentRow.id)`
 *     against a contact the agent does not own matches nothing, and supabase-js
 *     returns error:null for that — the UI said "Re-engagement disabled" for a
 *     write that never happened. toggleContactAIISA proves the row with
 *     `.select('id')` and a length check.
 *
 * The tenant scope also changes shape and that is deliberate: toggleContactAIISA
 * scopes by the SESSION's brokerage rather than by agent ownership, so a broker
 * or team lead can quiet a contact they do not personally own — which is the
 * behaviour the old write silently refused (as a false success).
 */
export async function disableReengagementForContact(contactId: string): Promise<{ success: boolean; error?: string }> {
  return toggleContactAIISA({ contactId, enabled: false })
}

/**
 * Resume AI re-engagement for a contact — the return leg the console never had.
 *
 * "Stop AI" was a ONE-WAY DOOR: once isa_reengage_allowed went false the row
 * rendered an "ISA off" badge and the re-engage / stop buttons disappeared, and
 * no surface anywhere in the app could set the flag back. toggleContactAIISA has
 * always been able to (it is a symmetric enable/pause switch) and nothing called
 * it, so the capability existed and was unreachable.
 */
export async function resumeReengagementForContact(contactId: string): Promise<{ success: boolean; error?: string }> {
  return toggleContactAIISA({ contactId, enabled: true })
}
