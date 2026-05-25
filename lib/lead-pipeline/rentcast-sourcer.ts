// lib/lead-pipeline/rentcast-sourcer.ts
// RentCast = STRUCTURED real-estate data API (rentals + MLS/sale listings with
// status + days-on-market). More reliable than HTML scraping for rentals and
// expired/off-market listings, so it is the PREFERRED source for those when a
// RentCast key is configured; the Apify/ZenRows scrapers remain the fallback.
//
// All records are SELLER intent (landlord / motivated seller) anchored on the
// property address; the owner is resolved by PeopleData skip-trace enrichment.
// Pure normalizer (rentcastToRecord) is unit-tested; the fetch is the real client.

import {
  searchRentcastRentalListings,
  searchRentcastSaleListings,
  type RentcastListing,
} from "@/lib/property/rentcast"
import { isViableRecord, type NormalizedScrapedRecord } from "./raw-record-types"

export interface RentcastMarket {
  city: string | null
  state: string | null
  zip?: string | null
}

/** Pure: a RentCast listing → canonical seller raw record for the given source. */
export function rentcastToRecord(
  listing: RentcastListing,
  source: "rental_listing" | "expired_listing",
): NormalizedScrapedRecord {
  const aging = (listing.daysOnMarket ?? 0) >= 90
  return {
    sourceRecordId: `rentcast-${source}-${listing.externalId}`,
    source,
    behaviorType: source,
    intentType: "seller",
    intentSignals:
      source === "expired_listing"
        ? ["off_market", "expired", ...(aging ? ["days_on_market"] : [])]
        : ["rental_listing", ...(aging ? ["vacant"] : [])],
    propertyAddress: listing.address || null,
    city: listing.city ?? null,
    state: listing.state ?? null,
    zip: listing.zip ?? null,
    // Expired/off-market is a stronger sell signal than an active rental.
    motivationScore: source === "expired_listing" ? 78 : aging ? 52 : 44,
    sourceUrl: null,
    rawPayload: { ...listing },
  }
}

/** Rentals via RentCast (landlord/investor sellers). */
export async function sourceRentcastRentals(
  brokerageId: string,
  market: RentcastMarket,
): Promise<{ records: NormalizedScrapedRecord[]; cost: number; ok: boolean }> {
  if (!market.city || !market.state) return { records: [], cost: 0, ok: false }
  const res = await searchRentcastRentalListings({
    brokerageId,
    filters: { city: market.city, state: market.state, zipCode: market.zip ?? undefined, limit: 50 },
  }).catch(() => ({ success: false, listings: [] as RentcastListing[] }))
  const records = (res.listings ?? []).map((l) => rentcastToRecord(l, "rental_listing")).filter(isViableRecord)
  return { records, cost: 0, ok: !!res.success }
}

/** Expired / off-market listings via RentCast (motivated sellers). */
export async function sourceRentcastExpired(
  brokerageId: string,
  market: RentcastMarket,
): Promise<{ records: NormalizedScrapedRecord[]; cost: number; ok: boolean }> {
  if (!market.city || !market.state) return { records: [], cost: 0, ok: false }
  const res = await searchRentcastSaleListings({
    brokerageId,
    filters: { city: market.city, state: market.state, zipCode: market.zip ?? undefined, status: "Inactive", limit: 50 },
  }).catch(() => ({ success: false, listings: [] as RentcastListing[] }))
  const records = (res.listings ?? []).map((l) => rentcastToRecord(l, "expired_listing")).filter(isViableRecord)
  return { records, cost: 0, ok: !!res.success }
}
