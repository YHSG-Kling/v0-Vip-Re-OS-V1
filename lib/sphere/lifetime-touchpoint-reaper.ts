// lib/sphere/lifetime-touchpoint-reaper.ts
// ─────────────────────────────────────────────────────────────────────────────
// LIFETIME-TOUCHPOINT REAPER (server, Sphere Manager) — completes the reaper family at the lifetime door.
// Scheduled post-close touchpoints (lifetime_customer_touchpoints, status='scheduled') that pass their
// date without being delivered are reconciled here so none sit stale: the row is marked 'skipped' (it
// was never sent) and the MISS is escalated ONCE per contact to the responsible agent, so a past
// client's retention sequence never stalls unnoticed. Idempotent (only acts on overdue 'scheduled' rows;
// flipping them to 'skipped' makes re-runs no-ops). Best-effort; never throws. Mirrors the
// signal / video / workflow-run / stranded-offer reapers.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { classifyStuckTouchpoint, STALE_TOUCHPOINT_GRACE_DAYS } from "./lifetime-touchpoint-reaper-policy"

type Svc = ReturnType<typeof createServiceClient>

export interface TouchpointReapResult { scanned: number; reaped: number; escalated: number }

export async function reapStuckLifetimeTouchpoints(
  brokerageId: string, client?: Svc, opts?: { limit?: number },
): Promise<TouchpointReapResult> {
  const svc = client ?? createServiceClient()
  const result: TouchpointReapResult = { scanned: 0, reaped: 0, escalated: 0 }
  if (!brokerageId) return result

  const now = Date.now()
  const cutoffIso = new Date(now - STALE_TOUCHPOINT_GRACE_DAYS * 86_400_000).toISOString().split("T")[0]

  const { data: rows } = await svc
    .from("lifetime_customer_touchpoints")
    .select("id, contact_id, agent_id, touchpoint_type, scheduled_date, status")
    .eq("brokerage_id", brokerageId)
    .eq("status", "scheduled")
    .lt("scheduled_date", cutoffIso)
    .order("scheduled_date", { ascending: true })
    .limit(opts?.limit ?? 300)

  // Escalate at most once per contact even if several of their touches stalled.
  const escalatedContacts = new Set<string>()

  for (const row of (rows ?? []) as Array<{
    id: string; contact_id: string | null; agent_id: string | null
    touchpoint_type: string | null; scheduled_date: string | null; status: string
  }>) {
    result.scanned += 1
    if (classifyStuckTouchpoint({ status: row.status, scheduledDate: row.scheduled_date, now }) !== "reap") continue

    // Reconcile the row: it was never delivered → 'skipped' (so it's not stuck 'scheduled' forever and
    // re-runs skip it). Guard on status to stay idempotent under concurrency.
    const { error: updErr } = await svc
      .from("lifetime_customer_touchpoints")
      .update({ status: "skipped" })
      .eq("id", row.id).eq("status", "scheduled")
    if (updErr) continue
    result.reaped += 1

    // Surface the miss to the agent ONCE per contact (don't let a past client's sequence stall silently).
    if (!row.contact_id || escalatedContacts.has(row.contact_id)) continue
    escalatedContacts.add(row.contact_id)
    try {
      const { resolveResponsibleAgentUserId } = await import("@/lib/intelligence/mobile-approval-queue")
      const agentUserId = await resolveResponsibleAgentUserId(svc, {
        recipient_contact_id: row.contact_id, entity_type: "contact", entity_id: row.contact_id,
      })
      if (!agentUserId) continue
      // Idempotent alert per (contact) — don't re-notify if one is already open.
      const { data: prior } = await svc
        .from("notifications").select("id")
        .eq("brokerage_id", brokerageId).eq("type", "lifetime_touchpoint_missed").eq("entity_id", row.contact_id)
        .limit(1).maybeSingle()
      if (prior) continue
      await svc.from("notifications").insert({
        user_id: agentUserId, brokerage_id: brokerageId, type: "lifetime_touchpoint_missed",
        title: "A past-client touch slipped — reach out",
        body: "A scheduled post-close touchpoint for one of your past clients passed without going out. Send them a quick, genuine personal note so the relationship stays warm.",
        entity_type: "contact", entity_id: row.contact_id, priority: "normal", is_read: false,
      })
      result.escalated += 1
    } catch (e) {
      console.error("[lifetime-touchpoint-reaper] escalation failed:", e)
    }
  }

  return result
}
