/**
 * CMA COMP ADJUSTMENTS — the appraisal-style grid + reconciliation layer.
 *
 * Owner ruling (wave 70, verbatim): "comps for sold were being pulled from
 * rentcast … I guess it wouldn't hurt to also add comps from batchdata to help
 * with the ai to analyze for cma's but need to best output for property
 * appraisal adjusted comps without high costs."
 *
 * ─── HOW THIS RELATES TO lib/cma/state-adjustment-rates.ts — NOT A DUPLICATE ──
 * `computeCompAdjustments` in state-adjustment-rates.ts already exists and is
 * wired: it reads a DB-backed, per-STATE, per-VINTAGE rate table
 * (state_appraiser_adjustment_rates) and persists its output to
 * cma_price_adjustments / cma_comparables. That module owns sqft/beds/baths/
 * garage/pool/lot/age/condition/time-of-sale for the PERSISTED, state-sourced
 * adjustment record, and this file does not re-implement or replace it — see
 * the orphan doctrine (CLAUDE.md §1): the capability already lives there.
 *
 * What state-adjustment-rates.ts does NOT do, and what the owner's ruling above
 * calls for, is the missing half this file builds:
 *   1. A DISTANCE/LOCATION line item — no adjustment type in the DB rate table
 *      covers proximity to the subject at all.
 *   2. GROSS vs NET adjustment, computed and reported separately (the
 *      orchestrator's `totalAdjustmentPct` is net-only — signed adjustments
 *      cancel out, which is exactly how a comp with big offsetting errors reads
 *      as "well-matched" when it is not).
 *   3. A "WEAK COMP" flag, per common appraisal guidance (Fannie Mae Selling
 *      Guide B4-1.3-09 "Adjustments to Comparable Sales": a gross adjustment
 *      over ~25% of sale price, or a net adjustment over ~15%, calls for the
 *      analysis to say the comp is a weak basis rather than let it silently
 *      pull the range).
 *   4. A RECONCILED value range, weighted so a comp that needed heavy surgery
 *      to match the subject counts for less than one that needed almost none —
 *      "reconciliation" being the appraisal term (URAR / USPAP sales-comparison
 *      approach) for turning several adjusted comp values into one supportable
 *      conclusion, which nothing in this codebase computed before this file.
 *
 * This module is DELIBERATELY PURE — no database read, no network call, no
 * `server-only` import. It runs synchronously on the comp rows and subject
 * features the caller already has (whichever provider sourced them — RentCast,
 * BatchData, or IDX), and it never blocks on, or requires, the state rate table
 * being loaded. That is what lets it run identically whether or not a state's
 * vintage table has been seeded, and what makes it independently testable
 * (scripts/comp-adjustments-simulator.ts) without a service-role DB client.
 *
 * ─── PER-LINE-ITEM RATE BASIS, AND WHERE EACH FIGURE CAME FROM ────────────────
 * Every constant below is a documented, common-appraisal RULE OF THUMB, not an
 * invented number — appraisal practice does not publish one universal figure
 * (adjustments are properly derived per-market from paired-sales analysis), so
 * these are conservative, widely-cited defaults used only as a CROSS-CHECK
 * layer alongside — never instead of — the state-specific rates:
 *
 *   sqft_living  — uses the COMP'S OWN price-per-sqft (comp.pricePerSqft) as the
 *                  rate, rather than a flat dollar figure: this is the standard
 *                  "market-derived $/sqft" convention in the sales-comparison
 *                  approach (Appraisal Institute, "The Appraisal of Real
 *                  Estate"), and it auto-scales with the local market the same
 *                  way the state engine's pct_of_comp_price basis does.
 *   bedroom      — $2,500/bedroom. Common industry rule-of-thumb range is
 *                  $2,000–$5,000; the low-mid of that range is used to avoid
 *                  overstating a single line.
 *   full_bath / half_bath — $5,000 / $2,500. Common rule-of-thumb range for a
 *                  full bath is $3,000–$7,500; half bath conventionally prices
 *                  at half the full-bath figure.
 *   garage_space — $4,000/space. Common rule-of-thumb range $3,000–$6,000.
 *   pool         — $12,000 flat, in-ground only. Common rule-of-thumb range
 *                  $10,000–$15,000; regional and highly pool-market-dependent.
 *   year_built   — 0.30% of comp price per year of age difference (effective-
 *                  age depreciation convention, common range 0.25%–0.5%/yr).
 *   lot_size     — $10,000/acre difference. Highly variable by market; used
 *                  only as a conservative suburban default.
 *   condition    — 5% of comp price per condition-grade step (1-5 scale, same
 *                  grade convention as state-adjustment-rates.ts). URAR C1–C6
 *                  condition ratings are commonly spaced 3%–7% apart.
 *   distance     — -0.5% of comp price per mile beyond a 1-mile "neutral"
 *                  radius, capped at -10% total. This is a conservative
 *                  proximity-decay heuristic (no published universal figure
 *                  exists for this either) covering the ONE line item the DB
 *                  rate table has never priced.
 *   time_of_sale — `marketTrendPctPerMonth` × months since the comp's sale
 *                  date, the SAME convention the state engine's
 *                  `time_market_trend` type uses (signed monthly appreciation/
 *                  depreciation rate × months). The caller is expected to pass
 *                  the resolved state rate's `time_market_trend.mid` when one
 *                  is loaded (real published data); FALLBACK_MONTHLY_TREND_PCT
 *                  below is used only when no rate is available at all, and is
 *                  clearly a fallback, not a market observation.
 *
 * WEAK_COMP_GROSS_THRESHOLD_PCT (0.25) and WEAK_COMP_NET_THRESHOLD_PCT (0.15)
 * are the Fannie Mae Selling Guide B4-1.3-09 gross/net adjustment guidance
 * figures, which the owner's task explicitly names ("gross > 25% or net > 15%
 * = weak comp per common appraisal guidance").
 *
 * ─── WHAT THIS IS NOT ──────────────────────────────────────────────────────
 * "CMA adjustments, not an appraisal." Per CLAUDE.md §5 ("Anything reaching a
 * licensed appraiser must not be model-authored"), every number this module
 * produces is DETERMINISTIC arithmetic — there is no model anywhere in this
 * file — and every surface that renders this grid must carry that label
 * verbatim (see ADJUSTMENT_GRID_DISCLAIMER below).
 */

