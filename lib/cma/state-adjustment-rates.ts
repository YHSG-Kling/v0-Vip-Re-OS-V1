/**
 * STATE APPRAISER ADJUSTMENT RATES
 *
 * Reader + prompt formatter + comp-adjustment helpers for the AI-CMA flow.
 * Each state has rate ranges per adjustment type (sqft, beds, baths, pool,
 * waterfront, etc.). The rates are applied DETERMINISTICALLY here and the same
 * table is shown to the narrative writer as context, so the sales-comparison
 * adjustments on a report are defensible against the state's published starting
 * points rather than guessed.
 *
 * Rate basis:
 *   'pct_of_comp_price' — adjustment as % of comp's sale price (auto-scales
 *                          with market). Most adjustments use this basis so
 *                          the same rates work in $200k markets and $2M
 *                          markets without re-seeding.
 *   'per_unit_dollars'  — fixed dollar amount per unit (rare; reserved for
 *                          features that don't scale with home price).
 *
 * ─── THE VINTAGE IS PART OF THE RATE ────────────────────────────────────────
 * OWNER, VERBATIM: "we use the current years state appraiser guidelines for
 * adjustments." That is one requirement with two halves, and until m505 neither
 * half existed.
 *
 *   · THE READ. `state_appraiser_adjustment_rates.effective_year` was on the
 *     table from the day it was created and NOTHING EVER SELECTED IT. Every CMA
 *     this system has produced was priced with whatever vintage happened to be
 *     in the table — all 39 live rows are 2024 — and no report said so. That is
 *     not a stale-data problem, it is an UNSTATED-BASIS problem: a dollar figure
 *     on a document that supports a price has to be able to say which year's
 *     published guidance produced it.
 *
 *   · THE STORE. The table's UNIQUE key was (state, adjustment_type,
 *     rate_basis), which cannot hold two vintages of the same rate at all. The
 *     owner's ruling was literally unstorable. m505 widens the key to include
 *     effective_year so vintages coexist, and makes effective_year NOT NULL
 *     with no default — a rate that cannot name its year is not a guideline.
 *
 * HOW THE YEAR IS CHOSEN, and what happens when the current year is not seeded.
 * `getStateAdjustmentRates(state, effectiveYear)` takes the year FROM THE CALLER
 * — the CMA passes the year of its own effective date, never a literal — and
 * resolves, per adjustment type, THE MOST RECENT VINTAGE AT OR BEFORE THAT YEAR.
 *
 * When a rate has no row for the requested year, the older row is carried
 * forward AS ITSELF: it keeps its own effective_year, the resolution reports
 * `carriedForward: true`, `vintageNote` says in plain words which vintage is in
 * force and that no newer one was published, and every adjustment line carries
 * `rateEffectiveYear`. Nothing anywhere re-dates a 2024 figure to the current
 * year. A stale rate labelled stale is honest; a stale rate relabelled as
 * current is a fabrication inside a document a seller prices a house from.
 */

import { createServiceClient } from "@/lib/supabase/service"

export type AdjustmentType =
  | "sqft_living"
  | "bedroom"
  | "full_bath"
  | "half_bath"
  | "garage_space"
  | "pool_inground"
  | "waterfront"
  | "view_premium"
  | "lot_size_acre"
  | "year_built_decade"
  | "condition_grade"
  | "basement_finished"
  | "new_construction"
  | "gated_community"
  | "time_market_trend"

export interface AdjustmentRate {
  state: string
  adjustmentType: AdjustmentType
  rateBasis: "pct_of_comp_price" | "per_unit_dollars"
  low: number
  mid: number
  high: number
  unit: string
  notes: string | null
  source: string | null
  /**
   * The year of the published guidance THIS row states, as stored. Never the
   * year it was requested for and never the year it was read in — when an older
   * vintage is carried forward it is carried forward wearing its own year.
   */
  effectiveYear: number
}

export type AdjustmentRateMap = Map<AdjustmentType, AdjustmentRate>

/**
 * The answer to "which year's guidelines priced this CMA", carried WITH the
 * rates so no caller can obtain the numbers without also obtaining the vintage.
 * That coupling is the point: the previous shape returned a bare Map, and a bare
 * Map has nowhere to put the fact that the rates in it are two years old.
 */
