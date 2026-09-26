// lib/transactions/offer-execution-state.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE DEFINITION OF "FULLY EXECUTED BY BOTH BUYER AND SELLER".
//
// Owner's ruling, verbatim (2026-09-04):
//
//   "compliance is involved when an offer gates to create a transaction ONCE THE
//    OFFER IS FULLY EXECUTED BY BOTH BUYER AND SELLER, the compliance gate runs
//    through the documents against an approved checklist provided by the
//    brokerage … then the executed offer becomes a transaction, whether we
//    represent the seller, or/and the buyer."
//
// Full execution is therefore a PRECONDITION of the compliance gate, not a
// by-product of it — and it is the SAME precondition on either side of the deal.
// Nothing here varies by representation: a contract is executed when both
// parties signed it, whoever we work for.
//
// ── §6, ONE VOCABULARY — the two duplicates this file absorbed ───────────────
// The identical boolean used to be written out inline in three places. Merged
// onto this module (2026-09-04), duplicates deleted with tombstones naming this
// file:
//   · lib/transactions/offer-bridge.ts:assertOfferReadyForTransaction
//   · app/actions/buyer-offer/submit-to-compliance.ts:submitOfferToCompliance
//
// WHAT THE SURVIVOR WAS MISSING, AND WAS GIVEN FIRST (CLAUDE.md §1):
// this predicate read only the SELLER half. It never read `buyer_signed_at`,
// while both duplicates did — as a separate refusal a line above their copy of
// the boolean. So the function NAMED "fully executed" and documented as "BOTH
// sides have signed" could return true for an offer the buyer had never signed,
// and it was the weaker of the two spellings wearing the canonical name. The
// buyer leg is now part of the definition, which is what makes the name true and
// what the owner's "by both buyer and seller" requires.
//
// Two valid paths to an executed contract, both requiring the fully-signed
// contract to actually be ON FILE:
//   (A) buyer-first, then the seller ACCEPTS  (seller_response_type='accepted')
//   (B) the seller COUNTERS and the buyer signs the counter (seller_signed_at)
//
// No `server-only`: pure, unit-testable, no I/O.

export interface OfferExecutionFields {
  buyer_signed_at?: string | null
  seller_response_type?: string | null
  seller_signed_at?: string | null
  fully_signed_contract_received_at?: string | null
  transaction_id?: string | null
}

/** WHICH admissible path put the executed contract on file. `null` = neither did. */
export type OfferExecutionPath = "seller_accepted" | "seller_counter_signed"

/**
 * The SELLER half only: which of the two paths established the executed
 * contract. Kept separate from the buyer leg because the callers need the
 * PROVENANCE, not just the boolean — the compliance gate event records which
 * columns established each side, and a caller that re-derived that from its own
 * copy of the condition could disagree with the gate that refuses on it.
 */
export function offerExecutionPath(o: OfferExecutionFields): OfferExecutionPath | null {
  if (!o.fully_signed_contract_received_at) return null
  // Precedence matters and is preserved from the duplicates: 'accepted' wins
  // when both are somehow true, so the recorded provenance never flips.
  if (o.seller_response_type === "accepted") return "seller_accepted"
  if (o.seller_signed_at) return "seller_counter_signed"
  return null
}

/**
 * The exact columns that established the seller side, spelled ONCE. This string
 * is written into the compliance gate event (`both_sides.seller.established_by`)
 * and is the durable audit record of what was actually read.
 */
export const SELLER_EXECUTION_EVIDENCE: Record<OfferExecutionPath, string> = {
  seller_accepted:       "offers.seller_response_type='accepted' + offers.fully_signed_contract_received_at",
  seller_counter_signed: "offers.seller_signed_at + offers.fully_signed_contract_received_at",
}

/**
 * PURE. True when BOTH sides have signed and the executed contract is on file —
 * the owner's "fully executed by both buyer and seller".
 *
 * The buyer leg is `buyer_signed_at`, which has TWO admissible writers (our
 * e-sign webhook, and a named human attesting to an executed contract already on
 * file — lib/buyer-offer/buyer-signature-evidence.ts). This predicate asks only
 * whether the column is set; WHAT established it is that module's question.
 */
export function isOfferFullyExecuted(o: OfferExecutionFields): boolean {
  if (!o.buyer_signed_at) return false
  return offerExecutionPath(o) !== null
}

/** PURE. Should the autonomous "execute → compliance scan → under contract" loop fire for this offer?
 *  Only when it's fully executed AND no transaction exists yet (idempotent — never double-creates). */
export function shouldAutoExecuteOffer(o: OfferExecutionFields): boolean {
  if (o.transaction_id) return false
  return isOfferFullyExecuted(o)
}
