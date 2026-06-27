// lib/transactions/offer-execution-state.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE offer-execution predicate — the single definition of "both sides have signed → fully executed
// contract on file", matching the canonical gate in offer-bridge.assertOfferReadyForTransaction.
// Two valid paths: (A) buyer-first then seller ACCEPTS (seller_response_type='accepted' + the
// fully-signed contract received), (B) seller COUNTERS and the buyer signs the counter
// (seller_signed_at + fully-signed received). No server-only — unit-testable.

export interface OfferExecutionFields {
  seller_response_type?: string | null
  seller_signed_at?: string | null
  fully_signed_contract_received_at?: string | null
  transaction_id?: string | null
}

/** PURE. True when BOTH sides have signed and the executed contract is on file. */
export function isOfferFullyExecuted(o: OfferExecutionFields): boolean {
  const executedViaResponse = o.seller_response_type === "accepted" && !!o.fully_signed_contract_received_at
  const executedViaCounter  = !!o.seller_signed_at && !!o.fully_signed_contract_received_at
  return executedViaResponse || executedViaCounter
}

/** PURE. Should the autonomous "execute → compliance scan → under contract" loop fire for this offer?
 *  Only when it's fully executed AND no transaction exists yet (idempotent — never double-creates). */
export function shouldAutoExecuteOffer(o: OfferExecutionFields): boolean {
  if (o.transaction_id) return false
  return isOfferFullyExecuted(o)
}
