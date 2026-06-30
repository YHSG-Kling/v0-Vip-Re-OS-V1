// ─── HOMEOWNERSHIP MAINTENANCE SUGGESTIONS ───────────────────────────────────
// Pure, import-free engine behind the lifetime portal's maintenance card: given
// the current month, how long they've owned, and which vendor categories their
// agent actually has in the marketplace, it returns a prioritized, SEASONAL set
// of upkeep suggestions — each tagged with the vendor category that does the job,
// so the card can surface a real "request an intro" to a trusted local pro.
//
// Generic homeowner guidance only (no protected-class signal). The month is an
// INPUT (resolved by the server component) so this stays deterministic/testable.

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
}

export function seasonForMonth(month: number): Season {
  const m = ((Math.trunc(month) - 1) % 12 + 12) % 12 + 1 // clamp to 1..12
  if (m >= 3 && m <= 5) return "spring"
  if (m >= 6 && m <= 8) return "summer"
  if (m >= 9 && m <= 11) return "fall"
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
  suggestions: MaintenanceSuggestion[]
}

export function maintenanceDeck(input: MaintenanceInput): MaintenanceDeck {
  const season = seasonForMonth(input.month)
  const seasonal = SEASONAL[season]
  const tenure = input.yearsHeld && input.yearsHeld > 0 ? tenureSuggestions(Math.floor(input.yearsHeld)) : []

  // Merge, dedupe by vendorCategory+key, sort by priority then keep it short.
  const merged: MaintenanceSuggestion[] = [...seasonal, ...tenure]
  const seen = new Set<string>()
  const deduped = merged.filter((s) => (seen.has(s.key) ? false : (seen.add(s.key), true)))
  deduped.sort((a, b) => a.priority - b.priority)

  return { season, suggestions: deduped.slice(0, 5) }
}
