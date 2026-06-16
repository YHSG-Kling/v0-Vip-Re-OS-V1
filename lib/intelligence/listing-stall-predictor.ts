// lib/intelligence/listing-stall-predictor.ts
//
// LISTING-STALL PREDICTOR (pure) — relist_recovery catches a listing AFTER it expired without
// selling; this catches it BEFORE. A great listing agent feels a stall coming: days on market past
// the area's pace, showings drying up, no offers. This reads those real signals and predicts the
// stall early enough to DO something — a marketing refresh while there's still time, or a price
// conversation before the listing goes stale in buyers' minds. The Listing Concierge runs the play
// (gated), so it's the team getting ahead of a problem, not reacting to one. Pure (no I/O), tested.

export type StallRisk = "none" | "watch" | "elevated" | "high"
export type StallPlay = "marketing_refresh" | "price_strategy" | "hold" | null

export interface ListingStallInput {
  daysOnMarket: number
  /** the local benchmark (area median DOM); null → use a conservative default. */
  areaMedianDom: number | null
  /** showings in the last 14 days and the 14 before that (to detect decline). */
  showingsLast14: number
  showingsPrev14: number
  /** offers received to date. */
  offers: number
}

export interface ListingStallPrediction {
  risk: StallRisk
  /** elevated or high — worth a manager play now. */
  willStall: boolean
  reasons: string[]
  recommendedPlay: StallPlay
}

const DEFAULT_MEDIAN_DOM = 30 // a conservative national-ish default when no area benchmark is known.

/** Predict whether an active listing is heading for a stall, and the play to run. Pure. */
export function predictListingStall(input: ListingStallInput): ListingStallPrediction {
  const reasons: string[] = []
  let score = 0

  const median = input.areaMedianDom && input.areaMedianDom > 0 ? input.areaMedianDom : DEFAULT_MEDIAN_DOM
  const ratio = input.daysOnMarket / median

  // 1. Days on market vs the area's pace.
  if (ratio >= 1.5) { score += 3; reasons.push(`${input.daysOnMarket}d on market — well past the area's ~${median}d pace`) }
  else if (ratio >= 1.0) { score += 2; reasons.push(`${input.daysOnMarket}d on market — at/over the area's ~${median}d pace`) }
  else if (ratio >= 0.7) { score += 1 }

  // 2. Showing momentum — is interest drying up?
  const declined = input.showingsPrev14 > 0 && input.showingsLast14 < input.showingsPrev14 * 0.5
  if (declined) { score += 2; reasons.push(`showings fell off (${input.showingsPrev14} → ${input.showingsLast14} in the last two weeks)`) }
  const cold = input.daysOnMarket >= 21 && input.showingsLast14 <= 1
  if (cold) { score += 2; reasons.push(`showings have gone cold (${input.showingsLast14} in the last two weeks)`) }

  // 3. No offers while time passes.
  if (input.offers === 0 && input.daysOnMarket >= median) { score += 2; reasons.push("no offers yet despite time on market") }

  const risk: StallRisk = score >= 6 ? "high" : score >= 4 ? "elevated" : score >= 2 ? "watch" : "none"
  const willStall = risk === "elevated" || risk === "high"

  // The play: showings still happening but no offers → it's priced wrong (price_strategy). Showings
  // drying up → it's a visibility problem (marketing_refresh). Healthy → hold.
  let recommendedPlay: StallPlay = null
  if (willStall) {
    const showingsHealthy = input.showingsLast14 >= 2 && !declined
    recommendedPlay = showingsHealthy && input.offers === 0 ? "price_strategy"
      : (declined || cold) ? "marketing_refresh"
      : "price_strategy"
  } else if (risk === "watch") {
    recommendedPlay = "hold"
  }

  return { risk, willStall, reasons, recommendedPlay }
}
