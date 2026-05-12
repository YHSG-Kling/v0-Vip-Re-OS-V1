"use server"

/**
 * Portal Stream — read + disposition actions.
 *
 *   - getCustomerPortalFeed({ contactId, limit? })
 *       Customer-facing read; relies on RLS to gate self-access.
 *
 *   - getAgentPortalStream({ contactId, limit? })
 *       Agent-facing read; includes agent_copy + disposition state.
 *
 *   - getOpenAgentActions({ limit? })
 *       Brokerage-wide queue of unresolved agent-action items, used by the
 *       agent dashboard's action queue widget.
 *
 *   - dispositionPortalEventAction({ eventId, mode, note? })
 *       The 3-way pattern the user called out. Flips the row's status,
 *       writes a row to `activities` for the canonical audit trail, and
 *       — for ai_delegate — best-effort fires a kernel event so AI ISA /
 *       Co-Pilot drafting can pick up the work.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { revalidatePath } from "next/cache"

// ─── Types ────────────────────────────────────────────────────────────────

export type DispositionMode = "manual" | "execute" | "ai_delegate" | "dismiss"

export interface PortalStreamRow {
  id:                      string
  contactId:               string
  contactName:             string | null
  eventType:               string
  customerCopy:            string | null
  customerIcon:            string | null
  agentCopy:               string
  agentActionRequired:     boolean
  agentActionLabel:        string | null
  agentActionStatus:       "open" | "completed_manual" | "completed_executed" | "completed_ai" | "dismissed"
  agentActionCompletedAt:  string | null
  severity:                "normal" | "high" | "critical" | "celebration"
  occurredAt:              string
  transactionId:           string | null
  listingId:               string | null
}

interface RawRow {
  id:                            string
  contact_id:                    string
  event_type:                    string
  customer_copy:                 string | null
  customer_icon:                 string | null
  agent_copy:                    string
  agent_action_required:         boolean
  agent_action_label:            string | null
  agent_action_status:           PortalStreamRow["agentActionStatus"]
  agent_action_completed_at:     string | null
  severity:                      PortalStreamRow["severity"]
  occurred_at:                   string
  transaction_id:                string | null
  listing_id:                    string | null
}

function rowToStream(r: RawRow, contactName: string | null = null): PortalStreamRow {
  return {
    id:                     r.id,
    contactId:              r.contact_id,
    contactName,
    eventType:              r.event_type,
    customerCopy:           r.customer_copy,
    customerIcon:           r.customer_icon,
    agentCopy:              r.agent_copy,
    agentActionRequired:    r.agent_action_required,
    agentActionLabel:       r.agent_action_label,
    agentActionStatus:      r.agent_action_status,
    agentActionCompletedAt: r.agent_action_completed_at,
    severity:               r.severity,
    occurredAt:             r.occurred_at,
    transactionId:          r.transaction_id,
    listingId:              r.listing_id,
  }
}

// ─── Customer-facing read ────────────────────────────────────────────────

export async function getCustomerPortalFeed(params: {
  contactId: string
  limit?:    number
}): Promise<{ success: boolean; error?: string; rows?: PortalStreamRow[] }> {
  if (!isValidUUID(params.contactId)) return { success: false, error: "Invalid contact id" }
  const supabase = await createClient()
  // RLS gates: customer can read only their own (via contacts.user_id =
  // auth.uid()) AND only rows with customer_copy IS NOT NULL.
  const { data, error } = await supabase
    .from("portal_event_stream")
    .select("id, contact_id, event_type, customer_copy, customer_icon, agent_copy, agent_action_required, agent_action_label, agent_action_status, agent_action_completed_at, severity, occurred_at, transaction_id, listing_id")
    .eq("contact_id", params.contactId)
    .not("customer_copy", "is", null)
    .order("occurred_at", { ascending: false })
    .limit(params.limit ?? 30)
  if (error) return { success: false, error: error.message }
  return { success: true, rows: (data ?? []).map((r) => rowToStream(r as RawRow)) }
}

// ─── Agent-facing read (single contact, full stream) ─────────────────────

export async function getAgentPortalStream(params: {
  contactId: string
  limit?:    number
}): Promise<{ success: boolean; error?: string; rows?: PortalStreamRow[] }> {
  if (!isValidUUID(params.contactId)) return { success: false, error: "Invalid contact id" }
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("portal_event_stream")
    .select("id, contact_id, event_type, customer_copy, customer_icon, agent_copy, agent_action_required, agent_action_label, agent_action_status, agent_action_completed_at, severity, occurred_at, transaction_id, listing_id")
    .eq("contact_id", params.contactId)
    .order("occurred_at", { ascending: false })
    .limit(params.limit ?? 50)
  if (error) return { success: false, error: error.message }
  return { success: true, rows: (data ?? []).map((r) => rowToStream(r as RawRow)) }
}

// ─── Agent-facing action queue across the brokerage ──────────────────────

export async function getOpenAgentActions(params?: {
  limit?: number
}): Promise<{ success: boolean; error?: string; rows?: PortalStreamRow[] }> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("portal_event_stream")
    .select("id, contact_id, event_type, customer_copy, customer_icon, agent_copy, agent_action_required, agent_action_label, agent_action_status, agent_action_completed_at, severity, occurred_at, transaction_id, listing_id")
    .eq("agent_action_required", true)
    .eq("agent_action_status", "open")
    .order("severity", { ascending: false })
    .order("occurred_at", { ascending: false })
    .limit(params?.limit ?? 20)
  if (error) return { success: false, error: error.message }

  // Hydrate contact names for the queue UI
  const contactIds = Array.from(new Set((data ?? []).map((r) => (r as RawRow).contact_id)))
  const nameMap = new Map<string, string>()
  if (contactIds.length > 0) {
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id, first_name, last_name")
      .in("id", contactIds)
    for (const c of (contacts ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>) {
      const name = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim()
      if (name) nameMap.set(c.id, name)
    }
  }
  return {
    success: true,
    rows: (data ?? []).map((r) => rowToStream(r as RawRow, nameMap.get((r as RawRow).contact_id) ?? null)),
  }
}

// ─── Disposition: Done manually / Do now / AI do it / Dismiss ────────────

export async function dispositionPortalEventAction(params: {
  eventId: string
  mode:    DispositionMode
  note?:   string
}): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(params.eventId)) return { success: false, error: "Invalid event id" }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  // Load the row so we can write a matching activities audit row + fan out
  const { data: row } = await supabase
    .from("portal_event_stream")
    .select("id, brokerage_id, contact_id, transaction_id, event_type, agent_copy, agent_action_label, agent_user_id")
    .eq("id", params.eventId)
    .maybeSingle()
  if (!row) return { success: false, error: "Event not found" }

  const statusMap: Record<DispositionMode, "completed_manual" | "completed_executed" | "completed_ai" | "dismissed"> = {
    manual:       "completed_manual",
    execute:      "completed_executed",
    ai_delegate:  "completed_ai",
    dismiss:      "dismissed",
  }
  const newStatus = statusMap[params.mode]

  const { error: updateError } = await supabase
    .from("portal_event_stream")
    .update({
      agent_action_status:       newStatus,
      agent_action_completed_at: new Date().toISOString(),
      agent_action_completed_by: user.id,
      agent_action_notes:        params.note ?? null,
    })
    .eq("id", params.eventId)
  if (updateError) return { success: false, error: updateError.message }

  // Canonical audit trail in `activities` — every disposition is a logged
  // activity attributed to the agent.
  const svc = createServiceClient()
  const activityTypeMap: Record<DispositionMode, string> = {
    manual:      "portal_action_resolved_manual",
    execute:     "portal_action_resolved_executed",
    ai_delegate: "portal_action_delegated_to_ai",
    dismiss:     "portal_action_dismissed",
  }
  await svc.from("activities").insert({
    brokerage_id:  row.brokerage_id,
    contact_id:    row.contact_id,
    transaction_id: row.transaction_id ?? null,
    agent_user_id: user.id,
    activity_type: activityTypeMap[params.mode],
    title:         row.agent_action_label ?? row.agent_copy,
    description:   params.note ?? null,
    status:        params.mode === "dismiss" ? "cancelled" : "completed",
    completed_at:  new Date().toISOString(),
    metadata: {
      portal_event_stream_id: row.id,
      source_event_type:      row.event_type,
      disposition_mode:       params.mode,
    },
  })

  // AI delegation: fire a kernel-style lifecycle event so AI ISA / draft
  // generators can pick it up. We use a generic 'agent.delegated_to_ai'
  // event_type — downstream handlers can check metadata.source_event_type
  // to know what to do.
  if (params.mode === "ai_delegate") {
    await svc.from("lifecycle_events").insert({
      event_type:    "agent.delegated_to_ai",
      entity_type:   row.transaction_id ? "transaction" : "contact",
      entity_id:     row.transaction_id ?? row.contact_id,
      brokerage_id:  row.brokerage_id,
      user_id:       user.id,
      metadata: {
        portal_event_stream_id: row.id,
        source_event_type:      row.event_type,
        agent_action_label:     row.agent_action_label,
      },
    })
  }

  // Revalidate the surfaces the disposition affects
  revalidatePath(`/crm`)
  revalidatePath(`/dashboard/agent`)
  revalidatePath(`/portal/${row.contact_id}`)
  return { success: true }
}

// ─── On-demand projection (admin) ────────────────────────────────────────

export async function triggerPortalProjectionAction(): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const secret = process.env.CRON_SECRET
  if (!secret) return { success: false, error: "CRON_SECRET not configured" }
  const base = process.env.NEXT_PUBLIC_APP_URL ?? process.env.VERCEL_URL
  const url = base
    ? `${base.startsWith("http") ? base : `https://${base}`}/api/cron/portal-stream-projector`
    : "/api/cron/portal-stream-projector"

  try {
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${secret}` },
      cache:   "no-store",
    })
    if (!r.ok) {
      const data = await r.json().catch(() => null)
      return { success: false, error: data?.error ?? `Projection returned ${r.status}` }
    }
    return { success: true }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Projection failed" }
  }
}
