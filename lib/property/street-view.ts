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
 * WAVE 140 (lane 140I; owner: "MAPBOX IS REQUIRED … restore the ORIGINAL/canonical mapping
 * capability … onto the existing mapping/location infrastructure … team heatmap chooses a VALID
 * configured provider, never Google Maps with an empty key … One map subsystem"). THIS FILE IS THE
 * ONE MAP-RENDER SURVIVOR: git history holds no Mapbox client to restore (MAPBOX_TOKEN was only ever a
 * key-presence check beside a Google Maps JS load — provider-adapters.ts "vocabulary_only" since wave
 * 139), so the missing half is BUILT here (CLAUDE.md §1.2): resolveMapProvider WALKS the map_render
 * route (lib/ai-isa/property-lookup-rail.ts CONTACT_PROVIDER_ROUTES — Mapbox first, Google Maps the
 * fallback, health-aware) and drops every provider whose credential is absent; getMapImageUrl mints
 * the chosen provider's static image; bookMapsImageSpend / bookMapLoadSpend book the spend. The team
 * heatmap (app/dashboard/team-heatmap/page.tsx) resolves the BROWSER provider here, server-side, and
 * hands the client only the public token of the provider that was chosen.
 *
 * Callers: lib/workflow/intelligence/listing-presentation-builder.ts (cover
 * photo) and app/actions/lead-intelligence.ts (the vision-property image),
 * app/dashboard/team-heatmap/page.tsx (browser map provider + map-load booking).
 *
 * Photo strategy (per spec): Google Street View / Google Maps / uploaded.
 * Route depends on listing state — we return Street View by default; the
 * listing intake UI surfaces an "Upload your own" button alongside. When no
 * API key is configured, returns null and the UI falls back to either an
 * agent-uploaded photo or a generic placeholder.
 */

import { createHash } from "node:crypto"
import { googleMapsBrowserKey } from "@/lib/env/aliases"
import { GOOGLE_MAPS_SKU_USD, MAPBOX_SKU_USD, type GoogleMapsSku, type MapboxSku } from "@/lib/vendor-governance/cost-normalizer"
import { routeCapability, type CapabilityProviderHealth, type ContactDataProvider } from "@/lib/ai-isa/property-lookup-rail"
import { VENDOR_CONTRACTS, MAPBOX_GL_JS_VERSION, MAPBOX_STATIC_STYLE } from "@/lib/agentic-os/connector-registry"

export interface StreetViewImage {
  url:       string
  source:    "google_street_view" | "mapbox_static"
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
  /** Wave 140 (140I): the key the map walk chose (getMapImageUrl) — else the process env as before. */
  apiKey?: string
}): StreetViewImage | null {
  const apiKey = opts.apiKey
                ?? process.env.GOOGLE_MAPS_API_KEY
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

// ─── THE ONE MAP CAPABILITY (wave 140, lane 140I) ────────────────────────────

/** The two providers the map_render route names (CONTACT_PROVIDER_ROUTES.map_render). */
type MapProvider = Extract<ContactDataProvider, "mapbox" | "google_maps">
type MapRenderKind = "browser_tiles" | "static_image"

/** The env the resolver reads — injectable so the walk is provable without touching process.env. */
interface MapCredentialEnv {
  MAPBOX_PUBLIC_TOKEN?: string
  MAPBOX_TOKEN?: string
  GOOGLE_MAPS_API_KEY?: string
  NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?: string
}

interface MapProviderChoice {
  provider: MapProvider
  /** The credential the chosen provider is called with. For browser tiles this is PUBLIC BY DESIGN
   *  (a Mapbox `pk.` token / the NEXT_PUBLIC Google key) — the published exception on the adapter. */
  key: string
  /** Evidence: the route walked and every provider left out with its reason (health or credential). */
  route: { capability: "map_render"; order: MapProvider[]; skipped: Array<{ provider: MapProvider; reason: string }> }
  /** The browser assets the client loads for this provider (Mapbox CDN pins MAPBOX_GL_JS_VERSION). */
  browser: { script: string; css: string | null }
}

const MAPBOX_API = VENDOR_CONTRACTS.mapbox.baseUrl

/**
 * The Mapbox token a BROWSER or a persisted image URL may carry: the PUBLIC token only. A secret
 * (`sk.`) token is refused here — it would leak into every deck, vision fetch and page view.
 * MAPBOX_TOKEN (the server / probe credential) is accepted only when it is itself a public token.
 */
function mapboxPublicToken(env: MapCredentialEnv): string | null {
  const candidate = env.MAPBOX_PUBLIC_TOKEN?.trim() || env.MAPBOX_TOKEN?.trim() || ""
  if (!candidate) return null
  if (candidate.startsWith("sk.")) return null
  return candidate
}

function credentialFor(provider: MapProvider, kind: MapRenderKind, env: MapCredentialEnv): { key: string } | { missing: string } {
  if (provider === "mapbox") {
    const pk = mapboxPublicToken(env)
    return pk ? { key: pk } : { missing: env.MAPBOX_TOKEN?.startsWith("sk.") ? "MAPBOX_PUBLIC_TOKEN (MAPBOX_TOKEN is a secret sk. token — never minted into a URL)" : "MAPBOX_PUBLIC_TOKEN" }
  }
  const browserKey = env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim() || ""
  const serverKey = env.GOOGLE_MAPS_API_KEY?.trim() || ""
  const key = kind === "browser_tiles" ? browserKey : (serverKey || browserKey)
  return key ? { key } : { missing: kind === "browser_tiles" ? "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY" : "GOOGLE_MAPS_API_KEY / NEXT_PUBLIC_GOOGLE_MAPS_API_KEY" }
}

/**
 * THE WALK — PURE given its inputs. routeCapability("map_render") gives the owner's order minus every
 * provider in a failing cool-down; a provider whose credential is ABSENT is then skipped with its
 * reason. null = no VALID configured provider (the caller renders its honest placeholder — never a
 * Google Maps script with an empty key).
 * @proofSeam scripts/provider-adapter-guard.ts (section Q) walks it with env + health fixtures; the
 * production readers are app/dashboard/team-heatmap/page.tsx and getMapImageUrl below.
 */
export function resolveMapProvider(
  kind: MapRenderKind,
  opts: { health?: Partial<Record<MapProvider, CapabilityProviderHealth | null>>; env?: MapCredentialEnv } = {},
): MapProviderChoice | null {
  const env: MapCredentialEnv = opts.env ?? {
    MAPBOX_PUBLIC_TOKEN: process.env.MAPBOX_PUBLIC_TOKEN,
    MAPBOX_TOKEN: process.env.MAPBOX_TOKEN,
    GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY,
    NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: googleMapsBrowserKey() ?? undefined,
  }
  const routed = routeCapability("map_render", opts.health ?? {})
  const skipped: Array<{ provider: MapProvider; reason: string }> = routed.skipped.map((s) => ({ provider: s.provider as MapProvider, reason: s.reason }))
  for (const provider of routed.providers as MapProvider[]) {
    const cred = credentialFor(provider, kind, env)
    if ("missing" in cred) { skipped.push({ provider, reason: `unconfigured: ${cred.missing} is not set` }); continue }
    return {
      provider,
      key: cred.key,
      route: { capability: "map_render", order: routed.providers as MapProvider[], skipped },
      browser: provider === "mapbox"
        ? { script: `${MAPBOX_API}/mapbox-gl-js/v${MAPBOX_GL_JS_VERSION}/mapbox-gl.js`, css: `${MAPBOX_API}/mapbox-gl-js/v${MAPBOX_GL_JS_VERSION}/mapbox-gl.css` }
        : { script: `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(cred.key)}&libraries=places`, css: null },
    }
  }
  return null
}

/**
 * Mapbox Static Images API URL (docs.mapbox.com/api/maps/static-images/, read 2026-10-11):
 * GET https://api.mapbox.com/styles/v1/{username}/{style_id}/static/{overlay}/{lon},{lat},{zoom},{bearing},{pitch}/{width}x{height}{@2x}
 * Token scope styles:tiles; a classic style (MAPBOX_STATIC_STYLE) — the Standard styles are not
 * supported by this API. Width/height ≤ 1280. The token is the PUBLIC one (the URL is handed out).
 */
function getMapboxStaticImageUrl(opts: {
  lat: number
  lon: number
  token: string
  zoom?: number
  width?: number
  height?: number
  marker?: boolean
}): StreetViewImage {
  const w = Math.min(1280, Math.max(1, Math.round(opts.width ?? 800)))
  const h = Math.min(1280, Math.max(1, Math.round(opts.height ?? 600)))
  const zoom = Math.min(22, Math.max(0, opts.zoom ?? 17))
  const lon = Number(opts.lon.toFixed(6)), lat = Number(opts.lat.toFixed(6))
  const overlay = opts.marker === false ? "" : `pin-s+3b82f6(${lon},${lat})/`
  return {
    url: `${MAPBOX_API}/styles/v1/${MAPBOX_STATIC_STYLE}/static/${overlay}${lon},${lat},${zoom},0,0/${w}x${h}@2x?access_token=${encodeURIComponent(opts.token)}`,
    source: "mapbox_static",
    attribution: "© Mapbox © OpenStreetMap",
  }
}

interface MapImage extends StreetViewImage {
  provider: MapProvider
  sku: MapboxSku | GoogleMapsSku
  route: MapProviderChoice["route"]
}

/** A static map image of a coordinate from the ONE route: Mapbox Static Images first, Google Static
 *  Maps (satellite) when Mapbox is unconfigured or failing. null = no configured provider. */
export function getMapImageUrl(opts: {
  lat: number
  lon: number
  zoom?: number
  width?: number
  height?: number
  health?: Partial<Record<MapProvider, CapabilityProviderHealth | null>>
  env?: MapCredentialEnv
}): MapImage | null {
  const choice = resolveMapProvider("static_image", { health: opts.health, env: opts.env })
  if (!choice) return null
  if (choice.provider === "mapbox") {
    return { ...getMapboxStaticImageUrl({ lat: opts.lat, lon: opts.lon, token: choice.key, zoom: opts.zoom, width: opts.width, height: opts.height }), provider: "mapbox", sku: "static_image", route: choice.route }
  }
  const g = getStaticMapImageUrl({ lat: opts.lat, lon: opts.lon, zoom: opts.zoom, width: opts.width, height: opts.height, apiKey: choice.key })
  return g ? { ...g, provider: "google_maps", sku: "static_map", route: choice.route } : null
}

// ─── THE SPEND (wave 139, lane 139C; wave 140, lane 140I: + Mapbox, + map loads) ────────────────
// These helpers mint a keyed URL; the vendor bills each image FETCH on the platform account (Maps
// usage was neither priced nor booked). A server caller that mints a URL its own pipeline fetches or
// persists books it here — ONCE per tenant · provider · SKU · location · day (the key), at the
// published entry-band list price with price_state 'variable' (the free tiers and volume bands make
// the booking an UPPER-BOUND estimate, reconciled against the invoice). PLATFORM-COVERED (owner, wave
// 139). A BROWSER map (the team heatmap) books ONE map load per server render through
// bookMapLoadSpend — the page render IS the map initialisation, so the count is 1:1.
type MapSpendProvider = MapProvider
type MapSpendSku = GoogleMapsSku | MapboxSku

function skuPrice(provider: MapSpendProvider, sku: MapSpendSku): number {
  if (provider === "mapbox") return (MAPBOX_SKU_USD as Record<string, number>)[sku] ?? MAPBOX_SKU_USD.static_image
  return (GOOGLE_MAPS_SKU_USD as Record<string, number>)[sku] ?? GOOGLE_MAPS_SKU_USD.static_map
}

export async function bookMapsImageSpend(input: {
  brokerageId: string | null
  sku: MapSpendSku
  url: string
  systemSource: string
  /** Default google_maps (every pre-140 caller mints a Google image). */
  provider?: MapSpendProvider
}, deps: { meter?: (i: import("@/lib/vendor-governance/meter-vendor").MeterVendorInput) => Promise<boolean> } = {}): Promise<boolean> {
  const meterVendorSpend = deps.meter ?? (await import("@/lib/vendor-governance/meter-vendor")).meterVendorSpend
  const provider: MapSpendProvider = input.provider ?? "google_maps"
  let location = input.url
  try { const u = new URL(input.url); u.searchParams.delete("key"); u.searchParams.delete("access_token"); location = u.toString() } catch { /* keep the raw string */ }
  const day = new Date().toISOString().slice(0, 10)
  return meterVendorSpend({
    vendorName: provider, usageType: input.sku, cost: skuPrice(provider, input.sku), unitCount: 1,
    brokerageId: input.brokerageId, systemSource: input.systemSource,
    priceState: "variable", costBasis: "estimated", coverage: "platform_covered",
    idempotencyKey: `${provider === "mapbox" ? "mapbox" : "gmaps"}:${input.sku}:${createHash("sha256").update(location).digest("hex").slice(0, 24)}:${day}`,
  })
}

/** ONE browser map load (a Mapbox GL JS `Map` / a Google Maps JS dynamic map) booked by the server
 *  render that chose the provider — with the route walked as evidence. */
export async function bookMapLoadSpend(input: {
  brokerageId: string | null
  choice: MapProviderChoice
  systemSource: string
}, deps: { meter?: (i: import("@/lib/vendor-governance/meter-vendor").MeterVendorInput) => Promise<boolean> } = {}): Promise<boolean> {
  const meterVendorSpend = deps.meter ?? (await import("@/lib/vendor-governance/meter-vendor")).meterVendorSpend
  const sku: MapSpendSku = input.choice.provider === "mapbox" ? "map_load" : "dynamic_map_load"
  return meterVendorSpend({
    vendorName: input.choice.provider, usageType: sku, cost: skuPrice(input.choice.provider, sku), unitCount: 1,
    brokerageId: input.brokerageId, systemSource: input.systemSource,
    priceState: "variable", costBasis: "estimated", coverage: "platform_covered",
    metadata: { route: input.choice.route, sku },
  })
}
