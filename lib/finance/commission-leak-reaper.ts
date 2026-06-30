// ─── COMMISSION-LEAK REAPER (Finance Manager) ────────────────────────────────
// Nothing-falls-through guard for brokerage MONEY: a deal that closed but never
// got a commission recorded (the on-close calc failed silently — stage-progression
// doesn't block the close on commission failure). Scans recently-closed
// transactions, checks the canonical `commissions` table, and escalates ONCE per
// deal so real revenue is never silently lost. Pure policy in commission-leak-policy.ts.

import { createServiceClient } from "@/lib/supabase/service"
import { classifyCommissionLeak, COMMISSION_LEAK_GRACE_DAYS } from "./commission-leak-policy"

type Svc = ReturnType<typeof createServiceClient>

export interface CommissionLeakReapResult {
  scanned: number
  escalated: number
}

export async function reapCommissionLeaks(
  brokerageId: string,
  client?: Svc,
  opts?: { now?: Date; limit?: number },
): Promise<CommissionLeakReapResult> {
  const svc = client ?? createServiceClient()
  const now = opts?.now ?? new Date()
  const result: CommissionLeakReapResult = { scanned: 0, escalated: 0 }

  const cutoffIso = new Date(now.getTime() - COMMISSION_LEAK_GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // Recently-closed deals (within a reasonable lookback so we don't rescan ancient
  // history every run) whose close date is already past the reconciliation grace.
  const lookbackIso = new Date(now.getTime() - 120 * 24 * 60 * 60 * 1000).toISOString()
  const { data: rows } = await svc
    .from("transactions")
    .select("id, status, close_date, contact_id")
    .eq("brokerage_id", brokerageId)
    .eq("status", "closed")
    .not("close_date", "is", null)
    .lt("close_date", cutoffIso)
    .gte("close_date", lookbackIso)
    .limit(opts?.limit ?? 200)

  for (const row of (rows ?? []) as Array<{ id: string; status: string | null; close_date: string | null; contact_id: string | null }>) {
    result.scanned++

    // Canonical commission record present? (the engine writes `commissions` on close)
    const { data: comm } = await svc
      .from("commissions")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("transaction_id", row.id)
      .limit(1)
    const hasCommissionRow = !!comm && comm.length > 0

    if (classifyCommissionLeak({ status: row.status, closeDate: row.close_date, hasCommissionRow, now }) !== "escalate") {
      continue
    }

    // Idempotent: one open leak alert per transaction.
    const { data: prior } = await svc
      .from("notifications")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("type", "commission_unrecorded")
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

    await svc.from("notifications").insert({
      user_id: agentUserId,
      brokerage_id: brokerageId,
      type: "commission_unrecorded",
      title: "💸 A closed deal has no commission recorded",
      body: "This deal closed but no commission was recorded — the on-close calculation may have failed. Re-run the commission so your split and the brokerage P&L are correct.",
      entity_type: "transaction",
      entity_id: row.id,
      priority: "high",
      is_read: false,
    })
    result.escalated++
  }

  return result
}
