// lib/commission/reconcile-tracking.ts
//
// ONE LOCK AT CLOSE — reconcile the two commission status trackings so they can never drift.
//
// The platform tracks a commission's paid state in TWO table systems, historically advanced by
// separate code with no cross-update:
//   • THE BRIDGE  — agent_commissions.status (pending → approved → paid): the agent-earnings
//                   dashboard/lifecycle record. Locked approved → paid at CLOSE (set-in-stone).
//   • THE LEDGER  — commissions.status + commission_distributions.status (pending → paid): the
//                   engine's disbursement ledger. Locked by markCommissionPaid (payment-tracker).
// Because CLOSE only locked the BRIDGE, a closed deal's ledger sat 'pending' forever while the
// dashboard said 'paid' — the two trackings disagreed. This module makes them ONE lock: when the
// bridge is finalized at close, the ledger is locked in the same step (reusing the canonical
// payment-tracker so the ledger's own event + distribution rows stay correct), and a reaper heals
// any historical/edge drift both ways.
//
// The pure detector is unit-tested; the reconcile+reaper do the I/O.

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

export type TrackingDriftDirection = "bridge_ahead" | "ledger_ahead" | null

/**
 * PURE: given the two trackings' status for ONE transaction, are they out of sync?
 *   • bridge_ahead — the bridge (agent_commissions) is paid but the ledger isn't → heal the ledger.
 *   • ledger_ahead — the ledger is paid but the bridge isn't → an anomaly a human should see.
 *   • null         — consistent, or one side is absent (nothing to compare).
 * `ledgerStatus` is the AGGREGATE ledger state (paid only when every commissions row for the txn is
 * paid); anything else is treated as not-yet-paid.
 */
export function detectCommissionTrackingDrift(input: {
  bridgeStatus: string | null | undefined
  ledgerStatus: string | null | undefined
}): { drifted: boolean; direction: TrackingDriftDirection } {
  const bridge = input.bridgeStatus ?? null
  const ledger = input.ledgerStatus ?? null
  if (bridge == null || ledger == null) return { drifted: false, direction: null }
  const bridgePaid = bridge === "paid"
  const ledgerPaid = ledger === "paid"
  if (bridgePaid === ledgerPaid) return { drifted: false, direction: null }
  return { drifted: true, direction: bridgePaid ? "bridge_ahead" : "ledger_ahead" }
}

/**
 * PURE: aggregate many commissions rows for one transaction into a single ledger status. Paid only
 * when at least one row exists and every non-cancelled row is paid; otherwise 'pending'. Returns null
 * when there is no ledger row at all (bridge-only — not drift, a separate leak concern).
 */
export function aggregateLedgerStatus(rows: Array<{ status?: string | null }>): string | null {
  const live = (rows ?? []).filter((r) => (r.status ?? "").toLowerCase() !== "cancelled")
  if (live.length === 0) return null
  return live.every((r) => (r.status ?? "").toLowerCase() === "paid") ? "paid" : "pending"
}

/**
 * Lock the LEDGER (commissions + commission_distributions) to paid for a transaction, in the SAME
 * step the bridge is finalized at close. Reuses the canonical payment-tracker markCommissionPaid per
 * ledger row so the distribution rows + the commission.paid lifecycle event stay correct. Idempotent
 * (already-paid/cancelled rows skipped). Best-effort — never blocks the close.
 */
export async function reconcileCommissionTrackingAtClose(
  svc: Svc,
  params: { transactionId: string; brokerageId: string; actorUserId: string; paidAt?: string },
): Promise<{ ledgerRowsFound: number; ledgerRowsLocked: number }> {
  const paidAt = params.paidAt ?? new Date().toISOString()
  const { data: ledgerRows } = await svc
    .from("commissions")
    .select("id, status")
    .eq("transaction_id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)

  const rows = (ledgerRows ?? []) as Array<{ id: string; status: string | null }>
  let locked = 0
  if (rows.length > 0) {
    const { markCommissionPaid } = await import("./payment-tracker")
    for (const row of rows) {
      const status = (row.status ?? "").toLowerCase()
      if (status === "paid" || status === "cancelled") continue
      const res = await markCommissionPaid({
        commissionId: row.id,
        brokerageId: params.brokerageId,
        paidBy: params.actorUserId,
        paidAt,
      })
      if (res.success) locked++
    }
  }
  return { ledgerRowsFound: rows.length, ledgerRowsLocked: locked }
}
