// lib/transactions/deal-type-resolver.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE deal_type resolution for a transaction created from an offer. deal_type (buyer|seller|dual)
// drives compliance REQUIRED-DOC seeding, client persona, and seller-close logic — so it must reflect
// who WE actually represent, not an in-house/buyer assumption.
//
// Two ground-truth signals the offer bridge can observe:
//   • ourListing — the offer is on one of OUR listings (a seller_contact_id resolved from it) → we
//     represent the SELLER side.
//   • ourBuyer   — the BUYER on the offer is OUR represented client: they're in our buyer pipeline
//     (contacts.buyer_stage is set). Our-buyer offers come through the buyer flow, which advances the
//     buyer_stage; an OUTSIDE buyer's offer that arrives by inbound-mail / upload intake creates a bare
//     contact with no buyer_stage. (agent_id is NOT a reliable signal — the mail intake stamps the
//     LISTING agent on an outside buyer's offer, so "same agent" alone can't tell single-agent dual
//     from a logged outside offer; buyer_stage can.)
//
// Rules:
//   • Not our listing (external/IDX target) → 'buyer' — we represent the buyer only.
//   • Our listing AND the buyer is our client → 'dual' — the brokerage holds BOTH sides. Covers BOTH
//     the two-agent in-house deal AND single-agent dual agency (one agent both sides) — same code path,
//     because the distinguishing fact is "is the buyer ours", not "how many agents".
//   • Our listing AND an OUTSIDE buyer → 'seller'.
// Pure + unit-tested.

export type DealType = "buyer" | "seller" | "dual"

export interface DealTypeInput {
  ourListing: boolean
  ourBuyer: boolean
}

export function resolveDealType(input: DealTypeInput): DealType {
  if (!input.ourListing) return "buyer"
  if (input.ourBuyer) return "dual"
  return "seller"
}
