/**
 * STATE APPRAISER ADJUSTMENT RATES
 *
 * Reader + prompt formatter + comp-adjustment helpers for the AI-CMA flow.
 * Each state has rate ranges per adjustment type (sqft, beds, baths, pool,
 * waterfront, etc.). The AI is given the rates as context so its sales-
 * comparison adjustments are defensible against the state's published
 * starting points rather than guessed.
 *
 * Rate basis:
 *   'pct_of_comp_price' — adjustment as % of comp's sale price (auto-scales
 *                          with market). Most adjustments use this basis so
 *                          the same rates work in $200k markets and $2M
 *                          markets without re-seeding.
 *   'per_unit_dollars'  — fixed dollar amount per unit (rare; reserved for
 *                          features that don't scale with home price).
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
}

export type AdjustmentRateMap = Map<AdjustmentType, AdjustmentRate>

/**
 * Get all adjustment rates for a state. Falls back to 'US' default for any
 * adjustment type not explicitly seeded for the state.
 */
export async function getStateAdjustmentRates(
  state: string
): Promise<AdjustmentRateMap> {
  const supabase = createServiceClient()
  const stateUpper = state.toUpperCase().slice(0, 2)

  // Query state-specific rows + 'US' default in one shot
  const { data, error } = await supabase
    .from("state_appraiser_adjustment_rates")
    .select(
      "state, adjustment_type, rate_basis, typical_rate_low, typical_rate_mid, typical_rate_high, unit, notes, source"
    )
    .in("state", [stateUpper, "US"])

  const map: AdjustmentRateMap = new Map()
  if (error || !data) return map

  // Pass 1: load 'US' defaults
  for (const row of data as Array<{
    state: string
    adjustment_type: string
    rate_basis: "pct_of_comp_price" | "per_unit_dollars"
    typical_rate_low: number
    typical_rate_mid: number
    typical_rate_high: number
    unit: string
    notes: string | null
    source: string | null
  }>) {
    if (row.state === "US") {
      map.set(row.adjustment_type as AdjustmentType, {
        state: "US",
        adjustmentType: row.adjustment_type as AdjustmentType,
        rateBasis: row.rate_basis,
        low: Number(row.typical_rate_low),
        mid: Number(row.typical_rate_mid),
        high: Number(row.typical_rate_high),
        unit: row.unit,
        notes: row.notes,
        source: row.source,
      })
    }
  }

  // Pass 2: state-specific rows override the US defaults
  for (const row of data as Array<{
    state: string
    adjustment_type: string
    rate_basis: "pct_of_comp_price" | "per_unit_dollars"
    typical_rate_low: number
    typical_rate_mid: number
    typical_rate_high: number
    unit: string
    notes: string | null
    source: string | null
  }>) {
    if (row.state === stateUpper) {
      map.set(row.adjustment_type as AdjustmentType, {
        state: stateUpper,
        adjustmentType: row.adjustment_type as AdjustmentType,
        rateBasis: row.rate_basis,
        low: Number(row.typical_rate_low),
        mid: Number(row.typical_rate_mid),
        high: Number(row.typical_rate_high),
        unit: row.unit,
        notes: row.notes,
        source: row.source,
      })
    }
  }

  return map
}

/**
 * Format the rate map into a human-readable block to inject into AI-CMA
 * prompts. The AI uses these as the published starting points and selects
 * within the low-high range based on each comp's similarity to the subject.
 */
export function formatRatesForPrompt(state: string, rates: AdjustmentRateMap): string {
  if (rates.size === 0) {
    return `No state-specific adjustment rates loaded for ${state}. Use industry-default sales-comparison adjustment ranges.`
  }
  const lines: string[] = [
    `State: ${state.toUpperCase()} — Sales-Comparison Adjustment Starting Points`,
    `(Apply each within the low-high range based on comp similarity. % rates are of the comp's sale price.)`,
    "",
  ]
  for (const [type, r] of rates) {
    const fmtPct = (n: number) => `${(n * 100).toFixed(2)}%`
    const fmtDollar = (n: number) => `$${n.toLocaleString()}`
    const fmt = r.rateBasis === "pct_of_comp_price" ? fmtPct : fmtDollar
    lines.push(
      `  • ${labelOf(type)}: ${fmt(r.low)}–${fmt(r.high)} (typical ${fmt(r.mid)}) ${r.unit}` +
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
  rateUsed: number     // the rate applied (pct or dollars)
  rateBasis: "pct_of_comp_price" | "per_unit_dollars"
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

  const apply = (
    type: AdjustmentType,
    rationale: string,
    direction: 1 | -1,
    multiplier: number,  // e.g., sqft difference, # of beds difference
    rateOverride?: number
  ) => {
    const rate = rates.get(type)
    if (!rate || multiplier === 0) return
    const r = rateOverride ?? rate.mid
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
