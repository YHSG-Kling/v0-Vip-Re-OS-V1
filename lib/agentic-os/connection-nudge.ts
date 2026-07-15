// lib/agentic-os/connection-nudge.ts
//
// PROACTIVE CONNECTION NUDGE (agenticapi model) — the "catch it BEFORE it
// fails" half of the connectivity fabric. The tenant card shows impact when
// they OPEN the dashboard; this reaches OUT: when a brokerage's connector
// fleet has a broken or expiring connection, notify the brokerage owners with
// the business impact ("reconnect your Instagram this week or your listing
// posts won't go out"). Deterministic; ONE nudge per (brokerage, provider,
// status) window ever (dedupe tag), so re-runs never spam. Rides the daily
// connector-health cron the fleet scan already runs.

import type { ConnectionImpactRead } from "@/lib/agentic-os/connection-impact"

/** PURE: the dedupe tag for a brokerage's current attention set (order-independent). */
export function nudgeTag(brokerageId: string, read: ConnectionImpactRead): string {
  const sig = [...read.broken.map((l) => `b:${l.provider}`), ...read.expiring.map((l) => `e:${l.provider}`)]
    .sort().join("|")
  return `[CONN_NUDGE:${brokerageId}] [${sig}]`
}

export interface NudgeResult { notified: number; skipped: boolean }

/**
 * Fire the proactive nudge for one brokerage when its connectivity needs
 * attention. Best-effort; deduped per attention-signature so the same broken
 * set never re-notifies until it changes or clears.
 */
export async function runConnectionNudge(svc: any, brokerageId: string): Promise<NudgeResult> {
  const { scanConnectivity } = await import("@/lib/agentic-os/resolve-connectivity")
  const { composeConnectionImpact, composeConnectionHeadline } = await import("@/lib/agentic-os/connection-impact")

  const report = await scanConnectivity({ brokerageId })
  const read = composeConnectionImpact(report)
  if (!read.needsAttention) return { notified: 0, skipped: true }

  const tag = nudgeTag(brokerageId, read)
  const { data: dup } = await svc.from("notifications").select("id").ilike("body", `%${tag}%`).limit(1).maybeSingle()
  if (dup) return { notified: 0, skipped: true }

  // Notify the brokerage's owners/admins (the ones who can reconnect).
  const { data: owners } = await svc.from("users").select("id")
    .eq("brokerage_id", brokerageId).in("user_type", ["broker", "broker_admin", "admin"]).limit(5)
  const recipients = ((owners ?? []) as Array<{ id: string }>).map((u) => u.id)
  if (recipients.length === 0) return { notified: 0, skipped: true }

  const headline = composeConnectionHeadline(read)
  const priority = read.broken.length > 0 ? "high" : "medium"
  let notified = 0
  for (const uid of recipients) {
    const { error } = await svc.from("notifications").insert({
      brokerage_id: brokerageId, user_id: uid, type: "connection_health",
      title: read.broken.length > 0 ? "A connection stopped working" : "A connection is about to expire",
      body: `${headline} Fix it in Settings → Connections. ${tag}`.slice(0, 480),
      priority, channel: "in_app", is_read: false,
    })
    if (!error) notified++
  }
  return { notified, skipped: notified === 0 }
}

/** Autonomous: every brokerage (rides the daily connector-health cron). */
export async function runConnectionNudgeAll(svc: any): Promise<{ brokerages: number; notified: number }> {
  const { data: brokerages } = await svc.from("brokerages").select("id").limit(2000)
  let notified = 0
  for (const b of ((brokerages ?? []) as Array<{ id: string }>)) {
    const r = await runConnectionNudge(svc, b.id).catch(() => null)
    if (r) notified += r.notified
  }
  return { brokerages: (brokerages ?? []).length, notified }
}
