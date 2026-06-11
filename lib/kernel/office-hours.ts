// lib/kernel/office-hours.ts
//
// MANAGER OFFICE HOURS — anti-fatigue batching. The competitors' failure mode is the
// notification spray: every automation pings the instant it runs and the agent learns
// to ignore all of it. A real office works on DROPS: the team works all day (and all
// night — idle hands), and the boss gets ONE organized stack in the morning and ONE
// in the afternoon.
//
// Each drop SWEEPS the unread per-proposal "approval_needed" pings into a single
// digest per agent — "Your team's morning drop: 7 proposals (Marketing 3, Sphere 2,
// AI ISA 2), oldest waiting 9h" — and marks the swept pings read so the inbox shows
// one card instead of seven. Nothing about the approvals themselves changes: the
// proposals still pend in the same gate, the SLA cron still escalates, fire drills
// and other CRITICAL notifications are NEVER swept (urgency outranks tidiness).
//
// NOT server-only (simulator-driven, like the rest of the kernel loaders).

import { createServiceClient } from "@/lib/supabase/service"
import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"

type Svc = ReturnType<typeof createServiceClient>

export interface DropItem { manager: ManagerKey | "unknown"; subject: string | null; hoursWaiting: number }

/** Pure: compose one drop digest — grouped by manager, oldest wait surfaced. */
export function composeDrop(slot: "morning" | "afternoon", items: DropItem[]): { title: string; body: string } {
  const byManager = new Map<string, number>()
  for (const i of items) {
    const label = i.manager === "unknown" ? "Team" : MANAGERS[i.manager].label
    byManager.set(label, (byManager.get(label) ?? 0) + 1)
  }
  const groups = Array.from(byManager.entries()).sort((a, b) => b[1] - a[1])
    .map(([label, n]) => `${label} ${n}`).join(", ")
  const oldest = Math.max(...items.map((i) => i.hoursWaiting), 0)
  return {
    title: `📥 Your team's ${slot} drop — ${items.length} proposal${items.length === 1 ? "" : "s"}`,
    body: `${items.length} proposal${items.length === 1 ? "" : "s"} wait${items.length === 1 ? "s" : ""} on you (${groups}). Oldest has waited ${Math.round(oldest)}h. Say "what should I do today" or open your queue — approving is one tap each.`,
  }
}

export interface OfficeHoursResult { digests: number; swept: number }

/**
 * One drop for a brokerage: per agent with unread approval pings, sweep them into a
 * single digest. CRITICAL notifications are untouched; one digest per agent per slot
 * per day; an agent with nothing pending gets nothing.
 */
export async function runOfficeHoursDrop(
  brokerageId: string,
  slot: "morning" | "afternoon",
  opts: { now?: Date } = {},
  client?: Svc,
): Promise<OfficeHoursResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const today = now.toISOString().slice(0, 10)

  // Unread per-proposal pings (medium priority — CRITICAL is never swept).
  const { data: pings } = await supabase.from("notifications")
    .select("id, user_id, entity_id, created_at")
    .eq("brokerage_id", brokerageId).eq("type", "approval_needed").eq("is_read", false)
    .neq("priority", "critical").limit(500)

  const byUser = new Map<string, Array<{ id: string; entity_id: string | null; created_at: string }>>()
  for (const p of (pings ?? []) as any[]) {
    if (!p.user_id) continue
    const list = byUser.get(p.user_id) ?? []
    list.push(p)
    byUser.set(p.user_id, list)
  }

  let digests = 0, swept = 0
  for (const [userId, userPings] of byUser) {
    // One digest per agent per slot per day.
    const { data: already } = await supabase.from("notifications").select("id")
      .eq("user_id", userId).eq("type", "office_hours_drop")
      .gte("created_at", `${today}T00:00:00Z`).ilike("title", `%${slot} drop%`).limit(1).maybeSingle()
    if (already) continue

    // The pings' underlying proposals — still pending only (approved ones drop out).
    const ids = userPings.map((p) => p.entity_id).filter((x): x is string => !!x)
    const { data: props } = await supabase.from("agent_client_messages")
      .select("id, agent_kind, subject, proposed_at").in("id", ids).eq("status", "proposed").limit(200)
    const items: DropItem[] = ((props ?? []) as any[]).map((p) => ({
      manager: (p.agent_kind in MANAGERS ? p.agent_kind : "unknown") as ManagerKey | "unknown",
      subject: p.subject,
      hoursWaiting: p.proposed_at ? (now.getTime() - new Date(p.proposed_at).getTime()) / 3_600_000 : 0,
    }))
    if (items.length === 0) continue

    const drop = composeDrop(slot, items)
    const { error } = await supabase.from("notifications").insert({
      user_id: userId, brokerage_id: brokerageId, type: "office_hours_drop",
      title: drop.title, body: drop.body, priority: "medium", is_read: false,
    })
    if (error) continue
    digests += 1

    // Sweep: the individual pings collapse into the drop (read, not deleted — audit).
    const stillPending = new Set(((props ?? []) as any[]).map((p) => p.id))
    const sweepIds = userPings.filter((p) => p.entity_id && stillPending.has(p.entity_id)).map((p) => p.id)
    if (sweepIds.length > 0) {
      const { data: updated } = await supabase.from("notifications")
        .update({ is_read: true }).in("id", sweepIds).select("id")
      swept += (updated ?? []).length
    }
  }
  return { digests, swept }
}
