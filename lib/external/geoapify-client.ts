/**
 * lib/external/geoapify-client.ts
 *
 * GEOAPIFY (OpenStreetMap) — the POI provider behind local-lifestyle
 * suggestions (client concierge #30: parks, schools, dining, groceries,
 * commute anchors "surfaced at the right exploration moment"). PLATFORM
 * provider setup (owner rule), gated on GEOAPIFY_API_KEY: unconfigured =
 * clean skip with an honest reason — the OS NEVER invents a restaurant or
 * a school. Geocode → places within a walk/short-drive radius, tolerant
 * parsing, hard timeout so a slow provider can never stall a chat turn.
 */

export interface NearbyPlace {
  name: string
  /** geoapify category head (e.g. "leisure.park"). */
  category: string
  distanceMeters: number | null
}

export function geoapifyConfigured(): boolean {
  return Boolean(process.env.GEOAPIFY_API_KEY)
}

const PLACE_CATEGORIES = [
  "leisure.park",
  "education.school",
  "catering.restaurant",
  "catering.cafe",
  "commercial.supermarket",
  "sport.fitness",
].join(",")

const TIMEOUT_MS = 2_500

async function fetchJson(url: string): Promise<any | null> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

/** Geocode an address and fetch real nearby places (3km). Honest failures. */
export async function fetchNearbyPlaces(address: string): Promise<
  | { ok: true; places: NearbyPlace[] }
  | { ok: false; reason: string }
> {
  const key = process.env.GEOAPIFY_API_KEY
  if (!key) return { ok: false, reason: "GEOAPIFY_API_KEY not configured (platform provider setup)" }
  if (!address.trim()) return { ok: false, reason: "no address" }

  const geo = await fetchJson(
    `https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(address)}&limit=1&apiKey=${key}`,
  )
  const feat = geo?.features?.[0]
  const lon = feat?.properties?.lon ?? feat?.geometry?.coordinates?.[0]
  const lat = feat?.properties?.lat ?? feat?.geometry?.coordinates?.[1]
  if (typeof lon !== "number" || typeof lat !== "number") {
    return { ok: false, reason: "address could not be geocoded" }
  }

  const placesRes = await fetchJson(
    `https://api.geoapify.com/v2/places?categories=${PLACE_CATEGORIES}&filter=circle:${lon},${lat},3000&bias=proximity:${lon},${lat}&limit=24&apiKey=${key}`,
  )
  const feats = Array.isArray(placesRes?.features) ? placesRes.features : []
  const places: NearbyPlace[] = []
  for (const f of feats) {
    const p = f?.properties ?? {}
    const name = (p.name ?? "").toString().trim()
    if (!name) continue
    places.push({
      name,
      category: Array.isArray(p.categories) ? String(p.categories[0] ?? "") : String(p.categories ?? ""),
      distanceMeters: typeof p.distance === "number" ? p.distance : null,
    })
  }
  return { ok: true, places }
}
