/**
 * Rentcast API client — Tier-2 fallback for buyer property search when
 * the brokerage hasn't connected an IDX feed yet.
 *
 * Rentcast is a paid data license (~$49/mo, 250 calls). We do NOT persist
 * listing data — only `external_listing_id`, address, and last-seen price
 * are kept (24h TTL). All MLS-licensed display data is re-fetched at view time.
 *
 * Key endpoints used:
 *   GET /v1/listings/sale?city=X&state=Y&bedrooms=&bathrooms=&maxPrice=&minPrice=
 *   GET /v1/listings/rental?city=X&state=Y&...
 *   GET /v1/avm/value?address=...
 *   GET /v1/properties?address=...&city=...&state=...
 */

import { createServiceClient } from "@/lib/supabase/service"

const RENTCAST_BASE = "https://api.rentcast.io/v1"

export interface RentcastSearchFilters {
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

export interface RentcastListing {
  externalId: string
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
  status: string | null
  /** Display-only photo URL — do NOT store; re-fetch */
  photoUrl: string | null
  source: "rentcast"
}

// ---------------------------------------------------------------------------
// Resolve API key for a given brokerage
// ---------------------------------------------------------------------------

async function getApiKey(brokerageId: string): Promise<string | null> {
  // Brokerage-level credential takes precedence
  const svc = createServiceClient()
  const { data: cred } = await svc
    .from("integration_credentials")
    .select("api_key, is_active")
    .eq("brokerage_id", brokerageId)
    .eq("provider_name", "rentcast")
    .maybeSingle()

  if (cred?.is_active && cred.api_key) return cred.api_key

  // Platform-level fallback (single shared key across all brokerages)
  return process.env.RENTCAST_API_KEY ?? null
}

// ---------------------------------------------------------------------------
// Search for-sale listings
// ---------------------------------------------------------------------------

export async function searchRentcastSaleListings(params: {
  brokerageId: string
  filters: RentcastSearchFilters
}): Promise<{ success: boolean; listings: RentcastListing[]; error?: string }> {
  const apiKey = await getApiKey(params.brokerageId)
  if (!apiKey) {
    return { success: false, listings: [], error: "Rentcast not configured" }
  }

  const qs = new URLSearchParams()
  const f = params.filters
  if (f.city) qs.set("city", f.city)
  if (f.state) qs.set("state", f.state)
  if (f.zipCode) qs.set("zipCode", f.zipCode)
  if (f.bedroomsMin != null) qs.set("bedrooms", String(f.bedroomsMin))
  if (f.bathroomsMin != null) qs.set("bathrooms", String(f.bathroomsMin))
  if (f.propertyType) qs.set("propertyType", f.propertyType)
  qs.set("status", "Active")
  qs.set("limit", String(f.limit ?? 30))

  try {
    const res = await fetch(`${RENTCAST_BASE}/listings/sale?${qs.toString()}`, {
      headers: { "X-Api-Key": apiKey, Accept: "application/json" },
      // No Next.js cache — listing freshness matters
      cache: "no-store",
    })
    if (!res.ok) {
      return { success: false, listings: [], error: `Rentcast returned ${res.status}` }
    }
    const data = await res.json()
    const arr: any[] = Array.isArray(data) ? data : []

    // Apply price filters client-side (Rentcast doesn't always honor min/max)
    const filtered = arr.filter((r) => {
      const price = r?.price ?? r?.listPrice ?? null
      if (f.priceMin != null && (price == null || price < f.priceMin)) return false
      if (f.priceMax != null && (price == null || price > f.priceMax)) return false
      if (f.bedroomsMax != null && r?.bedrooms != null && r.bedrooms > f.bedroomsMax) return false
      return true
    })

    const listings: RentcastListing[] = filtered.map((r) => ({
      externalId: r?.id ?? r?.formattedAddress ?? "",
      address: r?.formattedAddress ?? r?.addressLine1 ?? "",
      city: r?.city ?? null,
      state: r?.state ?? null,
      zip: r?.zipCode ?? null,
      price: r?.price ?? r?.listPrice ?? null,
      bedrooms: r?.bedrooms ?? null,
      bathrooms: r?.bathrooms ?? null,
      squareFeet: r?.squareFootage ?? null,
      yearBuilt: r?.yearBuilt ?? null,
      propertyType: r?.propertyType ?? null,
      daysOnMarket: r?.daysOnMarket ?? null,
      status: r?.status ?? "Active",
      photoUrl: r?.photos?.[0] ?? null,
      source: "rentcast",
    }))

    return { success: true, listings }
  } catch (err: any) {
    return { success: false, listings: [], error: err?.message ?? "Rentcast fetch failed" }
  }
}

// ---------------------------------------------------------------------------
// Search rental listings (used by investor mode + lifetime customer portal)
// ---------------------------------------------------------------------------

export async function searchRentcastRentalListings(params: {
  brokerageId: string
  filters: RentcastSearchFilters
}): Promise<{ success: boolean; listings: RentcastListing[]; error?: string }> {
  const apiKey = await getApiKey(params.brokerageId)
  if (!apiKey) {
    return { success: false, listings: [], error: "Rentcast not configured" }
  }

  const qs = new URLSearchParams()
  const f = params.filters
  if (f.city) qs.set("city", f.city)
  if (f.state) qs.set("state", f.state)
  if (f.zipCode) qs.set("zipCode", f.zipCode)
  if (f.bedroomsMin != null) qs.set("bedrooms", String(f.bedroomsMin))
  qs.set("status", "Active")
  qs.set("limit", String(f.limit ?? 20))

  try {
    const res = await fetch(`${RENTCAST_BASE}/listings/rental?${qs.toString()}`, {
      headers: { "X-Api-Key": apiKey, Accept: "application/json" },
      cache: "no-store",
    })
    if (!res.ok) {
      return { success: false, listings: [], error: `Rentcast returned ${res.status}` }
    }
    const data = await res.json()
    const arr: any[] = Array.isArray(data) ? data : []
    const listings: RentcastListing[] = arr.map((r) => ({
      externalId: r?.id ?? r?.formattedAddress ?? "",
      address: r?.formattedAddress ?? r?.addressLine1 ?? "",
      city: r?.city ?? null,
      state: r?.state ?? null,
      zip: r?.zipCode ?? null,
      price: r?.price ?? null,    // monthly rent
      bedrooms: r?.bedrooms ?? null,
      bathrooms: r?.bathrooms ?? null,
      squareFeet: r?.squareFootage ?? null,
      yearBuilt: r?.yearBuilt ?? null,
      propertyType: r?.propertyType ?? null,
      daysOnMarket: r?.daysOnMarket ?? null,
      status: r?.status ?? "Active",
      photoUrl: r?.photos?.[0] ?? null,
      source: "rentcast",
    }))
    return { success: true, listings }
  } catch (err: any) {
    return { success: false, listings: [], error: err?.message ?? "Rentcast fetch failed" }
  }
}

// ---------------------------------------------------------------------------
// AVM endpoint (used for cross-checking Perplexity estimate)
// ---------------------------------------------------------------------------

export async function getRentcastAVM(params: {
  brokerageId: string
  address: string
}): Promise<{ value: number | null; rangeLow: number | null; rangeHigh: number | null }> {
  const apiKey = await getApiKey(params.brokerageId)
  if (!apiKey) return { value: null, rangeLow: null, rangeHigh: null }

  try {
    const qs = new URLSearchParams({ address: params.address })
    const res = await fetch(`${RENTCAST_BASE}/avm/value?${qs.toString()}`, {
      headers: { "X-Api-Key": apiKey, Accept: "application/json" },
      cache: "no-store",
    })
    if (!res.ok) return { value: null, rangeLow: null, rangeHigh: null }
    const data = await res.json()
    return {
      value: data?.price ?? null,
      rangeLow: data?.priceRangeLow ?? null,
      rangeHigh: data?.priceRangeHigh ?? null,
    }
  } catch {
    return { value: null, rangeLow: null, rangeHigh: null }
  }
}