export interface ResolvedAdjustmentRates {
  /** 2-letter state the rates were resolved for. */
  state: string
  /** The year asked for — derived from the CMA's effective date by its caller. */
  requestedYear: number
  rates: AdjustmentRateMap
  /** Distinct vintages actually in force across `rates`, newest first. */
  vintagesUsed: number[]
  /** Newest vintage in force, or null when nothing loaded. */
  newestVintage: number | null
  /** Oldest vintage in force, or null when nothing loaded. */
  oldestVintage: number | null
  /**
   * TRUE when at least one rate in force was published BEFORE `requestedYear`,
   * i.e. the current year's guidance was not available and an older vintage is
   * doing the pricing. Read by the orchestrator to put it on the report.
   */
  carriedForward: boolean
  /** True when the rate table could not be read at all (provider/RLS refusal). */
  readFailed: boolean
  /**
   * One plain sentence naming the vintage in force and, when it is not the
   * requested year, saying so. NEVER empty — an unstated basis is the defect
   * this whole resolution exists to close.
   */
  vintageNote: string
}

interface RateRow {
  state: string
  adjustment_type: string
  rate_basis: "pct_of_comp_price" | "per_unit_dollars"
  typical_rate_low: number
  typical_rate_mid: number
  typical_rate_high: number
  unit: string
  notes: string | null
  source: string | null
  effective_year: number | null
}

function toRate(row: RateRow): AdjustmentRate {
  return {
    state: row.state,
    adjustmentType: row.adjustment_type as AdjustmentType,
    rateBasis: row.rate_basis,
    low: Number(row.typical_rate_low),
    mid: Number(row.typical_rate_mid),
    high: Number(row.typical_rate_high),
    unit: row.unit,
    notes: row.notes,
    source: row.source,
    effectiveYear: Number(row.effective_year),
  }
}

/**
 * Get the adjustment rates in force for a state IN A GIVEN YEAR.
 *
 * `effectiveYear` is REQUIRED, and deliberately so. It was easy to default it to
 * `new Date().getFullYear()` here and be done — and that would have re-created
 * the original defect in a new place, because a CMA whose effective date is not
 * today would then be priced with a different year's guidance than the one it
 * reports. The year is the CALLER'S fact; this function will not guess it.
 *
 * Resolution order, applied per adjustment type:
 *   1. Only rows with effective_year <= effectiveYear are eligible. A guideline
 *      published for a FUTURE year does not price a CMA dated before it.
 *   2. Within the state's own rows, the newest eligible vintage wins.
 *   3. A state row of any eligible vintage beats the 'US' default — the state's
 *      own published guidance is the more specific instrument even when the US
 *      default happens to be a year newer. The vintage of whichever row won is
 *      reported, so this precedence is never invisible.
 */
export async function getStateAdjustmentRates(
  state: string,
  effectiveYear: number
): Promise<ResolvedAdjustmentRates> {
  const supabase = createServiceClient()
  const stateUpper = state.toUpperCase().slice(0, 2)

  const empty = (readFailed: boolean, note: string): ResolvedAdjustmentRates => ({
    state: stateUpper,
    requestedYear: effectiveYear,
    rates: new Map(),
    vintagesUsed: [],
    newestVintage: null,
    oldestVintage: null,
    carriedForward: false,
    readFailed,
    vintageNote: note,
  })

  // Query state-specific rows + 'US' default in one shot, bounded by vintage.
  // Rows whose effective_year is NULL are excluded by `lte` and that is correct:
  // m505 makes the column NOT NULL, and until it is applied a row that cannot
  // name its year cannot be quoted as any year's published guidance.
  const { data, error } = await supabase
    .from("state_appraiser_adjustment_rates")
    .select(
      "state, adjustment_type, rate_basis, typical_rate_low, typical_rate_mid, typical_rate_high, unit, notes, source, effective_year"
    )
    .in("state", [stateUpper, "US"])
    .lte("effective_year", effectiveYear)

  // supabase-js RESOLVES a refusal. A read that failed and a state with no
  // seeded rates are opposite facts and must not produce the same sentence.
  if (error) {
    return empty(
      true,
      `The state appraiser adjustment rate table could not be read (${error.message}), so no published rate vintage is in force for ${stateUpper} and no state-rate adjustment was applied.`
    )
  }
  if (!data || data.length === 0) {
    return empty(
      false,
      `No state appraiser adjustment rates are published in this system for ${stateUpper} (or the US default) with an effective year of ${effectiveYear} or earlier.`
    )
  }

  // Pass 1: 'US' defaults, newest eligible vintage per type.
  // Pass 2: the state's own rows override them, newest eligible vintage per type.
  const map: AdjustmentRateMap = new Map()
  const layer = (matchState: string) => {
    for (const row of data as RateRow[]) {
      if (row.state !== matchState) continue
      const year = Number(row.effective_year)
      if (!Number.isFinite(year)) continue
      const type = row.adjustment_type as AdjustmentType
      const held = map.get(type)
      // Only a row from the SAME layer may be compared on vintage; the state
      // layer runs second and unconditionally supersedes whatever US left.
      if (held && held.state === matchState && held.effectiveYear >= year) continue
      map.set(type, toRate(row))
    }
  }
  layer("US")
  layer(stateUpper)

  if (map.size === 0) {
    return empty(
      false,
      `No state appraiser adjustment rates are published in this system for ${stateUpper} (or the US default) with an effective year of ${effectiveYear} or earlier.`
    )
  }

  const vintagesUsed = [...new Set([...map.values()].map((r) => r.effectiveYear))].sort((a, b) => b - a)
  const newestVintage = vintagesUsed[0]
  const oldestVintage = vintagesUsed[vintagesUsed.length - 1]
  const carriedForward = oldestVintage < effectiveYear

  const vintageNote = carriedForward
    ? `State appraiser adjustment rates for ${stateUpper}: the ${vintagesUsed
        .slice()
        .sort((a, b) => a - b)
        .join(" and ")} guideline vintage${vintagesUsed.length > 1 ? "s" : ""} ` +
      `${vintagesUsed.length > 1 ? "are" : "is"} in force. No ${effectiveYear} rate table has been published into this system for ` +
      `${stateUpper}, so the most recent vintage at or before ${effectiveYear} was carried forward unchanged. ` +
      `The figures are shown with the year they were published for and have NOT been re-dated to ${effectiveYear}.`
    : `State appraiser adjustment rates for ${stateUpper}: the ${effectiveYear} guideline vintage is in force.`

  return {
    state: stateUpper,
    requestedYear: effectiveYear,
    rates: map,
    vintagesUsed,
    newestVintage,
    oldestVintage,
    carriedForward,
    readFailed: false,
    vintageNote,
  }
}

