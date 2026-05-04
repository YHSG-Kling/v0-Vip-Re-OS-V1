/**
 * Free OSINT neighborhood data fetcher.
 *
 * Sources:
 *  1. Nominatim (OSM) — geocode address → lat/lon (no key, rate-limited to 1 req/s)
 *  2. Overpass API (OSM) — amenities within 1 km radius (no key)
 *  3. US Census ACS API — median home value, demographic data (no key needed for DEMO_KEY tier)
 *
 * Returns partial NeighborhoodOSINTData merged into the neighborhood report before
 * HouseCanary enrichment or AI fallback.
 */

export interface OSINTAmenityEntry {
  name: string
  distance: number // meters, rounded
}

export interface OSINTNeighborhoodData {
  lat: number | null
  lon: number | null
  amenities: {
    restaurants: OSINTAmenityEntry[]
    grocery: OSINTAmenityEntry[]
    parks: OSINTAmenityEntry[]
    schools: OSINTAmenityEntry[]
    transit: OSINTAmenityEntry[]
  }
  censusMedianHomeValue: number | null
  dataSource: "openstreetmap+census" | "openstreetmap" | "none"
}

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org"
const OVERPASS_BASE = "https://overpass-api.de/api/interpreter"
const CENSUS_BASE = "https://api.census.gov"

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

/** Geocode an address using Nominatim (OpenStreetMap). Returns null on failure. */
async function geocodeAddress(address: string, city: string, state: string, zip: string): Promise<{ lat: number; lon: number } | null> {
  try {
    const query = encodeURIComponent(`${address}, ${city}, ${state} ${zip}, USA`)
    const url = `${NOMINATIM_BASE}/search?q=${query}&format=json&limit=1&countrycodes=us`
    const res = await fetch(url, {
      headers: {
        "User-Agent": "RealEstateOS/1.0 (neighborhood-reports)",
        "Accept-Language": "en",
      },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const data = await res.json()
    if (!Array.isArray(data) || data.length === 0) return null
    return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) }
  } catch {
    return null
  }
}

/** Query Overpass API for nearby amenities within radiusMeters. */
async function queryOverpassAmenities(
  lat: number,
  lon: number,
  radiusMeters = 1000
): Promise<OSINTNeighborhoodData["amenities"]> {
  const amenities: OSINTNeighborhoodData["amenities"] = {
    restaurants: [],
    grocery: [],
    parks: [],
    schools: [],
    transit: [],
  }

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
    const res = await fetch(OVERPASS_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(overpassQuery)}`,
      signal: AbortSignal.timeout(12000),
    })
    if (!res.ok) return amenities
    const data = await res.json()

    for (const el of data.elements ?? []) {
      const elLat = el.lat ?? el.center?.lat
      const elLon = el.lon ?? el.center?.lon
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
    for (const key of Object.keys(amenities) as Array<keyof typeof amenities>) {
      amenities[key] = amenities[key]
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 5)
    }
  } catch {
    // Overpass timeout or network error — return empty amenities
  }

  return amenities
}

/** Fetch median home value from US Census ACS 5-year estimates using ZIP code. */
async function fetchCensusMedianHomeValue(zip: string): Promise<number | null> {
  try {
    // B25077_001E = Median value of owner-occupied housing units
    const url = `${CENSUS_BASE}/data/2022/acs/acs5?get=B25077_001E&for=zip%20code%20tabulation%20area:${zip}&key=DEMO_KEY`
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const data = await res.json()
    // data[0] = header row, data[1] = first result
    if (!Array.isArray(data) || data.length < 2) return null
    const valueStr = data[1][0]
    const value = parseInt(valueStr, 10)
    return isNaN(value) || value <= 0 ? null : value
  } catch {
    return null
  }
}

/**
 * Fetch free OSINT neighborhood data for a property.
 * Runs geocoding + OSM amenity query + Census median home value in parallel where possible.
 * Never throws — returns partial data on any error.
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
    amenities: { restaurants: [], grocery: [], parks: [], schools: [], transit: [] },
    censusMedianHomeValue: null,
    dataSource: "none",
  }

  // Step 1: Geocode
  const coords = await geocodeAddress(address, city, state, zip)
  if (!coords) return empty

  // Step 2: Overpass + Census in parallel (independent requests)
  const [amenities, censusMedianHomeValue] = await Promise.all([
    queryOverpassAmenities(coords.lat, coords.lon, 1000),
    fetchCensusMedianHomeValue(zip),
  ])

  const hasAmenities = Object.values(amenities).some((arr) => arr.length > 0)

  return {
    lat: coords.lat,
    lon: coords.lon,
    amenities,
    censusMedianHomeValue,
    dataSource: hasAmenities ? "openstreetmap+census" : "none",
  }
}
