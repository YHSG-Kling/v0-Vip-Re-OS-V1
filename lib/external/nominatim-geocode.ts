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
// This is the single shared helper so we stop re-inlining the same Nominatim call.
// MERGED (wave 5): osint-neighborhood.ts's private `geocodeAddress` copy is GONE — that
// module now calls geocodeOne here. The remaining inline copy lives in the `server-only`
// lib/property/enrichment-chain.ts, which cannot be imported from a plain-tsx guard path;
// folding it in is the next step, tracked in docs/wave5-free-osint.md.

import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { gatewayProbe, notAttemptedProbe, unreachableProbe, type FreeProbe } from "./free-probe"

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
