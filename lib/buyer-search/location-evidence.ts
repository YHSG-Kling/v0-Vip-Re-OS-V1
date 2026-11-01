/**
 * lib/buyer-search/location-evidence.ts — THE EVIDENCE BEHIND A NEIGHBOURLY ANSWER (wave 148, lane 148E, ruling 7, C18).
 *
 * Owner (2026-11-01): "if they need walkability or how far it is to commute or yard size or quiet setting, those can
 * have more info like a map; outdoor space is a home with acreage; quiet setting is not close to neighbors."
 *
 * This module GATHERS the facts; explanation-generator.ts decides what they mean for the buyer's ask and
 * explanation-evidence.ts types them (C18). NOTHING NEW IS INVENTED — every source is an existing survivor:
 *
 *   where the home is      the row's own coordinates (RentCast /listings latitude/longitude, evidence provider:rentcast),
 *                          else the canonical FREE geocoder lib/external/nominatim-geocode.ts geocodeOne (provider:osm)
 *   drive / walk time      the travel_time capability — lib/property/street-view.ts requestTravelTimes (Matrix, a
 *                          page of homes in ONE request) / requestTravelRoute (Directions, the one route a map draws)
 *   what's an easy walk    the keyless Overpass amenity probe lib/external/osint-neighborhood.ts probeOverpassAmenities
 *   how close neighbours   the same Overpass egress — probeOverpassSurroundings (nearest other building, major roads, rail)
 *   the map                the ONE map_render walk — getTravelRouteMapImageUrl / getPlacesMapImageUrl, booked through
 *                          bookMapsImageSpend; drawn ONLY from the evidence above (no route → no route map)
 *
 * COST DISCIPLINE (owner: "cache before any paid call"): every geocode, Overpass answer and routed time is read from
 * the one provider-payload store first (lib/cma/comp-supplement-cache.ts, namespaced keys); paid Mapbox calls are
 * gated (mayUseAndAfford, inside street-view.ts) and booked. A search page asks ONE Matrix request for the homes that
 * already carry coordinates and makes no free-tier geocode at all (Nominatim's 1 request/second would stall the
 * page); the per-home "why this home?" door gathers the full set on demand.
 *
 * NEVER THROWS. What could not be measured is a NOTE, and the ask stays UNKNOWN in the explanation.
 */
import type { LifestyleAsk } from "./conversation-criteria"
import type { EvidenceSource, HomeLocationEvidence, MapEvidence, PlaceEvidence, TravelEvidence, AmenityKind } from "./explanation-evidence"
import type { TravelDeps, TravelProfile, LatLon } from "@/lib/property/street-view"

type Point = { lat: number; lon: number }
type SurroundingsFacts = Omit<NonNullable<HomeLocationEvidence["surroundings"]>, "source" | "observed_at">

export interface LocationEvidenceDeps extends TravelDeps {
  geocode?: (parts: { address?: string | null; city?: string | null; state?: string | null; zip?: string | null }) => Promise<{ lat: number; lng: number } | null>
  amenities?: (lat: number, lon: number) => Promise<{ outcome: string; places: PlaceEvidence[] | null; error?: string | null }>
  surroundings?: (lat: number, lon: number) => Promise<{ outcome: string; value: SurroundingsFacts | null; error?: string | null }>
  now?: () => Date
  /** Image booking seam (bookMapsImageSpend's meter). */
  imageMeter?: TravelDeps["meter"]
  /** The map_render credentials (default: the process env, read by street-view.ts) — injectable for the proof. */
  mapEnv?: { MAPBOX_PUBLIC_TOKEN?: string; MAPBOX_TOKEN?: string; GOOGLE_MAPS_API_KEY?: string; NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?: string }
}

export interface HomeForEvidence {
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  lat?: number | null
  lon?: number | null
  /** Who supplied lat/lon when the row carries them (RentCast rows do). */
  coordsSource?: EvidenceSource
}

const GEOCODE_CACHE_DAYS = 90
const OVERPASS_CACHE_DAYS = 30
/** A commute destination the geocoder placed further than this from the home is the wrong place — not measured. */
const DESTINATION_SANITY_KM = 120
/** At most this many named destinations per explanation (each is one routed request). */
const MAX_DESTINATIONS = 2

const asksOf = (asks: LifestyleAsk[], kind: LifestyleAsk["kind"]) => asks.filter((a) => a.kind === kind)

