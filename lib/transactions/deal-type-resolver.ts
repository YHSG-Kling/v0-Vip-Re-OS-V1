// lib/transactions/deal-type-resolver.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE deal_type resolution for a transaction created from an offer. deal_type (buyer|seller|dual)
// drives compliance REQUIRED-DOC seeding, client persona, and seller-close logic — so it must reflect
// who WE actually represent, not an in-house/buyer assumption.
//
// Two ground-truth signals the offer bridge can observe:
//   • ourListing — the offer is on one of OUR listings (a seller_contact_id resolved from it) → we
//     represent the SELLER side.
//   • ourBuyer   — the BUYER on the offer is OUR represented client: the buyer ladder has MOVED past
//     its column default (buyerStageShowsRepresentation below — "is set" was always true, the column
//     defaults to BUYER_CONTACT_CREATED) or an ACTIVE buyer-broker agreement names them (computed in
//     lib/transactions/offer-bridge.ts). An OUTSIDE buyer's offer that arrives by inbound-mail /
//     upload intake has neither. (agent_id is NOT a reliable signal — the mail intake stamps the
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

import { BUYER_STAGES } from "@/lib/contacts/buyer-stage"

export type DealType = "buyer" | "seller" | "dual"

export interface DealTypeInput {
  ourListing: boolean
  ourBuyer: boolean
}

/**
 * PURE. Does a contacts.buyer_stage value show that the buyer is in OUR pipeline?
 *
 * The column DEFAULTS to 'BUYER_CONTACT_CREATED' (live, 2026-10-01), so every contact — an outside
 * buyer logged for paperwork, even a seller — carries that value without anyone having worked a
 * purchase with them. Only a stage the buyer ladder has MOVED to is evidence of representation.
 * Unknown spellings are not evidence (one vocabulary per function — lib/contacts/buyer-stage.ts).
 */
const DEFAULT_BUYER_STAGE = "BUYER_CONTACT_CREATED"
export function buyerStageShowsRepresentation(stage: string | null | undefined): boolean {
  return !!stage && stage !== DEFAULT_BUYER_STAGE && (BUYER_STAGES as readonly string[]).includes(stage)
}

export function resolveDealType(input: DealTypeInput): DealType {
  if (!input.ourListing) return "buyer"
  if (input.ourBuyer) return "dual"
  return "seller"
}
