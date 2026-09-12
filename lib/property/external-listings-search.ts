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
 *
 * ─── SALE OR RENTAL, AND WHY THAT USED TO BE UNASKABLE ──────────────────────
 * This router hard-coded `searchRentcastSaleListings` for every query. There was
 * no `listingType` on the input, so a caller could not ask for rentals even in
 * principle: whatever a seeker wanted, the request went to the FOR-SALE portal
 * and came back with sale prices in a field named `price`. RentCast's rental
 * endpoint has been wrapped in this repo the whole time
 * (`searchRentcastRentalListings`) and had ZERO consumers anywhere in the tree.
 *
 * `listingType` now selects the endpoint, and the RESULT says which one ran and
 * what its `price` field means — because "$2,400" is a catastrophic answer to
 * "what does this cost to buy" and a perfectly good answer to "what does it cost
 * to rent", and a normalized shape that does not distinguish them is how the two
 * get mixed in one list. Existing callers pass nothing and get `"sale"`, exactly
 * as before.
 *
 * THE RENTAL SIDE HAS NO IDX PROVIDER, AND SAYS SO. `IDXBrokerClient
 * .searchActiveListings` reads `/clients/featured` — the brokerage's own
 * featured FOR-SALE set — and carries no rental inventory. Under the owner
 * ruling a tenant who connected their own IDX feed is never billed for the
 * platform's RentCast, so for THAT tenant the rental side has no provider at
 * all. That is reported as `source: "none"` with a sentence saying why, in the
 * same shape as the CMA lane's closed-sale shortfall. It is not papered over
 * with a for-sale search, and RentCast is not quietly spent anyway.
 */

import {
  searchRentcastSaleListings,
  searchRentcastRentalListings,
  isRentcastConfigured,
  type RentcastSearchFilters,
  type RentcastListing,
} from "./rentcast"
import { IDXBrokerClient, type NormalizedIdxListing } from "@/lib/idxbroker-client"
import { resolveListingSource } from "./listing-source"
import { resolveRentcastEligibility, type TenantIdxConnection } from "./rentcast-eligibility"

/** What a seeker is actually looking for. `price` means a different thing per value. */
export type ExternalListingType = "sale" | "rental"

/**
 * The vendor-ledger lanes this router spends under.
 *
 * NAMED PER LISTING TYPE, and neither is `buyer_search` by accident. RentCast
 * metering used to hard-code `buyer_search` on every reader, so a CMA comp pull
 * and a market-stats read were both filed as buyer search — the one question the
 * ledger exists to answer had a single possible answer and it was wrong for most
 * calls. A renter's search is not a buyer's search and must not be billed as one.
 */
const SALE_SYSTEM_SOURCE = "buyer_search"
const RENTAL_SYSTEM_SOURCE = "renter_search"

export interface ExternalListing {
  externalId: string
  source: "idx" | "rentcast"
  /**
   * WHAT `price` MEANS ON THIS ROW. `"sale"` → an asking SALE price. `"rental"`
   * → a MONTHLY RENT. Carried per row rather than only on the result because
   * callers merge these into mixed lists (lib/buyer-search/search-engine.ts
   * concatenates them with platform listings), and a row that has lost the
   * meaning of its own central number cannot be rendered correctly by anyone.
   */
  listingType: ExternalListingType
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
  /** For a rental search these bound the MONTHLY RENT, not a sale price. */
  priceMin?: number
  priceMax?: number
  propertyType?: string
  limit?: number
  /**
   * Is the seeker buying or renting? Defaults to `"sale"`, which is what every
   * existing caller was getting when this could not be asked at all.
   */
  listingType?: ExternalListingType
  /** Vendor-ledger lane. Defaults per listing type — see the constants above. */
  systemSource?: string
  /** Vendor-ledger attribution only. Never a credential selector or tenant boundary. */
  contactId?: string | null
}

export interface ExternalSearchResult {
  listings: ExternalListing[]
  source: "idx" | "rentcast" | "none"
  /** Which portal was actually searched — echoed back so a caller cannot read a
   *  rent as a price. Always present, always equal to the request's intent. */
  listingType: ExternalListingType
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
  const listingType: ExternalListingType = input.listingType ?? "sale"
  const rentcast = await resolveRentcastEligibility({ brokerageId: input.brokerageId })
  const idx: TenantIdxConnection = rentcast.idx

