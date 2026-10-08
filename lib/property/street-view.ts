/**
 * lib/property/street-view.ts
 *
 * Google Street View / static satellite image URL helpers for a property.
 * MOVED VERBATIM (wave 80 lane B) out of lib/property/enrichment-chain.ts when
 * that file's OSINT → BatchData → ai_estimate ladder merged onto
 * lib/ai-isa/property-lookup-rail.ts (the `listing_intake` path) and the file
 * was deleted (CLAUDE.md §1.1 — survivor named in that rail's header). These
 * two helpers were never part of the ladder: they build a URL and make no
 * request (the Static APIs charge per image FETCHED). Wave 139 (139C): the
 * server callers that mint a URL now book it through bookMapsImageSpend below.
 *
 * Callers: lib/workflow/intelligence/listing-presentation-builder.ts (cover
 * photo) and app/actions/lead-intelligence.ts (the vision-property image).
 *
 * Photo strategy (per spec): Google Street View / Google Maps / uploaded.
 * Route depends on listing state — we return Street View by default; the
 * listing intake UI surfaces an "Upload your own" button alongside. When no
 * API key is configured, returns null and the UI falls back to either an
 * agent-uploaded photo or a generic placeholder.
 */

import { createHash } from "node:crypto"
import { googleMapsBrowserKey } from "@/lib/env/aliases"
import { GOOGLE_MAPS_SKU_USD, type GoogleMapsSku } from "@/lib/vendor-governance/cost-normalizer"

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

// ─── THE SPEND (wave 139, lane 139C) ─────────────────────────────────────────
// These helpers mint a keyed URL; Google bills each image FETCH on the platform Google Cloud
// account (Maps usage was neither priced nor booked). A server caller that mints a URL its own
// pipeline fetches or persists books it here — ONCE per tenant · SKU · location · day (the key), at
// the published entry-band list price with price_state 'variable' (the first 10,000 / SKU / month
// are free and volume bands step down, so the booking is an UPPER-BOUND estimate, reconciled
// against the invoice). PLATFORM-COVERED (owner, wave 139). Browser-only loads (the team heatmap's
// Maps JS, the tour tab's client static map) have no server rail — published on the adapter.
export async function bookMapsImageSpend(input: {
  brokerageId: string | null
  sku: GoogleMapsSku
  url: string
  systemSource: string
}, deps: { meter?: (i: import("@/lib/vendor-governance/meter-vendor").MeterVendorInput) => Promise<boolean> } = {}): Promise<boolean> {
  const meterVendorSpend = deps.meter ?? (await import("@/lib/vendor-governance/meter-vendor")).meterVendorSpend
  let location = input.url
  try { const u = new URL(input.url); u.searchParams.delete("key"); location = u.toString() } catch { /* keep the raw string */ }
  const day = new Date().toISOString().slice(0, 10)
  return meterVendorSpend({
    vendorName: "google_maps", usageType: input.sku, cost: GOOGLE_MAPS_SKU_USD[input.sku], unitCount: 1,
    brokerageId: input.brokerageId, systemSource: input.systemSource,
    priceState: "variable", costBasis: "estimated", coverage: "platform_covered",
    idempotencyKey: `gmaps:${input.sku}:${createHash("sha256").update(location).digest("hex").slice(0, 24)}:${day}`,
  })
}
