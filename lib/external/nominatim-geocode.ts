// lib/external/nominatim-geocode.ts
//
// Canonical FREE geocoder — address → { lat, lng } via OpenStreetMap Nominatim,
// routed through the connector-gateway (the one egress path to outside services), exactly
// like lib/external/osint-neighborhood.ts already does.
// No API key, no cost. Returns null on any failure (never throws, never fabricates).
//
// Nominatim usage policy: max ~1 request/second and a valid User-Agent. Callers that
// geocode several addresses in a row MUST space requests (see geocodeMany below, which
// serializes with a >=1s gap) and SHOULD cache — coordinates for a fixed address never
// change, so geocode each address at most once.
//
// This is the single shared helper so we stop re-inlining the same Nominatim call.
// MERGED (wave 5): osint-neighborhood.ts's private `geocodeAddress` copy is GONE — that
// module now calls geocodeOne here. FOLDED (wave 80 lane B): the third inline copy in
// lib/property/enrichment-chain.ts went with that file — its listing-intake path now
// lives in lib/ai-isa/property-lookup-rail.ts and geocodes through geocodeOne here.
// MOVED IN (wave 140, lane 140P): the two BROWSER Nominatim calls — app/components/ui/
// address-autocomplete.tsx and the offer-initiation flow — each fetched
// nominatim.openstreetmap.org/search from the client with its own address parser (two
// spellings of one parse, one with a state-abbreviation table and one without). Both now
// call the server action app/actions/address-suggestions.ts, which rides suggestAddressesDetailed
// below: the same gateway egress (tenant-scoped, health-gated), the same courtesy pacer, ONE
// parser (parseNominatimAddressRow), and a usage row on the free ledger.

import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { gatewayProbe, notAttemptedProbe, unreachableProbe, type FreeProbe } from "./free-probe"

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org"
/** Nominatim's documented courtesy rate limit: 1 request/second. */
export const NOMINATIM_MIN_GAP_MS = 1100
/** Fewer characters than this never leaves the server (Nominatim's policy forbids heavy
 *  autocomplete; the clients debounce AND the server refuses stubs). */
export const ADDRESS_SUGGEST_MIN_QUERY = 4
export const ADDRESS_SUGGEST_MAX_RESULTS = 5

export interface GeoPoint {
  lat: number
  lng: number
}

export interface AddressParts {
  address?: string | null
  city?: string | null
  state?: string | null
  zip?: string | null
}

/** PURE. Build the single-line query Nominatim expects from address parts. Exported so it
 *  can be unit-tested without a network call. Returns "" when there's nothing to geocode. */
export function buildGeocodeQuery(parts: AddressParts): string {
  const line = [parts.address, parts.city, parts.state, parts.zip]
    .map((p) => (p ?? "").toString().trim())
    .filter(Boolean)
    .join(", ")
  return line ? `${line}, USA` : ""
}

/**
 * COURTESY PACER AT THE ONE EGRESS POINT.
 *
 * Nominatim's usage policy is a hard 1 request/second and it BLOCKS abusers —
 * "keyless" does not mean "unlimited", and getting the platform's egress banned
 * would take the whole free lane down. createCachedGeocoder below paces a batch
 * it owns, but the enrichment drain calls geocodeOneDetailed once per queue row
 * with no shared resolver between rows, so the gap has to be enforced HERE, at
 * the single place the request is actually made.
 *
 * Per-instance state — that is all a serverless runtime can offer, and it is
 * strictly better than nothing. Callers that already pace (createCachedGeocoder)
 * simply find the gap satisfied and wait zero.
 */
let lastNominatimHitAt = 0
async function respectNominatimGap(): Promise<void> {
  const since = Date.now() - lastNominatimHitAt
  if (lastNominatimHitAt !== 0 && since < NOMINATIM_MIN_GAP_MS) {
    await new Promise((r) => setTimeout(r, NOMINATIM_MIN_GAP_MS - since))
  }
  lastNominatimHitAt = Date.now()
}