/**
 * Format the resolved rates into a human-readable block for the AI-CMA prompt.
 *
 * WHAT THIS BLOCK IS FOR, and what it used to claim to be for. The header line
 * used to instruct the model to pick a figure from each low-high band according
 * to how similar the comp was — an instruction it had no way to carry out and no
 * way to have honoured if it had. Every dollar figure is computed BEFORE the
 * model is called, from `mid`, by computeCompAdjustments below, and the same
 * prompt then tells the model the figures are not its to revise. Asking for a
 * choice the caller then discards is how a model is invited to narrate a
 * selection that never happened.
 *
 * So the block now states what is true: the typical (mid) figure was applied,
 * the band is shown so the narrative can say where the applied figure sits
 * inside the published range, and the vintage of each row is named.
 */
export function formatRatesForPrompt(resolved: ResolvedAdjustmentRates): string {
  const { state, rates } = resolved
  if (rates.size === 0) {
    return (
      `No state appraiser adjustment rates are loaded for ${state}. ${resolved.vintageNote} ` +
      `No state-rate adjustment has been applied to the comparables; do not supply, estimate or infer a rate.`
    )
  }
  const lines: string[] = [
    `State: ${state.toUpperCase()} — Sales-Comparison Adjustment Rates ACTUALLY APPLIED`,
    `(${resolved.vintageNote})`,
    `(The TYPICAL figure below is the one that was applied to every comp, deterministically. The low-high band is`,
    ` published context so you can say where the applied figure sits within it — it is not a range to choose from,`,
    ` and the dollar amounts are already computed. % rates are of the comp's sale price.)`,
    "",
  ]
  for (const [type, r] of rates) {
    const fmtPct = (n: number) => `${(n * 100).toFixed(2)}%`
    const fmtDollar = (n: number) => `$${n.toLocaleString()}`
    const fmt = r.rateBasis === "pct_of_comp_price" ? fmtPct : fmtDollar
    // The vintage is named on EVERY line, not only the carried-forward ones: a
    // marker that appears only when something is wrong teaches a reader to treat
    // its absence as a guarantee, and one line of a mixed set being current says
    // nothing about the next.
    lines.push(
      `  • ${labelOf(type)}: applied ${fmt(r.mid)} ${r.unit} ` +
        `(published band ${fmt(r.low)}–${fmt(r.high)}; ${r.effectiveYear} vintage` +
        (r.effectiveYear < resolved.requestedYear ? `, carried forward to ${resolved.requestedYear}` : "") +
        `)` +
        (r.notes ? `\n      ${r.notes}` : "") +
        (r.source ? ` [${r.source}]` : "")
    )
  }
  return lines.join("\n")
}

