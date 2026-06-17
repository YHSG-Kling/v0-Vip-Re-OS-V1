// lib/buyer-search/portal-cards.ts
//
// PURE mapper — turn scored BuyerSearchResult[] (the search engine's contract) into the portal widget's
// PropertyResult card shape (SmartSearchWidget), merging the buyer's existing saved/dismissed state so
// the cards render with the right action-button state. No I/O — the route fetches the data and calls
// this; unit-tested directly. This is the single place the two shapes meet (no drift between them).

import type { BuyerSearchResult } from "./search-engine"

/** Mirrors SmartSearchWidget's PropertyResult + kernel BuyerPropertyInterestLevel. */
export type PortalInterestLevel =
  | "saved" | "favorited" | "dismissed" | "not_interested" | "offer_requested" | "tour_requested"

export interface PortalSearchCard {
  id: string
  address?: string
  list_price?: number
  bedrooms?: number
  bathrooms?: number
  primary_photo_url?: string
  current_interest?: PortalInterestLevel
}

/**
 * Map search results → portal cards, attaching the buyer's current interest (if any) by listing id.
 * Pure + total. Null numeric/string fields are dropped (the widget treats undefined as "unknown").
 */
export function toPortalCards(
  results: BuyerSearchResult[],
  interestByListing: Record<string, PortalInterestLevel> = {},
): PortalSearchCard[] {
  return (results ?? []).map((r) => {
    const card: PortalSearchCard = { id: r.listing_id }
    if (r.address) card.address = r.address
    if (r.price != null) card.list_price = r.price
    if (r.bedrooms != null) card.bedrooms = r.bedrooms
    if (r.bathrooms != null) card.bathrooms = r.bathrooms
    if (r.primary_photo_url) card.primary_photo_url = r.primary_photo_url
    const interest = interestByListing[r.listing_id]
    if (interest) card.current_interest = interest
    return card
  })
}

/**
 * PURE: collapse a saved_properties row (the live boolean model: dismissed / added_to_tour) into the
 * portal interest level the widget understands. Kept here so the route and tests share one rule.
 */
export function savedRowToInterest(row: { dismissed?: boolean | null; added_to_tour?: boolean | null }): PortalInterestLevel {
  if (row.dismissed) return "dismissed"
  if (row.added_to_tour) return "tour_requested"
  return "saved"
}
