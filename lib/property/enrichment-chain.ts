/**
 * lib/property/enrichment-chain.ts
 *
 * Property data enrichment chain — used by aiEnrichPropertyData when the
 * agent enters a new listing address. Replaces the previous GPT-fabrication
 * approach with a real data chain that falls back gracefully:
 *
 *   1. OSINT (FREE)        — geocode via OSM Nominatim, scrape public
 *                            assessor / Zillow page via existing Zenrows
 *                            client. Returns whatever the page exposes
 *                            (bed/bath/sqft/yearBuilt). Free + best-effort.
 *
 *   2. BatchData (PAID)    — searchProperties(address) returns full
 *                            property records with reliable bed/bath/sqft/
 *                            yearBuilt/lotSize. Falls back to this when
 *                            OSINT returns nothing usable.
 *
 *   3. AI estimate (LAST RESORT) — clearly labeled as estimate so the agent
 *                            knows to verify. The previous behavior was to
 *                            ALWAYS use this; now it only fires when both
 *                            real-data sources fail or return incomplete data.
 *
 * Returns a discriminated result so the caller knows which source was used
 * (so the UI can show a "verify these — AI estimate" badge when needed).
 */

import "server-only"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { googleMapsBrowserKey } from "@/lib/env/aliases"
import { OSINTClient } from "@/lib/osint-client"
import { searchProperties } from "@/lib/external/batchdata-client"
import { generateObject } from "@/lib/ai/generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { z } from "zod"

export type EnrichSource = "osint" | "batchdata" | "ai_estimate"

export interface PropertyEnrichmentResult {
  source:        EnrichSource
  beds?:         number | null
  baths?:        number | null
  sqft?:         number | null
  yearBuilt?:    number | null
  lotSize?:      number | null
  stories?:      number | null
  garage?:       number | null
  pool?:         boolean | null
  propertyType?: "single_family" | "condo" | "townhouse" | null
  estimatedValue?: number | null
  estimatedRent?:  number | null
  schoolDistrict?: string | null
  walkScore?:      number | null
  floodZone?:      string | null
  /** Geocoded location, populated whenever Nominatim geocode succeeds */
  lat?:          number | null
  lon?:          number | null
  /** Whether this row is an AI estimate the agent should verify */
  isEstimate:    boolean
  /** Free-text note surfaced in the UI ("Verified via BatchData", etc.) */
  sourceNote:    string
}

// ─── 1. OSINT-by-address path ────────────────────────────────────────────

