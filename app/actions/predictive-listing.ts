"use server"

/**
 * Predictive Listing Score — agent-facing read & action server actions.
 *
 *   - getTopPredictiveSellers(agentId, limit) — dashboard top-N
 *   - dismissPredictiveSeller(contactId, days) — suppress for window
 *   - markPredictiveAction(contactId, type) — log action taken
 *   - cancelQueuedAutoTouch(actionId) — agent overrides queued auto-send
 *   - listQueuedAutoTouches(agentId) — review queue for the agent
 */

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"

export interface PredictiveSellerRow {
  contactId: string
  contactName: string
  plsScore: number
  confidence: number
  topSignals: Array<{ key: string; label: string; confidence: number }>
  lastActionAt: string | null
  lastActionType: string | null
  scoredAt: string
  /** The AVM the scorer recorded (contacts.home_value_estimate today) and where it came from. */
  avmValue: number | null
  avmSource: string | null
  /** Evidence depth behind the score: how many signals fired and their summed motivation boost. */
  signalsFired: number | null
  motivationTotal: number | null
}

export async function getTopPredictiveSellers(params: {
  agentId?: string
  brokerageId?: string
  minScore?: number
  limit?: number
}): Promise<PredictiveSellerRow[]> {
  const supabase = await createClient()
  const minScore = params.minScore ?? 60
  const limit = params.limit ?? 10

  // Lane M2 — avm_value/avm_source (the home-value estimate the scorer
  // recorded and where it came from) and signals_fired/
  // contributing_motivation_total (the evidence depth behind the score) were
  // written by every nightly scoring pass and read by nothing: the card showed
  // a bare score with no dollar context and no way to tell a 4-signal 78 from
  // a 1-signal 78.
  let query = supabase
    .from("predictive_listing_scores")
    .select(
      "contact_id, pls_score, confidence, top_signals, last_action_at, last_action_type, scored_at, suppressed_until, " +
        "avm_value, avm_source, signals_fired, contributing_motivation_total, " +
        "contacts!inner(first_name, last_name, agent_id)"
    )
    .gte("pls_score", minScore)
    .order("pls_score", { ascending: false })
    .limit(limit)

  if (params.agentId) query = query.eq("agent_id", params.agentId)
  if (params.brokerageId) query = query.eq("brokerage_id", params.brokerageId)

  const { data, error } = await query
  if (error || !data) return []

  const now = new Date()
  return (data as unknown as Array<{
    contact_id: string
    pls_score: number
    confidence: number
    top_signals: Array<{ key: string; label: string; confidence: number }> | null
    last_action_at: string | null
    last_action_type: string | null
    scored_at: string
    suppressed_until: string | null
    avm_value: number | null
    avm_source: string | null
    signals_fired: number | null
    contributing_motivation_total: number | null
    contacts: { first_name: string | null; last_name: string | null }
  }>)
    .filter((row) => !row.suppressed_until || new Date(row.suppressed_until) < now)
    .map((row) => ({
      contactId: row.contact_id,
      contactName:
        `${row.contacts?.first_name ?? ""} ${row.contacts?.last_name ?? ""}`.trim() || "Contact",
      plsScore: Number(row.pls_score),
      confidence: Number(row.confidence ?? 0),
      topSignals: row.top_signals ?? [],
      lastActionAt: row.last_action_at,
      lastActionType: row.last_action_type,
      scoredAt: row.scored_at,
      avmValue: row.avm_value != null ? Number(row.avm_value) : null,
      avmSource: row.avm_source,
      signalsFired: row.signals_fired != null ? Number(row.signals_fired) : null,
      motivationTotal:
        row.contributing_motivation_total != null ? Number(row.contributing_motivation_total) : null,
    }))
}

/**
 * Suppress a contact's PLS surfacing for `days` days. Used for "not for me"
 * agent dismissals.
 */
export async function dismissPredictiveSeller(params: {
  contactId: string
  brokerageId: string
  userId: string
  days?: number
  reason?: string
}): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const days = params.days ?? 90

  const { error } = await supabase
    .from("predictive_listing_scores")
    .update({
      suppressed_until: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
      suppression_reason: params.reason ?? "agent_dismissed",
      suppressed_by_user_id: params.userId,
      last_action_at: new Date().toISOString(),
      last_action_type: "dismissed",
    })
    .eq("contact_id", params.contactId)
    .eq("brokerage_id", params.brokerageId)

  if (error) return { success: false, error: error.message }

  // Also write a manual_dismiss action row for audit
  await supabase.from("predictive_listing_actions").insert({
    contact_id: params.contactId,
    brokerage_id: params.brokerageId,
    action_type: "manual_dismiss",
    status: "sent",
    cancel_reason: params.reason ?? "agent_dismissed",
    cancelled_by_user_id: params.userId,
    cancelled_at: new Date().toISOString(),
  })

  revalidatePath("/dashboard/agent")
  return { success: true }
}

/**
 * The dismissals ledger (lane M2). dismissPredictiveSeller stamps WHO hid a
 * contact (suppressed_by_user_id), WHY (suppression_reason) and until when —
 * and nothing ever read any of it: a dismissed contact simply vanished, and a
 * team could not tell a deliberate "not for me" from a mis-click, nor undo
 * either. Tenant comes from the SESSION (§4), not from a parameter — this is
 * the shape the sibling actions in this file should also converge on.
 *
 * suppressed_by_user_id carries a users.id (the card passes the page's
 * auth user id) — names resolve against users, never agents (§3: the id
 * spaces are disjoint).
 */
