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
// RAILS ADDED IN THE ROUND-36 EXCLUSION AUDIT (each earned its way in):
//   deal_outcome         ai_predictions gained a REAL outcome writer: the
//                        close-time grader in lib/analytics/ai-prediction-outcomes
//                        stamps actual_outcome/outcome_date when a transaction
//                        reaches a terminal stage (CLOSED/LOST — real events),
//                        and transactions.win_probability is FROZEN onto the same
//                        ledger at every AI write (snapshot rows, so the mutable
//                        column can never grade itself in hindsight). Only the
//                        FIRST pre-outcome call per deal is graded.
//   home_value_avm       home_value_estimates joined to a SOLD listing by strict
//                        normalized street+ZIP within the same brokerage — a key
//                        that matches more than one sold listing (or none) is
//                        REFUSED, never guessed. The estimate's own low–high band
//                        is the source-defined tolerance.
//   listing_propensity   the IMMUTABLE trigger ledger predictive_listing_actions
//                        (score frozen at the moment the play fired) graded
//                        against a real later listings row for the same contact
//                        within a declared 180-day window. The mutable
//                        predictive_listing_scores upsert row is NOT graded (its
//                        history is overwritten — see exclusions).
//   income_forecast      income_forecast_snapshots.weighted_30 reconciled against
//                        the CLOSED-transaction GCI actually recorded in the 30
//                        days after each snapshot; the snapshot's own
//                        low/high-band percentages are the source tolerance.
//
// RAIL ADDED IN ROUND 38 (rec 2 — the assignment-policy grading loop):
//   assignment_policy    assignment_log records WHICH assignment_rules row (or
//                        fallback method) routed every qualified lead AT
//                        assignment time; the outcome is a real first booked
//                        appointment (calendar_events isa/listing appointments +
//                        showings) within a declared 30-day horizon. Adapter
//                        lives in lib/analytics/assignment-outcomes.ts (it also
//                        hosts the deliberation-feed sweep, so the read-only
//                        rule below stays true of THIS module).
//
// RAILS DELIBERATELY EXCLUDED (and why — auditable, not forgotten):
//   buyer_behavior_predictions   UPSERT ON CONFLICT (contact_id) with a 24h
//                                expires_at — every regeneration DESTROYS the
//                                prior prediction, so by the time a 30–60-day
//                                offer window has elapsed the surviving row is no
//                                longer the prediction that was acted on. Grading
//                                survivors would be selection-biased, not accuracy.
//   predictive_listing_scores    same mutability problem (upsert per contact),
//                                carried honestly by listing_propensity via the
//                                immutable predictive_listing_actions ledger.
//   ai_predictions lead_conversion rows — only the POSITIVE outcome (converted →
//                                closed deal) is observable event-driven; the
//                                negative needs a horizon sweep on the cron rail
//                                (owned elsewhere this round). The close-time
//                                grader records conversions for ledger
//                                completeness, but a hit-rate over positives-only
//                                would be survivorship, so the rail skips them.
//   deal velocity                a measurement (decision→execution time), not a
//                                prediction.

import type { SupabaseClient } from "@supabase/supabase-js"
import { medianOf, type AccuracyLine, type ClosingCostSide } from "@/lib/offers/closing-cost-accuracy"
import { MATERIAL_ABS, MATERIAL_PCT } from "@/lib/net-sheet/net-sheet-reconciler"
import { applyTenantScope, platformScope, tenantScope, type TenantScope } from "@/lib/kernel/tenant-scope"

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
  | "deal_outcome"
  | "home_value_avm"
  | "listing_propensity"
  | "income_forecast"
  | "assignment_policy"