import type { ScoredComp } from "./comp-types"
import type { SubjectFeatures } from "./state-adjustment-rates"

// ─── Rule-of-thumb constants (see file header for the source of each) ───────

/** Documents the sqft_living rate basis for the file header above — module-
 *  private, referenced in the sqft_living rationale string below rather than
 *  exported with no importer. */
const SQFT_LIVING_RATE_BASIS = "comp_price_per_sqft" as const
export const BEDROOM_ADJUSTMENT_USD = 2_500
export const FULL_BATH_ADJUSTMENT_USD = 5_000
export const HALF_BATH_ADJUSTMENT_USD = 2_500
export const GARAGE_SPACE_ADJUSTMENT_USD = 4_000
export const POOL_ADJUSTMENT_USD = 12_000
export const YEAR_BUILT_PCT_PER_YEAR = 0.003
export const LOT_SIZE_ADJUSTMENT_USD_PER_ACRE = 10_000
export const CONDITION_TIER_PCT_PER_GRADE = 0.05
/** No adjustment inside this radius; the decay begins past it. */
export const DISTANCE_NEUTRAL_RADIUS_MILES = 1
export const DISTANCE_PCT_PER_MILE = 0.005
export const DISTANCE_MAX_PCT = 0.10
/** Used ONLY when the caller has no resolved state `time_market_trend` rate to pass. */
export const FALLBACK_MONTHLY_TREND_PCT = 0.003

/** Fannie Mae Selling Guide B4-1.3-09 gross/net adjustment thresholds. */
export const WEAK_COMP_GROSS_THRESHOLD_PCT = 0.25
export const WEAK_COMP_NET_THRESHOLD_PCT = 0.15

