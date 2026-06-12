// lib/external/nominatim-geocode.ts
//
// Canonical FREE geocoder — address → { lat, lng } via OpenStreetMap Nominatim,
// routed through the connector-gateway (the one egress path to outside services), exactly
// like lib/external/osint-neighborhood.ts and lib/property/enrichment-chain.ts already do.
// No API key, no cost. Returns null on any failure (never throws, never fabricates).
//
// Nominatim usage policy: max ~1 request/second and a valid User-Agent. Callers that
// geocode several addresses in a row MUST space requests (see geocodeMany below, which
// serializes with a >=1s gap) and SHOULD cache — coordinates for a fixed address never
// change, so geocode each address at most once.
//
// This is the single shared helper so we stop re-inlining the same Nominatim call. (Two
// older inline copies exist as private functions in osint-neighborhood.ts and the
// server-only enrichment-chain.ts; those can fold into this later — this is the canonical
// surface going forward.)

import { callConnector } from "@/lib/agentic-os/connector-gateway"

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org"
/** Nominatim's documented courtesy rate limit: 1 request/second. */
export const NOMINATIM_MIN_GAP_MS = 1100

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
 * Geocode ONE address. Real network call to Nominatim through the gateway. Returns the
 * point or null (no match / timeout / error). Never throws.
 */
export async function geocodeOne(parts: AddressParts): Promise<GeoPoint | null> {
  const q = buildGeocodeQuery(parts)
  if (!q) return null
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
    if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) return null
    return parseNominatimRow(res.data[0])
  } catch {
    return null
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
