// lib/kernel/listing-price-advisor.ts
//
// PRICE-DROP PRE-EMPTOR (the genuine delta) — detection of a stale/underperforming listing ALREADY
// exists (pattern-detector 'price_reduction_likely' + listing-health DOM/showings scoring). What was
// MISSING is the RECOMMENDATION: a suggested new price anchored to comps + DOM pressure + showing
// velocity, with the justification, so the Listing Concierge can propose the (gated) seller
// conversation BEFORE the listing goes stale. This is that engine — PURE, composes existing signals,
// recommends a price ONLY when the data supports it (never below comps; honest when price isn't the
// problem). Caller passes the already-computed signals (DOM, showings, comp median).

export interface PriceDropInput {
  listPrice: number
  daysOnMarket: number
  /** Showings in the last 14 days. */
  showingsRecent: number
  /** Showings in the prior 14 days (for the velocity trend). */
  showingsPrior: number
  /** Adjusted comp median from the CMA/AVM engine (null when unavailable). */
  compMedian?: number | null
}

export interface PriceDropRecommendation {
  recommend: boolean
  currentPrice: number
  recommendedPrice: number | null
  dropAmount: number | null
  /**
   * PERCENT value, one decimal — 5.0 means a 5% cut. Matches the repo convention
   * for stored rates (listing_agreements stores 3 for 3%). It previously returned
   * the raw fraction under this name, so the first consumer rendered "0.05%".
   */
  dropPct: number | null
  justification: string[]
  confidence: "low" | "medium" | "high"
  reason: string
}

const round1k = (n: number) => Math.round(n / 1000) * 1000

/** DOM-pressure drop percent — the longer it sits, the bigger the corrective move. */
function domDropPct(dom: number): number {
  if (dom >= 90) return 0.06
  if (dom >= 60) return 0.04
  if (dom >= 45) return 0.03
  return 0.02 // 30–44d
}

/**
 * Pure: recommend a price reduction when a stale listing's data supports it. Anchors to comps
 * (never recommends dropping below the comp median), scales the cut by DOM + low showing velocity,
 * and HONESTLY declines when the listing is priced in line with comps (the problem is exposure /
 * condition, not price) or isn't stale yet.
 */
export function computePriceDropRecommendation(input: PriceDropInput): PriceDropRecommendation {
  const currentPrice = input.listPrice
  const noRec = (reason: string): PriceDropRecommendation => ({
    recommend: false, currentPrice, recommendedPrice: null, dropAmount: null, dropPct: null,
    justification: [], confidence: "low", reason,
  })

  if (input.daysOnMarket < 30) return noRec("Not stale yet (under 30 days on market) — hold the price.")

  const overComps = input.compMedian != null && currentPrice > input.compMedian * 1.02
  if (input.compMedian != null && !overComps) {
    return noRec("Priced in line with comparable sales — the issue is exposure or condition, not price. Refresh photos/marketing before cutting.")
  }

  // DOM-driven cut, nudged up when showings are very cold.
  let dropPct = domDropPct(input.daysOnMarket)
  const coolingVelocity = input.showingsRecent <= 1 || input.showingsRecent < input.showingsPrior
  if (input.showingsRecent <= 1) dropPct += 0.01

  const candidate = currentPrice * (1 - dropPct)
  // Never recommend below the comp median (comps are the floor).
  const recommendedPrice = round1k(input.compMedian != null ? Math.max(input.compMedian, candidate) : candidate)
  const dropAmount = currentPrice - recommendedPrice

  if (dropAmount <= 0) return noRec("Comp-anchored target is at or above the current price — no reduction warranted.")

  const justification: string[] = [
    `${input.daysOnMarket} days on market (well past the ${30}-day mark).`,
    coolingVelocity
      ? `Showing activity is cooling (${input.showingsRecent} in the last 14 days vs ${input.showingsPrior} before).`
      : `Showing activity is low (${input.showingsRecent} in the last 14 days).`,
    input.compMedian != null
      ? `Listed ${Math.round(((currentPrice - input.compMedian) / input.compMedian) * 100)}% above the comp median ($${round1k(input.compMedian).toLocaleString()}).`
      : `No comp median available — recommendation is DOM/velocity-based only.`,
  ]
  const confidence: PriceDropRecommendation["confidence"] =
    input.compMedian != null && input.daysOnMarket >= 60 ? "high" : input.compMedian != null ? "medium" : "low"

  return {
    recommend: true, currentPrice, recommendedPrice, dropAmount,
    dropPct: Math.round((dropAmount / currentPrice) * 1000) / 10, justification, confidence,
    reason: `Recommend reducing to $${recommendedPrice.toLocaleString()} (−$${dropAmount.toLocaleString()}) to reactivate buyer interest.`,
  }
}
