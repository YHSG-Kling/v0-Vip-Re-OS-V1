// lib/contacts/ownership-model.ts
// Single source of truth for how contacts, properties, and offers relate.
// Import getOfferContext everywhere cross-side logic is needed — never inline it.

export type ContactSide = 'buyer' | 'seller' | 'both' | 'investor'

export type PropertyConnection =
  | { type: 'brokerage_listing'; listingId: string }  // property is in our system
  | { type: 'external_property'; mlsNumber: string }  // IDX / MLS only
  | { type: 'none' }

export type OfferContext =
  | { isCrossSide: true;  listingId: string; isSameAgent: boolean }  // brokerage listing → both sides tracked
  | { isCrossSide: false; propertyAddress: string }                   // external property → buyer side only

/**
 * Resolve whether an offer involves a brokerage listing (cross-side) or an
 * external IDX/MLS property (buyer-only).
 *
 * @param listingId       - offers.listing_id (null for external properties)
 * @param listingAgentId  - listings.agent_id (null when no listing)
 * @param buyerAgentId    - the agent creating / managing the buyer's offer
 */
export function getOfferContext(
  listingId:       string | null,
  listingAgentId:  string | null,
  buyerAgentId:    string,
): OfferContext {
  if (!listingId) {
    return { isCrossSide: false, propertyAddress: '' }
  }
  return {
    isCrossSide:  true,
    listingId,
    isSameAgent:  listingAgentId === buyerAgentId,
  }
}

// ── CANONICAL RULES ──────────────────────────────────────────────────────────
//
// contact.contact_type = 'buyer'
//   → dashboard at /contacts/[contactId]
//   → interested in properties (IDX search + brokerage listings)
//   → saved_properties.listing_id is only non-null when property is a brokerage listing
//
// contact.contact_type = 'seller'
//   → linked to a listing via listings.seller_contact_id
//   → portal shows a listing-specific view
//
// offers.listing_id IS NOT NULL
//   → cross-side: both buyer agent and listing agent are tracked
//   → dual-agency when listingAgentId === buyerAgentId
//   → seller portal notified on offer submission
//
// offers.listing_id IS NULL
//   → buyer-only: external IDX/MLS property
//   → standard offer flow — no listing-side notifications
