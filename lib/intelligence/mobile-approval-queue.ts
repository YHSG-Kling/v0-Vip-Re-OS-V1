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

/**
 * "Push" — for each DUE/BREACHED pending approval without an existing approval
 * notification, insert one for `recipientUserId` (deep-linked to /mobile/approvals).
 * Idempotent per (message) via notifications.entity_id. Returns how many were enqueued.
 */
export async function enqueueApprovalNotifications(
  brokerageId: string, recipientUserId: string, client?: ReturnType<typeof createServiceClient>,
): Promise<{ enqueued: number }> {
  const supabase = client ?? createServiceClient()
  const queue = await loadMobileApprovalQueue(brokerageId, supabase)
  const urgent = queue.items.filter((i) => i.slaLevel === "breached" || i.slaLevel === "due")
  if (urgent.length === 0) return { enqueued: 0 }

  // Skip messages that already have an approval notification (idempotency).
  const ids = urgent.map((i) => i.id)
  const { data: existing } = await supabase
    .from("notifications")
    .select("entity_id")
    .eq("user_id", recipientUserId).eq("type", "approval_needed").in("entity_id", ids)
  const have = new Set(((existing ?? []) as Array<{ entity_id: string | null }>).map((e) => e.entity_id))

  let enqueued = 0
  for (const item of urgent) {
    if (have.has(item.id)) continue
    const { error } = await supabase.from("notifications").insert({
      user_id: recipientUserId, brokerage_id: brokerageId,
      type: "approval_needed",
      title: `${item.managerLabel} needs your approval`,
      body: item.subject ? `${item.subject} — tap to review & approve.` : "A client message is awaiting your approval — tap to review.",
      entity_type: "agent_client_message", entity_id: item.id,
      priority: item.slaLevel === "breached" ? "high" : "medium",
      is_read: false,
    })
    if (!error) enqueued += 1
  }
  return { enqueued }
}
