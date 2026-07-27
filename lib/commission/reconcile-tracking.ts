// lib/commission/reconcile-tracking.ts
//
// THE MONEY LIFECYCLE — close FREEZES the amount; the ledger TRACKS the money after close.
//
// The platform tracks a commission across two systems that represent two REAL stages of the money —
// they are NOT redundant:
//   • THE BRIDGE  — agent_commissions.status (pending → approved → paid): the agent-EARNINGS record
//                   (what the agent will receive). 'approved' = authorized to disburse (the CDA
//                   broker-sign for CDA brokerages; auto at close for non-CDA). 'paid' = the agent
//                   actually received their disbursement.
//   • THE LEDGER  — commission_distributions (pending → paid; deposit_received_at lives on the
//                   summary row): the MONEY MOVEMENT, line by line. A brokerage RECEIVES the
//                   commission deposit at closing, then DISBURSES each split.
//
// KEEP-ONE (m283/m284): the `commissions` summary twin was merged INTO agent_commissions, so the
// bridge row and the summary row are now one record. The two trackings that can still drift are that
// summary row and its per-line distributions.
//
// CLOSE (final CD, both signed) freezes the AMOUNT — it does NOT pay. After close the ledger tracks
// the deposit, then the disbursement. DISBURSEMENT is the ONE LOCK: both trackings go 'paid' together
// (a reaper heals any single-sided drift). This mirrors how real brokerages settle: for a CDA-enforced
// brokerage the commission flows commission → broker → brokerage → agent; for a non-CDA brokerage it
// disburses per the agent's payout preference.
//
// The pure detector/aggregator are unit-tested; the reconcile/deposit helpers do the I/O.

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

export type TrackingDriftDirection = "bridge_ahead" | "ledger_ahead" | null

/**
 * PURE: given the two trackings' status for ONE transaction, are they out of sync on PAID?
 *   • bridge_ahead — the earnings record is paid but the ledger isn't → heal the ledger.
 *   • ledger_ahead — the ledger is paid but the earnings record isn't → an anomaly a human resolves.
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
 * PURE: aggregate many ledger rows for one transaction into a single ledger status. Paid only
 * when at least one row exists and every non-cancelled row is paid; otherwise 'pending'. Returns null
 * when there is no ledger row at all (bridge-only — not drift, a separate leak concern).
 */
export function aggregateLedgerStatus(rows: Array<{ status?: string | null }>): string | null {
  const live = (rows ?? []).filter((r) => (r.status ?? "").toLowerCase() !== "cancelled" && (r.status ?? "").toLowerCase() !== "voided")
  if (live.length === 0) return null
  return live.every((r) => (r.status ?? "").toLowerCase() === "paid") ? "paid" : "pending"
}

/**
 * FREEZE THE AMOUNT AT CLOSE — the deal is done (final CD both-signed). This does NOT pay. For a
 * NON-CDA brokerage there is no CDA broker-sign to authorize disbursement, so the earnings record is
 * auto-APPROVED here (pending → approved) to keep the later disbursement path uniform. For a CDA
 * brokerage the broker-sign already approved it (or it stays pending until signed — the CDA authorizes).
 * Idempotent, best-effort — never blocks the close. Returns how many rows were authorized.
 */
export async function finalizeCommissionAtClose(
  svc: Svc,
  params: { transactionId: string; brokerageId: string; actorUserId: string },
): Promise<{ autoApproved: number; offersCda: boolean }> {
  const { data: brk } = await svc
    .from("brokerages")
    .select("offers_cda")
    .eq("id", params.brokerageId)
    .maybeSingle()
  const offersCda = (brk as { offers_cda?: boolean } | null)?.offers_cda ?? false

  // Non-CDA: no CDA authorization step exists, so closing the deal authorizes the amount.
  if (offersCda) return { autoApproved: 0, offersCda }

  const nowIso = new Date().toISOString()
  const { data: pending } = await svc
    .from("agent_commissions")
    .select("id")
    .eq("transaction_id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)
    .eq("status", "pending")
  let autoApproved = 0
  for (const row of (pending ?? []) as Array<{ id: string }>) {
    const { error } = await svc
      .from("agent_commissions")
      .update({ status: "approved", approved_at: nowIso, approved_by: params.actorUserId, updated_at: nowIso })
      .eq("id", row.id)
      .eq("status", "pending")
    if (!error) autoApproved++
  }
  return { autoApproved, offersCda }
}

/**
 * POST-CLOSE: the brokerage RECEIVED the commission deposit at closing. Stamps deposit_received_at on
 * the ledger for the transaction (idempotent — only stamps rows not already marked). This is the
 * ledger's money-tracking step BETWEEN close and disbursement. Best-effort.
 */
export async function recordCommissionDepositReceived(
  svc: Svc,
  params: { transactionId: string; brokerageId: string; actorUserId: string; at?: string },
): Promise<{ stamped: number }> {
  const at = params.at ?? new Date().toISOString()
  const { data, error } = await svc
    .from("agent_commissions")
    .update({ deposit_received_at: at, deposit_received_by: params.actorUserId })
    .eq("transaction_id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)
    .is("deposit_received_at", null)
    .select("id")
  if (error) return { stamped: 0 }
  return { stamped: (data ?? []).length }
}

/**
 * THE ONE LOCK AT DISBURSEMENT — the agent was paid, so lock the LEDGER (the agent_commissions
 * summary row + its commission_distributions) to paid together, so the two trackings converge on
 * 'paid' at the SAME real event (disbursement), never at close. Reuses the canonical payment-tracker
 * per ledger row (correct distribution rows + commission.paid event). Idempotent; best-effort.
 */
export async function reconcileCommissionDisbursement(
  svc: Svc,
  params: { transactionId: string; brokerageId: string; actorUserId: string; paidAt?: string },
): Promise<{ ledgerRowsFound: number; ledgerRowsLocked: number }> {
  const paidAt = params.paidAt ?? new Date().toISOString()
  const { data: ledgerRows } = await svc
    .from("agent_commissions")
    .select("id, status")
    .eq("transaction_id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)

  const rows = (ledgerRows ?? []) as Array<{ id: string; status: string | null }>
  let locked = 0
  if (rows.length > 0) {
    const { markCommissionPaid } = await import("./payment-tracker")
    for (const row of rows) {
      const status = (row.status ?? "").toLowerCase()
      if (status === "cancelled" || status === "voided") continue
      // A summary row that is ALREADY paid still needs work when its per-line
      // distributions lag behind — that is exactly the drift the reaper heals.
      // Skipping on summary-status alone would make the heal a no-op.
      if (status === "paid") {
        const { data: dists } = await svc
          .from("commission_distributions")
          .select("status")
          .eq("commission_id", row.id)
          .eq("brokerage_id", params.brokerageId)
        const distStatus = aggregateLedgerStatus((dists ?? []) as Array<{ status?: string | null }>)
        if (distStatus == null || distStatus === "paid") continue
      }
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