/** PURE. Parse a Nominatim result row into a GeoPoint, or null when it isn't a usable point. */
export function parseNominatimRow(row: unknown): GeoPoint | null {
  if (!row || typeof row !== "object") return null
  const r = row as { lat?: unknown; lon?: unknown }
  const lat = parseFloat(String(r.lat))
  const lng = parseFloat(String(r.lon))
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  return { lat, lng }
}

/**
 * Geocode ONE address, REPORTING WHY it failed. Real network call to Nominatim through
 * the gateway. Never throws.
 *
 * This is the implementation; geocodeOne below is the value-only wrapper. Callers that
 * have to tell "Nominatim is down" apart from "this address has no match" — the free
 * OSINT enrichment lane, lib/external/osint-free.ts — MUST use this form. Reporting an
 * unreachable geocoder as "no coordinates for this address" is a fabricated fact.
 */
export async function geocodeOneDetailed(parts: AddressParts): Promise<FreeProbe<GeoPoint>> {
  const q = buildGeocodeQuery(parts)
  if (!q) return notAttemptedProbe<GeoPoint>("no address parts to geocode")
  await respectNominatimGap()
  try {
    const res = await callConnector<unknown[]>({
      connector: "nominatim",
      baseUrl: NOMINATIM_BASE,
      path: "/search",
      method: "GET",
      query: { q, format: "json", limit: "1", countrycodes: "us" },
      auth: { style: "none" },
      headers: { "User-Agent": "RealEstateOS/1.0 (tour-route-optimizer)", "Accept-Language": "en" },
      timeoutMs: 5000,
    })
    return gatewayProbe<GeoPoint>(res, () =>
      Array.isArray(res.data) && res.data.length > 0 ? parseNominatimRow(res.data[0]) : null,
    )
  } catch (err) {
    return unreachableProbe<GeoPoint>(err)
  }
}

/**
 * Geocode ONE address. Returns the point or null (no match / timeout / error). Never
 * throws. Value-only convenience over geocodeOneDetailed — keep using it wherever the
 * caller genuinely cannot act on the difference (route optimisation just skips a stop).
 */
export async function geocodeOne(parts: AddressParts): Promise<GeoPoint | null> {
  return (await geocodeOneDetailed(parts)).value
}

// ─── ADDRESS SUGGESTIONS (wave 140, lane 140P) ─────────────────────────────────────────────

/** One parsed Nominatim search hit — what the address boxes render and select. */
export interface AddressSuggestion {
  placeId: string
  /** Nominatim's display_name — the line the dropdown shows. */
  label: string
  street: string
  city: string
  state: string
  zip: string
}

/** USPS state abbreviations — Nominatim spells the state in full. The ONE table (it used to live
 *  in the browser autocomplete only, so the offer flow's parse kept "Texas"). */
const US_STATE_ABBR: Record<string, string> = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA",
  Colorado: "CO", Connecticut: "CT", Delaware: "DE", Florida: "FL", Georgia: "GA",
  Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA",
  Kansas: "KS", Kentucky: "KY", Louisiana: "LA", Maine: "ME", Maryland: "MD",
  Massachusetts: "MA", Michigan: "MI", Minnesota: "MN", Mississippi: "MS",
  Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH",
  "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY", "North Carolina": "NC",
  "North Dakota": "ND", Ohio: "OH", Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA",
  "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN",
  Texas: "TX", Utah: "UT", Vermont: "VT", Virginia: "VA", Washington: "WA",
  "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY",
  "District of Columbia": "DC",
}

/** PURE. Parse one `addressdetails=1` search row into an AddressSuggestion, or null when the row
 *  carries no display name. Street = house number + road; city falls back through town / village /
 *  suburb / neighbourhood (Nominatim's own precedence); the state is abbreviated when known. */