  // FAIL CLOSED. If we could not determine whether this tenant owns an IDX feed
  // we may not spend the platform's RentCast budget on them, and we cannot claim
  // their board either. Say so; the caller still serves platform-internal
  // listings. "We could not tell" is never reported as "they have nothing".
  if (idx.status === "unreadable") {
    return { listings: [], source: "none", listingType, error: idx.detail }
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

  // ── THE RENTAL SIDE HAS NO IDX PROVIDER ───────────────────────────────────
  //
  // Decided HERE, before the IDX pull and before RentCast is spent, because both
  // alternatives are dishonest. `searchActiveListings` reads `/clients/featured`
  // — the brokerage's own featured FOR-SALE set — so running it for a rental
  // query would return homes for sale under a rent search. And spending the
  // platform's RentCast on a tenant who connected their own feed is the exact
  // thing the owner ruled out; "but their feed can't serve rentals" is not an
  // exception the ruling contains, and inventing one here would put this file
  // back to holding a second opinion about the precedence.
  //
  // So the honest outcome is the CMA lane's outcome for the closed-sale side: no
  // provider covers it for this tenant, stated in words, with nothing
  // substituted. The caller still serves platform-internal listings.
  if (listingType === "rental" && hasIdx) {
    return {
      listings: [],
      source: "none",
      listingType,
      error:
        `No external rental listings were searched, and that was DELIBERATE, not a failure: this brokerage has connected its own IDX Broker credentials${
          idx.status === "connected" ? ` (at ${idx.ownerType} level)` : ""
        }, and RentCast is the platform's provider for brokerages that have not. The IDX Broker feed this product reads serves the brokerage's own featured FOR-SALE inventory and carries no rental listings, so no external provider covers the rental side for this tenant.`,
    }
  }

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
    // Unreachable for a rental query — the branch above returned already — so
    // this is always a for-sale set.
    return { listings: idxListings.map(idxToExternal), source: "idx", listingType: "sale" }
  }

  // Tier 2: Rentcast — and THE ENDPOINT FOLLOWS WHAT THE SEEKER ASKED FOR.
  //
  // The two readers share a request shape, a gate and a row mapper; what they do
  // NOT share is the meaning of `price`. `/listings/sale` returns asking sale
  // prices, `/listings/rental/long-term` returns monthly rents. That is why they
  // are two functions and not a flag, and it is why `listingType` rides out on
  // both the result and every row.
  if (chosen === "rentcast") {
    const filters: RentcastSearchFilters = {
      city: input.city,
      state: input.state,
      zipCode: input.zipCode,
      bedroomsMin: input.bedroomsMin,
      bedroomsMax: input.bedroomsMax,
      bathroomsMin: input.bathroomsMin,
      // For a rental search these bound the MONTHLY RENT — the same `price`
      // query parameter on RentCast's rental endpoint.
      priceMin: input.priceMin,
      priceMax: input.priceMax,
      propertyType: input.propertyType,
      limit: input.limit,
    }
    const caller = {
      brokerageId: input.brokerageId,
      // The lane that actually spent, on the vendor-ledger row. A renter's
      // search filed as `buyer_search` is the defect that was just removed from
      // six other RentCast readers.
      systemSource:
        input.systemSource ?? (listingType === "rental" ? RENTAL_SYSTEM_SOURCE : SALE_SYSTEM_SOURCE),
      contactId: input.contactId ?? null,
    }
    const rc =
      listingType === "rental"
        ? await searchRentcastRentalListings({ ...caller, filters })
        : await searchRentcastSaleListings({ ...caller, filters })
    return {
      listings: rc.listings.map((l) => rentcastToExternal(l, listingType)),
      source: rc.success ? "rentcast" : "none",
      listingType,
      error: rc.error,
    }
  }

  // Tier 3: nothing available
  return { listings: [], source: "none", listingType }
}

function idxToExternal(l: NormalizedIdxListing): ExternalListing {
  return {
    externalId: l.externalId,
    source: "idx",
    // IDXBrokerClient.searchActiveListings reads the brokerage's featured
    // FOR-SALE set. There is no rental branch to mislabel.
    listingType: "sale",
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

/** `listingType` is passed in rather than inferred: the row shape is identical
 *  for both endpoints, so the only thing that knows which portal it came from is
 *  the caller that chose the endpoint. */
function rentcastToExternal(l: RentcastListing, listingType: ExternalListingType): ExternalListing {
  return {
    externalId: l.externalId,
    source: "rentcast",
    listingType,
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