async function tryOsintEnrichment(address: string): Promise<PropertyEnrichmentResult | null> {
  // Geocode via free OSM Nominatim — always available
  let lat: number | null = null
  let lon: number | null = null
  try {
    const res = await callConnector<Array<{ lat: string; lon: string }>>({
      connector: "nominatim", baseUrl: "https://nominatim.openstreetmap.org", path: "/search", method: "GET",
      query: { format: "json", q: address, limit: "1" },
      auth: { style: "none" }, headers: { "User-Agent": "VipRealEstateOS/1.0 (real-estate)" }, timeoutMs: 8000,
    })
    if (res.ok) {
      const arr = (res.data ?? []) as Array<{ lat: string; lon: string }>
      if (arr[0]) {
        lat = parseFloat(arr[0].lat)
        lon = parseFloat(arr[0].lon)
      }
    }
  } catch { /* geocode failed — continue with no coords */ }

  // Try a Zenrows-scraped public listing page for property details. Zillow's
  // address-search URL routes to the property page directly when there's a
  // unique match. We use the existing OSINTClient's underlying scraper.
  let beds: number | null = null
  let baths: number | null = null
  let sqft: number | null = null
  let yearBuilt: number | null = null
  let propertyType: PropertyEnrichmentResult["propertyType"] = null
  try {
    const osint = new OSINTClient()
    // Reach into the underlying scraper (zenrows is private — call via a
    // safe public scrape). If the OSINTClient doesn't expose a scrape
    // method, this catch falls through.
    const scrape = (osint as any).zenrows?.scrape
    if (typeof scrape === "function") {
      const zillowSearch = `https://www.zillow.com/homes/${encodeURIComponent(address.replace(/\s+/g, "-"))}_rb/`
      const result = await scrape.call((osint as any).zenrows, zillowSearch, { js_render: true, premium_proxy: true })
      if (result?.success && typeof result.html === "string") {
        const html: string = result.html
        // Best-effort regex extraction — Zillow markup varies; capture
        // common patterns for bed/bath/sqft/yearBuilt
        const bedMatch  = html.match(/(\d+(?:\.\d+)?)\s*beds?/i)
        const bathMatch = html.match(/(\d+(?:\.\d+)?)\s*baths?/i)
        const sqftMatch = html.match(/([\d,]+)\s*sqft/i)
        const ybMatch   = html.match(/Year built[^>]*>[^<]*<[^>]*>([\d]{4})/i)
        const typeMatch = html.match(/Single[\s-]family|Condo|Townhouse|Multi[\s-]family/i)
        if (bedMatch)  beds      = parseFloat(bedMatch[1])
        if (bathMatch) baths     = parseFloat(bathMatch[1])
        if (sqftMatch) sqft      = parseInt(sqftMatch[1].replace(/,/g, ""), 10)
        if (ybMatch)   yearBuilt = parseInt(ybMatch[1], 10)
        if (typeMatch) {
          const t = typeMatch[0].toLowerCase()
          propertyType = t.includes("condo") ? "condo"
                       : t.includes("townhouse") ? "townhouse"
                       : "single_family"
        }
      }
    }
  } catch { /* scrape failed — pass through */ }

  // Only return a result if we got at least bed + sqft (otherwise let the
  // chain fall through to BatchData)
  if (beds == null || sqft == null) {
    if (lat != null && lon != null) {
      // Coordinates only — useful for Street View even if details missed
      return {
        source: "osint",
        lat, lon,
        beds, baths, sqft, yearBuilt, propertyType,
        isEstimate: true,
        sourceNote: "Geocoded via OSM. Property details could not be extracted — try entering them manually.",
      }
    }
    return null
  }

  return {
    source: "osint",
    beds, baths, sqft, yearBuilt, propertyType,
    lat, lon,
    isEstimate: false,
    sourceNote: "Property details extracted from public listing data (free OSINT).",
  }
}

// ─── 2. BatchData path ───────────────────────────────────────────────────

async function tryBatchDataEnrichment(address: string): Promise<PropertyEnrichmentResult | null> {
  if (!process.env.BATCHDATA_API_KEY) return null
  try {
    const result = await searchProperties(address)
    const top = result.matches?.[0]
    if (!top) return null

    // BatchData fields vary; pull common ones defensively
    const t = top as Record<string, unknown>
    return {
      source: "batchdata",
      beds:          (t.beds      as number | null) ?? null,
      baths:         (t.baths     as number | null) ?? null,
      sqft:          (t.sqft      as number | null) ?? null,
      yearBuilt:     (t.yearBuilt as number | null) ?? null,
      lotSize:       (t.lotSize   as number | null) ?? null,
      pool:          (t.pool      as boolean | null) ?? null,
      propertyType:  (t.propertyType as PropertyEnrichmentResult["propertyType"]) ?? "single_family",
      estimatedValue: (t.estimatedValue as number | null) ?? null,
      isEstimate:    false,
      sourceNote:    "Property details from BatchData public records.",
    }
  } catch {
    return null
  }
}

// ─── 3. AI estimate (last resort, clearly labeled) ───────────────────────

