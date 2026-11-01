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
 * Wave 148 (lane 148E): + the travel_time capability (requestTravelTimes / requestTravelRoute — Mapbox Matrix and
 * Directions) and the evidence maps (getTravelRouteMapImageUrl / getPlacesMapImageUrl), read by
 * lib/buyer-search/location-evidence.ts for the buyer's commute / walkability answers.
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
  return walkMapProviders(kind, opts)[0] ?? null
}

/** The same walk, EVERY viable provider in route order (wave 140, lane 140P). A caller whose render
 *  needs something the first provider cannot be given (a Mapbox route image with no geocoded stop)
 *  continues to the next viable one instead of re-walking with a forged health. Each choice carries
 *  the route evidence as resolveMapProvider does; the skipped list grows as the walk advances. */
function walkMapProviders(
  kind: MapRenderKind,
  opts: { health?: Partial<Record<MapProvider, CapabilityProviderHealth | null>>; env?: MapCredentialEnv } = {},
): MapProviderChoice[] {
  const env: MapCredentialEnv = opts.env ?? {
    MAPBOX_PUBLIC_TOKEN: process.env.MAPBOX_PUBLIC_TOKEN,
    MAPBOX_TOKEN: process.env.MAPBOX_TOKEN,
    GOOGLE_MAPS_API_KEY: process.env.GOOGLE_MAPS_API_KEY,
    NEXT_PUBLIC_GOOGLE_MAPS_API_KEY: googleMapsBrowserKey() ?? undefined,
  }
  const routed = routeCapability("map_render", opts.health ?? {})
  const skipped: Array<{ provider: MapProvider; reason: string }> = routed.skipped.map((s) => ({ provider: s.provider as MapProvider, reason: s.reason }))
  const out: MapProviderChoice[] = []
  for (const provider of routed.providers as MapProvider[]) {
    const cred = credentialFor(provider, kind, env)
    if ("missing" in cred) { skipped.push({ provider, reason: `unconfigured: ${cred.missing} is not set` }); continue }
    out.push({
      provider,
      key: cred.key,
      route: { capability: "map_render", order: routed.providers as MapProvider[], skipped: [...skipped] },
      browser: provider === "mapbox"
        ? { script: `${MAPBOX_API}/mapbox-gl-js/v${MAPBOX_GL_JS_VERSION}/mapbox-gl.js`, css: `${MAPBOX_API}/mapbox-gl-js/v${MAPBOX_GL_JS_VERSION}/mapbox-gl.css` }
        : { script: `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(cred.key)}&libraries=places`, css: null },
    })
  }
  return out
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

// ─── A ROUTE IMAGE — numbered stops on one static map (wave 140, lane 140P) ─────────────────────
// The buyer-tour Confirm tab used to build a Google Static Maps URL in the BROWSER from
// NEXT_PUBLIC_GOOGLE_MAPS_API_KEY (no provider choice, no health, no booking — lane 140I's
// outside-lane finding). It now asks app/actions/tour-planner.ts getTourRouteMap, which mints
// the image HERE on the same walk as getMapImageUrl and books it through bookMapsImageSpend.

/** One stop of a route image. Coordinates are OPTIONAL: Google draws from addresses; Mapbox's
 *  Static Images API draws overlays from coordinates only, so an un-geocoded stop is left off a
 *  Mapbox image (honest — never a fabricated point) and a route with no placed stop falls through
 *  to the next viable provider. */
export interface RouteMapStop {
  address: string
  lat?: number | null
  lon?: number | null
}

interface RouteMapImage extends MapImage {
  /** Stops drawn on the image (Mapbox: the geocoded ones; Google: all addresses). */
  placed: number
}

/** PURE. Mapbox Static Images GeoJSON overlay (docs.mapbox.com/api/maps/static-images/#overlay-options,
 *  read 2026-10-11): `geojson({…})` with simplestyle properties — `marker-symbol` 0-99 renders the
 *  stop number, `marker-color` the pin; a LineString joins the stops in order; position `auto`
 *  fits the overlay. URL-encoded; the whole URL stays under the documented 8,192-char limit for
 *  any tour this product plans (≤ ~40 stops). */
function mapboxRouteOverlay(stops: Array<{ lat: number; lon: number }>): string {
  const coords = stops.map((s) => [Number(s.lon.toFixed(6)), Number(s.lat.toFixed(6))])
  const features: unknown[] = coords.map((c, i) => ({
    type: "Feature",
    properties: { "marker-symbol": Math.min(99, i + 1), "marker-color": "#3b82f6", "marker-size": "small" },
    geometry: { type: "Point", coordinates: c },
  }))
  if (coords.length >= 2) {
    features.push({ type: "Feature", properties: { stroke: "#3b82f6", "stroke-width": 3, "stroke-opacity": 0.9 }, geometry: { type: "LineString", coordinates: coords } })
  }
  return `geojson(${encodeURIComponent(JSON.stringify({ type: "FeatureCollection", features }))})`
}

/** A static route image of ORDERED stops from the ONE route walk: Mapbox Static Images (geocoded
 *  stops, numbered, joined) first; Google Static Maps (address markers + path) when Mapbox is
 *  unconfigured / failing / has no placed stop. null = no configured provider or no stops. */
export function getRouteMapImageUrl(opts: {
  stops: RouteMapStop[]
  width?: number
  height?: number
  health?: Partial<Record<MapProvider, CapabilityProviderHealth | null>>
  env?: MapCredentialEnv
}): RouteMapImage | null {
  const stops = opts.stops.filter((s) => typeof s.address === "string" && s.address.trim().length > 0)
  if (stops.length === 0) return null
  const w = Math.min(1280, Math.max(1, Math.round(opts.width ?? 600)))
  const h = Math.min(1280, Math.max(1, Math.round(opts.height ?? 200)))
  for (const choice of walkMapProviders("static_image", { health: opts.health, env: opts.env })) {
    if (choice.provider === "mapbox") {
      const placed = stops.filter((s): s is RouteMapStop & { lat: number; lon: number } => Number.isFinite(s.lat ?? NaN) && Number.isFinite(s.lon ?? NaN))
      if (placed.length === 0) continue // nothing Mapbox can draw — the next viable provider draws from addresses
      const overlay = mapboxRouteOverlay(placed.map((s) => ({ lat: s.lat, lon: s.lon })))
      return {
        url: `${MAPBOX_API}/styles/v1/${MAPBOX_STATIC_STYLE}/static/${overlay}/auto/${w}x${h}@2x?padding=40&access_token=${encodeURIComponent(choice.key)}`,
        source: "mapbox_static",
        attribution: "© Mapbox © OpenStreetMap",
        provider: "mapbox",
        sku: "static_image",
        route: choice.route,
        placed: placed.length,
      }
    }
    const params = new URLSearchParams({ size: `${w}x${h}`, key: choice.key })
    const point = (s: RouteMapStop) => (Number.isFinite(s.lat ?? NaN) && Number.isFinite(s.lon ?? NaN) ? `${s.lat},${s.lon}` : s.address)
    if (stops.length >= 2) params.append("path", `weight:3|color:0x3b82f6|${stops.map(point).join("|")}`)
    stops.forEach((s, i) => params.append("markers", `${i < 9 ? `label:${i + 1}|` : ""}${point(s)}`))
    return {
      url: `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`,
      source: "google_street_view",
      attribution: "Google Maps",
      provider: "google_maps",
      sku: "static_map",
      route: choice.route,
      placed: stops.length,
    }
  }
  return null
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

// ─── TRAVEL TIME — Mapbox Matrix + Directions (wave 148, lane 148E) ─────────────────────────────
// Owner (2026-11-01): "if they need walkability or how far it is to commute … those can have more info like a
// map" and "which providers do you need for commute, etc.?". AUDITED FIRST (lane-148E notes, "Providers needed"):
// the repo had Mapbox for PICTURES only (map_render: Static Images + GL JS, this file) and a haversine "drive"
// estimate in lib/kernel/tour-optimizer.ts that is a straight line at an assumed speed — no request anywhere
// asked a router how long a real drive or walk takes. BUILT HERE, on the ONE map survivor and the SAME platform
// account / token / licence: the travel_time capability (lib/ai-isa/property-lookup-rail.ts CONTACT_PROVIDER_ROUTES)
// walked like map_render (health-aware, an unconfigured provider is skipped WITH its reason), CACHE FIRST through
// the one provider-payload store (lib/cma/comp-supplement-cache.ts — a repeat question costs no request), GATED
// before any paid call (mayUseAndAfford "app.access": no spend on a lapsed tenant) and BOOKED per element / request
// (bookTravelTimeSpend → meterVendorSpend, platform-covered like every map SKU). Never throws; an answer it cannot
// get is a null with a reason — the buyer explanation then says "unknown", never a guess.
//
// Contract (docs.mapbox.com/api/navigation/matrix + /directions, read 2026-11-01): Matrix GET
// /directions-matrix/v1/mapbox/{profile}/{lon,lat;…}?sources=…&destinations=…&annotations=duration,distance →
// durations (s) / distances (m), null for an unroutable pair; ≤ 25 coordinates (driving-traffic ≤ 10); billed per
// element (sources × destinations). Directions GET /directions/v5/mapbox/{profile}/{lon,lat;lon,lat}?geometries=
// polyline&overview=simplified → routes[0].duration / .distance / .geometry (encoded polyline, precision 5 — the
// same encoding Google Static Maps reads as `enc:`).

export type TravelProfile = "driving" | "driving-traffic" | "walking" | "cycling"
export interface LatLon { lat: number; lon: number }

const MATRIX_MAX_COORDINATES: Record<TravelProfile, number> = { driving: 25, walking: 25, cycling: 25, "driving-traffic": 10 }
/** How long a routed answer is reused: the road network is stable; a traffic-aware answer is time-of-day dependent. */
const TRAVEL_CACHE_DAYS: Record<TravelProfile, number> = { driving: 30, walking: 30, cycling: 30, "driving-traffic": 1 }

interface TravelTimeEnv { MAPBOX_TOKEN?: string; MAPBOX_PUBLIC_TOKEN?: string }

/** What a travel answer depends on — every seam injectable so the walk, the gate, the cache and the booking are provable. */
export interface TravelDeps {
  env?: TravelTimeEnv
  health?: Partial<Record<"mapbox", CapabilityProviderHealth | null>>
  call?: (req: import("@/lib/agentic-os/connector-gateway").GatewayRequest) => Promise<{ ok: boolean; status: number | null; data: any; error?: string | null }>
  cacheGet?: (key: string, maxAgeDays: number) => Promise<unknown | null>
  cacheSet?: (key: string, payload: unknown, costCents: number) => Promise<void>
  gate?: (brokerageId: string) => Promise<{ allowed: boolean; reason: string }>
  meter?: (i: import("@/lib/vendor-governance/meter-vendor").MeterVendorInput) => Promise<boolean>
}

/** The server-side Mapbox token: MAPBOX_TOKEN (secret or public — it never leaves the server) else the public one. */
function mapboxServerToken(env: TravelTimeEnv): string | null {
  return env.MAPBOX_TOKEN?.trim() || env.MAPBOX_PUBLIC_TOKEN?.trim() || null
}

/** THE WALK for travel_time — routeCapability order minus failing providers minus unconfigured ones. PURE given inputs. */
function resolveTravelTimeProvider(deps: Pick<TravelDeps, "env" | "health">):
  | { provider: "mapbox"; token: string; skipped: Array<{ provider: string; reason: string }> }
  | { provider: null; skipped: Array<{ provider: string; reason: string }> } {
  const env: TravelTimeEnv = deps.env ?? { MAPBOX_TOKEN: process.env.MAPBOX_TOKEN, MAPBOX_PUBLIC_TOKEN: process.env.MAPBOX_PUBLIC_TOKEN }
  const routed = routeCapability("travel_time", deps.health ?? {})
  const skipped: Array<{ provider: string; reason: string }> = routed.skipped.map((s) => ({ provider: s.provider, reason: s.reason }))
  for (const provider of routed.providers) {
    if (provider !== "mapbox") { skipped.push({ provider, reason: "no travel-time transport for this provider" }); continue }
    const token = mapboxServerToken(env)
    if (!token) { skipped.push({ provider, reason: "unconfigured: MAPBOX_TOKEN (or MAPBOX_PUBLIC_TOKEN) is not set" }); continue }
    return { provider: "mapbox", token, skipped }
  }
  return { provider: null, skipped }
}

/** PURE. The assumption a buyer reads beside a minutes figure (never a promise). */
export function trafficAssumption(profile: TravelProfile): string {
  switch (profile) {
    case "driving": return "a typical drive on mapped roads, without live traffic — rush hour can add time"
    case "driving-traffic": return "Mapbox's traffic-aware estimate for when it was asked — it changes through the day"
    case "walking": return "walking at an average pace on mapped streets and paths"
    case "cycling": return "cycling on mapped roads and paths"
  }
}

const coordKey = (p: LatLon) => `${Number(p.lon).toFixed(5)},${Number(p.lat).toFixed(5)}`
const validPoint = (p: LatLon | null | undefined): p is LatLon =>
  !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180

async function travelGate(brokerageId: string, deps: TravelDeps): Promise<{ allowed: boolean; reason: string }> {
  if (deps.gate) return deps.gate(brokerageId)
  try {
    const { mayUseAndAfford } = await import("@/lib/billing/billing-access")
    const d = await mayUseAndAfford({ brokerageId, capability: "app.access" })
    return { allowed: d.allowed, reason: d.reason }
  } catch (e) {
    // FAIL CLOSED: a gate that cannot run refuses the PAID call (the answer becomes "unknown", never a spend nobody checked).
    return { allowed: false, reason: `gate unavailable (${e instanceof Error ? e.message : "error"})` }
  }
}

async function travelCache(deps: TravelDeps): Promise<{ get: (k: string, d: number) => Promise<unknown | null>; set: (k: string, p: unknown, c: number) => Promise<void> }> {
  if (deps.cacheGet && deps.cacheSet) return { get: deps.cacheGet, set: deps.cacheSet }
  try {
    const store = await import("@/lib/cma/comp-supplement-cache")
    return { get: deps.cacheGet ?? ((k: string, d: number) => store.getCachedProviderPayload<unknown>(k, d)), set: deps.cacheSet ?? store.setCachedProviderPayload }
  } catch {
    return { get: deps.cacheGet ?? (async () => null), set: deps.cacheSet ?? (async () => {}) }
  }
}

async function mapboxCall(req: import("@/lib/agentic-os/connector-gateway").GatewayRequest, deps: TravelDeps): Promise<{ ok: boolean; status: number | null; data: any; error?: string | null }> {
  if (deps.call) return deps.call(req)
  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  return callConnector(req)
}

async function mapboxHealth(deps: TravelDeps): Promise<Partial<Record<"mapbox", CapabilityProviderHealth | null>>> {
  if (deps.health) return deps.health
  try {
    const { loadProviderHealth } = await import("@/lib/agentic-os/connector-gateway")
    return { mapbox: await loadProviderHealth("mapbox") }
  } catch { return {} }
}

/** Book travel-time spend (platform-covered, VARIABLE list price, an upper-bound estimate reconciled to the invoice). */
async function bookTravelTimeSpend(input: {
  brokerageId: string
  sku: "matrix_element" | "directions_request"
  units: number
  systemSource: string
}, deps: Pick<TravelDeps, "meter"> = {}): Promise<boolean> {
  if (!(input.units > 0)) return false
  const meterVendorSpend = deps.meter ?? (await import("@/lib/vendor-governance/meter-vendor")).meterVendorSpend
  return meterVendorSpend({
    vendorName: "mapbox", usageType: input.sku, cost: MAPBOX_SKU_USD[input.sku] * input.units, unitCount: input.units,
    brokerageId: input.brokerageId, systemSource: input.systemSource,
    priceState: "variable", costBasis: "estimated", coverage: "platform_covered",
    metadata: { capability: "travel_time", sku: input.sku },
  })
}

export interface TravelTimeAnswer {
  origin: LatLon
  minutes: number | null
  meters: number | null
  cached: boolean
}

export interface TravelTimesResult {
  provider: "mapbox" | null
  profile: TravelProfile
  results: TravelTimeAnswer[]
  /** Elements this call paid for (0 = everything came from the cache, or nothing could be asked). */
  elementsBilled: number
  /** Why some or all answers are null — never silent. */
  note: string | null
  route: { capability: "travel_time"; skipped: Array<{ provider: string; reason: string }> }
}

/**
 * N homes → ONE place the buyer named: drive / walk / cycle minutes and metres per home, from the travel_time route.
 * Cache first (per pair); only the misses are asked, in ONE Matrix request, after the gate. Tenant is the caller's
 * verified tenant (a session or a tenant-owned row — never a body field); no tenant → nothing is asked.
 */
export async function requestTravelTimes(input: {
  brokerageId: string | null
  origins: LatLon[]
  destination: LatLon
  profile?: TravelProfile
  systemSource?: string
}, deps: TravelDeps = {}): Promise<TravelTimesResult> {
  const profile: TravelProfile = input.profile ?? "driving"
  const origins = input.origins.filter(validPoint).slice(0, MATRIX_MAX_COORDINATES[profile] - 1)
  const results: TravelTimeAnswer[] = origins.map((o) => ({ origin: o, minutes: null, meters: null, cached: false }))
  const out = (provider: "mapbox" | null, note: string | null, billed: number, skipped: Array<{ provider: string; reason: string }> = []): TravelTimesResult =>
    ({ provider, profile, results, elementsBilled: billed, note, route: { capability: "travel_time", skipped } })
  if (!input.brokerageId) return out(null, "No verified tenant — travel times are not requested without one.", 0)
  if (!validPoint(input.destination)) return out(null, "The destination could not be placed on a map.", 0)
  if (origins.length === 0) return out(null, "No home here has map coordinates yet.", 0)

  const cache = await travelCache(deps)
  const keyFor = (o: LatLon) => `mapbox:matrix:${profile}:${coordKey(o)}>${coordKey(input.destination)}`
  const misses: number[] = []
  for (let i = 0; i < origins.length; i++) {
    const hit = (await cache.get(keyFor(origins[i]), TRAVEL_CACHE_DAYS[profile]).catch(() => null)) as { minutes?: unknown; meters?: unknown } | null
    if (hit && typeof hit.minutes === "number") {
      results[i] = { origin: origins[i], minutes: hit.minutes, meters: typeof hit.meters === "number" ? hit.meters : null, cached: true }
    } else misses.push(i)
  }
  if (misses.length === 0) return out("mapbox", null, 0)

  const walk = resolveTravelTimeProvider({ env: deps.env, health: await mapboxHealth(deps) })
  if (walk.provider === null) return out(null, `Travel times are not available right now (${walk.skipped.map((s) => `${s.provider}: ${s.reason}`).join("; ") || "no provider routed"}).`, 0, walk.skipped)
  const gate = await travelGate(input.brokerageId, deps)
  if (!gate.allowed) return out("mapbox", `The paid travel-time request was not made (${gate.reason}).`, 0, walk.skipped)

  const asked = misses.map((i) => origins[i])
  const res = await mapboxCall({
    connector: "mapbox", brokerageId: input.brokerageId, baseUrl: MAPBOX_API,
    path: `/directions-matrix/v1/mapbox/${profile}/${[...asked, input.destination].map(coordKey).join(";")}`,
    query: { annotations: "duration,distance", sources: asked.map((_, i) => String(i)).join(";"), destinations: String(asked.length) },
    auth: { style: "query", name: "access_token", value: walk.token },
    timeoutMs: 6000, retry: false, skipWhenFailing: true,
  }, deps)
  if (!res.ok || res.data?.code !== "Ok") {
    return out("mapbox", `Mapbox did not answer the travel-time request (${res.error ?? res.data?.code ?? res.status ?? "error"}).`, 0, walk.skipped)
  }
  const durations: unknown[][] = Array.isArray(res.data?.durations) ? res.data.durations : []
  const distances: unknown[][] = Array.isArray(res.data?.distances) ? res.data.distances : []
  const costCents = Math.round(MAPBOX_SKU_USD.matrix_element * 100)
  for (let k = 0; k < misses.length; k++) {
    const sec = durations[k]?.[0]
    const m = distances[k]?.[0]
    const minutes = typeof sec === "number" && Number.isFinite(sec) ? Math.max(1, Math.round(sec / 60)) : null
    const meters = typeof m === "number" && Number.isFinite(m) ? Math.round(m) : null
    results[misses[k]] = { origin: asked[k], minutes, meters, cached: false }
    if (minutes != null) void cache.set(keyFor(asked[k]), { minutes, meters }, costCents).catch(() => null)
  }
  await bookTravelTimeSpend({ brokerageId: input.brokerageId, sku: "matrix_element", units: asked.length, systemSource: input.systemSource ?? "buyer_search" }, deps)
  const unroutable = misses.filter((i) => results[i].minutes == null).length
  return out("mapbox", unroutable ? `${unroutable} of ${misses.length} homes had no routable path to that place.` : null, asked.length, walk.skipped)
}

export interface TravelRoute {
  provider: "mapbox" | null
  profile: TravelProfile
  minutes: number | null
  meters: number | null
  /** Encoded polyline (precision 5) — what a route map draws. null when no route was returned. */
  geometry: string | null
  cached: boolean
  note: string | null
}

/** ONE home → ONE place: the route a map draws (Directions API), cache first, gated, booked per request. */
export async function requestTravelRoute(input: {
  brokerageId: string | null
  from: LatLon
  to: LatLon
  profile?: TravelProfile
  systemSource?: string
}, deps: TravelDeps = {}): Promise<TravelRoute> {
  const profile: TravelProfile = input.profile ?? "driving"
  const none = (note: string, provider: "mapbox" | null = null): TravelRoute => ({ provider, profile, minutes: null, meters: null, geometry: null, cached: false, note })
  if (!input.brokerageId) return none("No verified tenant — the route is not requested without one.")
  if (!validPoint(input.from) || !validPoint(input.to)) return none("One end of the route could not be placed on a map.")
  const cache = await travelCache(deps)
  const key = `mapbox:directions:${profile}:${coordKey(input.from)}>${coordKey(input.to)}`
  const hit = (await cache.get(key, TRAVEL_CACHE_DAYS[profile]).catch(() => null)) as { minutes?: unknown; meters?: unknown; geometry?: unknown } | null
  if (hit && typeof hit.minutes === "number") {
    return { provider: "mapbox", profile, minutes: hit.minutes, meters: typeof hit.meters === "number" ? hit.meters : null, geometry: typeof hit.geometry === "string" ? hit.geometry : null, cached: true, note: null }
  }
  const walk = resolveTravelTimeProvider({ env: deps.env, health: await mapboxHealth(deps) })
  if (walk.provider === null) return none(`The route is not available right now (${walk.skipped.map((s) => `${s.provider}: ${s.reason}`).join("; ") || "no provider routed"}).`)
  const gate = await travelGate(input.brokerageId, deps)
  if (!gate.allowed) return none(`The paid route request was not made (${gate.reason}).`, "mapbox")
  const res = await mapboxCall({
    connector: "mapbox", brokerageId: input.brokerageId, baseUrl: MAPBOX_API,
    path: `/directions/v5/mapbox/${profile}/${coordKey(input.from)};${coordKey(input.to)}`,
    query: { geometries: "polyline", overview: "simplified", alternatives: "false", steps: "false" },
    auth: { style: "query", name: "access_token", value: walk.token },
    timeoutMs: 6000, retry: false, skipWhenFailing: true,
  }, deps)
  const r0 = res.ok && res.data?.code === "Ok" && Array.isArray(res.data?.routes) ? res.data.routes[0] : null
  if (!r0) return none(`Mapbox did not return a route (${res.error ?? res.data?.code ?? res.status ?? "error"}).`, "mapbox")
  const minutes = typeof r0.duration === "number" ? Math.max(1, Math.round(r0.duration / 60)) : null
  const meters = typeof r0.distance === "number" ? Math.round(r0.distance) : null
  const geometry = typeof r0.geometry === "string" && r0.geometry.length > 0 ? r0.geometry : null
  await bookTravelTimeSpend({ brokerageId: input.brokerageId, sku: "directions_request", units: 1, systemSource: input.systemSource ?? "buyer_search" }, deps)
  if (minutes != null) void cache.set(key, { minutes, meters, geometry }, Math.round(MAPBOX_SKU_USD.directions_request * 100)).catch(() => null)
  return { provider: "mapbox", profile, minutes, meters, geometry, cached: false, note: null }
}

/**
 * A ROUTE MAP from evidence only: the home (A) and the place (B) joined by the route geometry the Directions API
 * returned — no geometry, no map (a straight line would pretend to be a road). Mapbox Static Images first (path
 * overlay of the encoded polyline), Google Static Maps (`enc:` path — the same polyline encoding) when Mapbox is
 * unconfigured or failing. The caller books the image (bookMapsImageSpend) when it hands the URL out.
 */
export function getTravelRouteMapImageUrl(opts: {
  from: LatLon
  to: LatLon
  geometry: string | null
  width?: number
  height?: number
  health?: Partial<Record<MapProvider, CapabilityProviderHealth | null>>
  env?: MapCredentialEnv
}): MapImage | null {
  if (!opts.geometry || !validPoint(opts.from) || !validPoint(opts.to)) return null
  const w = Math.min(1280, Math.max(1, Math.round(opts.width ?? 600)))
  const h = Math.min(1280, Math.max(1, Math.round(opts.height ?? 320)))
  for (const choice of walkMapProviders("static_image", { health: opts.health, env: opts.env })) {
    if (choice.provider === "mapbox") {
      const overlay = `path-4+3b82f6-0.85(${encodeURIComponent(opts.geometry)}),pin-s-a+16a34a(${coordKey(opts.from)}),pin-s-b+dc2626(${coordKey(opts.to)})`
      const url = `${MAPBOX_API}/styles/v1/${MAPBOX_STATIC_STYLE}/static/${overlay}/auto/${w}x${h}@2x?padding=40&access_token=${encodeURIComponent(choice.key)}`
      if (url.length > 8192) continue // over the documented URL limit — the next provider (or no map) rather than a broken image
      return { url, source: "mapbox_static", attribution: "© Mapbox © OpenStreetMap", provider: "mapbox", sku: "static_image", route: choice.route }
    }
    const params = new URLSearchParams({ size: `${w}x${h}`, key: choice.key })
    params.append("path", `weight:4|color:0x3b82f6|enc:${opts.geometry}`)
    params.append("markers", `label:A|${opts.from.lat},${opts.from.lon}`)
    params.append("markers", `label:B|${opts.to.lat},${opts.to.lon}`)
    return { url: `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`, source: "google_street_view", attribution: "Google Maps", provider: "google_maps", sku: "static_map", route: choice.route }
  }
  return null
}

/** A PLACES MAP from evidence only: the home pin plus numbered pins for places a provider actually returned. */
export function getPlacesMapImageUrl(opts: {
  home: LatLon
  places: LatLon[]
  width?: number
  height?: number
  health?: Partial<Record<MapProvider, CapabilityProviderHealth | null>>
  env?: MapCredentialEnv
}): MapImage | null {
  const places = opts.places.filter(validPoint).slice(0, 9)
  if (!validPoint(opts.home) || places.length === 0) return null
  const w = Math.min(1280, Math.max(1, Math.round(opts.width ?? 600)))
  const h = Math.min(1280, Math.max(1, Math.round(opts.height ?? 320)))
  for (const choice of walkMapProviders("static_image", { health: opts.health, env: opts.env })) {
    if (choice.provider === "mapbox") {
      const pins = [`pin-l-home+3b82f6(${coordKey(opts.home)})`, ...places.map((p, i) => `pin-s-${i + 1}+f97316(${coordKey(p)})`)].join(",")
      return {
        url: `${MAPBOX_API}/styles/v1/${MAPBOX_STATIC_STYLE}/static/${pins}/auto/${w}x${h}@2x?padding=40&access_token=${encodeURIComponent(choice.key)}`,
        source: "mapbox_static", attribution: "© Mapbox © OpenStreetMap", provider: "mapbox", sku: "static_image", route: choice.route,
      }
    }
    const params = new URLSearchParams({ size: `${w}x${h}`, key: choice.key })
    params.append("markers", `color:blue|label:H|${opts.home.lat},${opts.home.lon}`)
    places.forEach((p, i) => params.append("markers", `color:orange|label:${i + 1}|${p.lat},${p.lon}`))
    return { url: `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`, source: "google_street_view", attribution: "Google Maps", provider: "google_maps", sku: "static_map", route: choice.route }
  }
  return null
}
