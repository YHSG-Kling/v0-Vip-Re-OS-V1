// lib/finance/commission-tracking-reaper.ts
//
// COMMISSION TRACKING-DRIFT REAPER (finance_manager) — the safety net for the two commission status
// trackings. After the KEEP-ONE merge (m283/m284) the summary ledger and the agent-earnings bridge
// are the SAME row (agent_commissions), so the drift surface that remains is the summary row vs its
// per-line commission_distributions. Disbursement locks both in one step, but historical closed deals
// and the manual mark-paid UI paths can still leave the two out of sync. This reaper finds
// transactions where they disagree and:
//   • summary paid, distributions lagging → HEALS it (reusing the canonical payment path).
//   • distributions paid, summary lagging → ESCALATES to finance/broker (an anomaly a human must
//                                            resolve — never force-finalizes an earnings record.)
// Deduped, bounded, best-effort — one reaper failure never aborts the net.

import type { SupabaseClient } from "@supabase/supabase-js"
import {
  detectCommissionTrackingDrift,
  aggregateLedgerStatus,
  reconcileCommissionDisbursement,
} from "@/lib/commission/reconcile-tracking"

type Svc = SupabaseClient<any, any, any>

const SCAN_LIMIT = 500

export async function reapCommissionTrackingDrift(
  brokerageId: string,
  svc: Svc,
): Promise<{ scanned: number; escalated: number; reaped: number }> {
  let scanned = 0, escalated = 0, reaped = 0

  // A broker/admin to attribute the healing payment to — or, for a solo shop, the agent themselves
  // (tier-safe; falls back to system-empty only when the brokerage has no users at all).
  const { resolveOrgRecipients } = await import("@/lib/kernel/org-recipients")
  const actorUserId = (await resolveOrgRecipients(svc, brokerageId, { limit: 1 }))[0] ?? ""

  // The LEDGER side is now the per-line distributions — the summary row is the bridge.
  const ledgerStatusFor = async (transactionId: string): Promise<string | null> => {
    const { data } = await svc
      .from("commission_distributions")
      .select("status")
      .eq("transaction_id", transactionId)
      .eq("brokerage_id", brokerageId)
    return aggregateLedgerStatus((data ?? []) as Array<{ status?: string | null }>)
  }

  // ── Direction 1: summary PAID, distributions lagging → HEAL ──────────────────
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
      const r = await reconcileCommissionDisbursement(svc, { transactionId: txnId, brokerageId, actorUserId })
      // Orphan rows (referral fees and the legacy path — no commission_id) count as a heal.
      // Counting only ledgerRowsLocked reported 'reaped: 0' on the exact drift this reaper
      // exists to close, which reads identically to "nothing was wrong".
      if (r.ledgerRowsLocked > 0 || r.orphanRowsLocked > 0) reaped++
    }
  }

  // ── Direction 2: distributions PAID, summary lagging → ESCALATE ──────────────
  const { data: paidLedger } = await svc
    .from("commission_distributions")
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
