// lib/analytics/prediction-accuracy.ts
//
// THE GENERALIZED ACCURACY FLYWHEEL (owner round 35) — ONE honest "how right
// were we" read across every prediction the OS makes THAT ALSO HAS A RECORDED
// OUTCOME. The trust surface that closes enterprise brokerages: a system that
// grades itself, in public, from its own ledgers.
//
// ARCHITECTURE: a per-rail ADAPTER pattern. Each adapter reads ITS existing
// prediction/outcome ledger (nothing new is written, no new tables, no new
// writers — this module is STRICTLY read-only) and returns one common shape:
//   { rail, observations, medianError | withinRate, period, honestNotes }
//
// HONESTY CONTRACT (inherited from the round-34 closing-cost flywheel):
//   - A rail with no outcome data reports { available: false, why } — never an
//     invented accuracy number. Zero observations is SHOWN as zero.
//   - withinRate is exposed ONLY where the source system itself defines the
//     band/tolerance (closing-cost estimate bands, the net-sheet surprise
//     tolerance, human-graded pattern outcomes). Where no band exists we show
//     the median error and say so — we never mint a tolerance to look good.
//   - Predictions are only graded against outcomes recorded independently of
//     the prediction (a scanned CD, a settlement statement, a sold price, a
//     head count, a human verdict). Nothing self-grades against itself.
//
// RAILS INCLUDED (prediction row AND outcome row genuinely exist):
//   closing_costs        closing_cost_accuracy_observations (round 34 — merged
//                        into this surface as its first rail, keep-one)
//   net_sheet            net_sheet_reconciliations (promised net vs settled net)
//   listing_price        price_predictions.predicted_price vs listings.sold_price
//   days_on_market       price_predictions.days_to_sell_estimate vs actual DOM
//   open_house_attendance open_house_events.attendance_prediction vs
//                        open_house_analytics.total_attendance
//   offer_strategy       strategy_outcomes (recommended price vs final price)
//   pattern_predictions  pattern_predictions.outcome (human-graded correct/incorrect)
//   content_performance  prediction_accuracy_log (predicted vs actual content score)
//
// RAILS DELIBERATELY EXCLUDED (and why — auditable, not forgotten):
//   ai_predictions               has an actual_outcome column but NO writer ever
//                                sets it — outcomes don't genuinely exist.
//   home_value_estimates (AVM)   no listing/transaction key — only a fuzzy
//                                address join to a sale; the AVM-vs-sale story
//                                is carried honestly by listing_price instead
//                                (price_predictions has an exact listing_id join).
//   buyer_behavior_predictions   predictions only; no outcome ledger.
//   listing propensity scores    gated briefs, but no recorded listed/not-listed
//                                outcome row to grade against.
//   transactions.win_probability live mutable column that converges to the
//                                outcome — no frozen snapshot ledger, so grading
//                                it would be hindsight, not accuracy.
//   income_forecast_snapshots    forecast-vs-GOAL gap exists; no realized-outcome
//                                reconciliation ledger yet.
//   deal velocity                a measurement (decision→execution time), not a
//                                prediction.

import type { SupabaseClient } from "@supabase/supabase-js"
import { medianOf, type AccuracyLine } from "@/lib/offers/closing-cost-accuracy"
import { MATERIAL_ABS, MATERIAL_PCT } from "@/lib/net-sheet/net-sheet-reconciler"

type Svc = SupabaseClient<any, any, any>

// ─── The common rail shape ───────────────────────────────────────────────────

export type AccuracyRailId =
  | "closing_costs"
  | "net_sheet"
  | "listing_price"
  | "days_on_market"
  | "open_house_attendance"
  | "offer_strategy"
  | "pattern_predictions"
  | "content_performance"

export interface RailMedianError {
  value: number
  /** unit of the median error value */
  unit: "usd" | "pct_of_sale" | "days" | "people" | "score_points"
  /** human phrasing, e.g. "median |actual − estimate midpoint|" */
  label: string
}

export interface RailWithinRate {
  /** 0..1 share of graded observations inside the SOURCE-DEFINED tolerance */
  rate: number
  /** names the tolerance so the number can't be mistaken for something else */
  label: string
}

export interface RailBreakdownRow {
  group: string
  observations: number
  withinRate: number | null
  /** same unit as the rail's medianError */
  medianError: number | null
}

