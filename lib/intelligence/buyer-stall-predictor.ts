// lib/intelligence/buyer-stall-predictor.ts
//
// BUYER-STALL PREDICTOR (pure) — the buyer-side counterpart to the listing-stall predictor. A buyer
// who's toured many homes over weeks and still hasn't written an offer is quietly at risk: fatigue,
// price expectations that don't match the market, indecision — and the very real danger of drifting
// to another agent. A great buyer's agent FEELS this and resets the conversation. This reads the real
// signals (tour volume + momentum, offers written, time active) and decides the Shopping Agent's play
// — recalibrate expectations, re-energize with fresh matches, or hold. Pure (no I/O), unit-tested.

export type BuyerStallRisk = "none" | "watch" | "elevated" | "high"
export type BuyerPlay = "recalibrate" | "re_energize" | "hold" | null

export interface BuyerStallInput {
  /** total tours/showings the buyer has attended. */
  toursTotal: number
  /** tours in the last 30 days and the 30 before (to detect momentum loss). */
  toursLast30: number
  toursPrev30: number
  /** offers the buyer has written. */
  offersMade: number
  /** days since their first tour (how long they've been actively looking). */
  daysSinceFirstTour: number
}

export interface BuyerStallPrediction {
  risk: BuyerStallRisk
  /** elevated or high — worth a Shopping Agent play now. */
  willStall: boolean
  reasons: string[]
  recommendedPlay: BuyerPlay
}

const MANY_TOURS = 6       // touring a lot…
const LONG_SEARCH = 30     // …over a long stretch…
const FATIGUE_TOURS = 10   // …or an unusually high tour count outright.

/** Predict whether an active buyer is stalling, and the play to run. Pure. */
export function predictBuyerStall(input: BuyerStallInput): BuyerStallPrediction {
  const reasons: string[] = []
  let score = 0

  const tours = Math.max(0, input.toursTotal ?? 0)
  const noOffers = (input.offersMade ?? 0) === 0

  // 1. Lots of touring, no offers, over a long stretch → expectations/decision problem. This is the
  //    buyer-stall signature on its own (elevated), independent of momentum.
  if (noOffers && tours >= MANY_TOURS && input.daysSinceFirstTour >= LONG_SEARCH) {
    score += 4; reasons.push(`${tours} tours over ${input.daysSinceFirstTour}d with no offer written`)
  } else if (noOffers && tours >= FATIGUE_TOURS) {
    score += 4; reasons.push(`${tours} tours and still no offer — likely fatigue or expectations`)
  } else if (noOffers && tours >= MANY_TOURS) {
    score += 2; reasons.push(`${tours} tours, no offer yet`)
  }

  // 2. Tour momentum dropping off — losing interest or drifting away.
  const declined = input.toursPrev30 > 0 && input.toursLast30 < input.toursPrev30 * 0.5
  if (declined) { score += 2; reasons.push(`touring slowed (${input.toursPrev30} → ${input.toursLast30} in the last two months)`) }
  const wentCold = input.daysSinceFirstTour >= LONG_SEARCH && input.toursLast30 === 0
  if (wentCold) { score += 2; reasons.push("no tours in the last month") }

  const risk: BuyerStallRisk = score >= 6 ? "high" : score >= 4 ? "elevated" : score >= 2 ? "watch" : "none"
  const willStall = risk === "elevated" || risk === "high"

  // The play: still touring but no offers → recalibrate expectations/criteria. Touring dried up →
  // re-energize with fresh matches. Healthy/new → hold.
  let recommendedPlay: BuyerPlay = null
  if (willStall) {
    const stillTouring = input.toursLast30 >= 2 && !wentCold
    recommendedPlay = stillTouring && noOffers ? "recalibrate"
      : (declined || wentCold) ? "re_energize"
      : "recalibrate"
  } else if (risk === "watch") {
    recommendedPlay = "hold"
  }

  return { risk, willStall, reasons, recommendedPlay }
}
