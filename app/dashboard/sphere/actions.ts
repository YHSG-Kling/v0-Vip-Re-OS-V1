"use server"

/**
 * Sphere Resonance — agent-facing read + action surface.
 *
 * Reads:   predictive_listing_actions WHERE triggering_pls_score IS NULL
 *          (NULL means the row was inserted by lib/sphere-resonance/, not by
 *           the regular Predictive Listing auto-send).
 * Writes:  status transitions (send-now, dismiss). Sending is delegated to the
 *          existing PL auto-send path so we don't fork delivery logic.
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

export interface SphereSignal {
  key:         string
  label:       string
  evidenceKey?: string
  source?:     string
  date?:       string
  sensitive?:  boolean
}

export interface SphereRow {
  id:                string
  contactId:         string
  contactName:       string
  contactEmail:      string | null
  contactPhone:      string | null
  actionType:        "auto_touch" | "manual_touch"
  channel:           string | null
  signals:           SphereSignal[]
  primarySignal:    SphereSignal | null
  isSensitive:       boolean
  status:            string
  messageBody:       string | null
  scheduledSendAt:   string | null
  reviewedAt:        string | null
  sentAt:            string | null
  cancelledAt:       string | null
  cancelReason:      string | null
  createdAt:         string
}

export interface SphereLoad {
  pendingAuto:    SphereRow[]   // status='pending_review', action_type='auto_touch' — review-window queue
  needsAction:    SphereRow[]   // status='pending_review', action_type='manual_touch' OR sensitive — needs human
  sent:           SphereRow[]   // status='sent' — recent history
  cancelled:      SphereRow[]   // dismissed / cancelled by agent
}

function rowToView(row: any): SphereRow {
  const contact = row.contact ?? {}
  const signals = Array.isArray(row.triggering_signals) ? (row.triggering_signals as SphereSignal[]) : []
  const primarySignal = signals[0] ?? null
  return {
    id:               row.id,
    contactId:        row.contact_id,
    contactName:      `${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim() || "Contact",
    contactEmail:     contact.email ?? null,
    contactPhone:     contact.phone ?? null,
    actionType:       row.action_type as "auto_touch" | "manual_touch",
    channel:          row.channel ?? null,
    signals,
    primarySignal,
    isSensitive:      Boolean(primarySignal?.sensitive),
    status:           row.status,
    messageBody:      row.message_body ?? null,
    scheduledSendAt:  row.scheduled_send_at ?? null,
    reviewedAt:       row.reviewed_at ?? null,
    sentAt:           row.sent_at ?? null,
    cancelledAt:      row.cancelled_at ?? null,
    cancelReason:     row.cancel_reason ?? null,
    createdAt:        row.created_at,
  }
}

export async function loadSphereResonance(): Promise<{ data: SphereLoad } | { error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: "Not authenticated" }

  const svc = createServiceClient()
  const { data: agentRow } = await svc.from("agents").select("id").eq("user_id", user.id).maybeSingle()
  if (!agentRow?.id) return { error: "No agent profile" }

  // Only rows seeded by sphere-resonance (no PLS score attached).
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { data: rows } = await svc
    .from("predictive_listing_actions")
    .select(`
      id, contact_id, agent_id, action_type, channel, triggering_signals,
      status, message_subject, message_body, scheduled_send_at,
      reviewed_at, cancelled_at, cancel_reason, sent_at, created_at,
      contact:contact_id (first_name, last_name, email, phone)
    `)
    .is("triggering_pls_score", null)
    .eq("agent_id", agentRow.id)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(300)

  const data: SphereLoad = { pendingAuto: [], needsAction: [], sent: [], cancelled: [] }
  for (const r of (rows ?? []) as any[]) {
    const v = rowToView(r)
    if (v.status === "sent") data.sent.push(v)
    else if (v.status === "cancelled") data.cancelled.push(v)
    else if (v.actionType === "auto_touch" && !v.isSensitive) data.pendingAuto.push(v)
    else data.needsAction.push(v)
  }
  return { data }
}

/**
 * Approve a queued auto-touch — clears the review window so it sends on the
 * next sequence-executor tick. We don't queue our own send job; we just
 * stamp reviewed_at + status='approved' so the existing pipeline picks it up.
 */
export async function approveSphereTouch(actionId: string): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  const svc = createServiceClient()
  const { data: agentRow } = await svc.from("agents").select("id").eq("user_id", user.id).maybeSingle()
  if (!agentRow?.id) return { success: false, error: "No agent profile" }

  const { error } = await svc
    .from("predictive_listing_actions")
    .update({
      status:               "approved",
      reviewed_at:          new Date().toISOString(),
      reviewed_by_user_id:  user.id,
      // Move the send time to NOW so the dispatcher picks it up on the next tick
      scheduled_send_at:    new Date().toISOString(),
    })
    .eq("id", actionId)
    .eq("agent_id", agentRow.id)
    .eq("status", "pending_review")
  if (error) return { success: false, error: error.message }
  return { success: true }
}

/**
 * Edit message body before sending — only valid while still pending_review.
 */
export async function updateSphereMessage(actionId: string, messageBody: string): Promise<{ success: boolean; error?: string }> {
  if (!messageBody.trim()) return { success: false, error: "Message cannot be empty" }
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  const svc = createServiceClient()
  const { data: agentRow } = await svc.from("agents").select("id").eq("user_id", user.id).maybeSingle()
  if (!agentRow?.id) return { success: false, error: "No agent profile" }

  const { error } = await svc
    .from("predictive_listing_actions")
    .update({ message_body: messageBody })
    .eq("id", actionId)
    .eq("agent_id", agentRow.id)
    .eq("status", "pending_review")
  if (error) return { success: false, error: error.message }
  return { success: true }
}

/**
 * Dismiss — agent decided not to act. Records reason for audit + ML signal.
 */
export async function dismissSphereTouch(actionId: string, reason: string): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  const svc = createServiceClient()
  const { data: agentRow } = await svc.from("agents").select("id").eq("user_id", user.id).maybeSingle()
  if (!agentRow?.id) return { success: false, error: "No agent profile" }

  const { error } = await svc
    .from("predictive_listing_actions")
    .update({
      status:                "cancelled",
      cancelled_at:          new Date().toISOString(),
      cancelled_by_user_id:  user.id,
      cancel_reason:         reason || "agent_dismissed",
    })
    .eq("id", actionId)
    .eq("agent_id", agentRow.id)
  if (error) return { success: false, error: error.message }
  return { success: true }
}
