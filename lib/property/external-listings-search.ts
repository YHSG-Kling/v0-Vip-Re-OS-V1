/**
 * External listings search router.
 *
 * Tier order:
 *   1. IDX feed — the TENANT'S OWN IDX Broker connection (owner ruling: a
 *      brokerage that sets one up searches THEIR board). Full MLS data.
 *   2. RentCast — the PLATFORM-GATED default (owner ruling): one platform
 *      account serving every tenant, metered per tenant and budget-gated. Not a
 *      per-tenant credential and never offered as one. Used ONLY by tenants who
 *      have not connected an IDX Broker account of their own.
 *   3. None — return empty; caller falls back to platform-internal listings only
 *
 * The tiers are EXCLUSIVE, not ordered-with-fallback. A connected IDX feed that
 * returns nothing for a query returns nothing — it does not fall through to
 * RentCast, because the owner ruling turns on the CONNECTION and not on what the
 * connection returned.
 *
 * Output is normalized so callers don't need to know which source ran.
 */

import { searchRentcastSaleListings, isRentcastConfigured, type RentcastSearchFilters, type RentcastListing } from "./rentcast"
import { IDXBrokerClient, type NormalizedIdxListing } from "@/lib/idxbroker-client"
import { resolveListingSource } from "./listing-source"
import { resolveRentcastEligibility, type TenantIdxConnection } from "./rentcast-eligibility"

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
  // ONE gate answers both halves of the routing question, so this file cannot
  // hold a second opinion about either provider.
  //
  // IDX: it used to be resolved HERE, through the legacy connection-manager,
  // while the client two lines down resolved it through the owner cascade
  // (resolveScopedConnection). Two resolvers for one question is how a gate and
  // the client it guards end up disagreeing about whether a tenant "has IDX" —
  // so this now asks the eligibility resolver, which asks the SAME resolver
  // IDXBrokerClient.forBrokerage asks, and counts only an OWNER-SCOPED
  // credential (a platform-tier IDX row is the product's fallback account, not
  // the tenant's).
  //
  // RentCast: platform key AND the owner ruling AND the vendor budget.
  const rentcast = await resolveRentcastEligibility({ brokerageId: input.brokerageId })
  const idx: TenantIdxConnection = rentcast.idx

  // FAIL CLOSED. If we could not determine whether this tenant owns an IDX feed
  // we may not spend the platform's RentCast budget on them, and we cannot claim
  // their board either. Say so; the caller still serves platform-internal
  // listings. "We could not tell" is never reported as "they have nothing".
  if (idx.status === "unreadable") {
    return { listings: [], source: "none", error: idx.detail }
  }

  const hasIdx = idx.status === "connected"

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
  //
  // The platform-key question stays asked HERE rather than being folded silently
  // into the gate: this file is where platform-gating was correctly enforced, and
  // the ruling NARROWS that gate rather than replacing it. Both halves are
  // visible on one line — the platform must have a key, AND this tenant must be
  // one RentCast is allowed to serve.
  //
  // It is asked through `isRentcastConfigured`, whose whole body is the platform
  // key resolve (getApiKey — structurally pinned by test:provider-tenancy-model
  // as the ONE key reader that selects nothing by tenant), rather than through a
  // second literal `process.env` read in this file. One reader, one answer: a
  // duplicated env read is how the two halves of a gate drift apart.
  const hasRentcastPlatformKey = await isRentcastConfigured(input.brokerageId)
  const hasRentcast = hasRentcastPlatformKey && rentcast.eligible

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

  // CONNECTION decides, not the result count. A tenant with their own feed is
  // served from their own feed even when it comes back empty for this query —
  // that is an honest empty from their board, and it is what the owner ruled.
  const chosen = resolveListingSource({ hasIdx, hasRentcast })

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
