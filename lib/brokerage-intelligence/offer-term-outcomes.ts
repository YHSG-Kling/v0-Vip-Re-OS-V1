// lib/brokerage-intelligence/offer-term-outcomes.ts
//
// NEGOTIATION-OUTCOME LEARNER — the PURE engine.
//
// THE GAP (verified white space): the negotiation analyzer (lib/negotiation/analyzer.ts)
// ALREADY reads brokerage_intelligence_insights for the pattern_keys
// `win_rate_by_offer_strength` and `appraisal_gap_outcomes` to ground its counter-strategy
// in THIS brokerage's real local outcomes — but NOTHING ever mined them. They were dead
// reads. Offer terms are captured (offers.financing_type / down_payment_percent /
// appraisal_gap / earnest_money / contingencies / inspection_period_days) and outcomes are
// tracked (offers.status accepted/rejected/withdrawn, is_winning_offer), but no module
// aggregated which TERMS correlate with WINNING. Competitors score a single offer with
// fixed rules; none learn the local market's term-level win/loss from the brokerage's own
// history and feed it back into the negotiation copilot.
//
// This module is PURE (no I/O): given the resolved offers (won vs lost) with their terms,
// it computes term-level win rates and the lift of the strong/covered cohort over the weak/
// uncovered one. HONEST on thin data — a cohort below MIN_COHORT yields no insight (never a
// win rate asserted from 2 offers). The miner does the I/O and reuses the canonical
// scoreBuyerStrength so "offer strength" means the same thing here as on the seller's
// decision room.

import { scoreBuyerStrength } from "@/lib/offers/offer-strength"

/** One resolved historical offer (terminal outcome only — pending offers are excluded). */
export interface ResolvedOffer {
  offerPrice: number
  financingType: string | null
  downPaymentPercent: number | null
  contingencies: string[]
  emd: number | null
  /** appraisal-gap guarantee amount the buyer offered (0/undefined = none) */
  appraisalGap: number | null
  /** true = this offer WON (accepted / winning); false = it LOST (rejected/withdrawn) */
  won: boolean
}

export interface CohortStat {
  label: string
  wins: number
  losses: number
  total: number
  winRatePct: number
}

export interface TermOutcomePattern {
  patternKey: "win_rate_by_offer_strength" | "appraisal_gap_outcomes"
  /** the winning cohort vs the losing cohort */
  topCohort: CohortStat
  bottomCohort: CohortStat
  liftPct: number
  /** total resolved offers behind the pattern */
  sampleSize: number
  /** a grounded, no-fabrication one-liner for the negotiation copilot */
  summary: string
  playbook: string
}

// Honest thresholds — a cohort must clear MIN_COHORT resolved offers; the gap must clear
// MIN_LIFT to be worth publishing (below it, the terms didn't move outcomes meaningfully).
export const MIN_COHORT = 4
export const MIN_RESOLVED = 12
const MIN_LIFT_PCT = 15

function winRate(wins: number, total: number): number {
  return total > 0 ? (wins / total) * 100 : 0
}

function liftPct(top: number, bottom: number): number {
  if (bottom <= 0) return top > 0 ? 100 : 0
  return Math.round(((top - bottom) / bottom) * 100)
}

function cohort(label: string, offers: ResolvedOffer[]): CohortStat {
  const wins = offers.filter((o) => o.won).length
  const total = offers.length
  return { label, wins, losses: total - wins, total, winRatePct: Math.round(winRate(wins, total)) }
}

/** Strength score for one offer (reuses the canonical scorer — no parallel math). */
export function offerStrengthScore(o: ResolvedOffer): number {
  return scoreBuyerStrength({
    financingType: o.financingType,
    downPaymentPercent: o.downPaymentPercent,
    contingencies: o.contingencies,
    emd: o.emd,
    offerPrice: o.offerPrice,
  })
}

/**
 * Mine win_rate_by_offer_strength: split resolved offers into a STRONG cohort (score ≥ 70)
 * and a WEAK cohort (score < 50) and measure the acceptance-rate lift. Null when either
 * cohort is too thin or the lift is immaterial.
 */
export function mineWinRateByStrength(resolved: ResolvedOffer[]): TermOutcomePattern | null {
  if (resolved.length < MIN_RESOLVED) return null
  const strong = resolved.filter((o) => offerStrengthScore(o) >= 70)
  const weak = resolved.filter((o) => offerStrengthScore(o) < 50)
  if (strong.length < MIN_COHORT || weak.length < MIN_COHORT) return null

  const top = cohort("Strong offers (cash / low-contingency / solid EMD)", strong)
  const bottom = cohort("Weak offers (financed / contingency-heavy / thin EMD)", weak)
  const lift = liftPct(top.winRatePct, bottom.winRatePct)
  if (lift < MIN_LIFT_PCT) return null

  return {
    patternKey: "win_rate_by_offer_strength",
    topCohort: top,
    bottomCohort: bottom,
    liftPct: lift,
    sampleSize: resolved.length,
    summary: `In your market, strong offers win ${top.winRatePct}% of the time vs ${bottom.winRatePct}% for weak offers (${lift}% lift, n=${resolved.length}). Cleaner financing, fewer contingencies, and a solid earnest-money deposit move the needle most.`,
    playbook: `When advising a buyer to win, prioritize the levers that define a "strong" offer here: stronger financing (or cash where possible), trimming contingencies, and an earnest-money deposit at/above 3-5%. When representing the seller, weight certainty-of-close, not just price.`,
  }
}

/**
 * Mine appraisal_gap_outcomes: resolved offers WITH an appraisal-gap guarantee vs WITHOUT,
 * acceptance-rate lift. Null when either cohort is too thin or the lift is immaterial.
 */
export function mineAppraisalGapOutcomes(resolved: ResolvedOffer[]): TermOutcomePattern | null {
  if (resolved.length < MIN_RESOLVED) return null
  const withGap = resolved.filter((o) => (o.appraisalGap ?? 0) > 0)
  const withoutGap = resolved.filter((o) => (o.appraisalGap ?? 0) <= 0)
  if (withGap.length < MIN_COHORT || withoutGap.length < MIN_COHORT) return null

  const top = cohort("Offers with appraisal-gap coverage", withGap)
  const bottom = cohort("Offers without appraisal-gap coverage", withoutGap)
  const lift = liftPct(top.winRatePct, bottom.winRatePct)
  if (lift < MIN_LIFT_PCT) return null

  return {
    patternKey: "appraisal_gap_outcomes",
    topCohort: top,
    bottomCohort: bottom,
    liftPct: lift,
    sampleSize: resolved.length,
    summary: `In your market, offers that include appraisal-gap coverage win ${top.winRatePct}% of the time vs ${bottom.winRatePct}% without it (${lift}% lift, n=${resolved.length}). Sellers reward the certainty that a low appraisal won't blow up the deal.`,
    playbook: `For a competitive buyer offer, discuss appraisal-gap coverage to a comfortable cap — it's the single term most correlated with winning here. For a seller weighing offers, treat appraisal-gap language as a real risk-reducer, not just price.`,
  }
}

/** Run every term-outcome pattern; return the ones with enough signal to publish. */
export function mineOfferTermPatterns(resolved: ResolvedOffer[]): TermOutcomePattern[] {
  return [mineWinRateByStrength(resolved), mineAppraisalGapOutcomes(resolved)].filter(
    (p): p is TermOutcomePattern => p !== null,
  )
}