function km(a: Point, b: Point): number {
  const R = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLon = ((b.lon - a.lon) * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

async function cacheOf(deps: LocationEvidenceDeps) {
  if (deps.cacheGet && deps.cacheSet) return { get: deps.cacheGet, set: deps.cacheSet }
  try {
    const store = await import("@/lib/cma/comp-supplement-cache")
    return { get: deps.cacheGet ?? ((k: string, d: number) => store.getCachedProviderPayload<unknown>(k, d)), set: deps.cacheSet ?? store.setCachedProviderPayload }
  } catch {
    return { get: deps.cacheGet ?? (async () => null), set: deps.cacheSet ?? (async () => {}) }
  }
}

/** Free geocode, cache first. `allowNetwork: false` → the cache only (a search page never waits on Nominatim). */
async function geocodeCached(parts: { address?: string | null; city?: string | null; state?: string | null; zip?: string | null }, deps: LocationEvidenceDeps, allowNetwork: boolean): Promise<Point | null> {
  const q = [parts.address, parts.city, parts.state, parts.zip].map((p) => (p ?? "").toString().trim()).filter(Boolean).join(", ")
  if (!q) return null
  const cache = await cacheOf(deps)
  const key = `osm:geocode:${q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`
  const hit = (await cache.get(key, GEOCODE_CACHE_DAYS).catch(() => null)) as { lat?: unknown; lon?: unknown } | null
  if (hit && typeof hit.lat === "number" && typeof hit.lon === "number") return { lat: hit.lat, lon: hit.lon }
  if (!allowNetwork) return null
  try {
    const geocode = deps.geocode ?? (await import("@/lib/external/nominatim-geocode")).geocodeOne
    const p = await geocode(parts)
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return null
    void cache.set(key, { lat: p.lat, lon: p.lng }, 0).catch(() => null)
    return { lat: p.lat, lon: p.lng }
  } catch {
    return null
  }
}

async function homePoint(home: HomeForEvidence, deps: LocationEvidenceDeps, allowNetwork: boolean): Promise<HomeLocationEvidence["home"]> {
  if (typeof home.lat === "number" && typeof home.lon === "number" && Number.isFinite(home.lat) && Number.isFinite(home.lon)) {
    return { lat: home.lat, lon: home.lon, source: home.coordsSource ?? "listing" }
  }
  const p = await geocodeCached({ address: home.address, city: home.city, state: home.state, zip: home.zip }, deps, allowNetwork)
  return p ? { ...p, source: "provider:osm" } : null
}

/** The place the buyer named, placed near the home (city / state context), refused when it lands far away. */
async function destinationPoint(target: string, home: HomeForEvidence, at: Point, deps: LocationEvidenceDeps, allowNetwork: boolean): Promise<{ point: Point | null; note: string | null }> {
  if (/^(work|the office|my office|office|my work)$/i.test(target.trim())) return { point: null, note: "I need the address or a nearby landmark for work" }
  const p = await geocodeCached({ address: target, city: home.city, state: home.state }, deps, allowNetwork)
    ?? (allowNetwork ? await geocodeCached({ address: target, state: home.state }, deps, allowNetwork) : null)
  if (!p) return { point: null, note: allowNetwork ? `I couldn't place "${target}" on the map` : null }
  if (km(at, p) > DESTINATION_SANITY_KM) return { point: null, note: `the map placed "${target}" too far from this home to be the one you mean` }
  return { point: p, note: null }
}

const AMENITY_BUCKETS: Array<[keyof import("@/lib/external/osint-neighborhood").OSINTAmenities, AmenityKind]> = [
  ["parks", "park"], ["grocery", "grocery"], ["restaurants", "cafe_restaurant"], ["transit", "transit"],
  // "schools" is deliberately NOT mapped: proximity is lawful, but schools are not an amenity kind the buyer
  // explanation offers unprompted (conversation-criteria.ts AMENITY_WORDS excludes them for the same reason).
]

async function amenitiesNear(at: Point, deps: LocationEvidenceDeps): Promise<{ places: PlaceEvidence[] | null; note: string | null }> {
  const cache = await cacheOf(deps)
  const key = `osm:amenities:${at.lat.toFixed(4)},${at.lon.toFixed(4)}`
  const hit = (await cache.get(key, OVERPASS_CACHE_DAYS).catch(() => null)) as { places?: unknown } | null
  if (hit && Array.isArray(hit.places)) return { places: hit.places as PlaceEvidence[], note: null }
  try {
    let r: { outcome: string; places: PlaceEvidence[] | null; error?: string | null }
    if (deps.amenities) r = await deps.amenities(at.lat, at.lon)
    else {
      const { probeOverpassAmenities } = await import("@/lib/external/osint-neighborhood")
      const probe = await probeOverpassAmenities(at.lat, at.lon, 1600)
      const places: PlaceEvidence[] = []
      for (const [bucket, kind] of AMENITY_BUCKETS) {
        for (const e of probe.value?.[bucket] ?? []) {
          if (!e.name || e.name === "Unnamed") continue
          places.push({ name: e.name, kind, meters: e.distance, ...(typeof e.lat === "number" && typeof e.lon === "number" ? { lat: e.lat, lon: e.lon } : {}) })
        }
      }
      r = { outcome: probe.outcome, places: probe.outcome === "ok" ? places : probe.outcome === "no_data" ? [] : null, error: probe.error }
    }
    if (r.places == null) return { places: null, note: `the map of nearby places didn't answer (${r.error ?? r.outcome})` }
    void cache.set(key, { places: r.places }, 0).catch(() => null)
    return { places: r.places, note: null }
  } catch (e) {
    return { places: null, note: `the map of nearby places didn't answer (${e instanceof Error ? e.message : "error"})` }
  }
}

async function surroundingsNear(at: Point, deps: LocationEvidenceDeps): Promise<{ value: SurroundingsFacts | null; note: string | null }> {
  const cache = await cacheOf(deps)
  const key = `osm:surroundings:${at.lat.toFixed(4)},${at.lon.toFixed(4)}`
  const hit = (await cache.get(key, OVERPASS_CACHE_DAYS).catch(() => null)) as { buildingsWithin100m?: unknown } | null
  if (hit && typeof hit.buildingsWithin100m === "number") return { value: hit as never, note: null }
  try {
    const r = deps.surroundings
      ? await deps.surroundings(at.lat, at.lon)
      : await (await import("@/lib/external/osint-neighborhood")).probeOverpassSurroundings(at.lat, at.lon)
    if (!r.value) return { value: null, note: `the map of nearby buildings and roads didn't answer (${r.error ?? r.outcome})` }
    void cache.set(key, r.value, 0).catch(() => null)
    return { value: r.value, note: null }
  } catch (e) {
    return { value: null, note: `the map of nearby buildings and roads didn't answer (${e instanceof Error ? e.message : "error"})` }
  }
}

async function bookImage(brokerageId: string, img: { url: string; provider: "mapbox" | "google_maps"; sku: string }, systemSource: string, deps: LocationEvidenceDeps): Promise<void> {
  try {
    const { bookMapsImageSpend } = await import("@/lib/property/street-view")
    await bookMapsImageSpend({ brokerageId, provider: img.provider, sku: img.sku as never, url: img.url, systemSource }, deps.imageMeter ? { meter: deps.imageMeter } : {})
  } catch { /* booking is best-effort telemetry — never blocks the explanation */ }
}

/**
 * ONE HOME, ON DEMAND ("why this home?"): the full evidence set for the buyer's lifestyle asks — the routed drive to
 * each named place (with its route map), what's mapped within an easy walk (with a places map), and how close the
 * next buildings and the big roads are. Only what an ask needs is fetched.
 */
export async function gatherHomeLocationEvidence(input: {
  brokerageId: string
  home: HomeForEvidence
  asks: LifestyleAsk[]
  systemSource?: string
  profile?: TravelProfile
}, deps: LocationEvidenceDeps = {}): Promise<HomeLocationEvidence> {
  const ev: HomeLocationEvidence = { home: null, travel: [], amenities: null, surroundings: null, notes: [] }
  const commutes = asksOf(input.asks, "commute").filter((a) => !!a.target).slice(0, MAX_DESTINATIONS)
  const walks = asksOf(input.asks, "nearby_amenity")
  const quiet = asksOf(input.asks, "quiet_setting")
  if (commutes.length === 0 && walks.length === 0 && quiet.length === 0) return ev
  const systemSource = input.systemSource ?? "buyer_search"
  const now = () => (deps.now ? deps.now() : new Date()).toISOString()

  ev.home = await homePoint(input.home, deps, true)
  if (!ev.home) { ev.notes.push("This home couldn't be placed on a map, so drive times, walkability and spacing aren't measured."); return ev }
  const at: Point = { lat: ev.home.lat, lon: ev.home.lon }
  const label = input.home.address || input.home.city || "This home"

  const { requestTravelRoute, getTravelRouteMapImageUrl, getPlacesMapImageUrl, trafficAssumption } = await import("@/lib/property/street-view")
  const profile: TravelProfile = input.profile ?? "driving"
  for (const ask of commutes) {
    const target = ask.target!
    const dest = await destinationPoint(target, input.home, at, deps, true)
    const base: TravelEvidence = { target, placeLabel: target, to: dest.point ?? { lat: NaN, lon: NaN }, profile, minutes: null, meters: null, assumption: trafficAssumption(profile), observed_at: now(), map: null, note: dest.note }
    if (!dest.point) { ev.travel.push(base); continue }
    const route = await requestTravelRoute({ brokerageId: input.brokerageId, from: at as LatLon, to: dest.point as LatLon, profile, systemSource }, deps)
    const t: TravelEvidence = { ...base, to: dest.point, minutes: route.minutes, meters: route.meters, note: route.note }
    if (route.minutes != null && route.geometry) {
      const img = getTravelRouteMapImageUrl({ from: at, to: dest.point, geometry: route.geometry, env: deps.mapEnv })
      if (img) {
        await bookImage(input.brokerageId, img, systemSource, deps)
        t.map = {
          kind: "route", image_url: img.url, attribution: img.attribution, renderer: img.provider, evidence_source: "provider:mapbox",
          from: { ...at, label }, to: { ...dest.point, label: target }, minutes: route.minutes, meters: route.meters, profile, assumption: t.assumption, observed_at: t.observed_at,
        } satisfies MapEvidence
      }
    }
    ev.travel.push(t)
  }

  if (walks.length > 0) {
    const a = await amenitiesNear(at, deps)
    if (a.places == null) ev.notes.push(`Walkability isn't measured: ${a.note}.`)
    else {
      const observed_at = now()
      const pinned = a.places.filter((p) => typeof p.lat === "number" && typeof p.lon === "number").sort((x, y) => x.meters - y.meters).slice(0, 6)
      let map: MapEvidence | null = null
      if (pinned.length > 0) {
        const img = getPlacesMapImageUrl({ home: at, places: pinned.map((p) => ({ lat: p.lat!, lon: p.lon! })), env: deps.mapEnv })
        if (img) {
          await bookImage(input.brokerageId, img, systemSource, deps)
          map = { kind: "places", image_url: img.url, attribution: img.attribution, renderer: img.provider, evidence_source: "provider:osm", from: { ...at, label }, to: null, observed_at }
        }
      }
      ev.amenities = { source: "provider:osm", observed_at, places: a.places, map }
    }
  }

  if (quiet.length > 0) {
    const s = await surroundingsNear(at, deps)
    if (!s.value) ev.notes.push(`Spacing and road exposure aren't measured: ${s.note}.`)
    else ev.surroundings = { source: "provider:osm", observed_at: now(), ...s.value }
  }
  return ev
}

/**
 * A SEARCH PAGE: the drive to the buyer's (first) named place for every home that already carries coordinates — ONE
 * Matrix request, cache first, no free-tier geocode of the homes. Homes without coordinates keep an UNKNOWN commute
 * whose detail invites "why this home?" (the on-demand door above). Returns evidence keyed like the input.
 */
export async function gatherPageTravelEvidence(input: {
  brokerageId: string
  homes: Array<HomeForEvidence & { key: string }>
  asks: LifestyleAsk[]
  systemSource?: string
}, deps: LocationEvidenceDeps = {}): Promise<Map<string, HomeLocationEvidence>> {
  const out = new Map<string, HomeLocationEvidence>()
  const ask = asksOf(input.asks, "commute").find((a) => !!a.target)
  if (!ask) return out
  const withPoints: Array<{ key: string; at: Point; home: HomeForEvidence; source: EvidenceSource }> = []
  for (const h of input.homes) {
    const p = await homePoint(h, deps, false)
    if (p) withPoints.push({ key: h.key, at: { lat: p.lat, lon: p.lon }, home: h, source: p.source })
  }
  if (withPoints.length === 0) return out
  // Place the destination once, near the first home (the search area), from the cache or the free geocoder.
  const dest = await destinationPoint(ask.target!, withPoints[0].home, withPoints[0].at, deps, true)
  const { requestTravelTimes, trafficAssumption } = await import("@/lib/property/street-view")
  const observed_at = (deps.now ? deps.now() : new Date()).toISOString()
  const base = (w: { at: Point; source: EvidenceSource }, minutes: number | null, meters: number | null, note: string | null): HomeLocationEvidence => ({
    home: { ...w.at, source: w.source },
    travel: [{ target: ask.target!, placeLabel: ask.target!, to: dest.point ?? { lat: NaN, lon: NaN }, profile: "driving", minutes, meters, assumption: trafficAssumption("driving"), observed_at, map: null, note }],
    amenities: null, surroundings: null, notes: [],
  })
  if (!dest.point) {
    for (const w of withPoints) out.set(w.key, base(w, null, null, dest.note))
    return out
  }
  const r = await requestTravelTimes({ brokerageId: input.brokerageId, origins: withPoints.map((w) => w.at as LatLon), destination: dest.point as LatLon, profile: "driving", systemSource: input.systemSource ?? "buyer_search" }, deps)
  withPoints.forEach((w, i) => {
    const a = r.results[i]
    out.set(w.key, base(w, a?.minutes ?? null, a?.meters ?? null, a?.minutes == null ? r.note : null))
  })
  return out
}