export async function listDismissedPredictiveSellers(): Promise<Array<{
  contactId: string
  contactName: string
  suppressionReason: string | null
  suppressedUntil: string | null
  suppressedByName: string | null
}>> {
  const supabase = await createClient()
  const { getAgentContext } = await import("@/lib/identity")
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return []

  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from("predictive_listing_scores")
    .select(
      "contact_id, suppression_reason, suppressed_by_user_id, suppressed_until, " +
        "contacts!inner(first_name, last_name)"
    )
    .eq("brokerage_id", ctx.brokerageId)
    .gt("suppressed_until", now)
    .order("suppressed_until", { ascending: false })
    .limit(20)

  // §3: the error is read; a refused read returns an empty ledger, never throws
  // into the dashboard.
  if (error) {
    console.error("[predictive-listing] dismissals read refused:", error.message)
    return []
  }

  const rows = (data ?? []) as unknown as Array<{
    contact_id: string
    suppression_reason: string | null
    suppressed_by_user_id: string | null
    suppressed_until: string | null
    contacts: { first_name: string | null; last_name: string | null }
  }>

  // Resolve dismisser names in one read against USERS (the id class written).
  const userIds = [
    ...new Set(rows.map((r) => r.suppressed_by_user_id).filter((id): id is string => !!id)),
  ]
  const nameById = new Map<string, string>()
  if (userIds.length > 0) {
    const { data: users, error: usersErr } = await supabase
      .from("users")
      .select("id, first_name, last_name")
      .eq("brokerage_id", ctx.brokerageId)
      .in("id", userIds)
    if (usersErr) {
      console.error("[predictive-listing] dismisser name read refused:", usersErr.message)
    } else {
      for (const u of (users ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>) {
        const name = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim()
        if (name) nameById.set(u.id, name)
      }
    }
  }

  return rows.map((r) => ({
    contactId: r.contact_id,
    contactName:
      `${r.contacts?.first_name ?? ""} ${r.contacts?.last_name ?? ""}`.trim() || "Contact",
    suppressionReason: r.suppression_reason,
    suppressedUntil: r.suppressed_until,
    suppressedByName: r.suppressed_by_user_id
      ? (nameById.get(r.suppressed_by_user_id) ?? null)
      : null,
  }))
}

/**
 * Log a manual action the agent took (touched, scheduled consult, added to nurture).
 */
export async function markPredictiveAction(params: {
  contactId: string
  brokerageId: string
  actionType: "touched" | "consulted" | "nurtured"
}): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { error } = await supabase
    .from("predictive_listing_scores")
    .update({
      last_action_at: new Date().toISOString(),
      last_action_type: params.actionType,
    })
    .eq("contact_id", params.contactId)
    .eq("brokerage_id", params.brokerageId)

  if (error) return { success: false, error: error.message }

  // Log to predictive_listing_actions for audit
  const actionType =
    params.actionType === "touched"
      ? "manual_touch"
      : params.actionType === "consulted"
      ? "manual_consult"
      : "manual_nurture"
  await supabase.from("predictive_listing_actions").insert({
    contact_id: params.contactId,
    brokerage_id: params.brokerageId,
    action_type: actionType,
    status: "sent",
    sent_at: new Date().toISOString(),
  })

  revalidatePath("/dashboard/agent")
  return { success: true }
}

/**
 * Cancel a queued auto-touch action. Agent can override before the review
 * window expires — pre-empts the execute cron.
 */
export async function cancelQueuedAutoTouch(params: {
  actionId: string
  brokerageId: string
  userId: string
  reason?: string
}): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()
  const { error } = await supabase
    .from("predictive_listing_actions")
    .update({
      status: "cancelled",
      cancelled_by_user_id: params.userId,
      cancelled_at: new Date().toISOString(),
      cancel_reason: params.reason ?? "agent_cancelled",
    })
    .eq("id", params.actionId)
    .eq("brokerage_id", params.brokerageId)
    .eq("status", "pending_review")

  if (error) return { success: false, error: error.message }
  revalidatePath("/dashboard/agent")
  return { success: true }
}

/**
 * Read pending auto-touches for an agent — what's queued to send if they
 * don't intervene.
 */
export async function listQueuedAutoTouches(params: {
  agentId?: string
  brokerageId: string
}): Promise<Array<{
  id: string
  contactId: string
  contactName: string
  channel: string | null
  scheduledSendAt: string | null
  triggeringPlsScore: number | null
  triggeringSignals: Array<{ key: string; label: string }> | null
}>> {
  const supabase = await createClient()
  let query = supabase
    .from("predictive_listing_actions")
    .select(
      "id, contact_id, channel, scheduled_send_at, triggering_pls_score, triggering_signals, " +
        "contacts!inner(first_name, last_name, agent_id)"
    )
    .eq("brokerage_id", params.brokerageId)
    .eq("action_type", "auto_touch")
    .eq("status", "pending_review")
    .order("scheduled_send_at", { ascending: true })

  if (params.agentId) query = query.eq("agent_id", params.agentId)

  const { data } = await query
  if (!data) return []

  return (data as unknown as Array<{
    id: string
    contact_id: string
    channel: string | null
    scheduled_send_at: string | null
    triggering_pls_score: number | null
    triggering_signals: Array<{ key: string; label: string }> | null
    contacts: { first_name: string | null; last_name: string | null }
  }>).map((row) => ({
    id: row.id,
    contactId: row.contact_id,
    contactName:
      `${row.contacts?.first_name ?? ""} ${row.contacts?.last_name ?? ""}`.trim() || "Contact",
    channel: row.channel,
    scheduledSendAt: row.scheduled_send_at,
    triggeringPlsScore: row.triggering_pls_score,
    triggeringSignals: row.triggering_signals,
  }))
}
