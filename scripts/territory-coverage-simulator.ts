#!/usr/bin/env tsx
/**
 * scripts/territory-coverage-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Round 39 — TERRITORY COVERAGE MAP + SCRAPE ROI PER TERRITORY.
 *
 * Layer 1 — pure coverage math on fixtures (lib/analytics/territory-coverage):
 *           claim resolution through the SAME active-subscription predicate the
 *           scrape resolver uses (stale claims counted, never shown as live),
 *           per-zip raw/promoted/platform/awaiting tallies, unknown-zip bucket,
 *           state grouping, honest empty board, and the tenant view (claimed
 *           zips, totals, same-state expansion hints with REAL platform volume
 *           only — never a zero-volume suggestion).
 *
 * Layer 2 — pure ROI math on fixtures (lib/analytics/territory-roi): the
 *           raw → promoted → contacts → first-appointments funnel with honest
 *           denominators (null rates, never fabricated 0%/100%), recorded-cost-
 *           only economics ("cost not recorded" is a stated absence), the
 *           pre-existing-appointment refusal (round-38 idiom), and the
 *           cost-divergence detector (fires only with both sides at the floor
 *           AND recorded cost; unrecorded cost can never argue).
 *
 * Layer 3 — source locks: active-predicate reuse in both libs, NO map library
 *           on either mount (an honest sortable table beats a fake map), BOTH
 *           mounts present (superadmin platform board + tenant scrape-
 *           diagnostics card), and the deliberation emitter registered in
 *           REFERRAL_EMITTERS on the EXISTING deliberative lead_quality_spend
 *           edge (ai_isa → ads_manager) — no new collaboration edge minted.
 *
 * Run:  npx tsx scripts/territory-coverage-simulator.ts   (npm run test:territory-coverage)
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  composeCoverageBoard, composeTenantCoverage,
  COVERAGE_WINDOW_DAYS, EXPANSION_HINT_LIMIT,
  type CoverageInputs, type TenantMarketInfo,
} from "../lib/analytics/territory-coverage"
import {
  computeTerritoryRoi, findCostDivergentMarket, marketLabel,
  TERRITORY_ROI_MIN_PROMOTED, TERRITORY_ROI_DIVERGENCE_RATIO,
  type RoiMarketInfo, type RoiRawRow, type RoiLeadRow, type RoiAppointmentEvent,
} from "../lib/analytics/territory-roi"
import { REFERRAL_EMITTERS, emittersForDomain, validateReferral } from "../lib/managers/cross-referral"
import { MANAGER_COLLABORATIONS } from "../lib/kernel/manager-registry"
import { ACTIVE_SUBSCRIPTION_STATUSES } from "../lib/lead-pipeline/subscription-gate"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = (rel: string) => readFileSync(join(ROOT, rel), "utf8")

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 1 · coverage board — claim resolution + per-zip tallies]")
// ─────────────────────────────────────────────────────────────────────────────

const B_ACTIVE = "b-active-1"
const B_TRIAL = "b-trial-2"
const B_PASTDUE = "b-pastdue-3"

const inputs: CoverageInputs = {
  subscriptions: [
    { brokerage_id: B_ACTIVE, status: "active" },
    { brokerage_id: B_TRIAL, status: "trialing" },
    { brokerage_id: B_PASTDUE, status: "past_due" },
  ],
  serviceAreas: [
    { brokerage_id: B_ACTIVE, zip_code: "78701", city: "Austin", state: "tx", active: true },
    { brokerage_id: B_TRIAL, zip_code: "78701", city: "Austin", state: "TX", active: true },   // shared zip, trialing counts
    { brokerage_id: B_ACTIVE, zip_code: "78702", city: "Austin", state: "TX", active: true },
    { brokerage_id: B_PASTDUE, zip_code: "30301", city: "Atlanta", state: "GA", active: true }, // stale claim
    { brokerage_id: B_ACTIVE, zip_code: "78799", state: "TX", active: false },                  // inactive claim row ignored
  ],
  brokerages: [
    { id: B_ACTIVE, name: "Austin Realty" },
    { id: B_TRIAL, name: "Trial Homes" },
    { id: B_PASTDUE, name: "Lapsed LLC" },
  ],
  leadRows: [
    { zip_code: "78701", state: "TX", brokerage_id: B_ACTIVE, raw_record_id: "r1", source_origin: "platform" },
    { zip_code: "78701", state: "TX", brokerage_id: null, raw_record_id: "r2", source_origin: "platform" },   // parked, awaiting
    { zip_code: "78702", state: "TX", brokerage_id: B_ACTIVE, raw_record_id: null, source_origin: "brokerage" },
    { zip_code: "30301", state: "GA", brokerage_id: null, raw_record_id: "r3", source_origin: "platform" },   // volume in the stale-claim zip
    { zip_code: "78704", state: "TX", brokerage_id: null, raw_record_id: "r4", source_origin: "platform" },   // unclaimed TX zip w/ platform volume
    { zip_code: "78704", state: "TX", brokerage_id: null, raw_record_id: "r5", source_origin: "platform" },
    { zip_code: "99999", state: "WA", brokerage_id: B_ACTIVE, raw_record_id: null, source_origin: "brokerage" }, // other-state, never a hint
  ],
  rawZips: ["78701", "78701", "78704", null],
  windowDays: COVERAGE_WINDOW_DAYS,
}

const board = composeCoverageBoard(inputs)
const zip = (z: string) => board.zips.find((x) => x.zip === z)

check("active + trialing claims both count on the shared zip (the resolver's own predicate)",
  (zip("78701")?.claimedBy.length ?? 0) === 2
  && !!zip("78701")?.claimedBy.some((c) => c.name === "Austin Realty")
  && !!zip("78701")?.claimedBy.some((c) => c.name === "Trial Homes"))
check("a past_due tenant's claim is STALE — counted, never shown as live coverage",
  (zip("30301")?.claimedBy.length ?? 0) === 0 && board.totals.staleClaims === 1)
check("an active=false claim row is ignored entirely",
  !board.zips.some((z) => z.zip === "78799"))
check("per-zip tallies: raw / promoted / leads / platform / awaiting are all real counts",
  zip("78701")?.rawCount === 2 && zip("78701")?.promotedCount === 2
  && zip("78701")?.leadCount === 2 && zip("78701")?.platformLeadCount === 2
  && zip("78701")?.awaitingSubscriber === 1)
check("raw record without a normalized zip lands in the honest unknown-zip bucket",
  board.zips.some((z) => z.zip === "(zip unknown)" && z.rawCount === 1))
check("state grouping is sorted and carries the claim-row state (uppercased)",
  zip("78701")?.state === "TX"
  && board.byState.length >= 2
  && board.byState.map((g) => g.state).join(",")
    === [...board.byState.map((g) => g.state)].sort((a, b) => a.localeCompare(b)).join(","))
check("totals: claimed zips / active claimants / awaiting leads / unclaimed-with-volume",
  board.totals.claimedZips === 2 && board.totals.activeClaimants === 2
  && board.totals.awaitingSubscriberLeads === 4
  && board.totals.unclaimedZipsWithVolume >= 2) // 30301, 78704, unknown-zip bucket, 99999
check("board totals: raw + promoted sums match the fixtures (5 leads carry the promotion stamp)",
  board.totals.rawTotal === 4 && board.totals.promotedTotal === 5)
check("honest notes name the active predicate and the awaiting-subscriber definition",
  board.honestNotes.some((n) => n.includes(ACTIVE_SUBSCRIPTION_STATUSES.join("/")))
  && board.honestNotes.some((n) => n.includes("brokerage_id is NULL")))

const emptyBoard = composeCoverageBoard({
  subscriptions: [], serviceAreas: [], brokerages: [], leadRows: [], rawZips: [],
})
check("empty board is honestly empty — no zips, zero totals, notes still stated",
  emptyBoard.zips.length === 0 && emptyBoard.totals.claimedZips === 0
  && emptyBoard.totals.awaitingSubscriberLeads === 0 && emptyBoard.honestNotes.length > 0)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 1b · tenant view — claimed zips + honest expansion hints]")
// ─────────────────────────────────────────────────────────────────────────────

const markets: TenantMarketInfo[] = [
  { id: "m1", name: "Austin Core", city: "Austin", state: "TX", zip_codes: ["78701", "78702"], is_active: true },
]
const tenant = composeTenantCoverage(board, B_ACTIVE, markets)

check("tenant view lists exactly the tenant's claimed zips with the board's volume",
  tenant.claimedZips.map((z) => z.zip).sort().join(",") === "78701,78702"
  && tenant.totals.claimedZips === 2 && tenant.totals.promotedCount === 2)
check("expansion hints: same-state unclaimed zip WITH platform volume is suggested",
  tenant.expansionHints.some((z) => z.zip === "78704" && z.platformLeadCount === 2))
check("expansion hints never include a claimed zip, another state, or zero-volume zips",
  !tenant.expansionHints.some((z) => z.zip === "78701" || z.zip === "78702") // claimed
  && !tenant.expansionHints.some((z) => z.state === "GA")                     // GA is not a tenant state via claims/markets? (99999 lead gave tenant WA)
  && !tenant.expansionHints.some((z) => z.platformLeadCount === 0)
  && tenant.expansionHints.length <= EXPANSION_HINT_LIMIT)
check("hint honesty is stated in the notes (same-state, no adjacency math, real volume only)",
  tenant.honestNotes.some((n) => n.toLowerCase().includes("adjacency is not computed")))

const strangerView = composeTenantCoverage(board, "b-nobody", [])
check("a tenant with no claims and no markets gets an honest empty view (no hints without a state)",
  strangerView.claimedZips.length === 0 && strangerView.expansionHints.length === 0)

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 2 · scrape ROI — funnel math, honest denominators, recorded cost only]")
// ─────────────────────────────────────────────────────────────────────────────

const roiMarkets: RoiMarketInfo[] = [
  { id: "mkt-a", brokerage_id: B_ACTIVE, name: "Austin Core", city: "Austin", state: "TX", is_active: true },
  { id: "mkt-b", brokerage_id: B_ACTIVE, name: null, city: "Dallas", state: "TX", is_active: true },
  { id: "mkt-c", brokerage_id: B_ACTIVE, name: "Waco Edge", city: "Waco", state: "TX", is_active: false },
]
const rawRows: RoiRawRow[] = [
  // mkt-a: 10 raw, 6 promoted
  ...Array.from({ length: 4 }, () => ({ market_id: "mkt-a", lead_id: null })),
  ...Array.from({ length: 6 }, (_, i) => ({ market_id: "mkt-a", lead_id: `la-${i}` })),
  // mkt-b: 10 raw, 5 promoted
  ...Array.from({ length: 5 }, () => ({ market_id: "mkt-b", lead_id: null })),
  ...Array.from({ length: 5 }, (_, i) => ({ market_id: "mkt-b", lead_id: `lb-${i}` })),
  // mkt-c: nothing pulled
]
const leadRows: RoiLeadRow[] = [
  // mkt-a: 3 of 6 promoted convert to contacts
  { id: "la-0", contact_id: "ca-0", created_at: "2026-07-01T00:00:00Z" },
  { id: "la-1", contact_id: "ca-1", created_at: "2026-07-01T00:00:00Z" },
  { id: "la-2", contact_id: "ca-2", created_at: "2026-07-01T00:00:00Z" },
  { id: "la-3", contact_id: null, created_at: "2026-07-01T00:00:00Z" },
  { id: "la-4", contact_id: null, created_at: "2026-07-01T00:00:00Z" },
  { id: "la-5", contact_id: null, created_at: "2026-07-01T00:00:00Z" },
  // mkt-b: 5 promoted, 2 contacts
  { id: "lb-0", contact_id: "cb-0", created_at: "2026-07-02T00:00:00Z" },
  { id: "lb-1", contact_id: "cb-1", created_at: "2026-07-02T00:00:00Z" },
  { id: "lb-2", contact_id: null, created_at: "2026-07-02T00:00:00Z" },
  { id: "lb-3", contact_id: null, created_at: "2026-07-02T00:00:00Z" },
  { id: "lb-4", contact_id: null, created_at: "2026-07-02T00:00:00Z" },
]
const events: RoiAppointmentEvent[] = [
  { contactId: "ca-0", leadId: null, at: "2026-07-05T00:00:00Z" },  // after creation → counts
  { contactId: "ca-1", leadId: null, at: "2026-06-20T00:00:00Z" },  // BEFORE lead creation → refused
  { contactId: null, leadId: "la-2", at: "2026-07-08T00:00:00Z" },  // lead-entity join → counts
  { contactId: "cb-0", leadId: null, at: "2026-07-09T00:00:00Z" },  // mkt-b → counts
]
const costs = new Map<string, number>([["mkt-a", 120], ["mkt-b", 10]]) // mkt-c: cost not recorded

const roi = computeTerritoryRoi(roiMarkets, rawRows, leadRows, events, costs, { windowDays: 30 })
const mkt = (id: string) => roi.markets.find((m) => m.marketId === id)!

check("funnel counts: raw → promoted → contacts per market",
  mkt("mkt-a").rawPulled === 10 && mkt("mkt-a").promoted === 6 && mkt("mkt-a").convertedContacts === 3
  && mkt("mkt-b").rawPulled === 10 && mkt("mkt-b").promoted === 5 && mkt("mkt-b").convertedContacts === 2)
check("first appointments join by contact OR lead entity, and a pre-existing appointment is refused",
  mkt("mkt-a").firstAppointments === 2 && mkt("mkt-b").firstAppointments === 1)
check("rates carry honest denominators (promotion 0.6, contact 0.5, appointment 2/3)",
  mkt("mkt-a").promotionRate === 0.6 && mkt("mkt-a").contactRate === 0.5 && mkt("mkt-a").appointmentRate === 0.67)
check("a market with nothing pulled grades null everywhere — never a fabricated 0% or 100%",
  mkt("mkt-c").rawPulled === 0 && mkt("mkt-c").promotionRate === null
  && mkt("mkt-c").contactRate === null && mkt("mkt-c").appointmentRate === null)
check("unrecorded cost is an honest stated absence, not $0",
  mkt("mkt-c").costUsd === null && mkt("mkt-c").costPerPromotedUsd === null
  && mkt("mkt-c").costNote.includes("cost not recorded"))
check("cost-per-promoted uses recorded cost only ($120/6 = $20, $10/5 = $2)",
  mkt("mkt-a").costPerPromotedUsd === 20 && mkt("mkt-b").costPerPromotedUsd === 2)
check("totals sum recorded cost only and count the markets that recorded it",
  roi.totals.recordedCostUsd === 130 && roi.totals.marketsWithCost === 2
  && roi.totals.rawPulled === 20 && roi.totals.promoted === 11)
check("market label falls back honestly (name → geo → id prefix)",
  marketLabel(roiMarkets[0]) === "Austin Core" && marketLabel(roiMarkets[1]) === "Dallas, TX")
check("empty-market report is honest (no markets, null recorded cost, notes stated)",
  computeTerritoryRoi([], [], [], [], new Map()).totals.recordedCostUsd === null
  && computeTerritoryRoi([], [], [], [], new Map()).honestNotes.length > 0)

console.log("\n[Layer 2b · cost-divergence detector — floors + recorded-cost-only]")

const div = findCostDivergentMarket(roi.markets)
check(`divergence fires: mkt-a at $20/promoted vs the rest pooled $2 (ratio 10 ≥ ${TERRITORY_ROI_DIVERGENCE_RATIO}), both sides ≥ ${TERRITORY_ROI_MIN_PROMOTED} promoted`,
  div?.market.marketId === "mkt-a" && div?.marketCostPerPromoted === 20
  && div?.restCostPerPromoted === 2 && div?.ratio === 10 && div?.restPromoted === 5)
check("below the observation floor the detector stays silent (no manufactured argument)",
  findCostDivergentMarket(roi.markets, { minPromoted: 6 }) === null) // rest pool has only 5 promoted
check("without recorded cost nothing can diverge — unrecorded cost never argues",
  findCostDivergentMarket(computeTerritoryRoi(roiMarkets, rawRows, leadRows, events, new Map(), {}).markets) === null)
check("a mild spread under the ratio does not fire",
  findCostDivergentMarket(computeTerritoryRoi(roiMarkets, rawRows, leadRows, events,
    new Map([["mkt-a", 15], ["mkt-b", 10]]), {}).markets) === null) // $2.50 vs $2 = 1.25×

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[Layer 3 · source locks — predicate reuse, no map lib, both mounts, emitter registered]")
// ─────────────────────────────────────────────────────────────────────────────

const covSrc = src("lib/analytics/territory-coverage.ts")
const roiSrc = src("lib/analytics/territory-roi.ts")
check("territory-coverage reuses the resolver's active-subscription predicate (subscription-gate import)",
  covSrc.includes("activeSubscriberBrokerageIds") && covSrc.includes("lib/lead-pipeline/subscription-gate"))
check("territory-roi's sweep candidates run the SAME active predicate (no scraping-for-the-lapsed)",
  roiSrc.includes("activeSubscriberBrokerageIds") && roiSrc.includes("lib/lead-pipeline/subscription-gate"))

const boardSrc = src("app/dashboard/superadmin/platform/territory-coverage-board.tsx")
const cardSrc = src("app/dashboard/admin/scrape-diagnostics/tenant-coverage-card.tsx")
const MAP_LIBS = /leaflet|mapbox|react-map-gl|@react-google-maps|google\.maps|maplibre/i
check("NO map library on either mount — an honest sortable table, never a fake map",
  !MAP_LIBS.test(boardSrc) && !MAP_LIBS.test(cardSrc)
  && !MAP_LIBS.test(covSrc) && !MAP_LIBS.test(roiSrc))

check("superadmin mount: the coverage board renders on the platform analytics page",
  src("app/dashboard/superadmin/platform/page.tsx").includes("TerritoryCoverageBoard")
  && src("app/dashboard/superadmin/platform/page.tsx").includes("loadCoverageBoard")
  && src("app/dashboard/superadmin/platform/page.tsx").includes("loadTerritoryRoi"))
check("tenant mount: the 'Your coverage' card renders on the brokerage lead-scraping surface",
  src("app/dashboard/admin/scrape-diagnostics/page.tsx").includes("TenantCoverageCard")
  && src("app/dashboard/admin/scrape-diagnostics/page.tsx").includes("loadTenantCoverage"))

const emitter = REFERRAL_EMITTERS["territory_roi_sweep"]
check("emitter registered in REFERRAL_EMITTERS as a sweep with a runnable cron entry point",
  !!emitter && emitter.kind === "sweep" && typeof emitter.run === "function")
check("the emitter REUSES the existing deliberative lead_quality_spend edge (ai_isa seat declared)",
  emitter?.collabDomain === "lead_quality_spend" && emitter?.from === "ai_isa"
  && MANAGER_COLLABORATIONS["lead_quality_spend"]?.deliberate === true
  && MANAGER_COLLABORATIONS["lead_quality_spend"]?.managers.includes("ai_isa")
  && MANAGER_COLLABORATIONS["lead_quality_spend"]?.managers.includes("ads_manager"))
check("ai_isa → ads_manager travels the declared edge (validateReferral passes)",
  validateReferral({ fromManager: "ai_isa", toManager: "ads_manager", collabDomain: "lead_quality_spend" }).ok === true)
check("the raise lives beside its funnel and dedupes over the bus ledger (marker + raiseReferralDeduped + market_id dedupe)",
  roiSrc.includes(emitter?.marker ?? "export async function publishTerritoryRoiReferrals")
  && roiSrc.includes("raiseReferralDeduped")
  && roiSrc.includes('sweep: "territory_roi"') && roiSrc.includes("market_id: div.market.marketId"))
check("the domain now carries the new emitter alongside the round-36 lead-quality sweep (both live raisers declared)",
  emittersForDomain("lead_quality_spend").length >= 2)
check("no new collaboration edge was minted for this feed — MANAGER_COLLABORATIONS untouched by round 39",
  !JSON.stringify(Object.keys(MANAGER_COLLABORATIONS)).includes("territory")
  && !src("lib/kernel/manager-registry.ts").includes("territory_roi"))

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(60)}`)
console.log(`RESULT: ${passed} passed, ${failed} failed`)
if (failures.length) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(1)
}
console.log("All territory-coverage + scrape-ROI checks passed.")
