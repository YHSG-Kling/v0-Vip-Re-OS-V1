// ─── HOMEOWNERSHIP MAINTENANCE SUGGESTIONS ───────────────────────────────────
// Pure engine behind the lifetime portal's maintenance card: given the current
// month, the home's LOCATION (→ hemisphere + climate zone), how long they've
// owned, and which vendor categories their agent has in the marketplace, it
// returns a prioritized, season-AND-climate-aware set of upkeep suggestions —
// each tagged with the vendor category that does the job.
//
// Location matters: a Phoenix "winter" gets no pipe-freeze warning (it gets a
// pre-summer A/C push + year-round pest); a coastal home gets storm readiness;
// the Southern hemisphere's seasons are inverted. Climate is derived by the pure
// deriveClimate() helper (lib/portal/climate.ts) with a documented seam for a
// live weather/climate-normals API. Month is an INPUT → deterministic/testable.
//
// Generic homeowner guidance only (no protected-class signal).

import { deriveClimate, type ClimateZone, type Hemisphere } from "./climate"

export type Season = "spring" | "summer" | "fall" | "winter"

export type VendorCategory =
  | "hvac"
  | "roofing"
  | "gutters"
  | "plumbing"
  | "electrical"
  | "landscaping"
  | "pest_control"
  | "painting"
  | "chimney"
  | "general_handyman"

export interface MaintenanceSuggestion {
  key: string
  title: string
  why: string
  vendorCategory: VendorCategory
  season: Season | "anytime"
  /** 1 = do soon, 2 = this season, 3 = nice to have. */
  priority: number
}

export interface MaintenanceInput {
  /** 1–12 (resolved by the caller; keeps this pure/testable). */
  month: number
  /** Whole years owned, when known (drives tenure-based, lifespan suggestions). */
  yearsHeld?: number | null
  /** Lowercased vendor-category strings present in the brokerage marketplace. */
  availableVendorCategories?: string[] | null
  /** The home's location string (address) — derives hemisphere + climate zone. */
  location?: string | null
}

export function seasonForMonth(month: number, hemisphere: Hemisphere = "north"): Season {
  const m = ((Math.trunc(month) - 1) % 12 + 12) % 12 + 1 // clamp to 1..12
  // Northern-hemisphere mapping; the Southern hemisphere is offset by 6 months.
  const effective = hemisphere === "south" ? ((m + 6 - 1) % 12) + 1 : m
  if (effective >= 3 && effective <= 5) return "spring"
  if (effective >= 6 && effective <= 8) return "summer"
  if (effective >= 9 && effective <= 11) return "fall"
  return "winter"
}

const SEASONAL: Record<Season, MaintenanceSuggestion[]> = {
  spring: [
    { key: "spring_hvac", title: "Service your A/C before summer", why: "A spring tune-up keeps cooling efficient and catches problems before the first heat wave.", vendorCategory: "hvac", season: "spring", priority: 1 },
    { key: "spring_gutters", title: "Clean gutters & downspouts", why: "Spring rain needs somewhere to go — clear gutters protect your roof and foundation.", vendorCategory: "gutters", season: "spring", priority: 2 },
    { key: "spring_landscaping", title: "Refresh the yard & trim back growth", why: "Early-season cleanup boosts curb appeal and keeps growth off siding and the roofline.", vendorCategory: "landscaping", season: "spring", priority: 3 },
  ],
  summer: [
    { key: "summer_pest", title: "Schedule a pest inspection", why: "Summer is peak activity for ants, wasps, and termites — an inspection now prevents bigger problems.", vendorCategory: "pest_control", season: "summer", priority: 2 },
    { key: "summer_paint", title: "Tackle exterior paint or touch-ups", why: "Warm, dry weather is ideal for exterior paint that actually lasts.", vendorCategory: "painting", season: "summer", priority: 3 },
    { key: "summer_roof", title: "Get a roof check after spring storms", why: "Catch loose or damaged shingles before fall rains arrive.", vendorCategory: "roofing", season: "summer", priority: 2 },
  ],
  fall: [
    { key: "fall_heating", title: "Service your furnace before winter", why: "A fall tune-up keeps heat reliable and safe through the cold months.", vendorCategory: "hvac", season: "fall", priority: 1 },
    { key: "fall_gutters", title: "Clear gutters after the leaves drop", why: "Clogged gutters cause ice dams and water damage — clear them before the freeze.", vendorCategory: "gutters", season: "fall", priority: 2 },
    { key: "fall_chimney", title: "Have the chimney swept & inspected", why: "If you use a fireplace, a fall sweep prevents chimney fires and carbon-monoxide risk.", vendorCategory: "chimney", season: "fall", priority: 2 },
  ],
  winter: [
    { key: "winter_plumbing", title: "Insulate pipes against freezing", why: "A small step now avoids a burst-pipe emergency during a cold snap.", vendorCategory: "plumbing", season: "winter", priority: 1 },
    { key: "winter_electrical", title: "Check detectors & winter electrical load", why: "Test smoke/CO detectors and make sure heaters aren't overloading circuits.", vendorCategory: "electrical", season: "winter", priority: 2 },
    { key: "winter_handyman", title: "Seal drafts around doors & windows", why: "Sealing gaps cuts heating bills and keeps the home comfortable.", vendorCategory: "general_handyman", season: "winter", priority: 3 },
  ],
}