export interface RailMedianError {
  value: number
  /** unit of the median error value */
  unit: "usd" | "pct_of_sale" | "days" | "people" | "score_points" | "probability_pts"
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
  /** ADDITIVE: how to READ medianError on THIS row. Absent = "usd", which is
   *  what every breakdown row meant before the content rail gained rows in
   *  score points and percentage points (the panel hardcoded a `±$` prefix, so
   *  a rate would have rendered as dollars). Deliberately a breakdown-local
   *  union and NOT a member of RailMedianError["unit"]: the accuracy gate
   *  (lib/managers/accuracy-gate.ts fmtMetric) switches exhaustively over that
   *  union with no default, and this rail's HEADLINE unit must stay
   *  "score_points" or the marketing_content autonomy bar stops matching. */
  unit?: "usd" | "score_points" | "pct_points"
  /** ADDITIVE: rows this group covers that have no outcome yet. Rendered as
   *  "not yet measured" — never as a zero. */
  pending?: number
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
  /** ADDITIVE (round 36): buyer/seller split where the rail's ledger carries a
   *  side discriminator (closing_costs). Absent everywhere else. */
  sideBreakdown?: RailBreakdownRow[]
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

// CENSUS NOTE (orphan-export category B — LIVE, not a backlog): every summarize*Rows,
// fractionalMedian and gradablePricePairs export in this module is called IN-FILE by its
// rail adapter, every adapter runs inside getPredictionAccuracyReport (below), and the
// report is rendered rail-by-rail by app/components/analytics/prediction-accuracy-panel.tsx:79
// (mounted from app/dashboard/analytics/page.tsx and superadmin/platform/page.tsx). They are
// exported for scripts/prediction-accuracy-simulator.ts and seller-closing-costs-simulator.ts.

/** True fractional median (medianOf from the closing-cost module rounds to
 *  whole dollars — right for money, wrong for percentage errors). */
export function fractionalMedian(values: number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** PURE: normalize a probability that may be stored 0..1 or 0..100 to 0..1.
 *  Out-of-range / non-numeric → null (refused, never clamped into a claim). */
export function normalizeProbability(v: unknown): number | null {
  const n = num(v)
  if (n == null || n < 0) return null
  if (n <= 1) return n
  if (n <= 100) return n / 100
  return null
}

// Street-suffix / directional canonicalization for the honest address join.
const STREET_TOKEN_CANON: Record<string, string> = {
  street: "st", avenue: "ave", av: "ave", boulevard: "blvd", drive: "dr", lane: "ln",
  road: "rd", court: "ct", circle: "cir", place: "pl", terrace: "ter", highway: "hwy",
  parkway: "pkwy", trail: "trl", square: "sq", north: "n", south: "s", east: "e",
  west: "w", northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
}

/** PURE: strict normalized join key for the AVM rail — street line + 5-digit ZIP.
 *  Refuses (null) anything without a leading street number and a real ZIP; unit /
 *  suite designators are stripped so "Apt 2" never forks the key. */
export function normalizeAddressKey(street: string | null | undefined, zip: string | null | undefined): string | null {
  if (!street || !zip) return null
  const zip5 = String(zip).trim().slice(0, 5)
  if (!/^\d{5}$/.test(zip5)) return null
  const tokens = String(street)
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(/\b(?:apt|apartment|unit|suite|ste)\b\s*\S*/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => STREET_TOKEN_CANON[t] ?? t)
  if (tokens.length < 2 || !/^\d+$/.test(tokens[0])) return null
  return `${tokens.join(" ")}|${zip5}`
}

// ─── Rail 1: CLOSING COSTS (the round-34 flywheel, merged in keep-one) ───────

export interface ClosingCostObsRow {
  state: string
  lines: AccuracyLine[]
  created_at: string | null
  /** ADDITIVE (round 36): 'buyer' | 'seller'. Rows written before migration
   *  1105 carry no side column — they are buyer-side by construction. */
  side?: string | null
  // ── THE SAMPLE'S OWN PROVENANCE (wave H5) ─────────────────────────────────
  // The rail's first honest note already CLAIMS the provenance rule ("human-
  // verified or high/medium-confidence scans") and the m1104 writer already
  // records which half each observation landed on — but nothing read it, so
  // the claim was a promise the surface could not evidence. CLAUDE.md §2:
  // publish the blind spots beside the number. These four are the denominator
  // of the accuracy figure, not decoration.
  /** true when at least one ledger row behind this observation was human-verified */
  extraction_verified?: boolean | null
  /** which CD field_keys were provenance-usable here (of CD_ACCURACY_FIELD_KEYS) */
  extracted_field_keys?: string[] | null
  /** the deal the estimate was recomputed from — the accuracy's scale */
  purchase_price?: number | string | null
  /** null = no loan figure was known, so lender-dependent lines were NOT graded */
  loan_amount?: number | string | null
  /** the CD's own section-J total. NEVER compared to the estimate total (it nets
   *  lender credits); used only to scale the per-line error into a share. */
  total_closing_costs?: number | string | null
  // ── CONTEXT ONLY, NEVER AN ERROR TERM ────────────────────────────────────
  // Both are written on every observation (lib/offers/closing-cost-accuracy.ts:498
  // and :632 on the buyer side, :632-633 on the seller side) and were read by
  // nothing. They are admitted here as SAMPLE DESCRIPTION and nowhere else: the
  // rail's honesty contract (see the note at :16 and the section-J rule at :192)
  // is that only a line the estimator actually predicted may be scored, and
  // neither of these is such a line.
  /** The count the writer recorded beside `lines`. Read back as an INTEGRITY
   *  check on the sample — if it disagrees with the array that arrived, the
   *  observation was truncated in transit and the denominator is wrong. */
  line_count?: number | string | null
  /** The CD's cash-to-close (buyer side only; the seller writer stores null by
   *  construction). Describes the deals the accuracy was measured on. NEVER
   *  differenced against anything — no estimator predicts it. */
  cash_to_close?: number | string | null
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

  // BUYER/SELLER breakdown (round 36 — additive; the rail's shape is unchanged).
  // Missing side = pre-1105 row = buyer-side by construction, never guessed.
  // Keyed by the ONE side vocabulary (lib/offers/closing-cost-accuracy.ts
  // ClosingCostSide), not by a bare string: the normalizer below is the only
  // place a stored value becomes a group, and typing its output means a third
  // spelling cannot enter this breakdown without failing type-check.
  const bySide = new Map<ClosingCostSide, { lines: AccuracyLine[]; observations: number }>()
  for (const r of graded) {
    const side: ClosingCostSide = r.side === "seller" ? "seller" : "buyer"
    const bucket = bySide.get(side) ?? { lines: [], observations: 0 }
    bucket.lines.push(...r.lines)
    bucket.observations += 1
    bySide.set(side, bucket)
  }
  const sideBreakdown: RailBreakdownRow[] = [...bySide.entries()]
    .map(([side, b]) => ({
      group: side,
      observations: b.observations,
      withinRate: round2(b.lines.filter((l) => l.withinBand).length / b.lines.length),
      medianError: medianOf(b.lines.map((l) => Math.abs(l.deltaFromMid))),
    }))
    .sort((a, b) => a.group.localeCompare(b.group))
  const sellerObs = bySide.get("seller")?.observations ?? 0
  const medianLineError = medianOf(allLines.map((l) => Math.abs(l.deltaFromMid)))

  return {
    ...CLOSING_COSTS_BASE,
    available: true,
    why: null,
    observations: graded.length,
    medianError: {
      value: medianLineError,
      unit: "usd",
      label: "median |actual − estimate-band midpoint| per graded line",
    },
    withinRate: {
      rate: round2(withinCount / allLines.length),
      label: "graded lines whose actual landed inside the quoted low–high band",
    },
    period: periodOf(graded.map((r) => r.created_at)),
    breakdown,
    sideBreakdown,
    honestNotes: [
      ...CLOSING_COSTS_BASE.honestNotes,
      ...(sellerObs > 0
        ? ["Seller-side observations grade commission / title-and-settlement / transfer-tax lines against the settlement statement; buyer-side grades the CD's borrower-paid column."]
        : []),
      ...describeClosingCostSample(graded, medianLineError),
    ],
  }
}

/**
 * PURE: the sample's own provenance, stated beside the accuracy number.
 *
 * WHY THIS EXISTS (wave H5). `extraction_verified`, `extracted_field_keys`,
 * `purchase_price` and `loan_amount` were written by BOTH observation writers
 * (lib/offers/closing-cost-accuracy.ts:493-501 and :625-632) and read by
 * nothing — while the rail's own first honest note asserted the provenance
 * rule they record. An unread provenance column is an unmade check: a rail
 * built entirely on unverified scans and one built on human-verified ledger
 * rows rendered as the same number, and a reviewer could not tell which they
 * were looking at. Each line here is measured off the graded rows or omitted
 * — a missing column produces NO line rather than a fabricated one, so a
 * pre-m1104 read and a genuinely unverified sample never look alike.
 */
function describeClosingCostSample(rows: ClosingCostObsRow[], medianLineError: number): string[] {
  const notes: string[] = []
  const n = rows.length
  if (n === 0) return notes

  // (1) PROVENANCE. Only rows that actually carry the flag are counted, so a
  // legacy row with no column can never be silently scored as "unverified".
  const withFlag = rows.filter((r) => typeof r.extraction_verified === "boolean")
  if (withFlag.length > 0) {
    const verified = withFlag.filter((r) => r.extraction_verified === true).length
    notes.push(
      `Provenance: ${verified} of ${withFlag.length} observation(s) used at least one HUMAN-VERIFIED extraction; ` +
      `the remainder are high/medium-confidence scans` +
      (withFlag.length < n ? ` (${n - withFlag.length} row(s) carry no provenance flag and are excluded from this count).` : "."),
    )
  }

  // (2) COVERAGE — the denominator. How much of the CD each observation could
  // actually see; a thin extraction grades fewer lines, which is why the line
  // count and the observation count are different quantities.
  const keyCounts = rows
    .map((r) => (Array.isArray(r.extracted_field_keys) ? r.extracted_field_keys.length : null))
    .filter((v): v is number => v != null)
  if (keyCounts.length > 0) {
    const distinct = new Set<string>()
    for (const r of rows) for (const k of r.extracted_field_keys ?? []) distinct.add(k)
    notes.push(
      `Extraction coverage: median ${fractionalMedian(keyCounts)} provenance-usable field(s) per observation ` +
      `across ${distinct.size} distinct CD field key(s) — lines whose figure was absent are NOT graded.`,
    )
  }

  // (3) SCALE. An identical dollar error means very different things on a
  // $180k and a $2.4M deal, so the price range the accuracy was measured on
  // is stated rather than left for the reader to assume.
  const prices = rows.map((r) => num(r.purchase_price)).filter((v): v is number => v != null && v > 0)
  if (prices.length > 0) {
    const sorted = [...prices].sort((a, b) => a - b)
    const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`
    notes.push(
      `Measured on ${prices.length} deal(s) from ${usd(sorted[0])} to ${usd(sorted[sorted.length - 1])} ` +
      `(median ${usd(fractionalMedian(prices))}).`,
    )
  }

  // (4) WHY A LENDER LINE MAY BE THIN. Lender's-title and other loan-dependent
  // lines are only gradeable where a loan figure was known.
  const loanKnown = rows.filter((r) => num(r.loan_amount) != null).length
  const loanColumnPresent = rows.some((r) => r.loan_amount !== undefined)
  if (loanColumnPresent) {
    notes.push(
      `${loanKnown} of ${n} observation(s) had a known loan amount — loan-dependent lines (lender's title) ` +
      `are graded only there, never estimated from a missing loan.`,
    )
  }

  // (4b) SAMPLE INTEGRITY. line_count is what the WRITER recorded beside the
  // lines array; the array is what actually arrived. They should agree on every
  // row, and a disagreement means the graded denominator is not the denominator
  // that was measured — a blind spot published beside the number rather than
  // discovered later (CLAUDE.md §2). Rows with no count are excluded from the
  // comparison, never scored as a mismatch.
  const countable = rows.filter((r) => num(r.line_count) != null && Array.isArray(r.lines))
  const countMismatch = countable.filter((r) => num(r.line_count) !== r.lines.length).length
  if (countable.length > 0 && countMismatch > 0) {
    notes.push(
      `Sample integrity: ${countMismatch} of ${countable.length} observation(s) carry a recorded line count that ` +
      `disagrees with the lines actually stored — the graded line total for those rows is not what was measured.`,
    )
  }

  // (4c) WHOSE DEALS, IN THE BUYER'S OWN TERMS. cash_to_close is CONTEXT: it says
  // what size of cash requirement these estimates were sitting behind. It is
  // deliberately NOT differenced against anything — no estimator on this rail
  // predicts cash-to-close, and treating it as an outcome would manufacture an
  // error term for a prediction nobody made. The seller-side writer stores null,
  // so this describes the buyer-side subset and says so.
  const cash = rows.map((r) => num(r.cash_to_close)).filter((v): v is number => v != null && v > 0)
  if (cash.length > 0) {
    const sortedCash = [...cash].sort((a, b) => a - b)
    const usdC = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`
    notes.push(
      `Context (not graded): the ${cash.length} observation(s) that recorded a cash-to-close ranged ` +
      `${usdC(sortedCash[0])} to ${usdC(sortedCash[sortedCash.length - 1])}, median ` +
      `${usdC(fractionalMedian(cash))}. Cash-to-close is never compared to an estimate — nothing predicts it.`,
    )
  }

  // (5) THE ERROR IN CONTEXT. Scaled against the CD's OWN section-J total, not
  // against the estimate total — the honesty contract forbids that comparison
  // (section J nets lender credits; it is not the estimated quantity).
  const cdTotals = rows.map((r) => num(r.total_closing_costs)).filter((v): v is number => v != null && v > 0)
  if (cdTotals.length > 0 && medianLineError > 0) {
    const medTotal = fractionalMedian(cdTotals)
    notes.push(
      `For scale, the median graded line error is ${round2((medianLineError / medTotal) * 100)}% of the median ` +
      `CD section-J total ($${Math.round(medTotal).toLocaleString("en-US")}) on the ${cdTotals.length} observation(s) ` +
      `that carried one. Section J is NEVER compared to the estimate total — it only scales the error.`,
    )
  }

  return notes
}

async function closingCostsAdapter(svc: Svc, brokerageId?: string): Promise<RailAccuracy> {
  const buildQuery = (withSide: boolean) => {
    // The provenance/scale columns (m1104) are selected in BOTH shapes — only
    // `side` is m1105-dependent, so the legacy retry keeps the sample profile.
    // Written as two plain LITERALS on purpose: the opposite-missing census
    // parses select() arguments as strings, and a template literal would make
    // this read unparseable — which drops the whole table from the
    // written-never-read direction and would read as a fix instead of a
    // blind spot (CLAUDE.md §2).
    let q = svc.from("closing_cost_accuracy_observations")
      .select(withSide
        ? "state, lines, created_at, extraction_verified, extracted_field_keys, purchase_price, loan_amount, total_closing_costs, line_count, cash_to_close, side"
        : "state, lines, created_at, extraction_verified, extracted_field_keys, purchase_price, loan_amount, total_closing_costs, line_count, cash_to_close")
      .order("created_at", { ascending: false })
      .limit(2000)
    if (brokerageId) q = q.eq("brokerage_id", brokerageId)
    return q
  }
  let { data, error } = await buildQuery(true)
  if (error) {
    // Pre-1105 ledger has no side column — every row is buyer-side; retry the
    // legacy shape so the rail keeps reporting instead of going dark.
    ;({ data, error } = await buildQuery(false))
  }
  if (error) return unavailable(CLOSING_COSTS_BASE, `ledger unreadable: ${error.message}`)
  return summarizeClosingCostRows((data ?? []) as unknown as ClosingCostObsRow[])
}

// ─── Rail 2: NET SHEET (promised seller net vs settled net) ──────────────────

export interface NetSheetReconRow {
  estimated_net: number | null
  actual_net: number | null
  variance_amount: number | null
  surprise_level: string
  created_at: string | null
  // ── DID THE SURPRISE ACTUALLY REACH A HUMAN? (wave H5) ────────────────────
  // lib/net-sheet/net-sheet-guard-runner.ts:211 records `escalated` on every
  // reconciliation, and the whole point of the surprise guard is that a
  // material negative surprise ARMS the agent before the seller feels
  // blindsided. Nothing read the flag, so a run where every escalation was
  // refused (no agent user, a dead notifications insert, a bus publish that
  // failed) rendered EXACTLY like a run where every one landed. An unread
  // escalation flag is an unmade check.
  /** true when a notification and/or a manager signal was actually published */
  escalated?: boolean | null
  /** varianceAmount / |estimatedNet| as recorded at reconciliation time */
  variance_pct?: number | string | null
  /** per-line deltas as recorded; the most negative netImpact is the TOP DRIVER */
  line_item_deltas?: Array<{ key?: string; label?: string; netImpact?: number | null }> | null
  /** the offer whose seller_net_estimate was the promise (null = derived elsewhere) */
  offer_id?: string | null
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

  // ── THE ESCALATION CHECK. `flagged` is the guard's own definition: a
  // materially NEGATIVE surprise (concerning/severe). Those are the only rows
  // the runner ever tries to escalate, so they are the only honest denominator.
  const flagged = graded.filter((r) => r.surprise_level === "concerning" || r.surprise_level === "severe")
  const escalationKnown = flagged.filter((r) => typeof r.escalated === "boolean")
  const escalationNotes: string[] = []
  if (escalationKnown.length > 0) {
    const reached = escalationKnown.filter((r) => r.escalated === true).length
    const missed = escalationKnown.length - reached
    escalationNotes.push(
      `Escalation: ${reached} of ${escalationKnown.length} materially-negative surprise(s) actually reached a human ` +
      `(agent notification and/or a Deal-Coordinator → Listing-Concierge signal)` +
      (missed > 0
        ? ` — ${missed} did NOT, and the seller was not armed by this rail on those deals.`
        : "."),
    )
  } else if (flagged.length > 0) {
    escalationNotes.push(
      `${flagged.length} materially-negative surprise(s) carry no escalation flag — whether the agent was armed is UNKNOWN, not "fine".`,
    )
  }

  // The percentage view of the same gap, recorded at reconciliation time. The
  // dollar median above cannot say whether a $9k gap was 3% or 30% of the promise.
  const pcts = graded.map((r) => num(r.variance_pct)).filter((v): v is number => v != null)
  const pctNotes = pcts.length > 0
    ? [`Median recorded variance: ${round2(fractionalMedian(pcts.map((p) => Math.abs(p))) * 100)}% of the promised net across ${pcts.length} reconciliation(s).`]
    : []

  // Provenance of the PROMISE: an offer row on file vs a net derived elsewhere.
  const offerLinked = graded.filter((r) => r.offer_id != null).length
  const offerNotes = graded.some((r) => r.offer_id !== undefined)
    ? [`${offerLinked} of ${graded.length} reconciliation(s) name the offer whose seller-net estimate was the promise; the rest reconcile a net with no offer row on file.`]
    : []

  // ── TOP DRIVER BREAKDOWN. The single line most responsible for each negative
  // surprise, folded across the sample: which cost line keeps hurting sellers.
  const driverCount = new Map<string, { n: number; impacts: number[] }>()
  for (const r of flagged) {
    const deltas = Array.isArray(r.line_item_deltas) ? r.line_item_deltas : []
    let worst: { label: string; impact: number } | null = null
    for (const d of deltas) {
      const impact = num(d?.netImpact)
      if (impact == null || impact >= 0) continue          // only lines that HURT the net
      const label = (d?.label ?? d?.key ?? "").toString().trim()
      if (!label) continue
      if (!worst || impact < worst.impact) worst = { label, impact }
    }
    if (!worst) continue
    const bucket = driverCount.get(worst.label) ?? { n: 0, impacts: [] }
    bucket.n += 1
    bucket.impacts.push(Math.abs(worst.impact))
    driverCount.set(worst.label, bucket)
  }
  const driverBreakdown: RailBreakdownRow[] = [...driverCount.entries()]
    .map(([label, b]) => ({
      group: label,
      observations: b.n,
      withinRate: null,                                     // a driver has no tolerance of its own
      medianError: medianOf(b.impacts),
    }))
    .sort((a, b) => b.observations - a.observations || a.group.localeCompare(b.group))

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
    ...(driverBreakdown.length > 0 ? { breakdown: driverBreakdown } : {}),
    honestNotes: [
      ...NET_SHEET_BASE.honestNotes,
      ...escalationNotes,
      ...pctNotes,
      ...offerNotes,
      ...(driverBreakdown.length > 0
        ? ["The breakdown groups each negative surprise by the ONE line that hurt the net most — only lines present on both the estimate and the settlement can be a driver."]
        : []),
    ],
  }
}

async function netSheetAdapter(svc: Svc, brokerageId?: string): Promise<RailAccuracy> {
  let q = svc.from("net_sheet_reconciliations")
    .select("estimated_net, actual_net, variance_amount, variance_pct, surprise_level, escalated, line_item_deltas, offer_id, created_at")
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

// THE READER USED TO DISCARD THREE OF THE WRITER'S FOUR MEASUREMENTS.
// lib/content/performance-predictor.ts:313-326 writes actual_score, actual_ctr,
// actual_engagement_rate AND prediction_id into prediction_accuracy_log; this
// adapter selected `delta_score, logged_at` and nothing else, so the panel could
// report exactly ONE abstract number (median |Δ score|) and could not say WHICH
// call it graded. This rail gates EARNED AUTONOMY (lib/managers/accuracy-gate.ts
// → app/dashboard/admin/manager-trust), so what it shows has to be complete.
//
// The headline metric is UNCHANGED on purpose: the accuracy gate's
// marketing_content bar is "median engagement-score miss ≤ 15 score_points".
// The recovered measurements arrive as BREAKDOWN rows beside it.
export interface ContentAccuracyRow {
  delta_score: number | null
  logged_at: string | null
  // ── the three recorded measurements the reader used to drop ────────────────
  /** 0–100 engagement score actually observed. NULL until reconciliation lands
   *  — honest-NULL by design; it is "not yet measured", never zero. */
  actual_score?: number | null
  /** clicks / impressions, 0..1 (same scale the predictor writes predicted_ctr on) */
  actual_ctr?: number | null
  /** (likes+comments+shares) / impressions, 0..1 */
  actual_engagement_rate?: number | null
  /** FK → content_performance_predictions.id: WHICH prediction made the call */
  prediction_id?: string | null
  // ── resolved from content_performance_predictions (second, tenant-anchored read) ──
  predicted_score?: number | null
  predicted_ctr?: number | null
  predicted_engagement_rate?: number | null
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

/** PURE: median |predicted − actual| over rows where BOTH sides are present.
 *  Returns null (never 0) when no row has both — absent is absent. */
function pairedMedianAbs(
  rows: ContentAccuracyRow[],
  predicted: (r: ContentAccuracyRow) => number | null,
  actual: (r: ContentAccuracyRow) => number | null,
): { median: number | null; observations: number } {
  const deltas: number[] = []
  for (const r of rows) {
    const p = predicted(r)
    const a = actual(r)
    if (p == null || a == null) continue
    deltas.push(Math.abs(p - a))
  }
  return { median: deltas.length > 0 ? fractionalMedian(deltas) : null, observations: deltas.length }
}

/** PURE: content rail — median |delta_score| over logged outcomes, PLUS the
 *  predicted-vs-actual CTR and engagement-rate comparisons the log already
 *  carries, PLUS an explicit count of rows whose outcome has not landed yet. */
export function summarizeContentRows(rows: ContentAccuracyRow[]): RailAccuracy {
  const graded = rows.filter((r) => num(r.delta_score) != null)

  // A logged row with NO actual_* at all is a prediction awaiting
  // reconciliation, not a miss of zero (§ honest-NULL).
  const awaitingOutcome = rows.filter(
    (r) => num(r.actual_score) == null && num(r.actual_ctr) == null && num(r.actual_engagement_rate) == null,
  ).length
  const unlinked = rows.filter((r) => !r.prediction_id).length
  const linkedButUnresolved = rows.filter(
    (r) => !!r.prediction_id && r.predicted_score == null && r.predicted_ctr == null && r.predicted_engagement_rate == null,
  ).length

  if (graded.length === 0) {
    const why = rows.length === 0
      ? "No published content has its actual engagement logged against a prediction yet."
      : `${rows.length} prediction${rows.length === 1 ? " is" : "s are"} logged but none carries a graded score delta yet — ${awaitingOutcome} still awaiting reconciliation.`
    return unavailable(CONTENT_BASE, why)
  }

  const ctr = pairedMedianAbs(rows, (r) => num(r.predicted_ctr), (r) => num(r.actual_ctr))
  const eng = pairedMedianAbs(rows, (r) => num(r.predicted_engagement_rate), (r) => num(r.actual_engagement_rate))

  const breakdown: RailBreakdownRow[] = [
    {
      group: "Click-through rate — predicted vs actual",
      observations: ctr.observations,
      withinRate: null,
      // stored 0..1 on BOTH sides (predictor writes predicted_ctr = score/2000,
      // logger writes actual_ctr = clicks/impressions) → ×100 = percentage points
      medianError: ctr.median == null ? null : round2(ctr.median * 100),
      unit: "pct_points",
      pending: rows.length - ctr.observations,
    },
    {
      group: "Engagement rate — predicted vs actual",
      observations: eng.observations,
      withinRate: null,
      medianError: eng.median == null ? null : round2(eng.median * 100),
      unit: "pct_points",
      pending: rows.length - eng.observations,
    },
  ]

  const honestNotes = [
    ...CONTENT_BASE.honestNotes,
    `CTR and engagement rate are compared only where the prediction row still resolves and the outcome has landed — ${ctr.observations} and ${eng.observations} of ${rows.length} logged rows respectively.`,
    `${awaitingOutcome} logged prediction${awaitingOutcome === 1 ? "" : "s"} carr${awaitingOutcome === 1 ? "ies" : "y"} no recorded outcome yet — shown as "not yet measured", never as a zero miss.`,
    ...(unlinked > 0
      ? [`${unlinked} log row${unlinked === 1 ? "" : "s"} name${unlinked === 1 ? "s" : ""} no prediction_id, so the call behind ${unlinked === 1 ? "it" : "them"} cannot be identified.`]
      : []),
    ...(linkedButUnresolved > 0
      ? [`${linkedButUnresolved} log row${linkedButUnresolved === 1 ? "" : "s"} name a prediction_id that did not resolve in this tenant scope — excluded from the rate comparisons.`]
      : []),
  ]

  return {
    ...CONTENT_BASE,
    honestNotes,
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
    breakdown,
  }
}

/** `.in()` travels in the query STRING — 2000 uuids is a 414, not a result. */
function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
  return out
}

async function contentAdapter(svc: Svc, brokerageId?: string): Promise<RailAccuracy> {
  let q = svc.from("prediction_accuracy_log")
    // Every column the writer records. `actual_*` is honest-NULL until
    // reconciliation lands; `prediction_id` names the call being graded.
    .select("delta_score, logged_at, actual_score, actual_ctr, actual_engagement_rate, prediction_id")
    .order("logged_at", { ascending: false })
    .limit(2000)
  if (brokerageId) q = q.eq("brokerage_id", brokerageId)
  const { data, error } = await q
  if (error) return unavailable(CONTENT_BASE, `ledger unreadable: ${error.message}`)

  const rows = (data ?? []) as ContentAccuracyRow[]

  // ── Resolve the PREDICTION side ─────────────────────────────────────────────
  // prediction_accuracy_log.prediction_id → content_performance_predictions is
  // the pair's ONLY FK (scripts/schema-fk-map.ts:591), so an embed would be
  // PGRST201-safe — but a second read is used anyway so the join is
  // TENANT-ANCHORED ON ITS OWN ROW (content_performance_predictions carries its
  // own brokerage_id) rather than inherited through the parent.
  const predictionIds = [...new Set(
    rows.map((r) => r.prediction_id).filter((v): v is string => typeof v === "string" && v.length > 0),
  )]
  const predicted = new Map<string, { predicted_score: number | null; predicted_ctr: number | null; predicted_engagement_rate: number | null }>()
  let predictionSideRefusal: string | null = null

  // The prediction side is scoped through lib/kernel/tenant-scope rather than
  // the `if (brokerageId) q = q.eq(…)` shape the rest of this module still
  // carries: a missing tenant id must not decay into "every tenant". Platform
  // scope here is the SAME decision the log read above made, said out loud.
  const predictionScope: TenantScope = brokerageId
    ? tenantScope(brokerageId, "prediction accuracy · content rail (prediction side)")
    : platformScope("cross-tenant accuracy report — the superadmin platform analytics mount passes no brokerageId, and this read is the prediction half of the log rows already read at that same scope")

  for (const ids of chunk(predictionIds, 100)) {
    const pq = svc.from("content_performance_predictions")
      .select("id, predicted_score, predicted_ctr, predicted_engagement_rate")
      .in("id", ids)
    // Mutating form (as lib/kernel/command-center.ts:358 uses it): the builder is
    // filtered in place, so the deeply-generic PostgREST return type is never
    // re-inferred through applyTenantScope's own type parameter (TS2589).
    interface EqOnly { eq(column: string, value: string): EqOnly }
    applyTenantScope(pq as unknown as EqOnly, predictionScope)
    const { data: preds, error: predError } = await pq
    if (predError) {
      // DELIBERATELY NOT FATAL, and said out loud. The headline metric is
      // computed from delta_score, which the LOG carries on its own row — that
      // number is still fully evidenced. Only the CTR / engagement-rate
      // comparisons need the prediction side, and they degrade to "not yet
      // measured" with the refusal named in the notes. Refusing the whole rail
      // here would black out an autonomy gate over a secondary read.
      predictionSideRefusal = predError.message
      console.error("[PredictionAccuracy] content prediction-side read refused:", predError.message)
      break
    }
    for (const p of (preds ?? []) as any[]) {
      predicted.set(p.id as string, {
        predicted_score: p.predicted_score ?? null,
        predicted_ctr: p.predicted_ctr ?? null,
        predicted_engagement_rate: p.predicted_engagement_rate ?? null,
      })
    }
  }

  const joined: ContentAccuracyRow[] = rows.map((r) => {
    const p = r.prediction_id ? predicted.get(r.prediction_id) : undefined
    return { ...r, ...(p ?? {}) }
  })

  const rail = summarizeContentRows(joined)
  if (predictionSideRefusal && rail.available) {
    rail.honestNotes = [
      ...rail.honestNotes,
      `Prediction-side read refused (${predictionSideRefusal}) — the score miss above still stands on the log's own delta_score; the rate comparisons are incomplete.`,
    ]
  }
  return rail
}

// ─── Rail 9: DEAL OUTCOME (frozen probability calls vs the terminal event) ───
//
// ai_predictions gained its outcome writer in round 36: the close-time grader
// (lib/analytics/ai-prediction-outcomes) stamps actual_outcome when a
// transaction reaches CLOSED or LOST, and every write of the mutable
// transactions.win_probability column is FROZEN as its own snapshot row on the
// same ledger. This rail grades ONLY transaction-entity rows with a recorded
// terminal outcome, taking the FIRST pre-outcome call per deal so a probability
// that converged toward the outcome can never grade itself.

export interface DealOutcomePredictionRow {
  predictionType: string
  predictionValue: unknown
  actualOutcome: unknown
  outcomeDate: string | null
  createdAt: string | null
  entityId: string
}

const DEAL_OUTCOME_BASE = {
  rail: "deal_outcome" as const,
  label: "Deal-outcome probability calls",
  honestNotes: [
    "Graded only against terminal transaction events (CLOSED / LOST) written by the close-time grader — never against the live mutable column.",
    "Only the FIRST pre-outcome call per deal is graded, so probabilities that converge toward the outcome can't grade themselves.",
  ],
  predictionSource: "Frozen probability calls (ai_predictions: win_probability snapshots + deal_close_probability)",
  outcomeSource: "Terminal transaction events (ai_predictions.actual_outcome, stamped at stage CLOSED/LOST)",
  detailHref: "/dashboard/transactions",
}

/** PURE: extract the 0..1 probability claim from a prediction row's jsonb. */
export function dealOutcomeProbability(row: DealOutcomePredictionRow): number | null {
  const v = row.predictionValue as Record<string, unknown> | null
  if (!v || typeof v !== "object") return null
  return normalizeProbability(
    (v as any).win_probability ?? (v as any).closeProbability ?? (v as any).close_probability,
  )
}

/** PURE: deal-outcome rail — first pre-outcome call per deal vs the real terminal event. */
export function summarizeDealOutcomeRows(rows: DealOutcomePredictionRow[]): RailAccuracy {
  // Oldest-first so the FIRST call per deal wins.
  const sorted = [...rows].sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")))
  const seen = new Set<string>()
  const graded: Array<{ p: number; y: 0 | 1; outcomeDate: string }> = []
  for (const r of sorted) {
    if (seen.has(r.entityId)) continue
    const outcome = (r.actualOutcome as Record<string, unknown> | null)?.outcome
    if (outcome !== "closed" && outcome !== "lost") continue // only real terminal events grade
    if (!r.createdAt || !r.outcomeDate) continue
    if (new Date(r.createdAt).getTime() >= new Date(r.outcomeDate).getTime()) continue // post-outcome claim: hindsight, refused
    const p = dealOutcomeProbability(r)
    if (p == null) continue
    seen.add(r.entityId)
    graded.push({ p, y: outcome === "closed" ? 1 : 0, outcomeDate: r.outcomeDate })
  }
  if (graded.length === 0) {
    return unavailable(DEAL_OUTCOME_BASE,
      "No frozen probability call has reached a terminal transaction outcome yet — the close-time grader records one when a deal closes or is lost.")
  }
  return {
    ...DEAL_OUTCOME_BASE,
    available: true,
    why: null,
    observations: graded.length,
    medianError: {
      value: Math.round(fractionalMedian(graded.map((g) => Math.abs(g.p - g.y))) * 1000) / 10,
      unit: "probability_pts",
      label: "median |predicted probability − outcome| in percentage points (outcome = 100 closed / 0 lost)",
    },
    withinRate: null, // no source-defined tolerance on a probability claim — nothing minted
    period: periodOf(graded.map((g) => g.outcomeDate)),
  }
}

async function dealOutcomeAdapter(svc: Svc, brokerageId?: string): Promise<RailAccuracy> {
  let q = svc.from("ai_predictions")
    .select("prediction_type, prediction_value, actual_outcome, outcome_date, created_at, entity_id")
    .eq("entity_type", "transaction")
    .not("actual_outcome", "is", null)
    .order("created_at", { ascending: true })
    .limit(2000)
  if (brokerageId) q = q.eq("brokerage_id", brokerageId)
  const { data, error } = await q
  if (error) return unavailable(DEAL_OUTCOME_BASE, `ledger unreadable: ${error.message}`)
  return summarizeDealOutcomeRows(((data ?? []) as any[]).map((r) => ({
    predictionType: r.prediction_type,
    predictionValue: r.prediction_value,
    actualOutcome: r.actual_outcome,
    outcomeDate: r.outcome_date,
    createdAt: r.created_at,
    entityId: r.entity_id,
  })))
}

// ─── Rail 10: HOMEOWNER AVM (home-value estimate vs the eventual sale) ───────
//
// home_value_estimates has no listing key — the ONLY honest join is a strict
// normalized street+ZIP match within the same brokerage, and ONLY when exactly
// one sold listing carries that key. Ambiguity is refused, never guessed. The
// estimate's own low–high range is the source-defined tolerance band.

export interface AvmEstimateRow {
  street: string | null
  zip: string | null
  brokerageId: string | null
  low: number | null
  mid: number | null
  high: number | null
  generatedAt: string | null
}

export interface SoldListingAddressRow {
  street: string | null
  zip: string | null
  brokerageId: string | null
  soldPrice: number | null
  soldDate: string | null
}

const HOME_VALUE_BASE = {
  rail: "home_value_avm" as const,
  label: "Homeowner value estimates (AVM)",
  honestNotes: [
    "Joined by strict normalized street + ZIP within the same brokerage — a key matching zero or more than one sold listing is refused, never guessed.",
    "Only estimates generated BEFORE the sale date are graded (last pre-sale estimate per address).",
    "\"Within tolerance\" is the estimate's OWN quoted low–high range — no band is minted here.",
  ],
  predictionSource: "Homeowner value estimates (home_value_estimates low/mid/high)",
  outcomeSource: "Recorded sales (listings.sold_price at the same normalized address)",
  detailHref: "/dashboard/analytics",
}

/** PURE: AVM rail — unique-address pre-sale estimates vs the recorded sale. */
export function summarizeHomeValueRows(estimates: AvmEstimateRow[], sold: SoldListingAddressRow[]): RailAccuracy {
  // Sold listings by brokerage-scoped normalized key — ambiguous keys refused.
  const soldByKey = new Map<string, SoldListingAddressRow[]>()
  for (const s of sold) {
    if ((num(s.soldPrice) ?? 0) <= 0 || !s.soldDate) continue
    const key = normalizeAddressKey(s.street, s.zip)
    if (!key) continue
    const scoped = `${s.brokerageId ?? ""}|${key}`
    soldByKey.set(scoped, [...(soldByKey.get(scoped) ?? []), s])
  }
  let ambiguousRefused = 0
  const uniqueSold = new Map<string, SoldListingAddressRow>()
  for (const [k, list] of soldByKey.entries()) {
    if (list.length === 1) uniqueSold.set(k, list[0])
    else ambiguousRefused += 1
  }

  // Last pre-sale estimate per unique key.
  const bestByKey = new Map<string, { est: AvmEstimateRow; sale: SoldListingAddressRow }>()
  for (const e of estimates) {
    if ((num(e.mid) ?? 0) <= 0 || (num(e.low) ?? 0) <= 0 || (num(e.high) ?? 0) <= 0 || !e.generatedAt) continue
    const key = normalizeAddressKey(e.street, e.zip)
    if (!key) continue
    const scoped = `${e.brokerageId ?? ""}|${key}`
    const sale = uniqueSold.get(scoped)
    if (!sale) continue
    // sold_date is a date — grade estimates generated up to the end of that day.
    const saleEnd = new Date(sale.soldDate as string).getTime() + 86_399_000
    const genAt = new Date(e.generatedAt).getTime()
    if (!Number.isFinite(genAt) || genAt > saleEnd) continue // post-sale estimate: hindsight, refused
    const cur = bestByKey.get(scoped)
    if (!cur || String(e.generatedAt) > String(cur.est.generatedAt)) bestByKey.set(scoped, { est: e, sale })
  }

  const graded = [...bestByKey.values()]
  if (graded.length === 0) {
    return unavailable(HOME_VALUE_BASE,
      "No sold listing uniquely matches a pre-sale home-value estimate at the same normalized address yet — ambiguous or missing matches are refused, not guessed.")
  }
  const within = graded.filter(({ est, sale }) =>
    (sale.soldPrice as number) >= (est.low as number) && (sale.soldPrice as number) <= (est.high as number)).length
  return {
    ...HOME_VALUE_BASE,
    available: true,
    why: null,
    observations: graded.length,
    medianError: {
      value: round4(fractionalMedian(graded.map(({ est, sale }) =>
        Math.abs((est.mid as number) - (sale.soldPrice as number)) / (sale.soldPrice as number)))),
      unit: "pct_of_sale",
      label: "median |estimate midpoint − sold price| as a share of the sale price",
    },
    withinRate: {
      rate: round2(within / graded.length),
      label: "sales that landed inside the estimate's own quoted low–high range",
    },
    period: periodOf(graded.map(({ sale }) => sale.soldDate)),
    honestNotes: [
      ...HOME_VALUE_BASE.honestNotes,
      ...(ambiguousRefused > 0 ? [`${ambiguousRefused} address key${ambiguousRefused === 1 ? "" : "s"} matched more than one sold listing and ${ambiguousRefused === 1 ? "was" : "were"} refused.`] : []),
    ],
  }
}

async function homeValueAdapter(svc: Svc, brokerageId?: string): Promise<RailAccuracy> {
  let eq = svc.from("home_value_estimates")
    .select("property_address, estimated_value_low, estimated_value_mid, estimated_value_high, generated_at, valuation_request_id, brokerage_id")
    .not("generated_at", "is", null)
    .order("generated_at", { ascending: false })
    .limit(1000)
  if (brokerageId) eq = eq.eq("brokerage_id", brokerageId)
  const { data: ests, error: eErr } = await eq
  if (eErr) return unavailable(HOME_VALUE_BASE, `ledger unreadable: ${eErr.message}`)
  const estRows = (ests ?? []) as any[]
  if (estRows.length === 0) return unavailable(HOME_VALUE_BASE, "No home-value estimates recorded yet.")

  // The estimate row carries the street line only — the ZIP lives on the intake request.
  const vrIds = [...new Set(estRows.map((r) => r.valuation_request_id).filter(Boolean))] as string[]
  const zipByVr = new Map<string, string | null>()
  if (vrIds.length > 0) {
    const { data: vrs, error: vErr } = await svc.from("valuation_requests")
      .select("id, zip_code")
      .in("id", vrIds)
      .limit(1000)
    if (vErr) return unavailable(HOME_VALUE_BASE, `ledger unreadable: ${vErr.message}`)
    for (const v of (vrs ?? []) as any[]) zipByVr.set(v.id, v.zip_code ?? null)
  }

  let lq = svc.from("listings")
    .select("address, zip, brokerage_id, sold_price, sold_date")
    .not("sold_price", "is", null)
    .not("sold_date", "is", null)
    .order("sold_date", { ascending: false })
    .limit(1000)
  if (brokerageId) lq = lq.eq("brokerage_id", brokerageId)
  const { data: soldRows, error: lErr } = await lq
  if (lErr) return unavailable(HOME_VALUE_BASE, `ledger unreadable: ${lErr.message}`)

  return summarizeHomeValueRows(
    estRows.map((r) => ({
      street: r.property_address ?? null,
      zip: r.valuation_request_id ? (zipByVr.get(r.valuation_request_id) ?? null) : null,
      brokerageId: r.brokerage_id ?? null,
      low: num(r.estimated_value_low),
      mid: num(r.estimated_value_mid),
      high: num(r.estimated_value_high),
      generatedAt: r.generated_at ?? null,
    })),
    ((soldRows ?? []) as any[]).map((l) => ({
      street: l.address ?? null,
      zip: l.zip ?? null,
      brokerageId: l.brokerage_id ?? null,
      soldPrice: num(l.sold_price),
      soldDate: l.sold_date ?? null,
    })),
  )
}

// ─── Rail 11: LISTING PROPENSITY (ready-to-list triggers vs a real listing) ──
//
// The gradable ledger is predictive_listing_actions — IMMUTABLE rows freezing
// the propensity score at the moment the play fired (the mutable
// predictive_listing_scores upsert is NOT graded; its history is overwritten).
// Outcome: a real listings row for the same contact. The 180-day window is a
// grading constant declared HERE (the source defines no horizon) and is named
// in the label so the number can't be misread.

export const LISTING_PROPENSITY_HORIZON_DAYS = 180

export interface PropensityActionRow {
  contactId: string
  brokerageId: string | null
  createdAt: string | null
}

export interface ContactListingEvent {
  contactId: string
  brokerageId: string | null
  listedAt: string | null
}

const PROPENSITY_BASE = {
  rail: "listing_propensity" as const,
  label: "Listing-propensity triggers",
  honestNotes: [
    `The ${LISTING_PROPENSITY_HORIZON_DAYS}-day window is a declared grading constant — the source system defines no horizon, so the label names it instead of implying one.`,
    "Graded on the immutable trigger ledger (score frozen when the play fired); contacts who already had a listing before the trigger are refused.",
  ],
  predictionSource: "Ready-to-list triggers (predictive_listing_actions.triggering_pls_score)",
  outcomeSource: "Recorded listings for the same contact (listings.listing_date)",
  detailHref: "/dashboard/agent",
}

/** PURE: propensity rail — earliest trigger per contact vs a later real listing. */
export function summarizePropensityRows(
  actions: PropensityActionRow[],
  listings: ContactListingEvent[],
  nowIso: string,
): RailAccuracy {
  const horizonMs = LISTING_PROPENSITY_HORIZON_DAYS * 86_400_000
  const now = new Date(nowIso).getTime()

  // Earliest trigger per contact (rows sorted oldest-first).
  const sorted = [...actions].sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")))
  const firstByContact = new Map<string, PropensityActionRow>()
  for (const a of sorted) {
    if (!a.createdAt) continue
    const key = `${a.brokerageId ?? ""}|${a.contactId}`
    if (!firstByContact.has(key)) firstByContact.set(key, a)
  }

  const listedByContact = new Map<string, number[]>()
  for (const l of listings) {
    if (!l.listedAt) continue
    const t = new Date(l.listedAt).getTime()
    if (!Number.isFinite(t)) continue
    const key = `${l.brokerageId ?? ""}|${l.contactId}`
    listedByContact.set(key, [...(listedByContact.get(key) ?? []), t])
  }

  let hits = 0, misses = 0, pending = 0, refusedPreExisting = 0
  const gradedDates: string[] = []
  for (const [key, a] of firstByContact.entries()) {
    const at = new Date(a.createdAt as string).getTime()
    const events = (listedByContact.get(key) ?? []).sort((x, y) => x - y)
    if (events.some((t) => t <= at)) { refusedPreExisting += 1; continue } // already listing — not a forecast
    const firstAfter = events.find((t) => t > at)
    if (firstAfter != null) {
      if (firstAfter - at <= horizonMs) hits += 1
      else misses += 1
      gradedDates.push(a.createdAt as string)
    } else if (now >= at + horizonMs) {
      misses += 1 // the full window elapsed with no listing — an observed non-event
      gradedDates.push(a.createdAt as string)
    } else {
      pending += 1 // window still open — never assumed either way
    }
  }

  const graded = hits + misses
  if (graded === 0) {
    return unavailable(PROPENSITY_BASE,
      pending > 0
        ? `${pending} trigger${pending === 1 ? "" : "s"} fired but no ${LISTING_PROPENSITY_HORIZON_DAYS}-day window has fully elapsed yet — nothing is graded early.`
        : "No ready-to-list trigger has fired yet — the auto-touch ledger is empty.")
  }
  return {
    ...PROPENSITY_BASE,
    available: true,
    why: null,
    observations: graded,
    medianError: null,
    withinRate: {
      rate: round2(hits / graded),
      label: `flagged homeowners who actually listed within ${LISTING_PROPENSITY_HORIZON_DAYS} days of the trigger`,
    },
    period: periodOf(gradedDates),
    honestNotes: [
      ...PROPENSITY_BASE.honestNotes,
      ...(pending > 0 ? [`${pending} trigger${pending === 1 ? "" : "s"} still inside the window and not graded.`] : []),
      ...(refusedPreExisting > 0 ? [`${refusedPreExisting} contact${refusedPreExisting === 1 ? "" : "s"} already had a listing before the trigger and ${refusedPreExisting === 1 ? "was" : "were"} refused.`] : []),
    ],
  }
}

async function propensityAdapter(svc: Svc, brokerageId?: string): Promise<RailAccuracy> {
  let aq = svc.from("predictive_listing_actions")
    .select("contact_id, brokerage_id, created_at")
    .order("created_at", { ascending: true })
    .limit(2000)
  if (brokerageId) aq = aq.eq("brokerage_id", brokerageId)
  const { data: acts, error: aErr } = await aq
  if (aErr) return unavailable(PROPENSITY_BASE, `ledger unreadable: ${aErr.message}`)
  const actRows = (acts ?? []) as any[]
  if (actRows.length === 0) {
    return unavailable(PROPENSITY_BASE, "No ready-to-list trigger has fired yet — the auto-touch ledger is empty.")
  }
  const ids = [...new Set(actRows.map((a) => a.contact_id).filter(Boolean))] as string[]
  const [{ data: byContact, error: e1 }, { data: bySeller, error: e2 }] = await Promise.all([
    svc.from("listings").select("contact_id, seller_contact_id, brokerage_id, listing_date, created_at").in("contact_id", ids).limit(2000),
    svc.from("listings").select("contact_id, seller_contact_id, brokerage_id, listing_date, created_at").in("seller_contact_id", ids).limit(2000),
  ])
  if (e1 || e2) return unavailable(PROPENSITY_BASE, `ledger unreadable: ${(e1 ?? e2)!.message}`)
  const idSet = new Set(ids)
  const events: ContactListingEvent[] = []
  for (const l of [...((byContact ?? []) as any[]), ...((bySeller ?? []) as any[])]) {
    const cid = idSet.has(l.contact_id) ? l.contact_id : (idSet.has(l.seller_contact_id) ? l.seller_contact_id : null)
    if (!cid) continue
    events.push({ contactId: cid, brokerageId: l.brokerage_id ?? null, listedAt: l.listing_date ?? l.created_at ?? null })
  }
  return summarizePropensityRows(
    actRows.map((a) => ({ contactId: a.contact_id, brokerageId: a.brokerage_id ?? null, createdAt: a.created_at ?? null })),
    events,
    new Date().toISOString(),
  )
}

// ─── Rail 12: INCOME FORECAST (30-day forecast vs realized closed GCI) ───────
//
// income_forecast_snapshots carries the forecast (weighted_30 + its own
// low/high band percentages); the realized side is the CLOSED-transaction GCI
// recorded in the 30 days after the snapshot. One snapshot per agent per
// calendar month (the earliest) is graded so daily reruns can't inflate the
// observation count with autocorrelated rows.

export interface IncomeForecastSnapshotRow {
  agentId: string | null
  computedAt: string | null
  weighted30: number | null
  lowBandPct: number | null
  highBandPct: number | null
}

export interface ClosedDealGciRow {
  agentId: string | null
  closeDate: string | null
  gci: number | null
}

const INCOME_FORECAST_BASE = {
  rail: "income_forecast" as const,
  label: "30-day income forecasts",
  honestNotes: [
    "Realized GCI = commission recorded on transactions that actually CLOSED inside the 30 days after the snapshot (commission_amount, frozen at close; estimated_commission only where no final figure exists).",
    "One snapshot per agent per month (the earliest) is graded — daily reruns don't inflate the sample.",
    "\"Within tolerance\" is the snapshot's OWN low/high band percentages — no band is minted here.",
  ],
  predictionSource: "Income forecast snapshots (income_forecast_snapshots.weighted_30)",
  outcomeSource: "Closed-transaction GCI in the following 30 days (transactions.commission_amount)",
  detailHref: "/dashboard/reports",
}

/** PURE: income-forecast rail — earliest snapshot per agent-month vs realized 30-day GCI. */
export function summarizeIncomeForecastRows(
  snapshots: IncomeForecastSnapshotRow[],
  closedDeals: ClosedDealGciRow[],
  nowIso: string,
): RailAccuracy {
  const now = new Date(nowIso).getTime()
  const windowMs = 30 * 86_400_000

  const sorted = [...snapshots].sort((a, b) => String(a.computedAt ?? "").localeCompare(String(b.computedAt ?? "")))
  const firstByAgentMonth = new Map<string, IncomeForecastSnapshotRow>()
  for (const s of sorted) {
    if (!s.agentId || !s.computedAt) continue
    const key = `${s.agentId}|${String(s.computedAt).slice(0, 7)}`
    if (!firstByAgentMonth.has(key)) firstByAgentMonth.set(key, s)
  }

  const dealsByAgent = new Map<string, Array<{ t: number; gci: number }>>()
  for (const d of closedDeals) {
    if (!d.agentId || !d.closeDate) continue
    const t = new Date(d.closeDate).getTime()
    if (!Number.isFinite(t)) continue
    dealsByAgent.set(d.agentId, [...(dealsByAgent.get(d.agentId) ?? []), { t, gci: num(d.gci) ?? 0 }])
  }

  let trivialSkipped = 0
  const graded: Array<{ err: number; within: boolean; computedAt: string }> = []
  for (const s of firstByAgentMonth.values()) {
    const start = new Date(s.computedAt as string).getTime()
    if (!Number.isFinite(start) || now < start + windowMs) continue // window not elapsed — never graded early
    const forecast = num(s.weighted30) ?? 0
    // close_date is a date — include deals closing through the end of the window day.
    const realized = (dealsByAgent.get(s.agentId as string) ?? [])
      .filter((d) => d.t > start && d.t <= start + windowMs + 86_399_000)
      .reduce((sum, d) => sum + d.gci, 0)
    if (forecast <= 0 && realized === 0) { trivialSkipped += 1; continue } // nothing forecast, nothing closed — not an observation
    const lowPct = num(s.lowBandPct) ?? 25
    const highPct = num(s.highBandPct) ?? 15
    graded.push({
      err: Math.abs(realized - forecast),
      within: realized >= forecast * (1 - lowPct / 100) && realized <= forecast * (1 + highPct / 100),
      computedAt: s.computedAt as string,
    })
  }

  if (graded.length === 0) {
    return unavailable(INCOME_FORECAST_BASE,
      "No income-forecast snapshot has a fully elapsed 30-day window with real forecast-or-closing activity yet.")
  }
  return {
    ...INCOME_FORECAST_BASE,
    available: true,
    why: null,
    observations: graded.length,
    medianError: {
      value: medianOf(graded.map((g) => g.err)),
      unit: "usd",
      label: "median |realized 30-day closed GCI − forecast|",
    },
    withinRate: {
      rate: round2(graded.filter((g) => g.within).length / graded.length),
      label: "windows where realized GCI landed inside the forecast's own low/high band",
    },
    period: periodOf(graded.map((g) => g.computedAt)),
    honestNotes: [
      ...INCOME_FORECAST_BASE.honestNotes,
      ...(trivialSkipped > 0 ? [`${trivialSkipped} zero-forecast/zero-close window${trivialSkipped === 1 ? "" : "s"} skipped — a trivially "right" nothing-predicted row is not an observation.`] : []),
    ],
  }
}

async function incomeForecastAdapter(svc: Svc, brokerageId?: string): Promise<RailAccuracy> {
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString()
  let sq = svc.from("income_forecast_snapshots")
    .select("agent_id, computed_at, weighted_30, low_band_pct, high_band_pct")
    .lte("computed_at", cutoff)
    .order("computed_at", { ascending: true })
    .limit(2000)
  if (brokerageId) sq = sq.eq("brokerage_id", brokerageId)
  const { data: snaps, error: sErr } = await sq
  if (sErr) return unavailable(INCOME_FORECAST_BASE, `ledger unreadable: ${sErr.message}`)
  const snapRows = (snaps ?? []) as any[]
  if (snapRows.length === 0) {
    return unavailable(INCOME_FORECAST_BASE, "No income-forecast snapshot is 30 days old yet — the first window has to elapse before anything is graded.")
  }

  let tq = svc.from("transactions")
    .select("agent_id, close_date, commission_amount, estimated_commission")
    .not("close_date", "is", null)
    .or("stage.eq.CLOSED,status.eq.closed")
    .limit(2000)
  if (brokerageId) tq = tq.eq("brokerage_id", brokerageId)
  const { data: deals, error: tErr } = await tq
  if (tErr) return unavailable(INCOME_FORECAST_BASE, `ledger unreadable: ${tErr.message}`)

  // IDENTITY CLASS (m352, corrected by m366). summarizeIncomeForecastRows joins
  // these two lists BY agentId, and they used to be two different classes:
  // income_forecast_snapshots.agent_id FK'd users while transactions.agent_id FK'd
  // agents, so `dealsByAgent.get(snapshot.agentId)` never hit and this rail graded
  // every income forecast as a total miss — in a surface that governs how much
  // autonomy the OS is allowed. m366 re-pointed the snapshot column at agents, so
  // both sides are agents-class now and the translation that fixed the join would
  // re-break it in the opposite direction. Join agents to agents, no hop.

  return summarizeIncomeForecastRows(
    snapRows.map((s) => ({
      agentId: s.agent_id ?? null,
      computedAt: s.computed_at ?? null,
      weighted30: num(s.weighted_30),
      lowBandPct: num(s.low_band_pct),
      highBandPct: num(s.high_band_pct),
    })),
    ((deals ?? []) as any[]).map((d) => ({
      // Agents-class on both sides; a deal with no agent is dropped by the
      // existing `if (!d.agentId) continue`, which is the honest outcome.
      agentId: (d.agent_id as string | null) ?? null,
      closeDate: d.close_date ?? null,
      gci: num(d.commission_amount) ?? num(d.estimated_commission),
    })),
    new Date().toISOString(),
  )
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
  const { assignmentPolicyAdapter, ASSIGNMENT_POLICY_BASE } = await import("./assignment-outcomes")
  const [closingCosts, netSheet, priceRails, attendance, strategy, patterns, content, dealOutcome, homeValue, propensity, incomeForecast, assignmentPolicy] = await Promise.all([
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
    safeRail(dealOutcomeAdapter(svc, b), DEAL_OUTCOME_BASE),
    safeRail(homeValueAdapter(svc, b), HOME_VALUE_BASE),
    safeRail(propensityAdapter(svc, b), PROPENSITY_BASE),
    safeRail(incomeForecastAdapter(svc, b), INCOME_FORECAST_BASE),
    safeRail(assignmentPolicyAdapter(svc, b), ASSIGNMENT_POLICY_BASE),
  ])
  const rails = [closingCosts, netSheet, priceRails[0], priceRails[1], attendance, strategy, patterns, content, dealOutcome, homeValue, propensity, incomeForecast, assignmentPolicy]
  return {
    scope: b ? "brokerage" : "platform",
    generatedAt: new Date().toISOString(),
    rails,
    gradedRails: rails.filter((r) => r.available).length,
    totalObservations: rails.reduce((s, r) => s + r.observations, 0),
  }
}

/**
 * ONE rail on demand — the accuracy-gate (lib/managers/accuracy-gate) consults a
 * single domain rail before an autonomy-eligible action, without paying for the
 * full 12-rail report on a send hot path. STRICTLY read-only like everything
 * else in this module; failures degrade to an honest unavailable rail.
 */
export async function loadRailAccuracy(svc: Svc, rail: AccuracyRailId, brokerageId?: string): Promise<RailAccuracy> {
  switch (rail) {
    case "closing_costs": return safeRail(closingCostsAdapter(svc, brokerageId), CLOSING_COSTS_BASE)
    case "net_sheet": return safeRail(netSheetAdapter(svc, brokerageId), NET_SHEET_BASE)
    case "listing_price": return (await pricePairsRails(svc, brokerageId).catch((e): [RailAccuracy, RailAccuracy] => [
      unavailable(LISTING_PRICE_BASE, `adapter failed: ${e instanceof Error ? e.message : String(e)}`),
      unavailable(DOM_BASE, `adapter failed: ${e instanceof Error ? e.message : String(e)}`),
    ]))[0]
    case "days_on_market": return (await pricePairsRails(svc, brokerageId).catch((e): [RailAccuracy, RailAccuracy] => [
      unavailable(LISTING_PRICE_BASE, `adapter failed: ${e instanceof Error ? e.message : String(e)}`),
      unavailable(DOM_BASE, `adapter failed: ${e instanceof Error ? e.message : String(e)}`),
    ]))[1]
    case "open_house_attendance": return safeRail(attendanceAdapter(svc, brokerageId), ATTENDANCE_BASE)
    case "offer_strategy": return safeRail(strategyAdapter(svc, brokerageId), STRATEGY_BASE)
    case "pattern_predictions": return safeRail(patternAdapter(svc, brokerageId), PATTERN_BASE)
    case "content_performance": return safeRail(contentAdapter(svc, brokerageId), CONTENT_BASE)
    case "deal_outcome": return safeRail(dealOutcomeAdapter(svc, brokerageId), DEAL_OUTCOME_BASE)
    case "home_value_avm": return safeRail(homeValueAdapter(svc, brokerageId), HOME_VALUE_BASE)
    case "listing_propensity": return safeRail(propensityAdapter(svc, brokerageId), PROPENSITY_BASE)
    case "income_forecast": return safeRail(incomeForecastAdapter(svc, brokerageId), INCOME_FORECAST_BASE)
    case "assignment_policy": {
      const { assignmentPolicyAdapter, ASSIGNMENT_POLICY_BASE } = await import("./assignment-outcomes")
      return safeRail(assignmentPolicyAdapter(svc, brokerageId), ASSIGNMENT_POLICY_BASE)
    }
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
const TRUST_CHIP_CLOSING_COST_MIN_WITHIN = 0.7
const TRUST_CHIP_PRICE_MAX_MEDIAN_PCT = 0.05

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
