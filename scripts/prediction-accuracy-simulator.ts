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
 *   throwing and returns the full 8-rail shape.
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
  type RailAccuracy,
  type NetSheetReconRow,
  type PricePredictionPair,
} from "../lib/analytics/prediction-accuracy"
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

  // ═══ Layer 2 · static guarantees on the library + the two mounts ═══
  console.log("\n[Layer 2 · read-only, existing tables only, keep-one component]")

  const libSrc = readFileSync(join(ROOT, "lib/analytics/prediction-accuracy.ts"), "utf8")
  check("aggregator is STRICTLY read-only (no insert/update/upsert/delete/rpc)",
    !/\.(insert|update|upsert|delete|rpc)\s*\(/.test(libSrc))

  // Every .from("table") literal must exist in the schema snapshot — no new tables.
  const snapshot = readFileSync(join(ROOT, "scripts/schema-snapshot.ts"), "utf8")
  const tables = [...libSrc.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1])
  check("adapters actually read the ledgers (≥ 8 table reads)", tables.length >= 8, tables.join(","))
  const unknown = [...new Set(tables)].filter((t) => !new RegExp(`^\\s+${t}: \\[`, "m").test(snapshot))
  check("every table read exists in the schema snapshot (no new table literals)", unknown.length === 0, unknown.join(","))

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
  check("live: full 8-rail shape returned without throwing", live.rails.length === 8, String(live.rails.length))
  check("live: every rail is honest (available with numbers, or unavailable with a why)",
    live.rails.every((r: RailAccuracy) => (r.available && r.observations > 0) || (!r.available && !!r.why && r.medianError === null)),
    JSON.stringify(live.rails.map((r) => ({ rail: r.rail, available: r.available, obs: r.observations, why: r.why }))))
  check("live: totalObservations is the sum of rail observations",
    live.totalObservations === live.rails.reduce((s, r) => s + r.observations, 0))
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
