/**
 * External listings search router.
 *
 * Tier order:
 *   1. IDX feed (provider_name='idx_broker' or 'spark_api') — full MLS data
 *   2. Rentcast (provider_name='rentcast') — paid data license, no IDX needed
 *   3. None — return empty; caller falls back to platform-internal listings only
 *
 * Output is normalized so callers don't need to know which source ran.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { searchRentcastSaleListings, type RentcastSearchFilters, type RentcastListing } from "./rentcast"
import { IDXBrokerClient, type NormalizedIdxListing } from "@/lib/idxbroker-client"
import { resolveListingSource } from "./listing-source"
import { resolveScopedConnection } from "@/lib/connections/resolve-scoped"

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
  const svc = createServiceClient()

  // IDX Broker may be stored under any of the credential tables / name aliases
  // (idxbroker vs idx_broker) — the connection manager resolves all of them.
  // Rentcast is tracked in integration_credentials.
  const [idxConn, { data: creds }] = await Promise.all([
    resolveScopedConnection("idxbroker", { brokerageId: input.brokerageId }),
    svc
      .from("integration_credentials")
      .select("provider_name, is_active")
      .eq("brokerage_id", input.brokerageId)
      .in("provider_name", ["spark", "rets", "bridge", "rentcast"])
      .eq("is_active", true),
  ])

  const hasIdx = !!idxConn?.apiKey
  const hasRentcast = creds?.some((c) => c.provider_name === "rentcast") || !!process.env.RENTCAST_API_KEY

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
