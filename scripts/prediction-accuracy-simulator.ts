#!/usr/bin/env tsx
/**
 * scripts/prediction-accuracy-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves THE GENERALIZED ACCURACY FLYWHEEL (owner round 35) — one honest
 * "how right were we" surface across every prediction rail that has a real
 * outcome ledger, with a per-rail adapter pattern over EXISTING tables only.
 *
 * Layer 1 (pure, fixtures): each rail summarizer's math on crafted fixtures —
 *   medians, within-rates, the pre-sale-only grading rule — and the
 *   REFUSE-TO-INVENT rule (empty/ungraded rails → { available: false, why }).
 * Layer 2 (static): the aggregator is STRICTLY read-only (no insert/update/
 *   upsert/delete), reads ONLY tables that exist in the schema snapshot (no
 *   new table literals), and BOTH analytics mounts render the ONE keep-one
 *   panel component (superadmin platform + broker analytics).
 * Layer 3 (chip): the trust chip composes only above its honest thresholds,
 *   is null below them, and both consumers (pitch kit, QBR) OMIT the section
 *   when the chip is absent.
 * Layer 4 (live, creds-gated): the aggregator runs against the real DB without
 *   throwing and returns the full 12-rail shape.
 *
 * ROUND 36 (exclusion audit + accuracy-driven autonomy): four rails earned
 * their way in — deal_outcome (ai_predictions close-time grader + frozen
 * win-probability snapshots), home_value_avm (strict unique normalized
 * address join), listing_propensity (immutable trigger ledger vs a real later
 * listing), income_forecast (weighted_30 vs realized closed GCI). Plus the
 * PREDICTIVE autonomy gate: accuracyGateVerdict / autonomyDecision precedence
 * (halts win, human-approved bypasses, only an explicit 'autonomous' posture
 * is accuracy-gated, the gate never grants).
 *
 * Fixtures live ONLY here — the library reads real ledgers exclusively.
 *
 * Run: npx tsx scripts/prediction-accuracy-simulator.ts
 *      (npm script name: "test:prediction-accuracy")
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  summarizeClosingCostRows,
  summarizeNetSheetRows,
  summarizeListingPriceRows,
  summarizeDomRows,
  summarizeAttendanceRows,
  summarizeStrategyRows,
  summarizePatternRows,
  summarizeContentRows,
  gradablePricePairs,
  fractionalMedian,
  composePredictionTrustChip,
  getPredictionAccuracyReport,
  TRUST_CHIP_MIN_OBSERVATIONS,
  TRUST_CHIP_NET_SHEET_MIN_WITHIN,
  normalizeProbability,
  normalizeAddressKey,
  summarizeDealOutcomeRows,
  summarizeHomeValueRows,
  summarizePropensityRows,
  summarizeIncomeForecastRows,
  LISTING_PROPENSITY_HORIZON_DAYS,
  type RailAccuracy,
  type NetSheetReconRow,
  type PricePredictionPair,
  type DealOutcomePredictionRow,
  type AvmEstimateRow,
  type SoldListingAddressRow,
  type PropensityActionRow,
  type ContactListingEvent,
  type IncomeForecastSnapshotRow,
  type ClosedDealGciRow,
} from "../lib/analytics/prediction-accuracy"
import {
  summarizeAssignmentPolicyRows,
  computePolicyOutcomes,
  findDivergentRulePair,
  policyLabel,
  ASSIGNMENT_OUTCOME_HORIZON_DAYS,
  ASSIGNMENT_POLICY_MIN_OBSERVATIONS,
  type AssignedCohortRow,
  type AssignmentRuleInfo,
  type FirstAppointmentEvent,
  type PolicyOutcomeStat,
} from "../lib/analytics/assignment-outcomes"
import {
  ACCURACY_GATE_POLICIES,
  MANAGER_ACCURACY_DOMAIN,
  accuracyGateVerdict,
  accuracyHold,
} from "../lib/managers/accuracy-gate"
import { autonomyDecision } from "../lib/managers/autonomy-gate"
import { recruitingPitchSpec, type RecruitingPitchFacts } from "../lib/recruiting/recruiting-pitch-kit"
import { composeQuarterlyReview, type QuarterFacts } from "../lib/intelligence/quarterly-review"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report(): never {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Prediction-accuracy flywheel verified — honest rails, refuse-to-invent, keep-one surface, gated chip.")
  console.log(" PREDICTION_ACCURACY_PASS")
  process.exit(0)
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Prediction-accuracy flywheel simulator")
  console.log("══════════════════════════════════════════════════")

  // ═══ Layer 1 · pure rail math on fixtures ═══
  console.log("\n[Layer 1 · rail math + refuse-to-invent]")

  // — closing costs (the merged round-34 rail) —
  const ccLine = (deltaFromMid: number, withinBand: boolean) => ({
    key: "owner_title" as const, label: "Owner's title insurance",
    estimateLow: 1000, estimateHigh: 2000, actual: 1500 + deltaFromMid, deltaFromMid, withinBand,
  })
  const cc = summarizeClosingCostRows([
    { state: "GA", lines: [ccLine(100, true), ccLine(-300, false)], created_at: "2026-01-01T00:00:00Z" },
    { state: "GA", lines: [ccLine(50, true)], created_at: "2026-03-01T00:00:00Z" },
    { state: "FL", lines: [ccLine(700, false)], created_at: "2026-02-01T00:00:00Z" },
  ])
  check("closing costs: 3 observations graded", cc.available && cc.observations === 3, JSON.stringify(cc.why))
  check("closing costs: within-rate 2/4 lines = 0.5", cc.withinRate?.rate === 0.5, String(cc.withinRate?.rate))
  // |deltas| = 100, 300, 50, 700 → sorted 50,100,300,700 → median = round((100+300)/2) = 200
  check("closing costs: median |Δ| = $200", cc.medianError?.value === 200 && cc.medianError.unit === "usd", String(cc.medianError?.value))
  check("closing costs: per-state breakdown preserved (GA first, 2 obs)", cc.breakdown?.[0]?.group === "GA" && cc.breakdown?.[0]?.observations === 2, JSON.stringify(cc.breakdown))
  check("closing costs: period spans the real rows", cc.period?.from === "2026-01-01T00:00:00Z" && cc.period?.to === "2026-03-01T00:00:00Z")
  const ccEmpty = summarizeClosingCostRows([])
  check("closing costs: empty ledger → available:false with a why", ccEmpty.available === false && !!ccEmpty.why && ccEmpty.observations === 0)
  check("closing costs: empty ledger → NO accuracy numbers", ccEmpty.medianError === null && ccEmpty.withinRate === null)

  // — net sheet —
  const ns = (variance: number, level: string): NetSheetReconRow => ({
    estimated_net: 200_000, actual_net: 200_000 + variance, variance_amount: variance,
    surprise_level: level, created_at: "2026-04-01T00:00:00Z",
  })
  const nsRail = summarizeNetSheetRows([
    ns(-500, "none"), ns(1_200, "none"), ns(-20_000, "severe"), ns(-6_000, "concerning"), ns(300, "none"),
  ])
  check("net sheet: 5 graded, within-rate 3/5 = 0.6", nsRail.available && nsRail.observations === 5 && nsRail.withinRate?.rate === 0.6, JSON.stringify(nsRail.withinRate))
  // |variances| sorted: 300, 500, 1200, 6000, 20000 → median 1200
  check("net sheet: median |gap| = $1,200", nsRail.medianError?.value === 1_200, String(nsRail.medianError?.value))
  const nsUngraded = summarizeNetSheetRows([{ estimated_net: null, actual_net: 1, variance_amount: null, surprise_level: "none", created_at: null }])
  check("net sheet: rows without both sides → available:false", nsUngraded.available === false && !!nsUngraded.why)

  // — listing price + DOM (pre-sale-only grading) —
  const pair = (over: Partial<PricePredictionPair>): PricePredictionPair => ({
    predictedPrice: 500_000, daysToSellEstimate: 30, predictedAt: "2026-01-10T00:00:00Z",
    soldPrice: 520_000, soldDate: "2026-02-20", listingDate: "2026-01-01", ...over,
  })
  const hindsight = pair({ predictedAt: "2026-03-15T00:00:00Z" }) // predicted AFTER the sale
  check("price pairs: a post-sale prediction is NOT gradable (no hindsight)", gradablePricePairs([hindsight]).length === 0)
  const lp = summarizeListingPriceRows([
    pair({}),                                                    // |500k−520k|/520k ≈ 3.85%
    pair({ predictedPrice: 600_000, soldPrice: 500_000 }),       // 20%
    pair({ predictedPrice: 495_000, soldPrice: 500_000 }),       // 1%
    hindsight,                                                   // refused
  ])
  check("listing price: hindsight pair excluded (3 graded, not 4)", lp.available && lp.observations === 3, String(lp.observations))
  const expectedMedian = Math.round(fractionalMedian([20_000 / 520_000, 0.2, 0.01]) * 10000) / 10000
  check("listing price: median pct error is the true fractional median", lp.medianError?.value === expectedMedian && lp.medianError.unit === "pct_of_sale", `${lp.medianError?.value} vs ${expectedMedian}`)
  check("listing price: no invented within-rate (no stored band)", lp.withinRate === null)
  const dom = summarizeDomRows([
    pair({}),                                        // actual DOM = 50, predicted 30 → miss 20
    pair({ daysToSellEstimate: 55 }),                // miss 5
    pair({ daysToSellEstimate: null }),              // ungradable
  ])
  // misses sorted: 5, 20 → medianOf rounds avg → 13 (round(12.5))
  check("DOM: 2 graded, median miss in days", dom.available && dom.observations === 2 && dom.medianError?.value === 13 && dom.medianError.unit === "days", JSON.stringify(dom.medianError))
  check("listing price: empty → available:false", summarizeListingPriceRows([]).available === false)

  // — open-house attendance —
  const att = summarizeAttendanceRows([
    { predicted: 18, actual: 25, eventDate: "2026-05-01" },   // miss 7
    { predicted: 12, actual: 10, eventDate: "2026-05-08" },   // miss 2
    { predicted: 20, actual: null, eventDate: "2026-05-15" }, // no head count → refused
  ])
  check("attendance: only events with BOTH sides graded (2)", att.available && att.observations === 2, String(att.observations))
  check("attendance: median miss = 5 people (round(4.5))", att.medianError?.value === 5 && att.medianError.unit === "people", String(att.medianError?.value))
  check("attendance: no invented band", att.withinRate === null)

  // — offer strategy —
  const strat = summarizeStrategyRows([
    { outcome: "accepted", final_price: 505_000, deviation_from_recommendation: 5_000, created_at: "2026-01-01T00:00:00Z" },
    { outcome: "countered", final_price: 512_000, deviation_from_recommendation: 12_000, created_at: "2026-01-02T00:00:00Z" },
    { outcome: "rejected", final_price: null, deviation_from_recommendation: null, created_at: "2026-01-03T00:00:00Z" },
  ])
  check("strategy: 2 graded (null deviation refused), median $8,500", strat.available && strat.observations === 2 && strat.medianError?.value === 8_500, JSON.stringify(strat.medianError))
  check("strategy: acceptance reported as a note, not as accuracy", strat.withinRate === null && strat.honestNotes.some((n) => n.includes("1 of 3")), JSON.stringify(strat.honestNotes))

  // — pattern predictions —
  const pat = summarizePatternRows([
    { outcome: "correct", outcome_recorded_at: "2026-06-01T00:00:00Z" },
    { outcome: "correct", outcome_recorded_at: "2026-06-02T00:00:00Z" },
    { outcome: "incorrect", outcome_recorded_at: "2026-06-03T00:00:00Z" },
    { outcome: null, outcome_recorded_at: null },
  ])
  check("patterns: hit rate 2/3 over HUMAN-graded rows only", pat.available && pat.observations === 3 && pat.withinRate?.rate === 0.67, JSON.stringify(pat.withinRate))
  check("patterns: pending rows named, never assumed correct", pat.honestNotes.some((n) => n.includes("1 prediction")), JSON.stringify(pat.honestNotes))
  const patPending = summarizePatternRows([{ outcome: null, outcome_recorded_at: null }])
  check("patterns: predictions without verdicts → available:false with honest why", patPending.available === false && (patPending.why ?? "").includes("human-recorded"), patPending.why ?? "")

  // — content performance —
  const content = summarizeContentRows([
    { delta_score: -10, logged_at: "2026-02-01T00:00:00Z" },
    { delta_score: 4, logged_at: "2026-02-02T00:00:00Z" },
    { delta_score: 22, logged_at: "2026-02-03T00:00:00Z" },
  ])
  check("content: median |delta| = 10 pts over 3 logged outcomes", content.available && content.observations === 3 && content.medianError?.value === 10, String(content.medianError?.value))
  check("content: empty log → available:false", summarizeContentRows([]).available === false)

  // ═══ Layer 1b · the four round-36 rails (exclusion audit) ═══
  console.log("\n[Layer 1b · round-36 rails — deal outcome, AVM join, propensity, income forecast]")

  // — probability normalization —
  check("normalizeProbability: 0..1 passes through", normalizeProbability(0.75) === 0.75)
  check("normalizeProbability: 0..100 scaled", normalizeProbability(75) === 0.75)
  check("normalizeProbability: out-of-range / junk refused", normalizeProbability(140) === null && normalizeProbability("x") === null && normalizeProbability(-1) === null)

  // — deal outcome (first pre-outcome call per deal, real terminal events only) —
  const doRow = (over: Partial<DealOutcomePredictionRow>): DealOutcomePredictionRow => ({
    predictionType: "win_probability",
    predictionValue: { win_probability: 0.8 },
    actualOutcome: { outcome: "closed" },
    outcomeDate: "2026-06-01T00:00:00Z",
    createdAt: "2026-03-01T00:00:00Z",
    entityId: "t1",
    ...over,
  })
  const dealRail = summarizeDealOutcomeRows([
    doRow({ entityId: "t1", createdAt: "2026-03-01T00:00:00Z", predictionValue: { win_probability: 0.8 } }),           // first call — graded (|0.8−1| = 0.2)
    doRow({ entityId: "t1", createdAt: "2026-05-30T00:00:00Z", predictionValue: { win_probability: 0.99 } }),          // later converged call — ignored
    doRow({ entityId: "t2", predictionValue: { closeProbability: 40 }, actualOutcome: { outcome: "lost" }, createdAt: "2026-02-01T00:00:00Z" }), // |0.4−0| = 0.4
    doRow({ entityId: "t3", createdAt: "2026-07-01T00:00:00Z" }),                                                      // claim AFTER the outcome — hindsight, refused
    doRow({ entityId: "t4", actualOutcome: { outcome: "pending" } }),                                                  // not a terminal event — refused
  ])
  check("deal outcome: first pre-outcome call per deal only (2 graded)", dealRail.available && dealRail.observations === 2, String(dealRail.observations))
  // errors 0.2, 0.4 → fractional median 0.3 → 30 probability points
  check("deal outcome: median = 30 probability pts", dealRail.medianError?.value === 30 && dealRail.medianError.unit === "probability_pts", String(dealRail.medianError?.value))
  check("deal outcome: no minted within-rate", dealRail.withinRate === null)
  check("deal outcome: empty → available:false", summarizeDealOutcomeRows([]).available === false)

  // — AVM address join (strict, unique-only) —
  check("address key: suffix + punctuation normalize to one key",
    normalizeAddressKey("123 Main Street", "30301") === normalizeAddressKey("123 Main St.", "30301-4321") && normalizeAddressKey("123 Main Street", "30301") != null)
  check("address key: unit designators stripped", normalizeAddressKey("123 Main St Apt 4B", "30301") === normalizeAddressKey("123 Main St", "30301"))
  check("address key: no street number / no ZIP refused", normalizeAddressKey("Main St", "30301") === null && normalizeAddressKey("123 Main St", "GA") === null)
  const est = (over: Partial<AvmEstimateRow>): AvmEstimateRow => ({
    street: "123 Main Street", zip: "30301", brokerageId: "b1",
    low: 380_000, mid: 400_000, high: 430_000, generatedAt: "2026-01-15T00:00:00Z", ...over,
  })
  const soldRow = (over: Partial<SoldListingAddressRow>): SoldListingAddressRow => ({
    street: "123 Main St", zip: "30301", brokerageId: "b1", soldPrice: 410_000, soldDate: "2026-04-01", ...over,
  })
  const avm = summarizeHomeValueRows(
    [
      est({}),                                                                      // graded: sold 410k within [380k,430k]
      est({ street: "77 Oak Ave", generatedAt: "2026-01-01T00:00:00Z", low: 100_000, mid: 120_000, high: 130_000 }), // ambiguous key → refused
      est({ street: "9 Pine Dr", generatedAt: "2026-09-01T00:00:00Z" }),            // generated AFTER the sale → refused
    ],
    [
      soldRow({}),
      soldRow({ street: "77 Oak Avenue", soldPrice: 200_000 }),
      soldRow({ street: "77 Oak Ave.", soldPrice: 210_000 }),                       // same key twice → ambiguity refused
      soldRow({ street: "9 Pine Drive", soldDate: "2026-05-01" }),
    ],
  )
  check("AVM: 1 graded (ambiguous + post-sale refused)", avm.available && avm.observations === 1, String(avm.observations))
  check("AVM: within-rate uses the estimate's OWN band (1/1)", avm.withinRate?.rate === 1, JSON.stringify(avm.withinRate))
  check("AVM: median error is |mid − sold| / sold", avm.medianError?.value === Math.round((10_000 / 410_000) * 10000) / 10000 && avm.medianError.unit === "pct_of_sale", String(avm.medianError?.value))
  check("AVM: ambiguity is NAMED in the honest notes", avm.honestNotes.some((n) => n.includes("refused")), JSON.stringify(avm.honestNotes))
  const avmCross = summarizeHomeValueRows([est({ brokerageId: "b2" })], [soldRow({})])
  check("AVM: cross-brokerage same-address never joins", avmCross.available === false)

  // — listing propensity (immutable trigger ledger vs a real later listing) —
  const NOW = "2026-07-20T00:00:00Z"
  const act = (over: Partial<PropensityActionRow>): PropensityActionRow => ({
    contactId: "c1", brokerageId: "b1", createdAt: "2026-01-01T00:00:00Z", ...over,
  })
  const lev = (over: Partial<ContactListingEvent>): ContactListingEvent => ({
    contactId: "c1", brokerageId: "b1", listedAt: "2026-03-01T00:00:00Z", ...over,
  })
  const prop = summarizePropensityRows(
    [
      act({ contactId: "c1" }),                                       // listed 2026-03-01, within 180d → hit
      act({ contactId: "c1", createdAt: "2026-02-01T00:00:00Z" }),    // later duplicate trigger — first one wins
      act({ contactId: "c2" }),                                       // no listing, window elapsed → miss
      act({ contactId: "c3", createdAt: "2026-07-01T00:00:00Z" }),    // window still open → pending, not graded
      act({ contactId: "c4" }),                                       // listing BEFORE the trigger → refused
    ],
    [
      lev({ contactId: "c1" }),
      lev({ contactId: "c4", listedAt: "2025-12-01T00:00:00Z" }),
    ],
    NOW,
  )
  check("propensity: 2 graded (1 hit + 1 elapsed miss), pending/pre-existing excluded", prop.available && prop.observations === 2, String(prop.observations))
  check("propensity: hit rate 1/2 with the horizon NAMED in the label",
    prop.withinRate?.rate === 0.5 && (prop.withinRate?.label ?? "").includes(String(LISTING_PROPENSITY_HORIZON_DAYS)), JSON.stringify(prop.withinRate))
  check("propensity: pending + refused counted in honest notes",
    prop.honestNotes.some((n) => n.includes("still inside the window")) && prop.honestNotes.some((n) => n.includes("refused")), JSON.stringify(prop.honestNotes))
  const propPending = summarizePropensityRows([act({ contactId: "c9", createdAt: "2026-07-10T00:00:00Z" })], [], NOW)
  check("propensity: open windows only → available:false (never graded early)", propPending.available === false && (propPending.why ?? "").includes("window"))

  // — income forecast (weighted_30 vs realized closed GCI, snapshot's own band) —
  const snap = (over: Partial<IncomeForecastSnapshotRow>): IncomeForecastSnapshotRow => ({
    agentId: "a1", computedAt: "2026-01-01T00:00:00Z", weighted30: 10_000, lowBandPct: 25, highBandPct: 15, ...over,
  })
  const deal = (over: Partial<ClosedDealGciRow>): ClosedDealGciRow => ({
    agentId: "a1", closeDate: "2026-01-15", gci: 9_000, ...over,
  })
  const inc = summarizeIncomeForecastRows(
    [
      snap({}),                                                        // realized 9,000 vs 10,000 → within [7,500, 11,500]
      snap({ computedAt: "2026-01-20T00:00:00Z" }),                    // same agent+month — deduped (earliest wins)
      snap({ agentId: "a2", weighted30: 20_000 }),                     // realized 0 → miss by 20,000, outside band
      snap({ agentId: "a3", weighted30: 0 }),                          // zero forecast + zero realized → trivial, skipped
      snap({ agentId: "a4", computedAt: "2026-07-10T00:00:00Z" }),     // window not elapsed → not graded
    ],
    [deal({}), deal({ agentId: "a1", closeDate: "2025-12-30", gci: 99_999 })], // pre-window close never counts
    NOW,
  )
  check("income forecast: 2 graded (month-dedup, trivial + open-window skipped)", inc.available && inc.observations === 2, String(inc.observations))
  // errors: |9,000−10,000| = 1,000 and |0−20,000| = 20,000 → medianOf rounds avg → 10,500
  check("income forecast: median |realized − forecast| = $10,500", inc.medianError?.value === 10_500 && inc.medianError.unit === "usd", String(inc.medianError?.value))
  check("income forecast: within-rate 1/2 against the snapshot's OWN band", inc.withinRate?.rate === 0.5, JSON.stringify(inc.withinRate))
  check("income forecast: trivial zero-zero skip named in notes", inc.honestNotes.some((n) => n.includes("skipped")), JSON.stringify(inc.honestNotes))
  check("income forecast: empty → available:false", summarizeIncomeForecastRows([], [], NOW).available === false)

  // ═══ Layer 1c · ACCURACY-DRIVEN AUTONOMY (round 36, rec 4) ═══
  console.log("\n[Layer 1c · accuracy gate — the predictive autonomy policy dispatch enforces]")

  const pricingPolicy = ACCURACY_GATE_POLICIES.pricing
  const strongPricing = summarizeListingPriceRows(Array.from({ length: 6 }, () =>
    pair({ predictedPrice: 505_000, soldPrice: 500_000 }))) // 1% median error, 6 obs
  const earned = accuracyGateVerdict(pricingPolicy, strongPricing)
  check("gate: strong rail (6 obs, 1% median) → EARNED with measured evidence",
    earned.state === "earned" && earned.observations === 6 && earned.reason.includes("1.0%"), earned.reason)
  const thinPricing = summarizeListingPriceRows([pair({})])
  const thin = accuracyGateVerdict(pricingPolicy, thinPricing)
  check("gate: thin sample (< min obs) → SUPERVISED with the stated reason",
    thin.state === "supervised" && thin.reason.includes(`${pricingPolicy.minObservations}`), thin.reason)
  const wildPricing = summarizeListingPriceRows(Array.from({ length: 6 }, () =>
    pair({ predictedPrice: 600_000, soldPrice: 500_000 }))) // 20% median error
  const offBar = accuracyGateVerdict(pricingPolicy, wildPricing)
  check("gate: off-the-bar rail (20% median) → SUPERVISED citing the measured miss",
    offBar.state === "supervised" && offBar.reason.includes("20.0%"), offBar.reason)
  const noRead = accuracyGateVerdict(pricingPolicy, null)
  check("gate: unreadable rail → NO_SIGNAL (fail open, stated)", noRead.state === "no_signal" && accuracyHold(noRead).held === false)
  const emptyRail = accuracyGateVerdict(pricingPolicy, summarizeListingPriceRows([]))
  check("gate: readable-but-empty rail → SUPERVISED (accuracy is earned, not assumed)",
    emptyRail.state === "supervised" && accuracyHold(emptyRail).held === true, emptyRail.reason)
  check("gate: only listed managers are gated (mapped domains exist)",
    MANAGER_ACCURACY_DOMAIN.listing_concierge === "pricing" && MANAGER_ACCURACY_DOMAIN.campaign_orchestrator === "marketing_content" && MANAGER_ACCURACY_DOMAIN.ai_isa === undefined)

  // — the decision point: precedence proven on the EXACT pure fn dispatch runs —
  const hold = accuracyHold(emptyRail)
  const heldByAccuracy = autonomyDecision({ managerKey: "campaign_orchestrator", effective: "autonomous", accuracyGate: hold })
  check("decision: 'autonomous' + supervised verdict → HELD with the measured reason",
    !heldByAccuracy.allow && heldByAccuracy.held && heldByAccuracy.posture === "approval_required" && heldByAccuracy.reason === hold.reason)
  check("decision: earned verdict changes nothing (never grants, never blocks)",
    autonomyDecision({ managerKey: "campaign_orchestrator", effective: "autonomous", accuracyGate: accuracyHold(earned) }).allow === true)
  check("decision: null / review_recommended postures are NOT accuracy-gated (no day-one regression)",
    autonomyDecision({ managerKey: "campaign_orchestrator", effective: null, accuracyGate: hold }).allow === true &&
    autonomyDecision({ managerKey: "campaign_orchestrator", effective: "review_recommended", accuracyGate: hold }).allow === true)
  check("decision: HUMAN-APPROVED bypasses the accuracy gate (supervised means a human approves)",
    autonomyDecision({ managerKey: "campaign_orchestrator", effective: "autonomous", humanApproved: true, accuracyGate: hold }).allow === true)
  const haltWins = autonomyDecision({
    managerKey: "campaign_orchestrator", effective: "autonomous",
    platformHalt: { halted: true, reason: "platform emergency halt" }, accuracyGate: accuracyHold(earned),
  })
  check("decision: a HALT always wins — an earned accuracy verdict never overrides it",
    !haltWins.allow && haltWins.reason === "platform emergency halt")
  const tenantWins = autonomyDecision({
    managerKey: "campaign_orchestrator", effective: "autonomous",
    tenantHalt: { halted: true, reason: "staff paused this brokerage" }, accuracyGate: accuracyHold(earned),
  })
  check("decision: the tenant halt also beats the accuracy gate", !tenantWins.allow && tenantWins.reason === "staff paused this brokerage")

  // ═══ Layer 1d · the round-38 assignment-policy rail (rec 2) ═══
  console.log("\n[Layer 1d · assignment-policy outcomes — attributed policies vs real first appointments]")

  const apRules: AssignmentRuleInfo[] = [
    { id: "ra", name: "Hot ZIPs", ruleType: "geo_based", isActive: true },
    { id: "rb", name: "Round robin", ruleType: "round_robin", isActive: true },
    { id: "rc", name: "Old rule", ruleType: "specialization", isActive: false },
  ]
  const asg = (over: Partial<AssignedCohortRow>): AssignedCohortRow => ({
    key: "lead:l1", brokerageId: "b1", contactId: "c1", leadId: "l1",
    ruleId: "ra", method: "geo_based", assignedAt: "2026-01-01T00:00:00Z", ...over,
  })
  const apCohort: AssignedCohortRow[] = [
    asg({}),                                                                                 // ruleA — appt on c1 at day 9 → hit
    asg({ key: "lead:l1", assignedAt: "2026-02-01T00:00:00Z" }),                             // duplicate identity — first assignment wins
    asg({ key: "lead:l2", leadId: "l2", contactId: "c2" }),                                  // ruleA — no appt, window elapsed → miss
    asg({ key: "lead:l3", leadId: "l3", contactId: null, ruleId: "rb", method: "round_robin" }),      // ruleB — appt joins via the LEAD entity at day 59 → miss (past horizon)
    asg({ key: "lead:l4", leadId: "l4", contactId: "c4", ruleId: "rb", method: "round_robin" }),      // ruleB — appt day 4 → hit
    asg({ key: "lead:l5", leadId: "l5", contactId: "c5", ruleId: null, method: "load_balance", assignedAt: "2026-07-10T00:00:00Z" }), // fallback — open window → pending
    asg({ key: "lead:l6", leadId: "l6", contactId: "c6" }),                                  // appt BEFORE assignment → refused
    asg({ key: "contact:c9", leadId: null, contactId: "c9", ruleId: "rb", method: "round_robin", assignedAt: "2026-01-20T00:00:00Z" }), // Track-B contact — appt day 12 → hit
  ]
  const apEvents: FirstAppointmentEvent[] = [
    { contactId: "c1", leadId: null, at: "2026-01-10T00:00:00Z" },
    { contactId: null, leadId: "l3", at: "2026-03-01T00:00:00Z" },
    { contactId: "c4", leadId: null, at: "2026-01-05T00:00:00Z" },
    { contactId: "c6", leadId: null, at: "2025-12-30T00:00:00Z" },
    { contactId: "c9", leadId: null, at: "2026-02-01T00:00:00Z" },
  ]
  const apRail = summarizeAssignmentPolicyRows(apCohort, apRules, apEvents, NOW)
  check("assignment policy: 5 graded (dup deduped, pending + pre-existing excluded)", apRail.available && apRail.observations === 5, String(apRail.observations))
  check(`assignment policy: outcome rate 3/5 with the ${ASSIGNMENT_OUTCOME_HORIZON_DAYS}-day horizon NAMED in the label`,
    apRail.withinRate?.rate === 0.6 && (apRail.withinRate?.label ?? "").includes(String(ASSIGNMENT_OUTCOME_HORIZON_DAYS)), JSON.stringify(apRail.withinRate))
  check("assignment policy: a rate rail mints NO error metric", apRail.medianError === null)
  check("assignment policy: per-policy breakdown carries only graded policies (rule B 3 obs first, rule A 2 obs)",
    apRail.breakdown?.length === 2 && apRail.breakdown[0].group.includes("Round robin") && apRail.breakdown[0].observations === 3
    && apRail.breakdown[0].withinRate === 0.67 && apRail.breakdown[1].observations === 2 && apRail.breakdown[1].withinRate === 0.5,
    JSON.stringify(apRail.breakdown))
  check("assignment policy: pending + pre-existing-appointment refusals named in the honest notes",
    apRail.honestNotes.some((n) => n.includes("still inside the window")) && apRail.honestNotes.some((n) => n.includes("refused")), JSON.stringify(apRail.honestNotes))
  check("assignment policy: an appointment joining via the LEAD entity grades (no contact row required)",
    (() => { const r = computePolicyOutcomes(apCohort, apRules, apEvents, NOW); return r.stats.find((s) => s.policyKey === "rule:rb")?.observations === 3 })())
  check("assignment policy: empty cohort → available:false with a why", summarizeAssignmentPolicyRows([], apRules, [], NOW).available === false)
  const apPendingOnly = summarizeAssignmentPolicyRows([asg({ key: "lead:l9", leadId: "l9", contactId: "c99", assignedAt: "2026-07-15T00:00:00Z" })], apRules, [], NOW)
  check("assignment policy: open windows only → available:false (never graded early)",
    apPendingOnly.available === false && (apPendingOnly.why ?? "").includes("window"), apPendingOnly.why ?? "")
  check("policy labels: retired + deleted rules and fallback methods are named honestly",
    policyLabel({ ruleId: "rc", method: "specialization" }, apRules).includes("(retired)")
    && policyLabel({ ruleId: "gone-rule-id", method: "x" }, apRules).startsWith("deleted rule")
    && policyLabel({ ruleId: null, method: "load_balance" }, apRules).includes("fallback"))

  // — the divergence detector (the deliberation feed's trigger) —
  const stat = (over: Partial<PolicyOutcomeStat>): PolicyOutcomeStat => ({
    policyKey: "rule:ra", ruleId: "ra", isActiveRule: true, label: "A",
    observations: 10, hits: 6, rate: 0.6, pending: 0, ...over,
  })
  const divergent = findDivergentRulePair([
    stat({}), stat({ policyKey: "rule:rb", ruleId: "rb", label: "B", hits: 2, rate: 0.2 }),
  ])
  check("divergence: two active rules ≥ floor with a 40-pt gap → the pair is found (top vs laggard)",
    divergent?.top.ruleId === "ra" && divergent?.laggard.ruleId === "rb" && divergent?.gap === 0.4, JSON.stringify(divergent))
  check(`divergence: below the ${ASSIGNMENT_POLICY_MIN_OBSERVATIONS}-observation floor → NO dispute is manufactured`,
    findDivergentRulePair([stat({ observations: ASSIGNMENT_POLICY_MIN_OBSERVATIONS - 1 }), stat({ policyKey: "rule:rb", ruleId: "rb", rate: 0.1 })]) === null)
  check("divergence: an immaterial gap → null (never argued)",
    findDivergentRulePair([stat({}), stat({ policyKey: "rule:rb", ruleId: "rb", rate: 0.5 })]) === null)
  check("divergence: retired rules and non-rule fallbacks never argue (no admin knob to defend)",
    findDivergentRulePair([stat({}), stat({ policyKey: "rule:rc", ruleId: "rc", isActiveRule: false, rate: 0.1 })]) === null
    && findDivergentRulePair([stat({}), stat({ policyKey: "method:load_balance", ruleId: null, rate: 0.1 })]) === null)

  // ═══ Layer 2 · static guarantees on the library + the two mounts ═══
  console.log("\n[Layer 2 · read-only, existing tables only, keep-one component]")

  const libSrc = readFileSync(join(ROOT, "lib/analytics/prediction-accuracy.ts"), "utf8")
  check("aggregator is STRICTLY read-only (no insert/update/upsert/delete/rpc)",
    !/\.(insert|update|upsert|delete|rpc)\s*\(/.test(libSrc))

  // Every .from("table") literal must exist in the schema snapshot — no new tables.
  const snapshot = readFileSync(join(ROOT, "scripts/schema-snapshot.ts"), "utf8")
  const tables = [...libSrc.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1])
  check("adapters actually read the ledgers (≥ 12 table reads)", tables.length >= 12, tables.join(","))
  const unknown = [...new Set(tables)].filter((t) => !new RegExp(`^\\s+${t}: \\[`, "m").test(snapshot))
  check("every table read exists in the schema snapshot (no new table literals)", unknown.length === 0, unknown.join(","))

  // ── round-38 wiring: the assignment-policy rail, its attribution sites, and its sweep ──
  const assignSrc = readFileSync(join(ROOT, "lib/analytics/assignment-outcomes.ts"), "utf8")
  const assignTables = [...assignSrc.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1])
  const assignUnknown = [...new Set(assignTables)].filter((t) => !new RegExp(`^\\s+${t}: \\[`, "m").test(snapshot))
  check("assignment-policy adapter reads only schema-snapshot tables", assignUnknown.length === 0, assignUnknown.join(","))
  check("assignment-policy module performs no direct writes (the sweep raises through the governed referral bus only)",
    !/\.(insert|update|upsert|delete)\s*\(/.test(assignSrc) && assignSrc.includes("raiseReferralDeduped"))
  const leadHandlersSrc = readFileSync(join(ROOT, "lib/kernel/lead-acquisition-handlers.ts"), "utf8")
  check("attribution is recorded AT assignment time: assignment_log.rule_id + the LEAD_ASSIGNED event payload carries the matched rule",
    leadHandlersSrc.includes("rule_id: ruleId ?? null") &&
    /LEAD_ASSIGNED,\s*\n\s*brokerage_id: brokerageId,\s*\n\s*metadata: \{ assignment:/.test(leadHandlersSrc))
  const captureSrc = readFileSync(join(ROOT, "lib/contact-pipeline/contact-capture.ts"), "utf8")
  check("Track-B capture stamps the matched rule on CONTACT_CAPTURED (attribution starts now — never retro-fabricated)",
    captureSrc.includes("createAttribution = { method: createAssignment.method, rule_id: createAssignment.ruleId ?? null }")
    && captureSrc.includes("{ assignment: createAttribution }"))
  const crossSrc = readFileSync(join(ROOT, "lib/managers/cross-referral.ts"), "utf8")
  const registrySrc = readFileSync(join(ROOT, "lib/kernel/manager-registry.ts"), "utf8")
  check("the divergence sweep is the registered live raiser of the deliberative assignment_policy_outcomes edge (ai_isa → data_steward)",
    crossSrc.includes('collabDomain: "assignment_policy_outcomes"') && crossSrc.includes("assignment_policy_sweep")
    && registrySrc.includes('key: "assignment_policy_outcomes"')
    && /assignment_policy_outcomes:[\s\S]{0,1600}?deliberate: true/.test(registrySrc))
  const delibSrc = readFileSync(join(ROOT, "lib/managers/deliberation.ts"), "utf8")
  check("the Data Steward's deliberation seat is grounded in the assignment_rules book for policy disputes",
    delibSrc.includes('ctx.entityType === "assignment_rule"') && delibSrc.includes('svc.from("assignment_rules")'))

  // ── round-36 wiring: the outcome writer, the freezer, and the accuracy gate ──
  const outcomesSrc = readFileSync(join(ROOT, "lib/analytics/ai-prediction-outcomes.ts"), "utf8")
  check("outcome writer exists and grades only on terminal events (idempotent guard)",
    outcomesSrc.includes("gradeTransactionPredictionOutcomes") && outcomesSrc.includes('.is("actual_outcome", null)'))
  const stageSrc = readFileSync(join(ROOT, "lib/transactions/stage-progression.ts"), "utf8")
  check("stage-progression grades ai_predictions at BOTH terminal stages (CLOSED and LOST)",
    /outcome: "closed"/.test(stageSrc) && /outcome: "lost"/.test(stageSrc) && stageSrc.includes("gradeTransactionPredictionOutcomes"))
  const coordSrc = readFileSync(join(ROOT, "app/actions/ai-transaction-coordinator.ts"), "utf8")
  check("the single win_probability writer freezes every claim as a snapshot",
    coordSrc.includes("captureWinProbabilitySnapshot") && coordSrc.includes("win_probability: analysis.winProbability"))
  const gateSrc = readFileSync(join(ROOT, "lib/managers/accuracy-gate.ts"), "utf8")
  check("accuracy gate consults the SAME rail loader the panel reads (no forked math)",
    gateSrc.includes("loadRailAccuracy") && gateSrc.includes("accuracyGateVerdict"))
  const dispatchSrc = readFileSync(join(ROOT, "lib/providers/dispatch.ts"), "utf8")
  check("dispatch consults the accuracy gate ONLY for an explicit 'autonomous' posture",
    dispatchSrc.includes("loadAccuracyHoldForManager") && /effective === "autonomous" && !humanApproved/.test(dispatchSrc))
  const autonomySrc = readFileSync(join(ROOT, "lib/managers/autonomy-gate.ts"), "utf8")
  check("the pure decision carries the accuracy gate BELOW both halts",
    autonomySrc.indexOf("platformHalt?.halted") < autonomySrc.indexOf("accuracyGate?.held") &&
    autonomySrc.indexOf("tenantHalt?.halted") < autonomySrc.indexOf("accuracyGate?.held"))
  const trustPageSrc = readFileSync(join(ROOT, "app/dashboard/admin/manager-trust/page.tsx"), "utf8")
  const trustClientSrc = readFileSync(join(ROOT, "app/dashboard/admin/manager-trust/manager-trust-client.tsx"), "utf8")
  check("the autonomy governance panel shows the per-domain verdict + reason",
    trustPageSrc.includes("loadAccuracyGateReport") && trustClientSrc.includes("accuracyGates") && trustClientSrc.includes("{g.reason}"))

  const superadminSrc = readFileSync(join(ROOT, "app/dashboard/superadmin/platform/page.tsx"), "utf8")
  const brokerSrc = readFileSync(join(ROOT, "app/dashboard/analytics/page.tsx"), "utf8")
  check("superadmin platform mounts the keep-one panel (cross-tenant)",
    superadminSrc.includes("PredictionAccuracyPanel") && superadminSrc.includes("getPredictionAccuracyReport"))
  check("superadmin mount is cross-tenant (no brokerageId passed)",
    /getPredictionAccuracyReport\(createServiceClient\(\) as any\)/.test(superadminSrc))
  check("broker analytics mounts the SAME panel, tenant-scoped",
    brokerSrc.includes("PredictionAccuracyPanel") && /brokerageId: profile\.brokerage_id/.test(brokerSrc))
  check("round-34 standalone rollup merged in (old card gone, keep-one)",
    !superadminSrc.includes("getClosingCostAccuracyReport") && !superadminSrc.includes("Closing-cost estimate accuracy"))
  const panelSrc = readFileSync(join(ROOT, "app/components/analytics/prediction-accuracy-panel.tsx"), "utf8")
  check("panel renders honest per-rail empty states (shows each rail's why)",
    panelSrc.includes("Not graded yet") && panelSrc.includes("{r.why}"))
  check("panel links each rail to its detail source", panelSrc.includes("r.detailHref"))

  // ═══ Layer 3 · the trust chip: earned or absent ═══
  console.log("\n[Layer 3 · trust chip thresholds + consumer omission]")

  const strongNet = summarizeNetSheetRows(Array.from({ length: 10 }, (_, i) => ns(i < 9 ? 100 : -30_000, i < 9 ? "none" : "severe")))
  check("fixture sanity: strong net-sheet rail (10 obs, 0.9 within)", strongNet.observations === 10 && strongNet.withinRate?.rate === 0.9)
  const chip = composePredictionTrustChip([strongNet, ccEmpty, summarizeListingPriceRows([])])
  check("strong rail → chip composes, citing measured counts", chip?.rail === "net_sheet" && chip.line.includes("9 of 10"), chip?.line)

  const weakNet = summarizeNetSheetRows([ns(-20_000, "severe"), ns(-15_000, "severe"), ns(100, "none"), ns(200, "none"), ns(-8_000, "concerning")])
  check(`weak within-rate (< ${TRUST_CHIP_NET_SHEET_MIN_WITHIN}) → chip is null`, composePredictionTrustChip([weakNet]) === null)
  const thinNet = summarizeNetSheetRows(Array.from({ length: TRUST_CHIP_MIN_OBSERVATIONS - 1 }, () => ns(50, "none")))
  check(`thin sample (< ${TRUST_CHIP_MIN_OBSERVATIONS} obs) → chip is null even at 100% within`, composePredictionTrustChip([thinNet]) === null)
  check("no rails → chip is null", composePredictionTrustChip([]) === null)

  // Consumers: the pitch kit section + QBR line appear ONLY when the chip exists.
  const brand = { primaryColor: "#000000", brokerageName: "Sim" } as any
  const baseFacts: RecruitingPitchFacts = {
    brokerageName: "Sim Brokerage", pitch: "p", valueProps: [], splitToAgent: null, monthlyFee: null,
    recruitedGciDollars: null, recruitedAgentCount: null, contactLine: null,
  }
  const specWithout = recruitingPitchSpec(baseFacts, "Pitch.", brand, "July 2026")
  const specWith = recruitingPitchSpec({ ...baseFacts, accuracyTrustLine: chip!.line }, "Pitch.", brand, "July 2026")
  const headings = (s: ReturnType<typeof recruitingPitchSpec>) => s.sections.map((x) => x.heading ?? "")
  check("pitch kit: chip absent → 'A system that grades itself' section OMITTED", !headings(specWithout).includes("A system that grades itself"))
  check("pitch kit: chip present → section renders the measured line",
    headings(specWith).includes("A system that grades itself") &&
    specWith.sections.some((s) => (s.paragraphs ?? []).includes(chip!.line)))

  const qFacts: QuarterFacts = {
    windowLabel: "Apr – Jul", planTier: null, closedDeals: 1, closedVolume: 100, activeDeals: 1,
    newContacts: 1, approvals: 1, autonomousActs: 0, grantsHeld: 0, conflictsCaught: 0,
    giftsOrdered: 0, briefingsOpened: 1, unusedRails: [], trustIncidents: 0, expansion: null,
  }
  const qbrWithout = composeQuarterlyReview(qFacts)
  const qbrWith = composeQuarterlyReview({ ...qFacts, accuracyTrustLine: chip!.line })
  check("QBR: chip absent → no accuracy line in trust", !qbrWithout.trust.includes(chip!.line))
  check("QBR: chip present → the measured line lands in trust", qbrWith.trust.includes(chip!.line))

  // ═══ Layer 4 · live (creds-gated): the aggregator never throws ═══
  console.log("\n[Layer 4 · live aggregator (creds-gated)]")
  const hasCreds =
    !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure + static layers ran).")
    return report()
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const live = await getPredictionAccuracyReport(svc as any)
  check("live: full 13-rail shape returned without throwing", live.rails.length === 13, String(live.rails.length))
  check("live: every rail is honest (available with numbers, or unavailable with a why)",
    live.rails.every((r: RailAccuracy) => (r.available && r.observations > 0) || (!r.available && !!r.why && r.medianError === null)),
    JSON.stringify(live.rails.map((r) => ({ rail: r.rail, available: r.available, obs: r.observations, why: r.why }))))
  check("live: totalObservations is the sum of rail observations",
    live.totalObservations === live.rails.reduce((s, r) => s + r.observations, 0))
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
