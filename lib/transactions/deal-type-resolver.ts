// lib/transactions/deal-type-resolver.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE deal_type resolution for a transaction created from an offer. deal_type (buyer|seller|dual)
// drives compliance REQUIRED-DOC seeding, client persona, and seller-close logic — so it must reflect
// who WE actually represent, not an in-house/buyer assumption.
//
// Ground truth the offer bridge can observe:
//   • ourListing      — the offer is on one of OUR listings (a seller_contact_id resolved from it).
//   • buyerAgentId    — offers.agent_id: the in-house agent who wrote the offer (the buyer's side).
//   • listingAgentId  — the in-house listing's agent (the seller's side).
//
// Rules:
//   • Not our listing (external/IDX target) → 'buyer' — we represent the buyer only.
//   • Our listing AND a DIFFERENT in-house agent represents the buyer → 'dual' — the brokerage holds
//     BOTH sides (the common in-house buyer + in-house listing deal: two of our agents, one each side).
//   • Our listing, same agent or no distinct buyer agent (e.g. the listing agent logged an outside
//     buyer's offer for tracking) → 'seller'.
//
// NOTE: single-agent dual agency (ONE agent representing both sides) reads as 'seller' here (same
// agent_id on both) — it's the rarer case and indistinguishable from a listing agent logging an outside
// offer. It can be set explicitly via the bridge's dealType override. Pure + unit-tested.

export type DealType = "buyer" | "seller" | "dual"

export interface DealTypeInput {
  ourListing: boolean
  buyerAgentId: string | null
  listingAgentId: string | null
}

export function resolveDealType(input: DealTypeInput): DealType {
  if (!input.ourListing) return "buyer"
  if (input.buyerAgentId && input.listingAgentId && input.buyerAgentId !== input.listingAgentId) {
    return "dual"
  }
  return "seller"
}