export const ADJUSTMENT_GRID_DISCLAIMER =
  "CMA adjustments, not an appraisal. These are deterministic, rule-of-thumb sales-comparison adjustments computed by software for market-analysis purposes; they are not, and must never be presented as, a state-licensed appraisal. No model authored any figure on this grid."

export type AdjustmentLineType =
  | "sqft_living"
  | "bedroom"
  | "full_bath"
  | "half_bath"
  | "garage_space"
  | "pool"
  | "year_built"
  | "lot_size"
  | "condition"
  | "distance_location"
  | "time_of_sale"

export interface AdjustmentGridLine {
  type: AdjustmentLineType
  /** Signed dollars — positive raises the comp toward the subject. */
  amount: number
  rationale: string
}

export type WeakCompFlagReason = "gross_adjustment_exceeds_threshold" | "net_adjustment_exceeds_threshold"

export interface ComparableAdjustmentGrid {
  comp: ScoredComp
  lines: AdjustmentGridLine[]
  /** Sum of signed adjustments. */
  netAdjustment: number
  /** Sum of |adjustments| — what "how much surgery did this comp need" measures. */
  grossAdjustment: number
  netAdjustmentPct: number
  grossAdjustmentPct: number
  /** comp.salePrice + netAdjustment. */
  adjustedValue: number
  /** True when gross > WEAK_COMP_GROSS_THRESHOLD_PCT or |net| > WEAK_COMP_NET_THRESHOLD_PCT. */
  isWeakComp: boolean
  weakCompReasons: WeakCompFlagReason[]
}

export interface ReconciledValueRange {
  /** Weighted-average adjusted value, weight = 1 / max(grossAdjustmentPct, floor). */
  reconciledValue: number
  low: number
  high: number
  /** How many comps fed the reconciliation (weak comps are INCLUDED but down-weighted, never dropped). */
  compsUsed: number
  /** True only when every comp fed in was flagged weak — the range is still returned, honestly labelled. */
  allCompsWeak: boolean
}

export interface AdjustCompsResult {
  grid: ComparableAdjustmentGrid[]
  reconciled: ReconciledValueRange | null
  disclaimer: string
}

/** Avoids a division blow-up for a comp with a near-zero gross adjustment —
 *  it still gets the HIGHEST weight, just not an infinite one. */
const MIN_WEIGHT_GROSS_FLOOR_PCT = 0.01

function monthsBetween(isoDay: string, nowMs: number): number {
  const then = new Date(isoDay).getTime()
  if (!Number.isFinite(then)) return 0
  return Math.max(0, (nowMs - then) / (30.44 * 24 * 60 * 60 * 1000))
}

/**
 * Build the appraisal-style adjustment grid for one comp against the subject.
 * Pure arithmetic — see file header for every rate's source.
 */