// Climate-specific suggestions layered onto the seasonal base. Warm/tropical
// homes don't freeze (drop pipe-insulation) but bake (A/C first) and host pests
// year-round; coastal homes need storm readiness; cold homes lean into heating.
function climateSuggestions(season: Season, zone: ClimateZone, stormExposed: boolean): MaintenanceSuggestion[] {
  const out: MaintenanceSuggestion[] = []
  const warmish = zone === "warm" || zone === "tropical"

  if (warmish) {
    // A/C is the priority system in hot climates — surface it most of the year.
    if (season === "spring" || season === "summer") {
      out.push({ key: "warm_ac_priority", title: "Service your A/C now — beat the heat", why: "In a hot climate your cooling system works hardest; a tune-up before peak heat prevents a mid-summer failure.", vendorCategory: "hvac", season, priority: 1 })
    }
    // Pests stay active year-round in warm/tropical zones.
    out.push({ key: "warm_pest_yearround", title: "Stay ahead of year-round pests", why: "Warm climates keep insects and rodents active all year — a regular pest plan beats a seasonal one.", vendorCategory: "pest_control", season, priority: 2 })
  }

  if (stormExposed && (season === "summer" || season === "fall")) {
    out.push({ key: "storm_readiness", title: "Prep the home for storm season", why: "In a coastal/hurricane-exposed area, secure the roof, clear drains, and check seals before peak storm months.", vendorCategory: "roofing", season, priority: 1 })
  }

  if (zone === "cold" && season === "winter") {
    out.push({ key: "cold_roof_snow", title: "Watch for ice dams & roof load", why: "In a cold climate, ice dams and heavy snow can damage the roof — keep gutters clear and watch buildup.", vendorCategory: "roofing", season, priority: 1 })
  }

  return out
}

/** Tenure-based, lifespan-driven suggestions (appended when ownership crosses typical service windows). */
function tenureSuggestions(yearsHeld: number): MaintenanceSuggestion[] {
  const out: MaintenanceSuggestion[] = []
  if (yearsHeld >= 8) {
    out.push({ key: "tenure_water_heater", title: "Have your water heater checked", why: `You've owned for ${yearsHeld} years — typical water heaters last ~10–12, so a check now avoids a surprise failure.`, vendorCategory: "plumbing", season: "anytime", priority: 2 })
  }
  if (yearsHeld >= 12) {
    out.push({ key: "tenure_roof", title: "Consider a roof condition assessment", why: `At ${yearsHeld} years of ownership it's worth knowing your roof's remaining life before it becomes urgent.`, vendorCategory: "roofing", season: "anytime", priority: 2 })
  }
  if (yearsHeld >= 10) {
    out.push({ key: "tenure_hvac", title: "Plan ahead for HVAC replacement", why: `Systems often run 10–15 years — a check-up now helps you budget instead of scramble.`, vendorCategory: "hvac", season: "anytime", priority: 3 })
  }
  return out
}

/** Does the brokerage marketplace have a vendor whose category matches this job? */
export function hasVendorFor(category: VendorCategory, available?: string[] | null): boolean {
  if (!available || available.length === 0) return false
  const needle = category.replace(/_/g, " ")
  const alt = category.replace(/_/g, "")
  return available.some((c) => {
    const s = (c ?? "").toLowerCase()
    return s.includes(needle) || s.includes(alt) || needle.includes(s) || s.includes(category)
  })
}

export interface MaintenanceDeck {
  season: Season
  /** Climate zone the deck was tailored to ('temperate' when location unknown). */
  zone: ClimateZone
  /** Region resolved from the location (e.g. a US state), for "tailored to {region}" copy. */
  region: string | null
  suggestions: MaintenanceSuggestion[]
}

export function maintenanceDeck(input: MaintenanceInput): MaintenanceDeck {
  const climate = deriveClimate(input.location)
  const season = seasonForMonth(input.month, climate.hemisphere)
  const warmish = climate.zone === "warm" || climate.zone === "tropical"

  // Seasonal base — but drop pipe-freeze guidance where it never freezes.
  const seasonal = SEASONAL[season].filter(
    (s) => !(warmish && s.key === "winter_plumbing"),
  )
  const climateExtra = climateSuggestions(season, climate.zone, climate.stormExposed)
  const tenure = input.yearsHeld && input.yearsHeld > 0 ? tenureSuggestions(Math.floor(input.yearsHeld)) : []

  // Climate-specific items first (most location-relevant), then seasonal, then tenure.
  const merged: MaintenanceSuggestion[] = [...climateExtra, ...seasonal, ...tenure]
  const seen = new Set<string>()
  const deduped = merged.filter((s) => (seen.has(s.key) ? false : (seen.add(s.key), true)))
  deduped.sort((a, b) => a.priority - b.priority)

  return { season, zone: climate.zone, region: climate.region, suggestions: deduped.slice(0, 5) }
}
