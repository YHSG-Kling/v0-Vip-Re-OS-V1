// lib/notifications/brokerage-admins.ts
// ─────────────────────────────────────────────────────────────────────────────
// Brokerage-admin notification — the way a manager raises a BROKERAGE-level alert to
// the broker/broker_admin/admin users who can act on it (activate an agent, fix an
// assignment rule, intervene on a deal). The brokerage-level counterpart to
// notifyPlatformStaff. Resolves recipients by user_type within the brokerage.

import type { SupabaseClient } from "@supabase/supabase-js"

/** The brokerage roles that receive operational alerts. */
export const BROKERAGE_ADMIN_ROLES = ["broker", "broker_owner", "broker_admin", "admin"] as const

export interface BrokerageAdminNotification {
  type: string
  title: string
  body: string
  entityType?: string | null
  entityId?: string | null
  priority?: "low" | "medium" | "high"
}

/** Resolve the broker/admin user ids for a brokerage, deduped. */
export async function resolveBrokerageAdminIds(supabase: SupabaseClient, brokerageId: string): Promise<string[]> {
  const { data: admins } = await supabase
    .from("users")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .in("user_type", [...BROKERAGE_ADMIN_ROLES])
    .limit(50)
  return Array.from(new Set(((admins ?? []) as Array<{ id: string }>).map((u) => u.id).filter(Boolean)))
}

/** Notify every broker/admin of a brokerage in the in-app feed. Returns the count notified. */
export async function notifyBrokerageAdmins(
  supabase: SupabaseClient,
  brokerageId: string,
  n: BrokerageAdminNotification,
): Promise<number> {
  const ids = await resolveBrokerageAdminIds(supabase, brokerageId)
  if (ids.length === 0) return 0
  const rows = ids.map((id) => ({
    user_id:      id,
    brokerage_id: brokerageId,
    type:         n.type,
    title:        n.title.slice(0, 200),
    body:         n.body.slice(0, 480),
    entity_type:  n.entityType ?? null,
    entity_id:    n.entityId ?? null,
    priority:     n.priority ?? "high",
    channel:      "in_app",
    is_read:      false,
  }))
  const { error } = await supabase.from("notifications").insert(rows)
  return error ? 0 : ids.length
}
