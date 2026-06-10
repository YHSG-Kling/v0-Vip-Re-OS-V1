// lib/intelligence/mobile-approval-queue.ts
//
// MOBILE PUSH-TO-APPROVE — approval latency is the egress's critical path now that every
// loop ends at the gate. This is the broker's thumb-friendly approval surface: the pending
// client-message deliverables across ALL loops, each with its owning manager, age, SLA and
// a preview, plus a notification enqueuer that "pushes" breached/due approvals into the
// broker's notification feed (deep-linked to the mobile queue). Approve/reject reuse the
// existing governed server actions — no new mutation path, same audit trail.

import { createServiceClient } from "@/lib/supabase/service"
import { evaluateApprovalSla, type ApprovalSlaLevel } from "@/lib/kernel/approval-sla"
import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"

export interface MobileApprovalItem {
  id:           string
  managerKey:   ManagerKey | "unknown"
  managerLabel: string
  audience:     string
  channel:      string
  subject:      string | null
  /** First ~160 chars of the body for the card preview. */
  preview:      string
  proposedAt:   string | null
  ageHours:     number
  slaLevel:     ApprovalSlaLevel
}

export interface MobileApprovalQueue {
  brokerageId: string
  items:       MobileApprovalItem[]
  counts:      { total: number; breached: number; due: number }
}