export interface RailAccuracy {
  rail: AccuracyRailId
  label: string
  /** false = no outcome data (or ledger unreadable); why says which */
  available: boolean
  why: string | null
  observations: number
  medianError: RailMedianError | null
  withinRate: RailWithinRate | null
  /** the real observed window (min/max of the graded rows), never invented */
  period: { from: string; to: string } | null
  honestNotes: string[]
  predictionSource: string
  outcomeSource: string
  detailHref: string | null
  breakdown?: RailBreakdownRow[]
}

export interface PredictionAccuracyReport {
  scope: "platform" | "brokerage"
  generatedAt: string
  rails: RailAccuracy[]
  /** rails with at least one graded observation */
  gradedRails: number
  totalObservations: number
}

// ─── Small shared helpers (pure) ─────────────────────────────────────────────

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null // absent is ABSENT, never a fabricated 0
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function periodOf(isoDates: Array<string | null | undefined>): { from: string; to: string } | null {
  const ds = isoDates.filter((d): d is string => typeof d === "string" && d.length > 0).sort()
  if (ds.length === 0) return null
  return { from: ds[0], to: ds[ds.length - 1] }
}

function unavailable(base: Omit<RailAccuracy, "available" | "why" | "observations" | "medianError" | "withinRate" | "period">, why: string): RailAccuracy {
  return { ...base, available: false, why, observations: 0, medianError: null, withinRate: null, period: null }
}

const round2 = (n: number) => Math.round(n * 100) / 100
const round4 = (n: number) => Math.round(n * 10000) / 10000

/** True fractional median (medianOf from the closing-cost module rounds to
 *  whole dollars — right for money, wrong for percentage errors). */
