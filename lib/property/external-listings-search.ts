/**
 * External listings search router.
 *
 * Tier order:
 *   1. IDX feed — the TENANT'S OWN IDX Broker connection (owner ruling: a
 *      brokerage that sets one up searches THEIR board). Full MLS data.
 *   2. RentCast — the PLATFORM-GATED default (owner ruling): one platform
 *      account serving every tenant, metered per tenant and budget-gated. Not a
 *      per-tenant credential and never offered as one.
 *   3. None — return empty; caller falls back to platform-internal listings only
 *
 * Output is normalized so callers don't need to know which source ran.
 */

import { searchRentcastSaleListings, type RentcastSearchFilters, type RentcastListing } from "./rentcast"
import { IDXBrokerClient, type NormalizedIdxListing } from "@/lib/idxbroker-client"
import { resolveListingSource } from "./listing-source"
import { resolveConnection } from "@/lib/integrations/connection-manager"

export interface ExternalListing {
  externalId: string
  source: "idx" | "rentcast"
  address: string
  city: string | null
  state: string | null
  zip: string | null
  price: number | null
  bedrooms: number | null
  bathrooms: number | null
  squareFeet: number | null
  yearBuilt: number | null
  propertyType: string | null
  daysOnMarket: number | null
  photoUrl: string | null
}

export interface ExternalSearchInput {
  brokerageId: string
  city?: string
  state?: string
  zipCode?: string
  bedroomsMin?: number
  bedroomsMax?: number
  bathroomsMin?: number
  priceMin?: number
  priceMax?: number
  propertyType?: string
  limit?: number
}

export interface ExternalSearchResult {
  listings: ExternalListing[]
  source: "idx" | "rentcast" | "none"
  error?: string
}

/**
 * Picks the best available external source for the brokerage and runs the search.
 * Returns an empty list if no external source is configured (callers should
 * still serve internal platform listings).
 */
export async function searchExternalListings(
  input: ExternalSearchInput
): Promise<ExternalSearchResult> {
  // IDX Broker may be stored under any of the credential tables / name aliases
  // (idxbroker vs idx_broker) — the connection manager resolves all of them.
  // It is the TENANT-SETTABLE listing provider (owner ruling): a brokerage that
  // sets up their own IDX Broker account searches THEIR board.
  const idxConn = await resolveConnection({
    brokerageId: input.brokerageId,
    provider: "idxbroker",
  })

  const hasIdx = !!idxConn?.apiKey

  // RentCast is PLATFORM-GATED (owner ruling): one platform account serving every
  // tenant, metered per tenant and budget-gated. There is no tenant RentCast key
  // to look for, so availability is the platform key and nothing else.
  //
  // This used to read a per-brokerage `integration_credentials` row and OR it
  // with the platform key. Two things were wrong with that beyond the tenancy
  // model. The row could make this lane report AVAILABLE on a credential the
  // platform cannot meter or cap — and the read dropped its `error`, so a
  // refused lookup reported "no tenant credential" rather than "we could not
  // tell", which is the failure this codebase keeps paying for.
  //
  // The read was also querying `spark`, `rets` and `bridge` alongside rentcast
  // and then never inspecting any of them — `creds` was consulted for exactly
  // one thing, the rentcast row. With that gone the whole query is dead, so it
  // is removed rather than left as an unread round trip. If those three feeds
  // ever become selectable sources they need their own resolution and their own
  // branch below; silently re-adding them to a discarded `.in(...)` list would
  // not have made them work.
  const hasRentcast = !!process.env.RENTCAST_API_KEY

  // Tier 1: IDX Broker feed (the brokerage's own MLS-enabled active listings).
  let idxListings: NormalizedIdxListing[] = []
  if (hasIdx) {
    const idx = await IDXBrokerClient.forBrokerage(input.brokerageId)
    idxListings = await idx.searchActiveListings({
      city: input.city,
      state: input.state,
      zipCode: input.zipCode,
      bedroomsMin: input.bedroomsMin,
      bedroomsMax: input.bedroomsMax,
      bathroomsMin: input.bathroomsMin,
      priceMin: input.priceMin,
      priceMax: input.priceMax,
      limit: input.limit,
    })
  }

  // RentCast is the platform default; IDX wins only when connected AND it
  // actually returned results (account-scoped feeds can be empty for a query).
  const chosen = resolveListingSource({ hasIdx, idxResultCount: idxListings.length, hasRentcast })

  if (chosen === "idx") {
    return { listings: idxListings.map(idxToExternal), source: "idx" }
  }

  // Tier 2: Rentcast
  if (chosen === "rentcast") {
    const rc = await searchRentcastSaleListings({
      brokerageId: input.brokerageId,
      filters: {
        city: input.city,
        state: input.state,
        zipCode: input.zipCode,
        bedroomsMin: input.bedroomsMin,
        bedroomsMax: input.bedroomsMax,
        bathroomsMin: input.bathroomsMin,
        priceMin: input.priceMin,
        priceMax: input.priceMax,
        propertyType: input.propertyType,
        limit: input.limit,
      },
    })
    return {
      listings: rc.listings.map(rentcastToExternal),
      source: rc.success ? "rentcast" : "none",
      error: rc.error,
    }
  }

  // Tier 3: nothing available
  return { listings: [], source: "none" }
}

function idxToExternal(l: NormalizedIdxListing): ExternalListing {
  return {
    externalId: l.externalId,
    source: "idx",
    address: l.address,
    city: l.city,
    state: l.state,
    zip: l.zip,
    price: l.price,
    bedrooms: l.bedrooms,
    bathrooms: l.bathrooms,
    squareFeet: l.squareFeet,
    yearBuilt: l.yearBuilt,
    propertyType: l.propertyType,
    daysOnMarket: l.daysOnMarket,
    photoUrl: l.photoUrl,
  }
}

function rentcastToExternal(l: RentcastListing): ExternalListing {
  return {
    externalId: l.externalId,
    source: "rentcast",
    address: l.address,
    city: l.city,
    state: l.state,
    zip: l.zip,
    price: l.price,
    bedrooms: l.bedrooms,
    bathrooms: l.bathrooms,
    squareFeet: l.squareFeet,
    yearBuilt: l.yearBuilt,
    propertyType: l.propertyType,
    daysOnMarket: l.daysOnMarket,
    photoUrl: l.photoUrl,
  }
}