async function aiEstimate(address: string): Promise<PropertyEnrichmentResult> {
  const { object } = await generateObject({
    model: resolveModel("openai/gpt-4o-mini"),
    schema: z.object({
      beds: z.number(),
      baths: z.number(),
      sqft: z.number(),
      yearBuilt: z.number(),
      lotSize: z.number(),
      stories: z.number(),
      garage: z.number(),
      pool: z.boolean(),
      propertyType: z.enum(["single_family", "condo", "townhouse"]),
      estimatedValue: z.number(),
      estimatedRent: z.number(),
      walkScore: z.number(),
    }),
    prompt: `You are a real estate data analyst. Estimate property details for: ${address}. Return realistic estimates (no certainty implied).`,
  })
  return {
    source: "ai_estimate",
    beds: object.beds,
    baths: object.baths,
    sqft: object.sqft,
    yearBuilt: object.yearBuilt,
    lotSize: object.lotSize,
    stories: object.stories,
    garage: object.garage,
    pool: object.pool,
    propertyType: object.propertyType,
    estimatedValue: object.estimatedValue,
    estimatedRent: object.estimatedRent,
    walkScore: object.walkScore,
    isEstimate: true,
    sourceNote: "AI estimate — verify before publishing. No real property record was found for this address.",
  }
}

// ─── Chain orchestrator ──────────────────────────────────────────────────

export async function enrichPropertyChain(address: string): Promise<PropertyEnrichmentResult> {
  // 1. OSINT first (free)
  const osint = await tryOsintEnrichment(address)
  if (osint && !osint.isEstimate) return osint

  // 2. BatchData backup (paid, more reliable)
  const batch = await tryBatchDataEnrichment(address)
  if (batch) {
    // Carry over geocode from OSINT step if BatchData didn't return it
    return { ...batch, lat: batch.lat ?? osint?.lat ?? null, lon: batch.lon ?? osint?.lon ?? null }
  }

  // 3. AI estimate (clearly labeled)
  const ai = await aiEstimate(address)
  return { ...ai, lat: osint?.lat ?? null, lon: osint?.lon ?? null }
}

// ─── Google Street View Static API helper ────────────────────────────────
//
// Returns a public image URL for the front of the property. Uses the
// Static Street View API which charges per-request (cheap). When no API
// key is configured, returns null and the UI falls back to either an
// agent-uploaded photo or a generic placeholder.
//
// Photo strategy (per spec): Google Street View / Google Maps / uploaded.
// Route depends on listing state — we return Street View by default; the
// listing intake UI surfaces an "Upload your own" button alongside.

export interface StreetViewImage {
  url:       string
  source:    "google_street_view"
  attribution: string
}

export function getStreetViewImageUrl(opts: {
  address?: string
  lat?:     number | null
  lon?:     number | null
  width?:   number
  height?:  number
  fov?:     number
  pitch?:   number
}): StreetViewImage | null {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY
                ?? googleMapsBrowserKey()
  if (!apiKey) return null

  const params = new URLSearchParams({
    size:    `${opts.width ?? 800}x${opts.height ?? 600}`,
    fov:     String(opts.fov   ?? 80),
    pitch:   String(opts.pitch ?? 0),
    key:     apiKey,
  })

  if (opts.lat != null && opts.lon != null) {
    params.set("location", `${opts.lat},${opts.lon}`)
  } else if (opts.address) {
    params.set("location", opts.address)
  } else {
    return null
  }

  return {
    url:         `https://maps.googleapis.com/maps/api/streetview?${params.toString()}`,
    source:      "google_street_view",
    attribution: "Google Street View",
  }
}

// ─── Static Map fallback (when no Street View available) ─────────────────

export function getStaticMapImageUrl(opts: {
  lat:    number
  lon:    number
  zoom?:  number
  width?: number
  height?: number
}): StreetViewImage | null {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY
                ?? googleMapsBrowserKey()
  if (!apiKey) return null

  const params = new URLSearchParams({
    center: `${opts.lat},${opts.lon}`,
    zoom:   String(opts.zoom ?? 19),
    size:   `${opts.width ?? 800}x${opts.height ?? 600}`,
    maptype: "satellite",
    key:    apiKey,
  })
  return {
    url:         `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`,
    source:      "google_street_view",
    attribution: "Google Maps Satellite",
  }
}
