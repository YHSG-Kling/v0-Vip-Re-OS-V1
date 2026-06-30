// ─── CLOSING-OVERDUE REAPER (Deal Coordinator) ───────────────────────────────
// Nothing-falls-through guard for the deal-level "blew past its close date and
// nobody noticed" failure. Scans non-terminal transactions whose estimated close
// date is past the grace window and escalates ONCE to the responsible agent so a
// stuck deal never sits silently. Mirrors the other reapers (scan → classify →
// idempotent escalate); the pure policy lives in closing-overdue-policy.ts.

import { createServiceClient } from "@/lib/supabase/service"
import {
  classifyOverdueClosing,
  daysOverdue,
  TERMINAL_TXN_STATUSES,
  CLOSING_OVERDUE_GRACE_DAYS,
} from "./closing-overdue-policy"

type Svc = ReturnType<typeof createServiceClient>

export interface ClosingOverdueReapResult {
  scanned: number
  escalated: number
}

export async function reapOverdueClosings(
  brokerageId: string,
  client?: Svc,
  opts?: { now?: Date; limit?: number },
): Promise<ClosingOverdueReapResult> {
  const svc = client ?? createServiceClient()
  const now = opts?.now ?? new Date()
  const result: ClosingOverdueReapResult = { scanned: 0, escalated: 0 }

  const cutoffIso = new Date(now.getTime() - CLOSING_OVERDUE_GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // Non-terminal deals whose estimated close date is already past the grace cutoff.
  const { data: rows } = await svc
    .from("transactions")
    .select("id, status, estimated_close_date, contact_id, listing_id")
    .eq("brokerage_id", brokerageId)
    .not("estimated_close_date", "is", null)
    .lt("estimated_close_date", cutoffIso)
    .not("status", "in", `(${Array.from(TERMINAL_TXN_STATUSES).join(",")})`)
    .limit(opts?.limit ?? 200)

  for (const row of (rows ?? []) as Array<{
    id: string; status: string | null; estimated_close_date: string | null
    contact_id: string | null; listing_id: string | null
  }>) {
    result.scanned++
    if (classifyOverdueClosing({ status: row.status, estimatedCloseDate: row.estimated_close_date, now }) !== "escalate") {
      continue
    }

    // Idempotent: one open overdue alert per transaction.
    const { data: prior } = await svc
      .from("notifications")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("type", "deal_closing_overdue")
      .eq("entity_id", row.id)
      .eq("is_read", false)
      .limit(1)
    if (prior && prior.length > 0) continue

    const { resolveResponsibleAgentUserId } = await import("@/lib/intelligence/mobile-approval-queue")
    const agentUserId = await resolveResponsibleAgentUserId(svc, {
      recipient_contact_id: row.contact_id,
      entity_type: "transaction",
      entity_id: row.id,
    })
    if (!agentUserId) continue

    const overdueDays = daysOverdue(row.estimated_close_date, now)
    await svc.from("notifications").insert({
      user_id: agentUserId,
      brokerage_id: brokerageId,
      type: "deal_closing_overdue",
      title: "⚠️ A deal blew past its close date",
      body: `This transaction was due to close ${overdueDays} day${overdueDays === 1 ? "" : "s"} ago and is still open. Confirm where it stands — push it to closing, or mark it lost so the Deal Coordinator stops tracking it.`,
      entity_type: "transaction",
      entity_id: row.id,
      priority: "high",
      is_read: false,
    })
    result.escalated++
  }

  return result
}