const LABELS: Record<AdjustmentType, string> = {
  sqft_living: "Living area (per sqft difference)",
  bedroom: "Bedroom (per bedroom difference)",
  full_bath: "Full bath (per bath difference)",
  half_bath: "Half bath (per bath difference)",
  garage_space: "Garage space (per space difference)",
  pool_inground: "In-ground pool (binary)",
  waterfront: "Waterfront (binary)",
  view_premium: "Significant view (binary)",
  lot_size_acre: "Lot size (per acre difference)",
  year_built_decade: "Age (per decade older than comp)",
  condition_grade: "Condition (per grade difference, 1-5)",
  basement_finished: "Finished basement (binary)",
  new_construction: "New construction premium (binary, ≤2 yrs)",
  gated_community: "Gated community (binary)",
  time_market_trend: "Time-of-sale (per month between comp date and effective date)",
}

function labelOf(t: AdjustmentType): string {
  return LABELS[t] ?? t
}

/**
 * Apply the rate map to derive a single adjustment dollar amount for a comp
 * vs the subject. Used as a deterministic backstop / sanity check on the
 * AI's narrative — the math result must be within the published rate range.
 *
 * Returns the line-item adjustments that, when summed, give an "adjusted
 * sale price" (comp.salePrice + total adjustments).
 */
export interface SubjectFeatures {
  sqftLiving?: number | null
  bedrooms?: number | null
  fullBaths?: number | null
  halfBaths?: number | null
  garageSpaces?: number | null
  hasPool?: boolean | null
  isWaterfront?: boolean | null
  hasView?: boolean | null
  lotSizeAcres?: number | null
  yearBuilt?: number | null
  conditionGrade?: number | null   // 1-5
  basementFinished?: boolean | null
  isNewConstruction?: boolean | null
  isGated?: boolean | null
}

export interface CompFeatures extends SubjectFeatures {
  salePrice: number
  saleDate: string  // ISO
}

export interface CompAdjustment {
  type: AdjustmentType
  amount: number       // signed dollars
  rationale: string
  rateUsed: number     // the rate applied (pct or dollars) — always the published mid
  rateBasis: "pct_of_comp_price" | "per_unit_dollars"
  /**
   * The guideline vintage of the rate that produced `amount`. Rides on the LINE
   * ITEM, not only on the report header, because these lines are persisted to
   * cma_price_adjustments and read back by the appraisal-defense packet long
   * after the header is gone.
   */
  rateEffectiveYear: number
}