export function fractionalMedian(values: number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// ─── Rail 1: CLOSING COSTS (the round-34 flywheel, merged in keep-one) ───────

export interface ClosingCostObsRow {
  state: string
  lines: AccuracyLine[]
  created_at: string | null
}

const CLOSING_COSTS_BASE = {
  rail: "closing_costs" as const,
  label: "Closing-cost estimates",
  honestNotes: [
    "Actuals come only from document-kernel Closing Disclosure extractions (human-verified or high/medium-confidence scans).",
    "Only estimate lines with a clean CD counterpart are graded; cash-to-close is never compared to the estimate total.",
    "This read arms the yearly review of the state convention table — conventions are never auto-adjusted.",
  ],
  predictionSource: "Regional closing-cost model (lib/offers/regional-closing-costs)",
  outcomeSource: "Scanned Closing Disclosures (closing_cost_accuracy_observations)",
  detailHref: "/dashboard/transactions",
}

/** PURE: fold observation rows (state + graded lines) into the rail shape. */
export function summarizeClosingCostRows(rows: ClosingCostObsRow[]): RailAccuracy {
  const graded = rows.filter((r) => Array.isArray(r.lines) && r.lines.length > 0)
  if (graded.length === 0) {
    return unavailable(CLOSING_COSTS_BASE,
      "No accuracy observations yet — one is recorded each time a deal closes with a scanned Closing Disclosure whose figures map cleanly to an estimate line.")
  }
  const allLines = graded.flatMap((r) => r.lines)
  const withinCount = allLines.filter((l) => l.withinBand).length

  // Per-state breakdown (the round-34 rollup's signal, preserved).
  const byState = new Map<string, AccuracyLine[]>()
  for (const r of graded) {
    if (!r.state) continue
    byState.set(r.state, [...(byState.get(r.state) ?? []), ...r.lines])
  }
  const stateObsCount = new Map<string, number>()
  for (const r of graded) stateObsCount.set(r.state, (stateObsCount.get(r.state) ?? 0) + 1)
  const breakdown: RailBreakdownRow[] = [...byState.entries()]
    .map(([state, lines]) => ({
      group: state,
      observations: stateObsCount.get(state) ?? 0,
      withinRate: round2(lines.filter((l) => l.withinBand).length / lines.length),
      medianError: medianOf(lines.map((l) => Math.abs(l.deltaFromMid))),
    }))
    .sort((a, b) => b.observations - a.observations || a.group.localeCompare(b.group))

  return {
    ...CLOSING_COSTS_BASE,
    available: true,
    why: null,
    observations: graded.length,
    medianError: {
      value: medianOf(allLines.map((l) => Math.abs(l.deltaFromMid))),
      unit: "usd",
      label: "median |actual − estimate-band midpoint| per graded line",
    },
    withinRate: {
      rate: round2(withinCount / allLines.length),
      label: "graded lines whose actual landed inside the quoted low–high band",
    },
    period: periodOf(graded.map((r) => r.created_at)),
    breakdown,
  }
}

async function closingCostsAdapter(svc: Svc, brokerageId?: string): Promise<RailAccuracy> {
  let q = svc.from("closing_cost_accuracy_observations")
    .select("state, lines, created_at")
    .order("created_at", { ascending: false })
    .limit(2000)
  if (brokerageId) q = q.eq("brokerage_id", brokerageId)
  const { data, error } = await q
  if (error) return unavailable(CLOSING_COSTS_BASE, `ledger unreadable: ${error.message}`)
  return summarizeClosingCostRows((data ?? []) as ClosingCostObsRow[])
}

// ─── Rail 2: NET SHEET (promised seller net vs settled net) ──────────────────

export interface NetSheetReconRow {
  estimated_net: number | null
  actual_net: number | null
  variance_amount: number | null
  surprise_level: string
  created_at: string | null
}

const NET_SHEET_BASE = {
  rail: "net_sheet" as const,
  label: "Seller net-sheet promises",
  honestNotes: [
    `"Within tolerance" is the surprise guard's own recorded verdict: |gap| under max($${MATERIAL_ABS.toLocaleString("en-US")}, ${MATERIAL_PCT * 100}% of the promised net).`,
    "Actual nets come off the final settlement statement / Closing Disclosure — only deals with both a promise and a settlement are graded.",
  ],
  predictionSource: "Offer-time seller net estimate (offers.seller_net_estimate)",
  outcomeSource: "Settlement-statement reconciliations (net_sheet_reconciliations)",
  detailHref: "/dashboard/transactions",
}

/** PURE: fold reconciliation rows into the rail shape. */
export function summarizeNetSheetRows(rows: NetSheetReconRow[]): RailAccuracy {
  const graded = rows.filter((r) => num(r.variance_amount) != null && num(r.estimated_net) != null)
  if (graded.length === 0) {
    return unavailable(NET_SHEET_BASE,
      "No reconciliations yet — one is recorded when a deal's final settlement statement lands with a promised net on file.")
  }
  // "Within" = the surprise guard's own recorded verdict ('none' = inside the
  // material tolerance). Pleasant/concerning/severe are all real gaps.
  const within = graded.filter((r) => r.surprise_level === "none").length
  return {
    ...NET_SHEET_BASE,
    available: true,
    why: null,
    observations: graded.length,
    medianError: {
      value: medianOf(graded.map((r) => Math.abs(r.variance_amount as number))),
      unit: "usd",
      label: "median |settled net − promised net|",
    },
    withinRate: {
      rate: round2(within / graded.length),
      label: "settlements inside the surprise-guard tolerance of the promised net",
    },
    period: periodOf(graded.map((r) => r.created_at)),
  }
}

async function netSheetAdapter(svc: Svc, brokerageId?: string): Promise<RailAccuracy> {
  let q = svc.from("net_sheet_reconciliations")
    .select("estimated_net, actual_net, variance_amount, surprise_level, created_at")
    .order("created_at", { ascending: false })
    .limit(2000)
  if (brokerageId) q = q.eq("brokerage_id", brokerageId)
  const { data, error } = await q
  if (error) return unavailable(NET_SHEET_BASE, `ledger unreadable: ${error.message}`)
  return summarizeNetSheetRows((data ?? []) as NetSheetReconRow[])
}

// ─── Rails 3+4: LISTING PRICE + DAYS ON MARKET (pricing model vs the sale) ───

export interface PricePredictionPair {
  /** prediction, made at predictedAt */
  predictedPrice: number | null
  daysToSellEstimate: number | null
  predictedAt: string | null
  /** outcome */
  soldPrice: number | null
  soldDate: string | null
  listingDate: string | null
}

const LISTING_PRICE_BASE = {
  rail: "listing_price" as const,
  label: "Pricing calls vs sale price",
  honestNotes: [
    "Only predictions made BEFORE the sale date are graded (the model's last pre-sale call per listing) — no hindsight grading.",
    "No stored tolerance band on this rail, so only the median gap is claimed — no invented \"within X%\" rate.",
  ],
  predictionSource: "AI price predictions (price_predictions.predicted_price)",
  outcomeSource: "Recorded sales (listings.sold_price)",
  detailHref: "/dashboard/listings/ai-pricing",
}

const DOM_BASE = {
  rail: "days_on_market" as const,
  label: "Days-on-market predictions",
  honestNotes: [
    "Actual DOM = sold date − listing date; graded only where both dates and a pre-sale prediction exist.",
    "No stored tolerance band on this rail — median miss only.",
  ],
  predictionSource: "AI sell-time estimates (price_predictions.days_to_sell_estimate)",
  outcomeSource: "Recorded sales (listings.listing_date → sold_date)",
  detailHref: "/dashboard/listings/ai-pricing",
}

/** PURE: keep only pairs where the prediction predates the sale. */
export function gradablePricePairs(pairs: PricePredictionPair[]): PricePredictionPair[] {
  return pairs.filter((p) => {
    if (!p.predictedAt || !p.soldDate) return false
    const pred = new Date(p.predictedAt).getTime()
    // sold_date is a date — grade predictions made up to the end of that day.
    const sold = new Date(p.soldDate).getTime() + 86_399_000
    return Number.isFinite(pred) && Number.isFinite(sold) && pred <= sold
  })
}

/** PURE: price-accuracy rail from prediction/sale pairs. */
export function summarizeListingPriceRows(pairs: PricePredictionPair[]): RailAccuracy {
  const graded = gradablePricePairs(pairs).filter(
    (p) => (num(p.predictedPrice) ?? 0) > 0 && (num(p.soldPrice) ?? 0) > 0,
  )
  if (graded.length === 0) {
    return unavailable(LISTING_PRICE_BASE,
      "No sold listing has a pre-sale price prediction yet — the rail grades itself as sales close.")
  }
  const pctErrors = graded.map((p) => Math.abs((p.predictedPrice as number) - (p.soldPrice as number)) / (p.soldPrice as number))
  return {
    ...LISTING_PRICE_BASE,
    available: true,
    why: null,
    observations: graded.length,
    medianError: {
      value: round4(fractionalMedian(pctErrors)),
      unit: "pct_of_sale",
      label: "median |predicted − sold| as a share of the sale price",
    },
    withinRate: null,
    period: periodOf(graded.map((p) => p.soldDate)),
  }
}

/** PURE: DOM-accuracy rail from the same pairs. */
export function summarizeDomRows(pairs: PricePredictionPair[]): RailAccuracy {
  const graded = gradablePricePairs(pairs).filter((p) => {
    if ((num(p.daysToSellEstimate) ?? 0) <= 0 || !p.listingDate || !p.soldDate) return false
    const listed = new Date(p.listingDate).getTime()
    const sold = new Date(p.soldDate).getTime()
    return Number.isFinite(listed) && Number.isFinite(sold) && sold >= listed
  })
  if (graded.length === 0) {
    return unavailable(DOM_BASE,
      "No sold listing carries both a pre-sale days-to-sell estimate and real listing/sold dates yet.")
  }
  const errors = graded.map((p) => {
    const actualDom = Math.round((new Date(p.soldDate as string).getTime() - new Date(p.listingDate as string).getTime()) / 86_400_000)
    return Math.abs((p.daysToSellEstimate as number) - actualDom)
  })
  return {
    ...DOM_BASE,
    available: true,
    why: null,
    observations: graded.length,
    medianError: { value: medianOf(errors), unit: "days", label: "median |predicted DOM − actual DOM|" },
    withinRate: null,
    period: periodOf(graded.map((p) => p.soldDate)),
  }
}

async function loadPricePairs(svc: Svc, brokerageId?: string): Promise<PricePredictionPair[] | { error: string }> {
  let lq = svc.from("listings")
    .select("id, sold_price, sold_date, listing_date")
    .not("sold_price", "is", null)
    .not("sold_date", "is", null)
    .order("sold_date", { ascending: false })
    .limit(500)
  if (brokerageId) lq = lq.eq("brokerage_id", brokerageId)
  const { data: sold, error: lErr } = await lq
  if (lErr) return { error: lErr.message }
  const soldRows = (sold ?? []) as Array<{ id: string; sold_price: number | null; sold_date: string | null; listing_date: string | null }>
  if (soldRows.length === 0) return []

  const { data: preds, error: pErr } = await svc.from("price_predictions")
    .select("listing_id, predicted_price, days_to_sell_estimate, created_at")
    .in("listing_id", soldRows.map((l) => l.id))
    .order("created_at", { ascending: false })
    .limit(2000)
  if (pErr) return { error: pErr.message }

  // The model's LAST pre-sale call per listing (rows are newest-first).
  const byListing = new Map(soldRows.map((l) => [l.id, l]))
  const taken = new Set<string>()
  const pairs: PricePredictionPair[] = []
  for (const p of (preds ?? []) as Array<{ listing_id: string; predicted_price: number | null; days_to_sell_estimate: number | null; created_at: string | null }>) {
    const listing = byListing.get(p.listing_id)
    if (!listing || taken.has(p.listing_id)) continue
    if (!p.created_at || !listing.sold_date) continue
    if (new Date(p.created_at).getTime() > new Date(listing.sold_date).getTime() + 86_399_000) continue // post-sale prediction: skip, keep looking for an earlier one
    taken.add(p.listing_id)
    pairs.push({
      predictedPrice: num(p.predicted_price),
      daysToSellEstimate: num(p.days_to_sell_estimate),
      predictedAt: p.created_at,
      soldPrice: num(listing.sold_price),
      soldDate: listing.sold_date,
      listingDate: listing.listing_date,
    })
  }
  return pairs
}

// ─── Rail 5: OPEN-HOUSE ATTENDANCE (predicted head count vs the door) ────────

export interface AttendancePair {
  predicted: number | null
  actual: number | null
  eventDate: string | null
}

const ATTENDANCE_BASE = {
  rail: "open_house_attendance" as const,
  label: "Open-house attendance predictions",
  honestNotes: [
    "Only events that carried a prediction AND recorded a real head count are graded.",
    "The stored prediction is the mid estimate — no low/high band survives to grade against, so only the median miss is claimed.",
  ],
  predictionSource: "Pre-event predictions (open_house_events.attendance_prediction)",
  outcomeSource: "Recorded attendance (open_house_analytics.total_attendance)",
  detailHref: "/dashboard/open-houses",
}

/** PURE: attendance rail from prediction/actual pairs. */
export function summarizeAttendanceRows(pairs: AttendancePair[]): RailAccuracy {
  const graded = pairs.filter((p) => (num(p.predicted) ?? 0) > 0 && num(p.actual) != null)
  if (graded.length === 0) {
    return unavailable(ATTENDANCE_BASE,
      "No open house has both a pre-event attendance prediction and a recorded head count yet.")
  }
  return {
    ...ATTENDANCE_BASE,
    available: true,
    why: null,
    observations: graded.length,
    medianError: {
      value: medianOf(graded.map((p) => Math.abs((p.actual as number) - (p.predicted as number)))),
      unit: "people",
      label: "median |actual attendees − predicted|",
    },
    withinRate: null,
    period: periodOf(graded.map((p) => p.eventDate)),
  }
}

async function attendanceAdapter(svc: Svc, brokerageId?: string): Promise<RailAccuracy> {
  let eq = svc.from("open_house_events")
    .select("id, attendance_prediction, event_date")
    .not("attendance_prediction", "is", null)
    .order("event_date", { ascending: false })
    .limit(500)
  if (brokerageId) eq = eq.eq("brokerage_id", brokerageId)
  const { data: events, error: eErr } = await eq
  if (eErr) return unavailable(ATTENDANCE_BASE, `ledger unreadable: ${eErr.message}`)
  const evRows = (events ?? []) as Array<{ id: string; attendance_prediction: number | null; event_date: string | null }>
  if (evRows.length === 0) {
    return unavailable(ATTENDANCE_BASE, "No open-house events carry an attendance prediction yet.")
  }
  const { data: analytics, error: aErr } = await svc.from("open_house_analytics")
    .select("event_id, total_attendance")
    .in("event_id", evRows.map((e) => e.id))
    .not("total_attendance", "is", null)
    .limit(2000)
  if (aErr) return unavailable(ATTENDANCE_BASE, `ledger unreadable: ${aErr.message}`)
  const actualByEvent = new Map(((analytics ?? []) as Array<{ event_id: string; total_attendance: number | null }>)
    .map((a) => [a.event_id, num(a.total_attendance)]))
  return summarizeAttendanceRows(evRows.map((e) => ({
    predicted: num(e.attendance_prediction),
    actual: actualByEvent.has(e.id) ? (actualByEvent.get(e.id) ?? null) : null,
    eventDate: e.event_date,
  })))
}

// ─── Rail 6: OFFER STRATEGY (recommended price vs the final price) ───────────

export interface StrategyOutcomeRow {
  outcome: string
  final_price: number | null
  deviation_from_recommendation: number | null
  created_at: string | null
}

const STRATEGY_BASE = {
  rail: "offer_strategy" as const,
  label: "Offer-strategy recommendations",
  honestNotes: [
    "Deviation is |final price − recommended price| on offers that reached a terminal state — an adoption-and-accuracy blend, so acceptance share is reported separately, not as accuracy.",
  ],
  predictionSource: "Strategy advisor recommended price (strategy_recommendations)",
  outcomeSource: "Closed strategy loop (strategy_outcomes.final_price / outcome)",
  detailHref: "/dashboard/transactions",
}

/** PURE: strategy rail from closed-loop outcome rows. */
export function summarizeStrategyRows(rows: StrategyOutcomeRow[]): RailAccuracy {
  const graded = rows.filter((r) => num(r.deviation_from_recommendation) != null)
  if (graded.length === 0) {
    return unavailable(STRATEGY_BASE,
      "No offer produced by a strategy recommendation has reached a terminal state with a recorded price yet.")
  }
  const accepted = rows.filter((r) => r.outcome === "accepted").length
  return {
    ...STRATEGY_BASE,
    available: true,
    why: null,
    observations: graded.length,
    medianError: {
      value: medianOf(graded.map((r) => Math.abs(r.deviation_from_recommendation as number))),
      unit: "usd",
      label: "median |final price − recommended price|",
    },
    withinRate: null,
    period: periodOf(graded.map((r) => r.created_at)),
    honestNotes: [
      ...STRATEGY_BASE.honestNotes,
      `${accepted} of ${rows.length} strategy-produced offers were accepted outright.`,
    ],
  }
}

async function strategyAdapter(svc: Svc, brokerageId?: string): Promise<RailAccuracy> {
  let q = svc.from("strategy_outcomes")
    .select("outcome, final_price, deviation_from_recommendation, created_at")
    .order("created_at", { ascending: false })
    .limit(2000)
  if (brokerageId) q = q.eq("brokerage_id", brokerageId)
  const { data, error } = await q
  if (error) return unavailable(STRATEGY_BASE, `ledger unreadable: ${error.message}`)
  return summarizeStrategyRows((data ?? []) as StrategyOutcomeRow[])
}

// ─── Rail 7: PATTERN PREDICTIONS (human-graded correct/incorrect) ────────────

export interface PatternPredictionRow {
  outcome: string | null
  outcome_recorded_at: string | null
}

const PATTERN_BASE = {
  rail: "pattern_predictions" as const,
  label: "Pattern-detector predictions",
  honestNotes: [
    "Outcomes are HUMAN verdicts recorded on each prediction — ungraded (pending) predictions are counted but never assumed correct.",
  ],
  predictionSource: "Pattern detector (pattern_predictions.predicted_event)",
  outcomeSource: "Human-recorded verdicts (pattern_predictions.outcome)",
  detailHref: "/dashboard/patterns",
}

/** PURE: pattern rail — hit rate over human-graded rows only. */
export function summarizePatternRows(rows: PatternPredictionRow[]): RailAccuracy {
  const graded = rows.filter((r) => r.outcome === "correct" || r.outcome === "incorrect")
  if (graded.length === 0) {
    return unavailable(PATTERN_BASE,
      rows.length > 0
        ? `${rows.length} prediction${rows.length === 1 ? "" : "s"} made, but none has a human-recorded outcome yet — nothing is graded from assumptions.`
        : "No pattern predictions recorded yet.")
  }
  const correct = graded.filter((r) => r.outcome === "correct").length
  const pending = rows.length - graded.length
  return {
    ...PATTERN_BASE,
    available: true,
    why: null,
    observations: graded.length,
    medianError: null,
    withinRate: { rate: round2(correct / graded.length), label: "human-graded predictions marked correct" },
    period: periodOf(graded.map((r) => r.outcome_recorded_at)),
    honestNotes: [
      ...PATTERN_BASE.honestNotes,
      ...(pending > 0 ? [`${pending} prediction${pending === 1 ? "" : "s"} still await a verdict and are not graded.`] : []),
    ],
  }
}

async function patternAdapter(svc: Svc, brokerageId?: string): Promise<RailAccuracy> {
  let q = svc.from("pattern_predictions")
    .select("outcome, outcome_recorded_at")
    .order("created_at", { ascending: false })
    .limit(2000)
  if (brokerageId) q = q.eq("brokerage_id", brokerageId)
  const { data, error } = await q
  if (error) return unavailable(PATTERN_BASE, `ledger unreadable: ${error.message}`)
  return summarizePatternRows((data ?? []) as PatternPredictionRow[])
}

// ─── Rail 8: CONTENT PERFORMANCE (predicted vs actual engagement score) ──────

export interface ContentAccuracyRow {
  delta_score: number | null
  logged_at: string | null
}

const CONTENT_BASE = {
  rail: "content_performance" as const,
  label: "Content-performance predictions",
  honestNotes: [
    "delta = predicted score − actual score on the same 0–100 engagement scale, logged only once real engagement lands.",
  ],
  predictionSource: "Pre-publish predictions (content_performance_predictions)",
  outcomeSource: "Post-publish accuracy log (prediction_accuracy_log)",
  detailHref: "/dashboard/marketing/studio",
}

/** PURE: content rail — median |delta_score| over logged outcomes. */
export function summarizeContentRows(rows: ContentAccuracyRow[]): RailAccuracy {
  const graded = rows.filter((r) => num(r.delta_score) != null)
  if (graded.length === 0) {
    return unavailable(CONTENT_BASE,
      "No published content has its actual engagement logged against a prediction yet.")
  }
  return {
    ...CONTENT_BASE,
    available: true,
    why: null,
    observations: graded.length,
    medianError: {
      value: medianOf(graded.map((r) => Math.abs(r.delta_score as number))),
      unit: "score_points",
      label: "median |predicted score − actual score| (0–100 scale)",
    },
    withinRate: null,
    period: periodOf(graded.map((r) => r.logged_at)),
  }
}

async function contentAdapter(svc: Svc, brokerageId?: string): Promise<RailAccuracy> {
  let q = svc.from("prediction_accuracy_log")
    .select("delta_score, logged_at")
    .order("logged_at", { ascending: false })
    .limit(2000)
  if (brokerageId) q = q.eq("brokerage_id", brokerageId)
  const { data, error } = await q
  if (error) return unavailable(CONTENT_BASE, `ledger unreadable: ${error.message}`)
  return summarizeContentRows((data ?? []) as ContentAccuracyRow[])
}

// ─── The unified read ────────────────────────────────────────────────────────

async function pricePairsRails(svc: Svc, brokerageId?: string): Promise<[RailAccuracy, RailAccuracy]> {
  const pairs = await loadPricePairs(svc, brokerageId)
  if (!Array.isArray(pairs)) {
    return [
      unavailable(LISTING_PRICE_BASE, `ledger unreadable: ${pairs.error}`),
      unavailable(DOM_BASE, `ledger unreadable: ${pairs.error}`),
    ]
  }
  return [summarizeListingPriceRows(pairs), summarizeDomRows(pairs)]
}

/** Never throws: an adapter failure degrades to an honest unavailable rail. */
async function safeRail(p: Promise<RailAccuracy>, base: Parameters<typeof unavailable>[0]): Promise<RailAccuracy> {
  try { return await p } catch (e) {
    return unavailable(base, `adapter failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * ONE honest aggregator over every prediction rail with a real outcome ledger.
 * STRICTLY read-only. Cross-tenant when brokerageId is omitted (superadmin
 * surface — callers gate access); tenant-scoped when provided.
 */
export async function getPredictionAccuracyReport(
  svc: Svc,
  opts?: { brokerageId?: string },
): Promise<PredictionAccuracyReport> {
  const b = opts?.brokerageId
  const [closingCosts, netSheet, priceRails, attendance, strategy, patterns, content] = await Promise.all([
    safeRail(closingCostsAdapter(svc, b), CLOSING_COSTS_BASE),
    safeRail(netSheetAdapter(svc, b), NET_SHEET_BASE),
    pricePairsRails(svc, b).catch((e): [RailAccuracy, RailAccuracy] => [
      unavailable(LISTING_PRICE_BASE, `adapter failed: ${e instanceof Error ? e.message : String(e)}`),
      unavailable(DOM_BASE, `adapter failed: ${e instanceof Error ? e.message : String(e)}`),
    ]),
    safeRail(attendanceAdapter(svc, b), ATTENDANCE_BASE),
    safeRail(strategyAdapter(svc, b), STRATEGY_BASE),
    safeRail(patternAdapter(svc, b), PATTERN_BASE),
    safeRail(contentAdapter(svc, b), CONTENT_BASE),
  ])
  const rails = [closingCosts, netSheet, priceRails[0], priceRails[1], attendance, strategy, patterns, content]
  return {
    scope: b ? "brokerage" : "platform",
    generatedAt: new Date().toISOString(),
    rails,
    gradedRails: rails.filter((r) => r.available).length,
    totalObservations: rails.reduce((s, r) => s + r.observations, 0),
  }
}

// ─── THE TRUST CHIP (client-facing, bounded) ─────────────────────────────────
//
// ONE reusable line the recruiting pitch kit and the QBR can cite — rendered
// ONLY when a rail is genuinely strong. Thresholds are explicit constants,
// the numbers in the line are the measured ones, and below threshold the chip
// is null (the consumer omits the section — the pitch-kit "measured GCI" idiom).

export const TRUST_CHIP_MIN_OBSERVATIONS = 5
export const TRUST_CHIP_NET_SHEET_MIN_WITHIN = 0.8
export const TRUST_CHIP_CLOSING_COST_MIN_WITHIN = 0.7
export const TRUST_CHIP_PRICE_MAX_MEDIAN_PCT = 0.05

export interface PredictionTrustChip {
  rail: AccuracyRailId
  railLabel: string
  observations: number
  /** the one client-facing sentence — every number in it is measured */
  line: string
}

const usd0 = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`

/** PURE: pick the strongest chip-eligible rail; null when none qualifies. */
export function composePredictionTrustChip(rails: RailAccuracy[]): PredictionTrustChip | null {
  const by = new Map(rails.map((r) => [r.rail, r]))

  const net = by.get("net_sheet")
  if (net?.available && net.observations >= TRUST_CHIP_MIN_OBSERVATIONS &&
      (net.withinRate?.rate ?? 0) >= TRUST_CHIP_NET_SHEET_MIN_WITHIN) {
    const withinCount = Math.round((net.withinRate as RailWithinRate).rate * net.observations)
    return {
      rail: "net_sheet", railLabel: net.label, observations: net.observations,
      line: `The net we promised sellers matched the final settlement within tolerance on ${withinCount} of ${net.observations} reconciled closings` +
        (net.medianError ? ` (median gap ${usd0(net.medianError.value)})` : "") +
        ` — graded against real settlement statements, not claimed.`,
    }
  }

  const cc = by.get("closing_costs")
  if (cc?.available && cc.observations >= TRUST_CHIP_MIN_OBSERVATIONS &&
      (cc.withinRate?.rate ?? 0) >= TRUST_CHIP_CLOSING_COST_MIN_WITHIN) {
    return {
      rail: "closing_costs", railLabel: cc.label, observations: cc.observations,
      line: `${Math.round((cc.withinRate as RailWithinRate).rate * 100)}% of our closing-cost estimates landed inside the quoted band across ${cc.observations} closed deals — graded against the actual Closing Disclosures.`,
    }
  }

  const price = by.get("listing_price")
  if (price?.available && price.observations >= TRUST_CHIP_MIN_OBSERVATIONS &&
      price.medianError != null && price.medianError.value <= TRUST_CHIP_PRICE_MAX_MEDIAN_PCT) {
    return {
      rail: "listing_price", railLabel: price.label, observations: price.observations,
      line: `Our pricing calls landed within a median ${(price.medianError.value * 100).toFixed(1)}% of the eventual sale price across ${price.observations} sold listings — measured on recorded sales.`,
    }
  }

  return null
}

/** IO: tenant-scoped chip for the pitch kit / QBR. Reads ONLY the three
 *  chip-eligible rails; null (omit) on any failure — never a fabricated claim. */
export async function loadPredictionTrustChip(svc: Svc, brokerageId: string): Promise<PredictionTrustChip | null> {
  try {
    const [net, cc, priceRails] = await Promise.all([
      safeRail(netSheetAdapter(svc, brokerageId), NET_SHEET_BASE),
      safeRail(closingCostsAdapter(svc, brokerageId), CLOSING_COSTS_BASE),
      pricePairsRails(svc, brokerageId),
    ])
    return composePredictionTrustChip([net, cc, priceRails[0]])
  } catch { return null }
}
