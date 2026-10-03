// lib/property/neighborhood-scoring.ts
// Pure neighborhood scoring + Fair-Housing-safe text helpers. No network, no
// server-only imports — unit-testable directly (and importable from the simulator).
// The async report orchestration lives in neighborhood-intelligence.ts.

import type { OSINTNeighborhoodData } from "@/lib/external/osint-neighborhood"

// ── TIER PARITY (owner ruling) ───────────────────────────────────────────────
// Neighborhood intelligence used to be gated to `brokerage` / `multi_location`
// — "the most advanced AI plans". OWNER, verbatim: "brokerages can have teams
// and agents but that is the brokerage tier. when we have the team and solo
// agent subscription tiers, those subscriptions get the same level of features
// as brokerages." Tiers differ by SEAT COUNT, not by feature set, so a solo
// agent listing a house gets the same neighborhood report a brokerage's agent
// does. The AI cost of producing it is platform-covered with per-tier overage
// (CLAUDE.md §5) — that is the lever that scales with plan, not this gate.
//
// The `ALLOWED_TIERS` set that lived here is DELETED rather than widened to all
// four names: a set every value satisfies is a set with no reader, and leaving
// it would read as a live restriction to the next lane (CLAUDE.md §1). The tier
// ARGUMENT stays — callers still pass what they read, the canonical vocabulary
// is unchanged, and a future CAPACITY rule (not a capability rule) has a place
// to land. An unknown / NULL tier passes too: a tenant whose plan_tier was
// never backfilled is on SOME plan, and every plan includes this.
//
// The gate itself survives at app/actions/neighborhood-reports.ts:185, which is
// the one caller.

/** True on every plan — see the parity note above. */
export function isNeighborhoodReportAllowed(planTier: string | null | undefined): boolean {
  void planTier
  return true
}

export interface LivabilityResult {
  score: number // 0..100
  label: "Highly walkable" | "Moderately walkable" | "Car-dependent" | "Limited data"
  factors: string[]
}

/**
 * Deterministic walkability/livability score from amenity presence + proximity.
 * Daily-need categories (grocery, transit) get a proximity bonus when very close.
 */
export function computeLivabilityScore(osint: OSINTNeighborhoodData): LivabilityResult {
  if (osint.dataSource === "none" || (osint.lat == null && osint.lon == null)) {
    return { score: 0, label: "Limited data", factors: [] }
  }
  const a = osint.amenities
  const factors: string[] = []
  let score = 0

  const categories: Array<[keyof typeof a, string]> = [
    ["restaurants", "dining"],
    ["grocery", "grocery"],
    ["parks", "parks"],
    ["schools", "schools"],
    ["transit", "transit"],
  ]
  for (const [key, label] of categories) {
    if (a[key].length > 0) {
      score += 12
      factors.push(`${a[key].length} ${label} within 1km`)
    }
  }

  // Proximity bonus for daily needs (nearest entry is the closest after the sort).
  for (const key of ["grocery", "transit"] as const) {
    const nearest = a[key][0]?.distance
    if (typeof nearest === "number" && nearest < 500) score += 8
  }

  // Density bonus, capped.
  const total = (Object.keys(a) as Array<keyof typeof a>).reduce((n, k) => n + a[k].length, 0)
  score += Math.min(total, 24)

  score = Math.max(0, Math.min(100, score))
  const label: LivabilityResult["label"] =
    score >= 75 ? "Highly walkable" : score >= 50 ? "Moderately walkable" : score >= 25 ? "Car-dependent" : "Limited data"
  return { score, label, factors }
}

/** Build a compact, fact-only block for grounding the AI narrative. */
export function assembleFactsBlock(osint: OSINTNeighborhoodData, liv: LivabilityResult): string {
  const a = osint.amenities
  const lines: string[] = [`Walkability score: ${liv.score}/100 (${liv.label}).`]
  const nearest = (k: keyof typeof a) => (a[k][0] ? `${a[k][0].name} (${a[k][0].distance}m)` : "none nearby")
  lines.push(`Nearest grocery: ${nearest("grocery")}.`)
  lines.push(`Nearest transit: ${nearest("transit")}.`)
  lines.push(`Parks within 1km: ${a.parks.length}. Schools within 1km: ${a.schools.length}. Dining options: ${a.restaurants.length}.`)
  if (osint.censusMedianHomeValue) lines.push(`US Census median owner-occupied home value: $${osint.censusMedianHomeValue.toLocaleString()}.`)
  return lines.join(" ")
}

/**
 * A purely factual narrative built from amenity counts — contains no protected-class
 * or steering language, so it is the safe fallback when the AI output fails the
 * Fair-Housing check.
 */
export function factualNarrative(osint: OSINTNeighborhoodData, liv: LivabilityResult): string {
  const a = osint.amenities
  const parts: string[] = [
    `This location scores ${liv.score}/100 for walkability (${liv.label.toLowerCase()}).`,
  ]
  if (a.grocery[0]) parts.push(`The nearest grocery is ${a.grocery[0].distance} meters away.`)
  if (a.transit.length) parts.push(`There ${a.transit.length === 1 ? "is" : "are"} ${a.transit.length} transit stop${a.transit.length === 1 ? "" : "s"} within walking distance.`)
  if (a.parks.length) parts.push(`${a.parks.length} park${a.parks.length === 1 ? "" : "s"} and ${a.restaurants.length} dining option${a.restaurants.length === 1 ? "" : "s"} are within 1 km.`)
  if (osint.censusMedianHomeValue) parts.push(`The Census median home value for this ZIP is $${osint.censusMedianHomeValue.toLocaleString()}.`)
  return parts.join(" ")
}