function adjustOneComp(
  subject: SubjectFeatures,
  comp: ScoredComp,
  marketTrendPctPerMonth: number,
  nowMs: number,
): ComparableAdjustmentGrid {
  const price = comp.salePrice > 0 ? comp.salePrice : 0
  const lines: AdjustmentGridLine[] = []
  const push = (type: AdjustmentLineType, amount: number, rationale: string) => {
    if (amount === 0) return
    lines.push({ type, amount: Math.round(amount), rationale })
  }

  // sqft_living — comp's own $/sqft, applied to the sqft DIFFERENCE.
  if (subject.sqftLiving != null && comp.sqftLiving != null) {
    const diff = subject.sqftLiving - comp.sqftLiving
    const perSqft = comp.pricePerSqft ?? (comp.sqftLiving > 0 ? price / comp.sqftLiving : 0)
    if (diff !== 0 && perSqft > 0) {
      push("sqft_living", diff * perSqft, `Sqft diff ${diff} at $${Math.round(perSqft)}/sqft (${SQFT_LIVING_RATE_BASIS})`)
    }
  }

  // bedroom
  if (subject.bedrooms != null && comp.bedrooms != null) {
    const diff = subject.bedrooms - comp.bedrooms
    if (diff !== 0) push("bedroom", diff * BEDROOM_ADJUSTMENT_USD, `${Math.abs(diff)} bedroom diff at $${BEDROOM_ADJUSTMENT_USD.toLocaleString()}/bed`)
  }

  // full + half bath
  if (subject.fullBaths != null && comp.fullBaths != null) {
    const diff = subject.fullBaths - comp.fullBaths
    if (diff !== 0) push("full_bath", diff * FULL_BATH_ADJUSTMENT_USD, `${Math.abs(diff)} full bath diff at $${FULL_BATH_ADJUSTMENT_USD.toLocaleString()}/bath`)
  }
  if (subject.halfBaths != null && comp.halfBaths != null) {
    const diff = subject.halfBaths - comp.halfBaths
    if (diff !== 0) push("half_bath", diff * HALF_BATH_ADJUSTMENT_USD, `${Math.abs(diff)} half bath diff at $${HALF_BATH_ADJUSTMENT_USD.toLocaleString()}/bath`)
  }

  // garage
  if (subject.garageSpaces != null && comp.garageSpaces != null) {
    const diff = subject.garageSpaces - comp.garageSpaces
    if (diff !== 0) push("garage_space", diff * GARAGE_SPACE_ADJUSTMENT_USD, `${Math.abs(diff)} garage space diff at $${GARAGE_SPACE_ADJUSTMENT_USD.toLocaleString()}/space`)
  }

  // pool (binary)
  if (subject.hasPool != null && comp.hasPool != null && subject.hasPool !== comp.hasPool) {
    push("pool", subject.hasPool ? POOL_ADJUSTMENT_USD : -POOL_ADJUSTMENT_USD, subject.hasPool ? "Subject has an in-ground pool, comp doesn't" : "Comp has an in-ground pool, subject doesn't")
  }

  // year_built — pct of comp price per year of age difference
  if (subject.yearBuilt != null && comp.yearBuilt != null) {
    const yearDiff = subject.yearBuilt - comp.yearBuilt
    if (yearDiff !== 0 && price > 0) {
      push("year_built", yearDiff * YEAR_BUILT_PCT_PER_YEAR * price, `Subject ${yearDiff > 0 ? "newer" : "older"} by ${Math.abs(yearDiff)} year(s) at ${(YEAR_BUILT_PCT_PER_YEAR * 100).toFixed(2)}%/yr`)
    }
  }

  // lot_size
  if (subject.lotSizeAcres != null && comp.lotSizeAcres != null) {
    const diff = subject.lotSizeAcres - comp.lotSizeAcres
    if (Math.abs(diff) >= 0.05) push("lot_size", diff * LOT_SIZE_ADJUSTMENT_USD_PER_ACRE, `Lot diff ${diff.toFixed(2)} acres at $${LOT_SIZE_ADJUSTMENT_USD_PER_ACRE.toLocaleString()}/acre`)
  }

  // condition/quality tier (1-5)
  if (subject.conditionGrade != null && comp.conditionGrade != null) {
    const diff = subject.conditionGrade - comp.conditionGrade
    if (diff !== 0 && price > 0) {
      push("condition", diff * CONDITION_TIER_PCT_PER_GRADE * price, `Condition diff ${diff} grade(s) at ${(CONDITION_TIER_PCT_PER_GRADE * 100).toFixed(0)}%/grade`)
    }
  }

  // distance/location — the line item nothing else in this codebase prices.
  if (comp.distanceMiles != null && comp.distanceMiles > DISTANCE_NEUTRAL_RADIUS_MILES && price > 0) {
    const milesBeyond = comp.distanceMiles - DISTANCE_NEUTRAL_RADIUS_MILES
    const pct = Math.min(DISTANCE_MAX_PCT, milesBeyond * DISTANCE_PCT_PER_MILE)
    push("distance_location", -pct * price, `${comp.distanceMiles.toFixed(1)} mi from subject (${DISTANCE_NEUTRAL_RADIUS_MILES} mi neutral radius) — ${(pct * 100).toFixed(1)}% proximity discount`)
  }

  // time_of_sale — marketTrendPctPerMonth × months since sale
  if (price > 0 && comp.saleDate) {
    const months = monthsBetween(comp.saleDate, nowMs)
    if (months > 0.5 && marketTrendPctPerMonth !== 0) {
      push("time_of_sale", marketTrendPctPerMonth * months * price, `${months.toFixed(1)} months since sale at ${(marketTrendPctPerMonth * 100).toFixed(2)}%/mo market trend`)
    }
  }

  const netAdjustment = lines.reduce((s, l) => s + l.amount, 0)
  const grossAdjustment = lines.reduce((s, l) => s + Math.abs(l.amount), 0)
  const netAdjustmentPct = price > 0 ? netAdjustment / price : 0
  const grossAdjustmentPct = price > 0 ? grossAdjustment / price : 0
  const adjustedValue = price + netAdjustment

  const weakCompReasons: WeakCompFlagReason[] = []
  if (grossAdjustmentPct > WEAK_COMP_GROSS_THRESHOLD_PCT) weakCompReasons.push("gross_adjustment_exceeds_threshold")
  if (Math.abs(netAdjustmentPct) > WEAK_COMP_NET_THRESHOLD_PCT) weakCompReasons.push("net_adjustment_exceeds_threshold")

  return {
    comp,
    lines,
    netAdjustment: Math.round(netAdjustment),
    grossAdjustment: Math.round(grossAdjustment),
    netAdjustmentPct,
    grossAdjustmentPct,
    adjustedValue: Math.round(adjustedValue),
    isWeakComp: weakCompReasons.length > 0,
    weakCompReasons,
  }
}

