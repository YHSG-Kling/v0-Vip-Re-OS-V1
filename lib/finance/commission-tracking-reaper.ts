// lib/finance/commission-tracking-reaper.ts
//
// COMMISSION TRACKING-DRIFT REAPER (finance_manager) — the safety net for the two commission status
// trackings. CLOSE now locks both the bridge (agent_commissions) and the ledger
// (commissions/commission_distributions) in one step, but historical closed deals and the manual
// mark-paid UI paths can still leave the two out of sync. This reaper finds transactions where the
// trackings disagree and:
//   • bridge paid, ledger lagging  → HEALS it (locks the ledger, reusing the canonical payment path).
//   • ledger paid, bridge lagging  → ESCALATES to finance/broker (an anomaly a human must resolve —
//                                     never force-finalizes an agent-earnings record the close didn't).
// Deduped, bounded, best-effort — one reaper failure never aborts the net.

import type { SupabaseClient } from "@supabase/supabase-js"
import {
  detectCommissionTrackingDrift,
  aggregateLedgerStatus,
  reconcileCommissionTrackingAtClose,
} from "@/lib/commission/reconcile-tracking"

type Svc = SupabaseClient<any, any, any>

const SCAN_LIMIT = 500

export async function reapCommissionTrackingDrift(
  brokerageId: string,
  svc: Svc,
): Promise<{ scanned: number; escalated: number; reaped: number }> {
  let scanned = 0, escalated = 0, reaped = 0

  // A broker/admin to attribute the healing payment to (falls back to system-empty).
  const { data: brokerUser } = await svc
    .from("users")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .in("user_type", ["broker", "broker_admin", "admin"])
    .limit(1)
    .maybeSingle()
  const actorUserId = (brokerUser as { id?: string } | null)?.id ?? ""

  const ledgerStatusFor = async (transactionId: string): Promise<string | null> => {
    const { data } = await svc
      .from("commissions")
      .select("status")
      .eq("transaction_id", transactionId)
      .eq("brokerage_id", brokerageId)
    return aggregateLedgerStatus((data ?? []) as Array<{ status?: string | null }>)
  }

  // ── Direction 1: bridge PAID, ledger lagging → HEAL ──────────────────────────
  const { data: paidBridge } = await svc
    .from("agent_commissions")
    .select("transaction_id")
    .eq("brokerage_id", brokerageId)
    .eq("status", "paid")
    .not("transaction_id", "is", null)
    .limit(SCAN_LIMIT)
  const bridgeTxns = Array.from(new Set(((paidBridge ?? []) as Array<{ transaction_id: string | null }>)
    .map((r) => r.transaction_id).filter((x): x is string => !!x)))

  for (const txnId of bridgeTxns) {
    scanned++
    const ledgerStatus = await ledgerStatusFor(txnId)
    const { direction } = detectCommissionTrackingDrift({ bridgeStatus: "paid", ledgerStatus })
    if (direction === "bridge_ahead") {
      const r = await reconcileCommissionTrackingAtClose(svc, { transactionId: txnId, brokerageId, actorUserId })
      if (r.ledgerRowsLocked > 0) reaped++
    }
  }

  // ── Direction 2: ledger PAID, bridge lagging → ESCALATE ──────────────────────
  const { data: paidLedger } = await svc
    .from("commissions")
    .select("transaction_id")
    .eq("brokerage_id", brokerageId)
    .eq("status", "paid")
    .not("transaction_id", "is", null)
    .limit(SCAN_LIMIT)
  const ledgerTxns = Array.from(new Set(((paidLedger ?? []) as Array<{ transaction_id: string | null }>)
    .map((r) => r.transaction_id).filter((x): x is string => !!x)))

  for (const txnId of ledgerTxns) {
    if (bridgeTxns.includes(txnId)) continue // already consistent (bridge paid too)
    const { data: bridge } = await svc
      .from("agent_commissions")
      .select("status")
      .eq("transaction_id", txnId)
      .eq("brokerage_id", brokerageId)
      .limit(1)
      .maybeSingle()
    const bridgeStatus = (bridge as { status?: string | null } | null)?.status ?? null
    if (bridgeStatus == null) continue // no bridge row — a leak concern, not tracking-drift
    const ledgerStatus = await ledgerStatusFor(txnId)
    const { direction } = detectCommissionTrackingDrift({ bridgeStatus, ledgerStatus })
    if (direction !== "ledger_ahead") continue
    scanned++

    // Dedup — one open alert per (transaction) in the last 7 days.
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString()
    const { data: existing } = await svc
      .from("notifications")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("type", "commission_tracking_drift")
      .eq("entity_id", txnId)
      .gte("created_at", since)
      .limit(1)
    if (existing && existing.length > 0) continue

    escalated++
    if (actorUserId) {
      await svc.from("notifications").insert({
        user_id: actorUserId,
        brokerage_id: brokerageId,
        type: "commission_tracking_drift",
        title: "Commission tracking mismatch",
        body: "A closed deal's commission ledger shows PAID but the agent-earnings record isn't finalized. Review the transaction and finalize or correct it.",
        entity_type: "transaction",
        entity_id: txnId,
        priority: "high",
        channel: "in_app",
      }).then(() => {}, () => {})
    }
  }

  return { scanned, escalated, reaped }
}
