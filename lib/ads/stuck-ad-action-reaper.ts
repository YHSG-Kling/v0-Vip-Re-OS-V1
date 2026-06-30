// ─── STUCK-AD-ACTION REAPER (Ads Manager) ────────────────────────────────────
// Nothing-falls-through guard for paid advertising: an ad action the broker
// APPROVED but that never executed (the launch failed silently) — authorized spend
// sitting idle. Escalates to the brokerage's ad-spend owners (broker/admins), since
// ad_manager_actions carries no agent_id and spend is a broker decision. Pure policy
// in stuck-ad-action-policy.ts.

import { createServiceClient } from "@/lib/supabase/service"
import { classifyStuckAdAction, AD_ACTION_STUCK_HOURS } from "./stuck-ad-action-policy"

type Svc = ReturnType<typeof createServiceClient>

export interface StuckAdActionReapResult {
  scanned: number
  escalated: number
}

// Ad spend is a broker/admin decision — resolve the brokerage's spend owners.
async function resolveAdSpendOwners(svc: Svc, brokerageId: string): Promise<string[]> {
  const { data } = await svc
    .from("users")
    .select("id, user_type")
    .eq("brokerage_id", brokerageId)
    .in("user_type", ["broker", "broker_admin", "admin"])
    .limit(20)
  return ((data ?? []) as Array<{ id: string }>).map((u) => u.id)
}

export async function reapStuckAdActions(
  brokerageId: string,
  client?: Svc,
  opts?: { now?: Date; limit?: number },
): Promise<StuckAdActionReapResult> {
  const svc = client ?? createServiceClient()
  const now = opts?.now ?? new Date()
  const result: StuckAdActionReapResult = { scanned: 0, escalated: 0 }

  const { data: rows } = await svc
    .from("ad_manager_actions")
    .select("id, status, approved_at, executed_at, action_type")
    .eq("brokerage_id", brokerageId)
    .in("status", ["approved", "executing"])
    .is("executed_at", null)
    .limit(opts?.limit ?? 200)

  if (!rows || rows.length === 0) return result

  let owners: string[] | null = null

  for (const row of rows as Array<{ id: string; status: string | null; approved_at: string | null; executed_at: string | null; action_type: string | null }>) {
    result.scanned++
    if (classifyStuckAdAction({ status: row.status, approvedAt: row.approved_at, executedAt: row.executed_at, now }) !== "escalate") {
      continue
    }

    // Idempotent: one open escalation per ad action.
    const { data: prior } = await svc
      .from("notifications")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("type", "ad_action_unlaunched")
      .eq("entity_id", row.id)
      .eq("is_read", false)
      .limit(1)
    if (prior && prior.length > 0) continue

    if (owners === null) owners = await resolveAdSpendOwners(svc, brokerageId)
    if (owners.length === 0) continue

    const actionType = (row.action_type ?? "ad action").toString().replace(/_/g, " ")
    for (const userId of owners) {
      await svc.from("notifications").insert({
        user_id: userId,
        brokerage_id: brokerageId,
        type: "ad_action_unlaunched",
        title: "📣 Approved ad spend never launched",
        body: `An approved "${actionType}" has sat unlaunched past ${AD_ACTION_STUCK_HOURS}h — the launch may have failed. Re-run it or cancel it so authorized spend isn't left idle.`,
        entity_type: "ad_manager_action",
        entity_id: row.id,
        priority: "high",
        is_read: false,
      })
    }
    result.escalated++
  }

  return result
}
