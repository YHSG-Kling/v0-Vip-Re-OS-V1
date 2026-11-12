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
const GEOAPIFY_BASE = "https://api.geoapify.com"

/**
 * The ONE Geoapify egress — through the connector gateway (wave 139, lane 139B: was a raw fetch).
 * The chat-turn latency budget is kept: ONE attempt (`retry: false`) under the same 2.5s hard
 * timeout. `skipWhenFailing`: Geoapify has NO alternate inside this budget (the keyless Overpass
 * amenity rail needs a Nominatim geocode + a 12s query — lib/external/osint-neighborhood.ts), so
 * during an outage the derived health (api_response_logs + the platform probe) skips the call
 * without egress instead of every chat turn waiting out the dead vendor. The key rides as the
 * `apiKey` query param, which the gateway never writes to the log row. Never throws.
 */
async function geoapifyGet(path: string, query: Record<string, string>, key: string, brokerageId: string | null): Promise<{ data: any | null; skipped: string | null }> {
  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const res = await callConnector({
    connector: "geoapify", brokerageId, baseUrl: GEOAPIFY_BASE, path, query,
    auth: { style: "query", name: "apiKey", value: key },
    timeoutMs: TIMEOUT_MS, retry: false, skipWhenFailing: true,
  })
  return { data: res.ok ? res.data : null, skipped: !res.ok && res.error?.startsWith("provider_failing:") ? res.error : null }
}

/** Geocode an address and fetch real nearby places (3km). Honest failures. */
export async function fetchNearbyPlaces(address: string, opts: { brokerageId?: string | null } = {}): Promise<
  | { ok: true; places: NearbyPlace[] }
  | { ok: false; reason: string }
> {
  const key = process.env.GEOAPIFY_API_KEY
  if (!key) return { ok: false, reason: "GEOAPIFY_API_KEY not configured (platform provider setup)" }
  if (!address.trim()) return { ok: false, reason: "no address" }
  const tenant = opts.brokerageId ?? null

  const geoRes = await geoapifyGet("v1/geocode/search", { text: address, limit: "1" }, key, tenant)
  if (geoRes.skipped) return { ok: false, reason: geoRes.skipped }
  const geo = geoRes.data
  const feat = geo?.features?.[0]
  const lon = feat?.properties?.lon ?? feat?.geometry?.coordinates?.[0]
  const lat = feat?.properties?.lat ?? feat?.geometry?.coordinates?.[1]
  if (typeof lon !== "number" || typeof lat !== "number") {
    return { ok: false, reason: "address could not be geocoded" }
  }

  const placesRes = (await geoapifyGet("v2/places", {
    categories: PLACE_CATEGORIES, filter: `circle:${lon},${lat},3000`, bias: `proximity:${lon},${lat}`, limit: "24",
  }, key, tenant)).data
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
