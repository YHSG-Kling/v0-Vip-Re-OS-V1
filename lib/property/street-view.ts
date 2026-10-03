/**
 * lib/property/street-view.ts
 *
 * Google Street View / static satellite image URL helpers for a property.
 * MOVED VERBATIM (wave 80 lane B) out of lib/property/enrichment-chain.ts when
 * that file's OSINT → BatchData → ai_estimate ladder merged onto
 * lib/ai-isa/property-lookup-rail.ts (the `listing_intake` path) and the file
 * was deleted (CLAUDE.md §1.1 — survivor named in that rail's header). These
 * two helpers were never part of the ladder: they build a URL, make no
 * request, and book no spend (the Static Street View API charges per image
 * fetched by the browser, not here).
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

import { googleMapsBrowserKey } from "@/lib/env/aliases"

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