/** @proofSeam pure Nominatim row parser proven by test:provider-adapter (section Q); production reaches it only through suggestAddressesDetailed in this file. */
export function parseNominatimAddressRow(row: unknown): AddressSuggestion | null {
  if (!row || typeof row !== "object") return null
  const r = row as { place_id?: unknown; display_name?: unknown; address?: Record<string, unknown> | null }
  const label = typeof r.display_name === "string" ? r.display_name.trim() : ""
  if (!label) return null
  const a = (r.address && typeof r.address === "object" ? r.address : {}) as Record<string, unknown>
  const s = (k: string) => (typeof a[k] === "string" ? (a[k] as string).trim() : "")
  const street = [s("house_number"), s("road")].filter(Boolean).join(" ")
  const city = s("city") || s("town") || s("village") || s("suburb") || s("neighbourhood")
  const stateFull = s("state")
  return {
    placeId: r.place_id == null ? label : String(r.place_id),
    label,
    street,
    city,
    state: US_STATE_ABBR[stateFull] ?? stateFull,
    zip: s("postcode"),
  }
}

/**
 * Address SUGGESTIONS for a partial query (US only), REPORTING WHY there are none. The same
 * gateway egress as geocodeOneDetailed, plus: `brokerageId` lands on the outcome row (tenant
 * scope), `skipWhenFailing` refuses without egress while Nominatim is in a failing cool-down
 * (provider health respected — a dead geocoder costs the typist nothing), and the courtesy
 * pacer still spaces every real request. Never throws. Server-only (the gateway is).
 */
export async function suggestAddressesDetailed(
  query: string,
  opts: { brokerageId?: string | null; limit?: number } = {},
): Promise<FreeProbe<AddressSuggestion[]>> {
  const q = (query ?? "").trim()
  if (q.length < ADDRESS_SUGGEST_MIN_QUERY) return notAttemptedProbe<AddressSuggestion[]>(`query shorter than ${ADDRESS_SUGGEST_MIN_QUERY} characters`)
  const limit = Math.min(ADDRESS_SUGGEST_MAX_RESULTS, Math.max(1, Math.round(opts.limit ?? ADDRESS_SUGGEST_MAX_RESULTS)))
  await respectNominatimGap()
  try {
    const res = await callConnector<unknown[]>({
      connector: "nominatim",
      brokerageId: opts.brokerageId ?? null,
      baseUrl: NOMINATIM_BASE,
      path: "/search",
      method: "GET",
      query: { q, format: "json", addressdetails: "1", limit: String(limit), countrycodes: "us" },
      auth: { style: "none" },
      headers: { "User-Agent": "RealEstateOS/1.0 (address-suggestions)", "Accept-Language": "en" },
      timeoutMs: 5000,
      retry: false,
      skipWhenFailing: true,
    })
    return gatewayProbe<AddressSuggestion[]>(res, () => {
      const rows = Array.isArray(res.data) ? res.data : []
      const parsed = rows.map(parseNominatimAddressRow).filter((x): x is AddressSuggestion => x !== null)
      return parsed.length > 0 ? parsed : null
    })
  } catch (err) {
    return unreachableProbe<AddressSuggestion[]>(err)
  }
}

/**
 * A cached, rate-respecting resolver. Returns an async function that geocodes an
 * AddressParts at most once per distinct query string and spaces real network calls by
 * >= NOMINATIM_MIN_GAP_MS. Use this when geocoding several stops in one pass (e.g. a tour).
 * Cached/empty lookups incur no delay; only genuine network hits are spaced.
 */
export function createCachedGeocoder(minGapMs: number = NOMINATIM_MIN_GAP_MS) {
  const cache = new Map<string, GeoPoint | null>()
  let lastHitAt = 0
  return async function resolve(parts: AddressParts): Promise<GeoPoint | null> {
    const q = buildGeocodeQuery(parts)
    if (!q) return null
    if (cache.has(q)) return cache.get(q) ?? null
    const since = Date.now() - lastHitAt
    if (lastHitAt !== 0 && since < minGapMs) {
      await new Promise((r) => setTimeout(r, minGapMs - since))
    }
    lastHitAt = Date.now()
    const point = await geocodeOne(parts)
    cache.set(q, point)
    return point
  }
}
