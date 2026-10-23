// lib/vendors/vendor-payout-events.ts
// ─────────────────────────────────────────────────────────────────────────────
// VENDOR PAYOUT COMPLETION COMES FROM THE PROVIDER'S EVENT — the missing writer.
//
// Owner ruling, verbatim (2026-08-27): "the vendor payout completed at should
// come from the providers event completion."
//
// WHAT THE WRITER CREATES. app/actions/vendor-payments.ts :: initiateVendorPayout
// creates a Stripe TRANSFER (lib/providers/payment/index.ts :: createTransfer →
// POST v1/transfers, destination = the vendor's connected account) on the
// BROKERAGE's Stripe account ({ side: "tenant", brokerageId }), then inserts
// vendor_payouts with stripe_transfer_id and status 'processing' ('pending' for
// non-Stripe methods). NOTHING ever wrote status 'paid'/'failed' or
// completed_at — the terminal half of the ledger had no writer, so every payout
// stayed "processing" forever on the vendor's earnings page.
//
// WHICH EVENTS (researched 2026-08-27 against the installed SDK, stripe@20.4.1,
// apiVersion 2026-02-25.clover — node_modules/stripe/types/EventTypes.d.ts):
//   · A Transfer emits exactly transfer.created / transfer.updated /
//     transfer.reversed. There is NO transfer.paid / transfer.failed in current
//     API versions (those died when transfers and payouts split in 2017) — a
//     handler waiting for them would wait forever.
//   · transfer.created  → the transfer landed on the connected account's
//     balance: the payout COMPLETED. transfer.reversed → the funds were pulled
//     back: FAILED. transfer.updated changes only description/metadata and is
//     deliberately ignored.
//   · payout.paid / payout.failed are events of the PAYOUT object (po_…), which
//     this repo stores in vendor_payouts.stripe_payout_id — a column with no
//     writer today. Mapped anyway so the read half of that column is honest the
//     day something writes it; matching zero rows until then is expected.
//
// ONE VOCABULARY (§6): the live CHECK on vendor_payouts.status is
// pending|processing|paid|failed|cancelled (queried 2026-08-27) — there is NO
// 'completed' token. The owner's "completed" is the 'paid' token plus the
// completed_at timestamp; writing 'completed' would be refused by the CHECK and
// supabase-js would RESOLVE that refusal. So: 'paid' + completed_at.
//
// TENANT (§4): the row is found by the STRIPE ID STORED ON IT — never by event
// metadata alone (metadata is written by whoever owns the signing account). The
// transfer was created on the brokerage's account, so a delivery signed by a
// tenant may only touch a payout row whose brokerage_id IS that tenant; a
// platform-signed delivery is the Connect-platform lane (connect-mode tenants
// bank under the platform's account, whose webhook receives their events).
//
// §3: the UPDATE is .select()ed and COUNTED — an update that matched nothing is
// reported as a failure to the caller (Stripe then redelivers), never as
// success. Replays are idempotent: Stripe redelivers, and a payout already in
// the target state answers "replay", not a second write.

type MaybeSingleResult = { data: unknown; error: { message: string } | null }

/** The slice of a supabase client this module touches — stubbed by the simulator. */
export interface VendorPayoutDbClient {
  from(table: "vendor_payouts"): {
    select(cols: string): {
      eq(col: string, v: string): {
        maybeSingle(): Promise<MaybeSingleResult>
      }
    }
    update(values: Record<string, unknown>): {
      eq(col: string, v: string): {
        select(cols: string): Promise<{ data: unknown[] | null; error: { message: string } | null }>
      }
    }
  }
}

export interface VendorPayoutEventMapping {
  /** Which vendor_payouts column carries the provider id this event names. */
  column: "stripe_transfer_id" | "stripe_payout_id"
  /** Terminal status in the LIVE vocabulary ('paid' is "completed" — no such token as 'completed'). */
  outcome: "paid" | "failed"
}

/** Stripe event type → what it means for a vendor payout. Names verified against stripe@20.4.1. */
export const VENDOR_PAYOUT_COMPLETION_EVENTS: Record<string, VendorPayoutEventMapping> = {
  "transfer.created": { column: "stripe_transfer_id", outcome: "paid" },
  "transfer.reversed": { column: "stripe_transfer_id", outcome: "failed" },
  "payout.paid": { column: "stripe_payout_id", outcome: "paid" },
  "payout.failed": { column: "stripe_payout_id", outcome: "failed" },
}

