// IDX search adapter for the alert engine
// Calls IDXBrokerClient.forBrokerage + parallel internal listings query
// Merges + deduplicates by mls_number (internal listing wins on conflict)

import { IDXBrokerClient } from "@/lib/idxbroker-client"
import { createServiceClient } from "@/lib/supabase/service"
import type { AlertProperty, AlertCriteria } from "./alert-matcher"

export interface IDXAlertSearchResult {
  results: AlertProperty[]
  api_called: boolean
  response_time_ms: number | null
  error?: string
}

/**
 * `alertId` NAMES THE SUBJECT OF EVERY DIAGNOSTIC THIS FUNCTION EMITS — it was
 * accepted here and read by NOTHING until 2026-08-24. The alert engine runs this
 * once per alert across a whole cron sweep (lib/property-alerts/alert-engine.ts),
 * and both failure exits below were anonymous: an operator reading the log saw
 * "IDX API error" or nothing at all, with no way to tell WHICH alert — or which
 * brokerage's credential — produced it.
 *
 * The machine-readable `error` CODES are deliberately left untouched: the engine
 * compares `searchResult.error === "not_configured"` by string equality, so putting
 * an id inside that field would have broken the branch it feeds.
 */
export async function searchIDXForAlert(
  alertId: string,
  criteria: AlertCriteria,
  brokerageId: string
): Promise<IDXAlertSearchResult> {
  const startMs = Date.now()

  // ── IDX Broker call ───────────────────────────────────────────────────────
  const client = await IDXBrokerClient.forBrokerage(brokerageId)

  if (!client.isConfigured()) {
    console.warn(
      `[idx-alert-search] alert ${alertId} (brokerage ${brokerageId}) skipped — no IDX credential resolved`,
    )
    return { results: [], api_called: false, response_time_ms: null, error: "not_configured" }
  }

  let idxResults: AlertProperty[] = []
  let api_called = false

  try {
    const query = buildIDXQuery(criteria)
    const raw = await client.searchProperties(query)
    api_called = true
    idxResults = normaliseIDXResults(raw ?? [])
  } catch (err: any) {
    console.error(
      `[idx-alert-search] IDX API error on alert ${alertId} (brokerage ${brokerageId}):`,
      err?.message,
    )
    return {
      results: [],
      api_called: true,
      response_time_ms: Date.now() - startMs,
      error: err?.message ?? "idx_api_error",
    }
  }

  // ── Internal listings query (parallel source) ─────────────────────────────
  const supabase = createServiceClient()
  const internalQuery = supabase
    .from("listings")
    .select("id, mls_number, address, city, state, zip, list_price, bedrooms, bathrooms, sqft, status, listing_date, brokerage_id")
    .eq("brokerage_id", brokerageId)
    .in("lifecycle_stage", ["MLS_ACTIVE", "COMING_SOON_ACTIVE"])
    .is("deleted_at", null)

  if (criteria.min_price) internalQuery.gte("list_price", criteria.min_price)
  if (criteria.max_price) internalQuery.lte("list_price", criteria.max_price)
  if (criteria.bedrooms_min) internalQuery.gte("bedrooms", criteria.bedrooms_min)
  if (criteria.cities?.length) internalQuery.in("city", criteria.cities)

  const { data: internalListings } = await internalQuery

  const internalResults: AlertProperty[] = (internalListings ?? []).map(l => ({
    mls_number: l.mls_number ?? `internal-${l.id}`,
    property_address: l.address,
    city: l.city ?? undefined,
    state: l.state ?? undefined,
    zip: l.zip ?? undefined,
    list_price: l.list_price ? Number(l.list_price) : undefined,
    bedrooms: l.bedrooms ?? undefined,
    bathrooms: l.bathrooms ? Number(l.bathrooms) : undefined,
    sqft: l.sqft ?? undefined,
    property_type: "internal",
    listed_at: l.listing_date ?? undefined,
  }))

  // ── Merge + dedup by mls_number (internal listing wins) ───────────────────
  const merged = new Map<string, AlertProperty>()

  // IDX first (lower priority)
  for (const r of idxResults) {
    if (r.mls_number) merged.set(r.mls_number, r)
  }
  // Internal overwrites IDX on conflict
  for (const r of internalResults) {
    if (r.mls_number) merged.set(r.mls_number, r)
  }

  return {
    results: Array.from(merged.values()),
    api_called,
    response_time_ms: Date.now() - startMs,
  }
}

function buildIDXQuery(criteria: AlertCriteria): string {
  const parts: string[] = []
  if (criteria.cities?.length)      parts.push(criteria.cities.join(" OR "))
  if (criteria.zip_codes?.length)   parts.push(criteria.zip_codes.join(" OR "))
  if (criteria.keywords)            parts.push(criteria.keywords)
  if (criteria.property_types?.length) parts.push(criteria.property_types.join(" OR "))
  return parts.join(" ") || "active listings"
}

function normaliseIDXResults(raw: any[]): AlertProperty[] {
  return raw.map(r => ({
    mls_number:       r.mlsID   ?? r.mls_number   ?? r.id ?? "",
    property_address: r.address ?? r.property_address ?? "",
    city:             r.city    ?? undefined,
    state:            r.state   ?? undefined,
    zip:              r.zip     ?? r.zipCode ?? undefined,
    list_price:       r.listPrice   != null ? Number(r.listPrice)   : undefined,
    bedrooms:         r.bedrooms    != null ? Number(r.bedrooms)    : undefined,
    bathrooms:        r.bathrooms   != null ? Number(r.bathrooms)   : undefined,
    sqft:             r.sqft        != null ? Number(r.sqft)        : undefined,
    property_type:    r.propType    ?? r.property_type ?? undefined,
    days_on_market:   r.daysOnMarket != null ? Number(r.daysOnMarket) : undefined,
    listing_url:      r.listingURL  ?? r.listing_url ?? undefined,
    primary_photo_url: r.image      ?? r.primaryPhoto ?? undefined,
    is_price_reduction: !!r.priceReduction,
    previous_price:   r.previousPrice != null ? Number(r.previousPrice) : undefined,
    description:      r.remarks ?? r.description ?? undefined,
    listed_at:        r.listingDate ?? r.listed_at ?? undefined,
  }))
}
