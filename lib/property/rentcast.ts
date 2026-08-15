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
import { logVendorUsage } from "@/lib/vendor-governance/usage-logger"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import {
  normalizeRentcastMarketStats,
  normalizeRentcastComps,
  type RentcastMarketStats,
  type RentcastComp,
} from "./rentcast-normalize"

export { normalizeRentcastMarketStats, normalizeRentcastComps, type RentcastMarketStats, type RentcastComp }

const RENTCAST_BASE = "https://api.rentcast.io/v1"

/** RentCast GET through the connector-gateway (X-Api-Key header). */
async function rentcastGet(apiKey: string, path: string, qs: URLSearchParams): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await callConnector<any>({
    connector: "rentcast", baseUrl: RENTCAST_BASE, path, method: "GET",
    query: Object.fromEntries(qs), auth: { style: "header", name: "X-Api-Key", value: apiKey },
  })
  return { ok: res.ok, status: res.status ?? 0, data: res.data }
}

// Approximate per-call costs at Rentcast's standard tier ($49/mo / 250 calls = $0.196).
// Used for usage telemetry — actual billing happens via Rentcast directly.
const COST_PER_LISTING_SEARCH = 0.20
const COST_PER_AVM_LOOKUP = 0.15

/**
 * Fire-and-forget usage logger; never blocks the caller's request.
 */
function meterCall(params: {
  brokerageId: string
  usageType: string
  cost: number
  endpoint: string
  metadata?: Record<string, any>
}) {
  void logVendorUsage({
    vendorName: "rentcast",
    usageType: params.usageType,
    unitCount: 1,
    estimatedCost: params.cost,
    systemSource: "buyer_search",
    brokerageId: params.brokerageId,
    metadata: { endpoint: params.endpoint, ...(params.metadata ?? {}) },
  }).catch(() => null)
}

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
  /** Listing status filter (RentCast): 'Active' (default) | 'Inactive' (off-market/expired). */
  status?: string
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
  qs.set("status", f.status ?? "Active")
  qs.set("limit", String(f.limit ?? 30))

  try {
    const res = await rentcastGet(apiKey, "/listings/sale", qs)
    meterCall({
      brokerageId: params.brokerageId,
      usageType: "api_call",
      cost: COST_PER_LISTING_SEARCH,
      endpoint: "/listings/sale",
      metadata: { ok: res.ok, status: res.status },
    })
    if (!res.ok) {
      return { success: false, listings: [], error: `Rentcast returned ${res.status}` }
    }
    const data = res.data
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
    const res = await rentcastGet(apiKey, "/listings/rental", qs)
    meterCall({
      brokerageId: params.brokerageId,
      usageType: "api_call",
      cost: COST_PER_LISTING_SEARCH,
      endpoint: "/listings/rental",
      metadata: { ok: res.ok, status: res.status },
    })
    if (!res.ok) {
      return { success: false, listings: [], error: `Rentcast returned ${res.status}` }
    }
    const data = res.data
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
    const res = await rentcastGet(apiKey, "/avm/value", qs)
    meterCall({
      brokerageId: params.brokerageId,
      usageType: "avm_lookup",
      cost: COST_PER_AVM_LOOKUP,
      endpoint: "/avm/value",
      metadata: { ok: res.ok, status: res.status },
    })
    if (!res.ok) return { value: null, rangeLow: null, rangeHigh: null }
    const data = res.data
    return {
      value: data?.price ?? null,
      rangeLow: data?.priceRangeLow ?? null,
      rangeHigh: data?.priceRangeHigh ?? null,
    }
  } catch {
    return { value: null, rangeLow: null, rangeHigh: null }
  }
}

// ---------------------------------------------------------------------------
// Market statistics endpoint — zip-level aggregate (median price, DOM, inventory).
// This is the TIER-1 data feed for the AI market-insight report, replacing the
// retired HouseCanary integration. RentCast is the brokerage's chosen property-data
// provider for AVM/comps/market stats.
// ---------------------------------------------------------------------------

const COST_PER_MARKET_LOOKUP = 0.20

/** Fetch zip-level sale market statistics from RentCast. Never throws. */
export async function getRentcastMarketStats(params: {
  brokerageId: string
  zipCode: string
}): Promise<RentcastMarketStats | null> {
  const apiKey = await getApiKey(params.brokerageId)
  if (!apiKey || !params.zipCode) return null

  try {
    const qs = new URLSearchParams({ zipCode: params.zipCode, dataType: "Sale", historyRange: "12" })
    const res = await rentcastGet(apiKey, "/markets", qs)
    meterCall({
      brokerageId: params.brokerageId,
      usageType: "market_stats",
      cost: COST_PER_MARKET_LOOKUP,
      endpoint: "/markets",
      metadata: { ok: res.ok, status: res.status, zip: params.zipCode },
    })
    if (!res.ok) return null
    const data = res.data
    return normalizeRentcastMarketStats(data?.saleData)
  } catch {
    return null
  }
}

/**
 * Fetch comparable sales for an address via RentCast's AVM endpoint (returns a
 * `comparables[]` array). This is the chosen comps source for CMA generation,
 * replacing the retired HouseCanary integration. Never throws.
 */
export async function getRentcastComps(params: {
  brokerageId: string
  address: string
  limit?: number
}): Promise<RentcastComp[]> {
  const apiKey = await getApiKey(params.brokerageId)
  if (!apiKey || !params.address) return []

  try {
    const qs = new URLSearchParams({ address: params.address, compCount: String(params.limit ?? 10) })
    const res = await rentcastGet(apiKey, "/avm/value", qs)
    meterCall({
      brokerageId: params.brokerageId,
      usageType: "comps_lookup",
      cost: COST_PER_AVM_LOOKUP,
      endpoint: "/avm/value(comps)",
      metadata: { ok: res.ok, status: res.status },
    })
    if (!res.ok) return []
    const data = res.data
    return normalizeRentcastComps(data?.comparables)
  } catch {
    return []
  }
}