/** Load the broker's pending approval deliverables, SLA-sorted (most urgent first). */
export async function loadMobileApprovalQueue(
  brokerageId: string, client?: ReturnType<typeof createServiceClient>,
): Promise<MobileApprovalQueue> {
  const supabase = client ?? createServiceClient()
  const now = new Date()

  const { data } = await supabase
    .from("agent_client_messages")
    .select("id, agent_kind, audience, channel, subject, body, proposed_at")
    .eq("brokerage_id", brokerageId).eq("status", "proposed")
    .order("proposed_at", { ascending: true })
    .limit(200)

  const rank: Record<ApprovalSlaLevel, number> = { breached: 0, due: 1, ok: 2 }
  const items: MobileApprovalItem[] = ((data ?? []) as Array<{
    id: string; agent_kind: string | null; audience: string; channel: string | null
    subject: string | null; body: string; proposed_at: string | null
  }>).map((m) => {
    const sla = evaluateApprovalSla(m.proposed_at ?? null, now)
    const key = (m.agent_kind && m.agent_kind in MANAGERS ? m.agent_kind : "unknown") as ManagerKey | "unknown"
    return {
      id: m.id,
      managerKey: key,
      managerLabel: key === "unknown" ? "Unassigned" : MANAGERS[key].label,
      audience: m.audience,
      channel: m.channel ?? "portal",
      subject: m.subject,
      preview: (m.body ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
      proposedAt: m.proposed_at ?? null,
      ageHours: sla.ageHours,
      slaLevel: sla.level,
    }
  }).sort((a, b) => rank[a.slaLevel] - rank[b.slaLevel] || (a.proposedAt ?? "").localeCompare(b.proposedAt ?? ""))

  return {
    brokerageId,
    items,
    counts: {
      total: items.length,
      breached: items.filter((i) => i.slaLevel === "breached").length,
      due: items.filter((i) => i.slaLevel === "due").length,
    },
  }
}

/** Managers (broker/admin) escalate only after a deliverable sits unapproved this long.
 *  Agents are the PRIMARY approvers — they own the deal/client the deliverable touches —
 *  so they're alerted immediately; the manager is a 4-hour safety net, not the front line. */
export const MANAGER_ESCALATION_HOURS = 4

/** Resolve the users.id of the AGENT responsible for a deliverable (the agent on the
 *  contact / listing / transaction / recruit it relates to). Null when none resolves
 *  (then only the manager escalation applies). */
export async function resolveResponsibleAgentUserId(
  supabase: ReturnType<typeof createServiceClient>,
  msg: { recipient_contact_id: string | null; entity_type: string | null; entity_id: string | null },
): Promise<string | null> {
  const agentIdToUser = async (agentId: string | null): Promise<string | null> => {
    if (!agentId) return null
    const { data } = await supabase.from("agents").select("user_id").eq("id", agentId).maybeSingle()
    return (data as { user_id: string | null } | null)?.user_id ?? null
  }
  // 1) The recipient contact's agent (covers most client messages).
  if (msg.recipient_contact_id) {
    const { data: c } = await supabase.from("contacts").select("agent_id").eq("id", msg.recipient_contact_id).maybeSingle()
    const u = await agentIdToUser((c as { agent_id?: string | null } | null)?.agent_id ?? null)
    if (u) return u
  }
  // 2) The owning entity's agent.
  if (msg.entity_id) {
    if (msg.entity_type === "listing") {
      const { data } = await supabase.from("listings").select("agent_id").eq("id", msg.entity_id).maybeSingle()
      const u = await agentIdToUser((data as { agent_id?: string | null } | null)?.agent_id ?? null)
      if (u) return u
    } else if (msg.entity_type === "transaction") {
      const { data } = await supabase.from("transactions").select("agent_id").eq("id", msg.entity_id).maybeSingle()
      const u = await agentIdToUser((data as { agent_id?: string | null } | null)?.agent_id ?? null)
      if (u) return u
    } else if (msg.entity_type === "recruit") {
      const { data } = await supabase.from("recruits").select("recruiter_agent_id").eq("id", msg.entity_id).maybeSingle()
      const u = await agentIdToUser((data as { recruiter_agent_id?: string | null } | null)?.recruiter_agent_id ?? null)
      if (u) return u
    } else if (msg.entity_type === "vendor_booking") {
      const { data } = await supabase.from("vendor_bookings").select("contact_id").eq("id", msg.entity_id).maybeSingle()
      const cid = (data as { contact_id?: string | null } | null)?.contact_id ?? null
      if (cid) {
        const { data: c } = await supabase.from("contacts").select("agent_id").eq("id", cid).maybeSingle()
        const u = await agentIdToUser((c as { agent_id?: string | null } | null)?.agent_id ?? null)
        if (u) return u
      }
    }
  }
  return null
}

/** Has `userId` already been notified about `messageId` with this notification type? */
async function alreadyNotified(
  supabase: ReturnType<typeof createServiceClient>, userId: string, messageId: string, type: string,
): Promise<boolean> {
  const { data } = await supabase.from("notifications")
    .select("id").eq("user_id", userId).eq("type", type).eq("entity_id", messageId).limit(1).maybeSingle()
  return !!data
}

/**
 * TWO-TIER approval push:
 *   · TIER 1 (agent) — the responsible agent is alerted on EVERY pending approval (they
 *     own the deal/client; they're the front line). type='approval_needed'.
 *   · TIER 2 (manager) — the broker/admin is escalated ONLY when a deliverable has sat
 *     unapproved ≥ MANAGER_ESCALATION_HOURS (4h). type='approval_escalation', high prio.
 * Idempotent per (user, message, type). Returns the counts for each tier.
 */
export async function enqueueApprovalNotifications(
  brokerageId: string, client?: ReturnType<typeof createServiceClient>,
  opts: { escalationHours?: number } = {},
): Promise<{ agentAlerts: number; managerEscalations: number }> {
  const supabase = client ?? createServiceClient()
  const escalationHours = opts.escalationHours ?? MANAGER_ESCALATION_HOURS
  const now = Date.now()

  const { data } = await supabase
    .from("agent_client_messages")
    .select("id, agent_kind, subject, proposed_at, recipient_contact_id, entity_type, entity_id")
    .eq("brokerage_id", brokerageId).eq("status", "proposed")
    .order("proposed_at", { ascending: true })
    .limit(200)
  const messages = (data ?? []) as Array<{
    id: string; agent_kind: string | null; subject: string | null; proposed_at: string | null
    recipient_contact_id: string | null; entity_type: string | null; entity_id: string | null
  }>
  if (messages.length === 0) return { agentAlerts: 0, managerEscalations: 0 }

  // Brokerage managers (escalation targets) resolved once.
  const { data: mgrs } = await supabase.from("users").select("id")
    .eq("brokerage_id", brokerageId).in("user_type", ["broker", "broker_admin", "admin"]).limit(20)
  const managerIds = ((mgrs ?? []) as Array<{ id: string }>).map((m) => m.id)

  let agentAlerts = 0, managerEscalations = 0
  for (const m of messages) {
    const label = (m.agent_kind && m.agent_kind in MANAGERS) ? MANAGERS[m.agent_kind as ManagerKey].label : "A manager"
    const ageHours = m.proposed_at ? (now - new Date(m.proposed_at).getTime()) / 3_600_000 : 0

    // TIER 1 — the responsible agent (front line).
    const agentUserId = await resolveResponsibleAgentUserId(supabase, m)
    if (agentUserId && !(await alreadyNotified(supabase, agentUserId, m.id, "approval_needed"))) {
      const { error } = await supabase.from("notifications").insert({
        user_id: agentUserId, brokerage_id: brokerageId, type: "approval_needed",
        title: `${label} needs your approval`,
        body: m.subject ? `${m.subject} — tap to review & approve.` : "A client message is awaiting your approval — tap to review.",
        entity_type: "agent_client_message", entity_id: m.id, priority: "medium", is_read: false,
      })
      if (!error) agentAlerts += 1
    }

    // TIER 2 — manager escalation, only past the 4h threshold.
    if (ageHours >= escalationHours) {
      for (const mid of managerIds) {
        if (mid === agentUserId) continue // the agent is the manager — don't double-notify
        if (await alreadyNotified(supabase, mid, m.id, "approval_escalation")) continue
        const { error } = await supabase.from("notifications").insert({
          user_id: mid, brokerage_id: brokerageId, type: "approval_escalation",
          title: `Overdue approval — ${label}`,
          body: `${m.subject ? `"${m.subject}"` : "A client message"} has waited ${Math.round(ageHours)}h without approval. Tap to step in.`,
          entity_type: "agent_client_message", entity_id: m.id, priority: "high", is_read: false,
        })
        if (!error) managerEscalations += 1
      }
    }
  }
  return { agentAlerts, managerEscalations }
}