export type VendorPayoutEventResult =
  /** Not one of the four payout-completion events — caller falls through to its other lanes. */
  | { outcome: "not_payout_event" }
  /** No vendor_payouts row carries this stripe id. A FINDING for the caller to log —
   *  transfers exist that are not vendor payouts (agent commission disbursements ride
   *  the same v1/transfers), so this is acknowledged, never retried forever. */
  | { outcome: "unmatched"; message: string }
  /** The signing tenant does not own the payout row. Refused by name. */
  | { outcome: "refused_cross_tenant"; message: string }
  /** Redelivery of a state the row already holds — idempotent no-op. */
  | { outcome: "replay"; payoutId: string; status: string }
  /** A completion arriving after a definitive failure/cancellation — refused, not resurrected. */
  | { outcome: "stale_transition"; payoutId: string; message: string }
  | { outcome: "applied"; payoutId: string; status: "paid" | "failed"; completedAt: string | null; updatedCount: number }
  /** A read/update REFUSAL, or an update that matched nothing (§3) — the caller
   *  must answer 5xx so the provider redelivers. */
  | { outcome: "error"; message: string }

export interface VendorPayoutEventInput {
  /** event.type as delivered. */
  eventType: string
  /** event.data.object.id — tr_… or po_…. */
  stripeObjectId: string | null | undefined
  /** The PROVIDER's event time (event.created), ISO — this is what completed_at records. */
  eventCreatedAtIso: string
  /** The authenticated principal of the delivery (verifyStripeWebhook), never the payload. */
  signer: { ownerType: string; ownerId: string }
}

/**
 * Apply one Stripe payout-lifecycle event to the vendor_payouts ledger.
 * Pure over the injected client — the webhook route passes the service client,
 * the simulator passes a stub and the same decisions run.
 */
export async function applyVendorPayoutProviderEvent(
  svc: VendorPayoutDbClient,
  input: VendorPayoutEventInput,
): Promise<VendorPayoutEventResult> {
  const mapping = VENDOR_PAYOUT_COMPLETION_EVENTS[input.eventType]
  if (!mapping) return { outcome: "not_payout_event" }

  if (!input.stripeObjectId) {
    return { outcome: "error", message: `${input.eventType} delivery carried no object id — nothing to match a payout row by` }
  }

  // THE ROW IS FOUND BY THE ID STORED ON IT (§4) — not by metadata.
  const { data, error } = await svc
    .from("vendor_payouts")
    .select("id, brokerage_id, status, completed_at")
    .eq(mapping.column, input.stripeObjectId)
    .maybeSingle()
  if (error) {
    // A refused read is NOT "no row" (fail closed) — answer retryable.
    return { outcome: "error", message: `vendor_payouts read refused: ${error.message}` }
  }
  const row = data as { id: string; brokerage_id: string | null; status: string; completed_at: string | null } | null
  if (!row) {
    return {
      outcome: "unmatched",
      message: `no vendor_payouts row carries ${mapping.column}=${input.stripeObjectId} (${input.eventType})`,
    }
  }

  // TENANT: a tenant-signed delivery may only touch its own brokerage's payout.
  if (input.signer.ownerType !== "platform" && row.brokerage_id !== input.signer.ownerId) {
    return {
      outcome: "refused_cross_tenant",
      message:
        `payout ${row.id} belongs to brokerage ${row.brokerage_id ?? "(none)"} but the delivery was signed by ` +
        `${input.signer.ownerType} ${input.signer.ownerId} — a tenant's Stripe account has no authority over another tenant's payout ledger`,
    }
  }

  // IDEMPOTENCY + ORDER. Stripe redelivers; replays of the state we already
  // hold are no-ops. A reversal may follow a completion (funds landed, then
  // were pulled back → paid→failed is legal), but a completion must never
  // resurrect a definitive failure or a cancelled payout.
  if (row.status === mapping.outcome) return { outcome: "replay", payoutId: row.id, status: row.status }
  if (mapping.outcome === "paid" && (row.status === "failed" || row.status === "cancelled")) {
    return {
      outcome: "stale_transition",
      payoutId: row.id,
      message: `payout ${row.id} is already ${row.status}; a replayed ${input.eventType} does not resurrect it`,
    }
  }
  if (mapping.outcome === "failed" && row.status === "cancelled") {
    return {
      outcome: "stale_transition",
      payoutId: row.id,
      message: `payout ${row.id} is cancelled; ${input.eventType} records nothing further`,
    }
  }

  // completed_at is the PROVIDER's event time (the ruling), not our clock; a
  // failure clears it — the payout did not complete, whatever it did earlier.
  const completedAt = mapping.outcome === "paid" ? input.eventCreatedAtIso : null
  const { data: updated, error: updateErr } = await svc
    .from("vendor_payouts")
    .update({ status: mapping.outcome, completed_at: completedAt })
    .eq("id", row.id)
    .select("id")
  if (updateErr) return { outcome: "error", message: `vendor_payouts update refused: ${updateErr.message}` }
  const updatedCount = updated?.length ?? 0
  if (updatedCount === 0) {
    // §3 — a DELETE/UPDATE that matches nothing resolves identically to one that
    // worked. The row existed a moment ago, so zero here is a failure to report,
    // never a success to assume. 5xx from the route invites Stripe's redelivery.
    return { outcome: "error", message: `vendor_payouts update matched 0 rows for payout ${row.id} — nothing was recorded` }
  }
  return { outcome: "applied", payoutId: row.id, status: mapping.outcome, completedAt, updatedCount }
}
