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

  const { data: creds } = await svc
    .from("integration_credentials")
    .select("provider_name, is_active")
    .eq("brokerage_id", input.brokerageId)
    .in("provider_name", ["idx_broker", "spark", "rets", "bridge", "rentcast"])
    .eq("is_active", true)

  const idxProviders = new Set(["idx_broker", "spark", "rets", "bridge"])
  const hasIdx = creds?.some((c) => idxProviders.has(c.provider_name))
  const hasRentcast = creds?.some((c) => c.provider_name === "rentcast") || !!process.env.RENTCAST_API_KEY

  // Tier 1: IDX feed (when integrated)
  if (hasIdx) {
    // Stub: when an IDX provider is wired, route here.
    // Today we fall through to Rentcast since IDX integration is brokerage-specific.
    // The provider-specific clients (idx-broker.ts, spark-api.ts) live alongside
    // rentcast.ts and follow the same shape.
    return { listings: [], source: "none", error: "IDX provider configured but no client implementation yet" }
  }

  // Tier 2: Rentcast
  if (hasRentcast) {
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