/**
 * Reconcile several adjusted comp values into one range, weighted by INVERSE
 * gross adjustment — a comp that needed little surgery to match the subject
 * counts for more than one that needed heavy surgery, which is the appraisal
 * "reconciliation" step (URAR sales-comparison approach) that nothing in this
 * codebase computed before this file.
 *
 * Weak comps are down-weighted, never dropped — excluding them outright would
 * let a thin comp set silently lose its only evidence; a heavily-adjusted comp
 * still says SOMETHING about the property, just less.
 */
function reconcile(grid: ComparableAdjustmentGrid[]): ReconciledValueRange | null {
  const withValue = grid.filter((g) => g.adjustedValue > 0)
  if (withValue.length === 0) return null

  const weights = withValue.map((g) => 1 / Math.max(g.grossAdjustmentPct, MIN_WEIGHT_GROSS_FLOOR_PCT))
  const totalWeight = weights.reduce((s, w) => s + w, 0)
  const weightedMean =
    withValue.reduce((s, g, i) => s + g.adjustedValue * weights[i], 0) / totalWeight

  const weightedVariance =
    withValue.reduce((s, g, i) => s + weights[i] * (g.adjustedValue - weightedMean) ** 2, 0) / totalWeight
  const weightedStdDev = Math.sqrt(weightedVariance)

  return {
    reconciledValue: Math.round(weightedMean),
    low: Math.round(Math.max(0, weightedMean - weightedStdDev)),
    high: Math.round(weightedMean + weightedStdDev),
    compsUsed: withValue.length,
    allCompsWeak: withValue.every((g) => g.isWeakComp),
  }
}

/**
 * THE PUBLIC ENTRY POINT.
 *
 * `marketTrendPctPerMonth` — pass the resolved state rate's
 * `time_market_trend.mid` (lib/cma/state-adjustment-rates.ts) when one is
 * loaded for this CMA; that is real published data. Falls back to
 * FALLBACK_MONTHLY_TREND_PCT only when the caller has none — always pass
 * `null` rather than guessing a number of your own, so the fallback is used
 * consistently instead of two different callers inventing two different ones.
 */
export function adjustComps(
  subject: SubjectFeatures,
  comps: ScoredComp[],
  marketTrendPctPerMonth: number | null,
): AdjustCompsResult {
  const trend = marketTrendPctPerMonth ?? FALLBACK_MONTHLY_TREND_PCT
  const nowMs = Date.now()
  const grid = comps.map((c) => adjustOneComp(subject, c, trend, nowMs))
  return {
    grid,
    reconciled: reconcile(grid),
    disclaimer: ADJUSTMENT_GRID_DISCLAIMER,
  }
}