export function computeCompAdjustments(input: {
  subject: SubjectFeatures
  comp: CompFeatures
  rates: AdjustmentRateMap
  effectiveDate?: string  // ISO; defaults to today
}): { adjustments: CompAdjustment[]; adjustedPrice: number } {
  const { subject, comp, rates } = input
  const effective = input.effectiveDate ? new Date(input.effectiveDate) : new Date()
  const adjustments: CompAdjustment[] = []

  // ─── TOMBSTONE · apply(..., rateOverride?: number) ────────────────────────
  // REMOVED. The fifth parameter was declared here and NEVER PASSED: every one
  // of the nine call sites below supplies four arguments (covering all fourteen
  // adjustment types), so the branch selecting it was unreachable from the day
  // it was written.
  //
  // It is removed rather than wired, and the difference matters. The only actor
  // in this lane with an opinion about WHICH figure inside a published band fits
  // a given comp is the narrative model, and the model is structurally barred
  // from the dollar math (lib/cma/ai-cma-orchestrator.ts:13 — "applied per comp
  // DETERMINISTICALLY (no model in the math)", proven by cma-provider-lane
  // check E1). Wiring the parameter would have handed the one caller that could
  // ever fill it exactly the authority this lane exists to deny it.
  //
  // WHAT SUPERSEDES IT: `AdjustmentRate.mid` — the published TYPICAL figure of
  // whichever vintage getStateAdjustmentRates resolved — read at
  // lib/cma/state-adjustment-rates.ts:427 below, and reported on every line via
  // `rateUsed` + `rateEffectiveYear`. A brokerage that needs a different figure
  // changes the rate ROW (or its vintage); it does not pass a fifth argument.
  const apply = (
    type: AdjustmentType,
    rationale: string,
    direction: 1 | -1,
    multiplier: number,  // e.g., sqft difference, # of beds difference
  ) => {
    const rate = rates.get(type)
    if (!rate || multiplier === 0) return
    const r = rate.mid
    const amount =
      rate.rateBasis === "pct_of_comp_price"
        ? direction * comp.salePrice * r * multiplier
        : direction * r * multiplier
    adjustments.push({
      type,
      amount: Math.round(amount),
      rationale,
      rateUsed: r,
      rateBasis: rate.rateBasis,
      rateEffectiveYear: rate.effectiveYear,
    })
  }

  // sqft_living
  if (subject.sqftLiving != null && comp.sqftLiving != null) {
    const diff = subject.sqftLiving - comp.sqftLiving
    if (diff !== 0) apply("sqft_living", `Sqft diff ${diff}`, diff > 0 ? 1 : -1, Math.abs(diff))
  }

  // bedrooms
  if (subject.bedrooms != null && comp.bedrooms != null) {
    const diff = subject.bedrooms - comp.bedrooms
    if (diff !== 0) apply("bedroom", `${Math.abs(diff)} bedroom diff`, diff > 0 ? 1 : -1, Math.abs(diff))
  }

  // full_bath
  if (subject.fullBaths != null && comp.fullBaths != null) {
    const diff = subject.fullBaths - comp.fullBaths
    if (diff !== 0) apply("full_bath", `${Math.abs(diff)} full bath diff`, diff > 0 ? 1 : -1, Math.abs(diff))
  }

  // half_bath
  if (subject.halfBaths != null && comp.halfBaths != null) {
    const diff = subject.halfBaths - comp.halfBaths
    if (diff !== 0) apply("half_bath", `${Math.abs(diff)} half bath diff`, diff > 0 ? 1 : -1, Math.abs(diff))
  }

  // garage_space
  if (subject.garageSpaces != null && comp.garageSpaces != null) {
    const diff = subject.garageSpaces - comp.garageSpaces
    if (diff !== 0) apply("garage_space", `${Math.abs(diff)} garage space diff`, diff > 0 ? 1 : -1, Math.abs(diff))
  }

  // binary features
  const binary = (
    type: AdjustmentType,
    subjectVal: boolean | null | undefined,
    compVal: boolean | null | undefined,
    label: string
  ) => {
    if (subjectVal == null || compVal == null || subjectVal === compVal) return
    apply(type, `${label} (${subjectVal ? "subject has, comp doesn't" : "comp has, subject doesn't"})`, subjectVal ? 1 : -1, 1)
  }
  binary("pool_inground", subject.hasPool, comp.hasPool, "Pool")
  binary("waterfront", subject.isWaterfront, comp.isWaterfront, "Waterfront")
  binary("view_premium", subject.hasView, comp.hasView, "View")
  binary("basement_finished", subject.basementFinished, comp.basementFinished, "Finished basement")
  binary("new_construction", subject.isNewConstruction, comp.isNewConstruction, "New construction")
  binary("gated_community", subject.isGated, comp.isGated, "Gated community")

  // lot_size_acre
  if (subject.lotSizeAcres != null && comp.lotSizeAcres != null) {
    const diff = subject.lotSizeAcres - comp.lotSizeAcres
    if (Math.abs(diff) >= 0.05) apply("lot_size_acre", `Lot diff ${diff.toFixed(2)} acres`, diff > 0 ? 1 : -1, Math.abs(diff))
  }

  // year_built_decade — subject older than comp = downward
  if (subject.yearBuilt != null && comp.yearBuilt != null) {
    const decadeDiff = (subject.yearBuilt - comp.yearBuilt) / 10
    if (Math.abs(decadeDiff) >= 0.5) {
      // year_built rate is negative when subject is older — multiplier is decadeDiff (signed)
      apply(
        "year_built_decade",
        `Subject ${decadeDiff > 0 ? "newer" : "older"} by ${Math.abs(decadeDiff).toFixed(1)} decades`,
        decadeDiff > 0 ? 1 : -1,
        Math.abs(decadeDiff)
      )
    }
  }

  // condition_grade
  if (subject.conditionGrade != null && comp.conditionGrade != null) {
    const diff = subject.conditionGrade - comp.conditionGrade
    if (diff !== 0) apply("condition_grade", `Condition diff ${diff} grade(s)`, diff > 0 ? 1 : -1, Math.abs(diff))
  }

  // time_market_trend — months between comp.saleDate and effective
  const compDate = new Date(comp.saleDate)
  const monthsSince = (effective.getTime() - compDate.getTime()) / (30.44 * 24 * 60 * 60 * 1000)
  if (monthsSince > 0.5) {
    apply("time_market_trend", `${monthsSince.toFixed(1)} months since comp sale`, 1, monthsSince)
  }

  const adjustedPrice = comp.salePrice + adjustments.reduce((s, a) => s + a.amount, 0)
  return { adjustments, adjustedPrice }
}
