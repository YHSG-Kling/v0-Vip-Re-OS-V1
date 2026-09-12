/**
 * Free OSINT neighborhood data fetcher.
 *
 * Sources:
 *  1. Nominatim (OSM) — geocode address → lat/lon (no key, rate-limited to 1 req/s)
 *  2. Overpass API (OSM) — amenities within 1 km radius (no key)
 *  3. US Census ACS API — median home value, demographic data (no key needed for DEMO_KEY tier)
 *
 * Returns partial NeighborhoodOSINTData merged into the neighborhood report before
 * RentCast enrichment or AI fallback.
 *
 * WAVE-5 MERGE — this module no longer carries its own copies of the Nominatim and
 * Census calls. The survivors are:
 *   • lib/external/nominatim-geocode.ts:geocodeOne          (was private `geocodeAddress`)
 *   • lib/external/census-appreciation.ts:fetchCensusMedianHomeValue
 *                                                            (was private `fetchCensusMedianHomeValue`)
 * Only the Overpass call is native here, and it is now exported in an
 * availability-honest form (probeOverpassAmenities) for the free enrichment lane.
 */

export interface OSINTAmenityEntry {
  name: string
  distance: number // meters, rounded
}

export interface OSINTAmenities {
  restaurants: OSINTAmenityEntry[]
  grocery: OSINTAmenityEntry[]
  parks: OSINTAmenityEntry[]
  schools: OSINTAmenityEntry[]
  transit: OSINTAmenityEntry[]
}

export interface OSINTNeighborhoodData {
  lat: number | null
  lon: number | null
  amenities: OSINTAmenities
  censusMedianHomeValue: number | null
  dataSource: "openstreetmap+census" | "openstreetmap" | "none"
}

import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { geocodeOne } from "./nominatim-geocode"
import { fetchCensusMedianHomeValue } from "./census-appreciation"
import { gatewayProbe, unreachableProbe, type FreeProbe } from "./free-probe"

const OVERPASS_BASE = "https://overpass-api.de/api/interpreter"

/** Simple haversine distance in meters between two lat/lon points. */
function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function emptyAmenities(): OSINTAmenities {
  return { restaurants: [], grocery: [], parks: [], schools: [], transit: [] }
}

/** PURE. Bucket + sort raw Overpass elements into the five amenity categories. */
function bucketOverpassElements(elements: any[], lat: number, lon: number): OSINTAmenities {
  const amenities = emptyAmenities()

  for (const el of elements) {
    const elLat = el?.lat ?? el?.center?.lat
    const elLon = el?.lon ?? el?.center?.lon
    if (elLat == null || elLon == null) continue

    const dist = Math.round(haversineMeters(lat, lon, elLat, elLon))
    const name: string = el.tags?.name ?? el.tags?.brand ?? "Unnamed"
    const entry: OSINTAmenityEntry = { name, distance: dist }

    const amenity = el.tags?.amenity ?? ""
    const shop = el.tags?.shop ?? ""
    const leisure = el.tags?.leisure ?? ""
    const transport = el.tags?.public_transport ?? el.tags?.highway ?? ""

    if (["restaurant", "cafe", "fast_food"].includes(amenity)) {
      amenities.restaurants.push(entry)
    } else if (["supermarket", "grocery"].includes(shop)) {
      amenities.grocery.push(entry)
    } else if (amenity === "school") {
      amenities.schools.push(entry)
    } else if (leisure === "park") {
      amenities.parks.push(entry)
    } else if (["stop_position", "station", "bus_stop"].includes(transport)) {
      amenities.transit.push(entry)
    }
  }

  // Sort by distance, keep top 5 per category
  for (const key of Object.keys(amenities) as Array<keyof OSINTAmenities>) {
    amenities[key] = amenities[key].sort((a, b) => a.distance - b.distance).slice(0, 5)
  }

  return amenities
}

/** True when at least one category has an entry. */
export function hasAnyAmenity(amenities: OSINTAmenities): boolean {
  return Object.values(amenities).some((arr) => arr.length > 0)
}

/**
 * Query Overpass (OSM) for amenities within radiusMeters, REPORTING WHY it failed.
 * `unreachable` = Overpass refused/timed out (it rate-limits hard and 504s under load);
 * `no_data` = Overpass answered and there is genuinely nothing tagged nearby. Those are
 * NOT the same fact and the free enrichment lane has to be able to say which happened.
 * Never throws.
 */
export async function probeOverpassAmenities(
  lat: number,
  lon: number,
  radiusMeters = 1000,
): Promise<FreeProbe<OSINTAmenities>> {
  const overpassQuery = `
    [out:json][timeout:10];
    (
      node["amenity"~"restaurant|cafe|fast_food"](around:${radiusMeters},${lat},${lon});
      node["shop"~"supermarket|grocery"](around:${radiusMeters},${lat},${lon});
      node["amenity"="school"](around:${radiusMeters},${lat},${lon});
      way["leisure"="park"](around:${radiusMeters},${lat},${lon});
      node["public_transport"~"stop_position|station"](around:${radiusMeters},${lat},${lon});
      node["highway"="bus_stop"](around:${radiusMeters},${lat},${lon});
    );
    out center;
  `.trim()

  try {
    const res = await callConnector<any>({
      connector: "overpass", baseUrl: "", path: "", url: OVERPASS_BASE, method: "POST",
      auth: { style: "none" }, bodyType: "form", body: { data: overpassQuery }, timeoutMs: 12000,
    })
    return gatewayProbe<OSINTAmenities>(res, () => {
      const elements = Array.isArray(res.data?.elements) ? res.data.elements : []
      const bucketed = bucketOverpassElements(elements, lat, lon)
      // null here means "Overpass answered, nothing tagged within the radius".
      return hasAnyAmenity(bucketed) ? bucketed : null
    })
  } catch (err) {
    return unreachableProbe<OSINTAmenities>(err)
  }
}

/**
 * Fetch free OSINT neighborhood data for a property.
 * Runs geocoding, then OSM amenity query + Census median home value in parallel.
 * Never throws — returns partial data on any error.
 *
 * `dataSource` is now HONEST about Census: "+census" is claimed only when the ACS
 * figure actually came back. It previously claimed "openstreetmap+census" whenever any
 * amenity was found, even with censusMedianHomeValue === null.
 */
export async function fetchOSINTNeighborhoodData(
  address: string,
  city: string,
  state: string,
  zip: string
): Promise<OSINTNeighborhoodData> {
  const empty: OSINTNeighborhoodData = {
    lat: null,
    lon: null,
    amenities: emptyAmenities(),
    censusMedianHomeValue: null,
    dataSource: "none",
  }

  // Step 1: Geocode (canonical free geocoder — lib/external/nominatim-geocode.ts)
  const coords = await geocodeOne({ address, city, state, zip })
  if (!coords) return empty

  // Step 2: Overpass + Census in parallel (independent requests)
  const [amenityProbe, censusMedianHomeValue] = await Promise.all([
    probeOverpassAmenities(coords.lat, coords.lng, 1000),
    fetchCensusMedianHomeValue(zip),
  ])

  const amenities = amenityProbe.value ?? emptyAmenities()
  const hasAmenities = hasAnyAmenity(amenities)

  return {
    lat: coords.lat,
    lon: coords.lng,
    amenities,
    censusMedianHomeValue,
    dataSource: hasAmenities
      ? (censusMedianHomeValue != null ? "openstreetmap+census" : "openstreetmap")
      : "none",
  }
}
