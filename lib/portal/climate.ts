// ─── CLIMATE / HEMISPHERE FROM LOCATION ──────────────────────────────────────
// Pure, import-free heuristic that turns a property's location string into a
// hemisphere + climate zone, so seasonal guidance reflects WHERE the home is —
// a Phoenix "winter" is not a Minneapolis "winter," and the Southern hemisphere's
// seasons are inverted. Deterministic (no Date, no network) → unit-testable.
//
// PRODUCTION SEAM: this is a coarse state-level classification. The right
// production source is a live climate-normals / weather lookup keyed off the
// home's geocode (NOAA normals, Open-Meteo climate, or a weather API) — wire it
// into deriveClimate() and the maintenance engine consumes the same shape. Until
// then this gives location-aware (not just calendar-aware) behavior with zero egress.

export type Hemisphere = "north" | "south"
export type ClimateZone = "cold" | "temperate" | "warm" | "tropical"

export interface Climate {
  hemisphere: Hemisphere
  zone: ClimateZone
  /** Coastal storm / hurricane exposure (drives storm-readiness guidance). */
  stormExposed: boolean
  /** What we resolved from (telemetry / "we tailored this to {region}"). */
  region: string | null
}

// US state → climate zone (coarse heuristic; see production seam above).
const COLD = new Set(["AK", "MN", "ND", "SD", "WI", "MI", "ME", "NH", "VT", "MT", "WY", "ID", "IA", "NE"])
const WARM = new Set(["TX", "AZ", "GA", "SC", "AL", "MS", "LA", "AR", "OK", "NM", "NV"])
const TROPICAL = new Set(["FL", "HI"])
// Atlantic/Gulf coastal states with meaningful hurricane exposure.
const STORM = new Set(["FL", "LA", "MS", "AL", "GA", "SC", "NC", "TX", "VA", "HI"])

const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
])

const SOUTHERN_HINTS = ["australia", "new zealand", "argentina", "chile", "south africa", "brazil", "uruguay", "paraguay"]

/** Pull a US 2-letter state token from an address tail, if present. */
export function parseUsState(location: string | null | undefined): string | null {
  if (!location) return null
  // Tokenize on commas/spaces; look for an uppercase 2-letter US state.
  const tokens = location.replace(/[^A-Za-z, ]/g, " ").split(/[\s,]+/).filter(Boolean)
  // Prefer a token that is exactly 2 uppercase letters & a valid state (scan from the end — state sits near the tail).
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i].toUpperCase()
    if (t.length === 2 && US_STATES.has(t) && tokens[i] === t) return t
  }
  // Fallback: any valid 2-letter state token regardless of case (less precise).
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i].toUpperCase()
    if (t.length === 2 && US_STATES.has(t)) return t
  }
  return null
}

export function deriveClimate(location: string | null | undefined): Climate {
  const lower = (location ?? "").toLowerCase()
  const hemisphere: Hemisphere = SOUTHERN_HINTS.some((h) => lower.includes(h)) ? "south" : "north"

  const state = parseUsState(location)
  let zone: ClimateZone = "temperate"
  if (state) {
    if (TROPICAL.has(state)) zone = "tropical"
    else if (WARM.has(state)) zone = "warm"
    else if (COLD.has(state)) zone = "cold"
    else zone = "temperate"
  }
  const stormExposed = state ? STORM.has(state) : false

  return { hemisphere, zone, stormExposed, region: state }
}
