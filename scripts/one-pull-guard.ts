/**
 * scripts/one-pull-guard.ts — `npm run test:one-pull`
 *
 * WAVE 93, LANE 93B. Owner, verbatim (2026-10-01): "can't you pull all of the active territories to
 * add to the criteria and pull all homeowners in the platform to make it one pull to keep the cost
 * down?" · "make sure our platform is setup the most effective and cost effective."
 *
 * Proves, with no network and no DB (scans read COMMENT-STRIPPED source — a tombstone naming a
 * retired call is not a call, CLAUDE.md §2 — and every absence carries a positive control):
 *   A  THE PURE CORE — planPooledGeography merges + dedupes overlapping ZIPs/counties/cities and
 *      chunks within the vendor's list limit; territoryContains is the SAME geography the pull used;
 *      fanOutByTerritory delivers a shared-ZIP homeowner to BOTH brokerages; splitPullCost sums to
 *      the charge TO THE CENT (largest remainder) and books nothing for zero receipts.
 *   B  ≤1 PULL PER VENDOR PER CYCLE (per limit-sized chunk) — runPooledBatchDataLane EXECUTED with an
 *      injected BatchData search that COUNTS requests: the count equals the derived chunk plan (never
 *      the territory count); the replayed per-territory loop (POSITIVE CONTROL) issues one request per
 *      territory × trigger; every record reaches every containing territory; the per-territory shares
 *      sum to the vendor charge; a recorder trigger under two different windows is two pools; a
 *      listing-status window is applied per territory at fan-out; pagination stops at the funded cap.
 *   C  THE FSBO-SITE ACTOR (a multi-location Apify input) and RENTCAST IDENTICAL-AREA SWEEPS — one
 *      actor run per ≤10 distinct locations, identical areas collapsed; the RentCast ledger row of a
 *      pooled sweep splits through the SAME rule (rentcast.ts meterCall → splitPullCost).
 *   D  DERIVED POPULATION — the lead-scraping cron: inside the per-territory loop NO vendor pull call
 *      remains (BatchData client, fetchMotivatedSellers, the RentCast inactive prefilter, the FSBO
 *      actor, the discovery sweep); the pooled phase issues each lane ONCE. Every OTHER paid cron is
 *      listed with why it is not pooled (tenant-owned criteria, or fact-cached per area) — a POSITIVE
 *      CONTROL fixture of the pre-93 loop is flagged by the same finder.
 */
import { readFileSync, readdirSync, existsSync } from "fs"
import { join } from "path"
import { createRequire } from "node:module"
import { stripComments, blankStrings } from "./strip-comments"

const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* not resolvable — nothing to shim */ }

const ROOT = process.cwd()
let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
const stripped = (p: string) => stripComments(raw(p))
const code = (p: string) => blankStrings(stripComments(raw(p)))

/** The body of the FIRST `for (const market of markets) {` loop in a source (brace-matched). */
function marketLoopBody(src: string): string {
  const i = src.indexOf("for (const market of markets) {")
  if (i < 0) return ""
  let depth = 0
  for (let j = src.indexOf("{", i); j < src.length; j++) {
    if (src[j] === "{") depth++
    else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(i, j + 1) }
  }
  return src.slice(i)
}

async function main() {
  const pp = await import("../lib/lead-pipeline/pooled-pull")
  const bd = await import("../lib/external/batchdata-client")

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[A · the pure core — merge + dedupe, containment, fan-out, the cost split]")
  const T = (id: string, b: string, o: Partial<{ city: string; state: string; zip_codes: string[]; counties: string[]; max_records_per_run: number }>) =>
    ({ id, brokerage_id: b, city: o.city ?? null, state: o.state ?? null, zip_codes: o.zip_codes ?? null, counties: o.counties ?? null, max_records_per_run: o.max_records_per_run ?? null })
  const terr = [
    T("m1", "b-A", { city: "Austin", state: "TX", zip_codes: ["78701", "78702"] }),
    T("m2", "b-B", { city: "Austin", state: "tx", zip_codes: ["78702-0001", "78703"] }), // overlaps 78702 with b-A
    T("m3", "b-C", { city: "Round Rock", state: "TX" }),                                  // city territory
    T("m4", "b-A", { city: "Tampa", state: "FL", counties: ["Hillsborough County"] }),    // county territory
    T("m5", "b-D", { city: "round rock", state: "TX" }),                                  // same city as m3
    T("m6", "b-E", { city: "Nowhere" }),                                                  // no state → unpoolable
  ]
  const plan = pp.planPooledGeography(terr, { maxValues: 100 })
  const zipChunk = plan.chunks.find((c) => c.kind === "zip")
  const cityChunk = plan.chunks.find((c) => c.kind === "city")
  check("EXECUTED: overlapping ZIPs dedupe across brokerages (4 requested → 3 distinct: 78701, 78702, 78703)",
    zipChunk?.values.join(",") === "78701,78702,78703" && zipChunk?.memberIds.join(",") === "m1,m2", JSON.stringify(plan))
  check("EXECUTED: two brokerages naming the SAME city (case-folded) ride ONE city value", cityChunk?.values.length === 1 && cityChunk.memberIds.join(",") === "m3,m5")
  check("EXECUTED: a county territory pools by county; a territory with no state is reported unpoolable, never guessed",
    plan.chunks.some((c) => c.kind === "county" && c.state === "FL") && plan.unpoolable.join(",") === "m6")
  check(`EXECUTED: the plan is ${plan.chunks.length} chunks for ${terr.length} territories (one per state × kind) — requested ${plan.requestedValues} values, ${plan.distinctValues} distinct`,
    plan.chunks.length === 3 && plan.requestedValues === 7 && plan.distinctValues === 5)
  const many = Array.from({ length: 250 }, (_, i) => T(`z${i}`, `b${i % 7}`, { state: "TX", zip_codes: [String(75000 + i)] }))
  const big = pp.planPooledGeography(many, { maxValues: bd.BATCHDATA_POOLED_MAX_INLIST })
  check(`EXECUTED: the vendor's list limit chunks the merge — 250 distinct ZIPs at ${bd.BATCHDATA_POOLED_MAX_INLIST}/request → ${big.chunks.length} chunks`,
    big.chunks.length === Math.ceil(250 / bd.BATCHDATA_POOLED_MAX_INLIST) && big.chunks.every((c) => c.values.length <= bd.BATCHDATA_POOLED_MAX_INLIST))

  check("EXECUTED: containment = the pull's own geography (ZIP+4 folds to ZIP; city/county need the state)",
    pp.territoryContains(terr[0], { zip: "78702-1234" }) && !pp.territoryContains(terr[0], { zip: "78704", city: "Austin", state: "TX" })
    && pp.territoryContains(terr[2], { city: "ROUND ROCK", state: "tx" }) && !pp.territoryContains(terr[2], { city: "Round Rock", state: "CA" })
    && pp.territoryContains(terr[3], { county: "Hillsborough", state: "FL" }))
  const fan = pp.fanOutByTerritory(
    [{ zip: "78702" }, { zip: "78701" }, { zip: "99999" }],
    terr.slice(0, 2),
    (r) => ({ zip: r.zip }),
  )
  check("EXECUTED: a homeowner in a SHARED ZIP fans to BOTH brokerages; a record no territory contains is counted, not dropped silently",
    fan.byTerritory.get("m1")?.length === 2 && fan.byTerritory.get("m2")?.length === 1 && fan.unattributed === 1
      && fan.receipts.get("m1") === 2 && fan.receipts.get("m2") === 1)
  const split = pp.splitPullCost(1, new Map([["a", 1], ["b", 1], ["c", 1]]))
  const sumCents = [...split.values()].reduce((s, v) => s + Math.round(v * 100), 0)
  check("EXECUTED: the split sums to the charge TO THE CENT ($1.00 over three equal receipts → 0.34 + 0.33 + 0.33)",
    sumCents === 100 && [...split.values()].sort().join(",") === "0.33,0.33,0.34", JSON.stringify([...split]))
  const prop = pp.splitPullCost(5.05, new Map([["a", 3], ["b", 1], ["z", 0]]))
  check("EXECUTED: shares are proportional to records received (3:1 of $5.05 → 3.79 / 1.26) and a zero-receipt territory pays nothing",
    prop.get("a") === 3.79 && prop.get("b") === 1.26 && !prop.has("z"))
  check("EXECUTED: zero receipts → no shares (the caller books the charge unattributed — spend is never dropped)", pp.splitPullCost(2, new Map()).size === 0)

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[B · ≤1 BatchData pull per lane per cycle (per limit-sized chunk) — executed with a counting search]")
  const NOW = new Date("2026-10-01T12:00:00Z")
  const calls: Array<{ state: string; trigger: string; criteria: Record<string, unknown>; limit: number; skip: number }> = []
  const homes = (state: string, zips: string[]) => zips.map((z, i) => ({ propertyZip: z, propertyState: state, propertyCity: "Austin", firstName: `O${i}`, lastName: "Owner", address: `${i} Main`, city: "Austin", state, zip: z }))
  const fakeDeps = (pageSize = 1000): import("../lib/lead-pipeline/pooled-pull").PooledBatchDataDeps => ({
    search: async (opts) => {
      calls.push({ state: opts.state, trigger: (opts.motivationTypes ?? [])[0], criteria: opts.searchCriteria ?? {}, limit: opts.limit ?? 0, skip: opts.skip ?? 0 })
      const addr = (opts.searchCriteria as any)?.address ?? {}
      const zips: string[] = addr.zip?.inList ?? []
      const rows = (homes(opts.state, zips) as any[]).slice(0, Math.min(opts.limit ?? 0, pageSize))
      const recs = rows.map((r) => ({ ...r, motivationType: (opts.motivationTypes ?? [])[0], motivationConfidence: 0.7, listing: { statusUpdatedAt: "2026-05-01" } }))
      return { records: recs as any, cost: recs.length * bd.BATCHDATA_PROPERTY_SEARCH_RECORD_COST_USD }
    },
    dateWindow: (t, w) => bd.dateWindowCriteria(t, { ...w, today: NOW }),
    statusWindow: (r, t, w) => bd.withinListingStatusWindow(r, t, { ...w, today: NOW }),
    geographyCriteria: (k, v) => bd.pooledGeographyCriteria(k, v),
    maxTake: bd.BATCHDATA_POOLED_MAX_TAKE,
    maxInList: bd.BATCHDATA_POOLED_MAX_INLIST,
  })
  const trio = ["high_equity", "absentee", "pre_foreclosure"]
  const wants = [
    { territory: T("m1", "b-A", { city: "Austin", state: "TX", zip_codes: ["78701", "78702"] }), triggers: trio, lookbackDays: 30 },
    { territory: T("m2", "b-B", { city: "Austin", state: "TX", zip_codes: ["78702", "78703"] }), triggers: trio, lookbackDays: 30 },
    { territory: T("m3", "b-C", { city: "Austin", state: "TX", zip_codes: ["78704"] }), triggers: trio, lookbackDays: 30 },
    { territory: T("m4", "b-D", { city: "Tampa", state: "FL", zip_codes: ["33602"] }), triggers: trio, lookbackDays: 30 },
  ]
  const lane = await pp.runPooledBatchDataLane("batchdata_motivated", wants, fakeDeps())
  // The derived expectation: one request per (trigger-pool × state-chunk) — 3 triggers × 2 states.
  const expectedRequests = new Set(wants.flatMap((w) => w.triggers.map((t) => `${t}|${w.territory.state}`))).size
  check(`EXECUTED: ${wants.length} territories × ${trio.length} triggers → ${lane.ledger.requests} BatchData requests (derived plan: ${expectedRequests} = trigger × state chunk), never one per territory`,
    lane.ledger.requests === expectedRequests && calls.length === expectedRequests && lane.ledger.perTerritoryRequestsReplaced === wants.length * trio.length,
    JSON.stringify({ ledger: lane.ledger, calls: calls.length }))
  const txCall = calls.find((c) => c.state === "TX" && c.trigger === "high_equity")
  check("EXECUTED: the TX request carries the MERGED, deduped ZIP list of all three TX brokerages (78701–78704, 78702 once)",
    JSON.stringify((txCall?.criteria as any)?.address?.zip?.inList) === JSON.stringify(["78701", "78702", "78703", "78704"]))
  check("EXECUTED: a recorder trigger keeps its date window on the pooled request (pre-foreclosure → foreclosure.recordingDate)",
    calls.filter((c) => c.trigger === "pre_foreclosure").every((c) => JSON.stringify(c.criteria).includes("recordingDate")))
  const m1 = lane.byTerritory.get("m1"), m2 = lane.byTerritory.get("m2")
  check("EXECUTED: the shared-ZIP homeowner (78702) reaches BOTH b-A and b-B; each territory gets only what it contains",
    !!m1 && !!m2 && m1.records.some((r) => r.propertyZip === "78702") && m2.records.some((r) => r.propertyZip === "78702")
      && m1.records.every((r) => ["78701", "78702"].includes(String(r.propertyZip))) && lane.ledger.unattributedRecords === 0)
  const shareSum = Math.round([...lane.byTerritory.values()].reduce((s, v) => s + v.costUsd, 0) * 100)
  check(`EXECUTED: the per-territory shares sum to the vendor charge ($${lane.ledger.chargeUsd} = Σ shares $${shareSum / 100})`,
    shareSum === Math.round(lane.ledger.chargeUsd * 100) && lane.ledger.allocatedUsd === lane.ledger.chargeUsd && lane.ledger.unallocatedUsd === 0)

  // POSITIVE CONTROL — replay the pre-93 per-territory loop against the SAME counting search.
  calls.length = 0
  const replayDeps = fakeDeps()
  let replayCharge = 0
  for (const w of wants) for (const t of w.triggers) {
    const r = await replayDeps.search({ state: String(w.territory.state), motivationTypes: [t], searchCriteria: replayDeps.geographyCriteria("zip", w.territory.zip_codes ?? []), limit: 100, skip: 0 })
    replayCharge += r.cost
  }
  check(`POSITIVE CONTROL: the replayed per-territory loop issues ${calls.length} requests (territory × trigger) and bills the shared ZIP twice ($${replayCharge.toFixed(2)} vs pooled $${lane.ledger.chargeUsd})`,
    calls.length === wants.length * trio.length && replayCharge > lane.ledger.chargeUsd)

  // Two windows on a recorder trigger = two pools; a standing trigger ignores the window.
  calls.length = 0
  const twoWindows = await pp.runPooledBatchDataLane("batchdata_motivated", [
    { territory: T("w1", "b-A", { state: "TX", zip_codes: ["78701"] }), triggers: ["pre_foreclosure", "high_equity"], lookbackDays: 30 },
    { territory: T("w2", "b-B", { state: "TX", zip_codes: ["78702"] }), triggers: ["pre_foreclosure", "high_equity"], lookbackDays: 90 },
  ], fakeDeps())
  check("EXECUTED: a recorder trigger under two different windows is TWO pools; the window-less standing trigger is ONE (3 requests, not 4)",
    twoWindows.ledger.requests === 3 && calls.filter((c) => c.trigger === "high_equity").length === 1)

  // Listing-status trigger: each territory's own client window applies at fan-out; billed rows still split.
  calls.length = 0
  const expired = await pp.runPooledBatchDataLane("expired_listing", [
    { territory: T("e1", "b-A", { state: "TX", zip_codes: ["78701"] }), triggers: ["expired"], lookbackDays: 30 },
    { territory: T("e2", "b-B", { state: "TX", zip_codes: ["78702"] }), triggers: ["expired"], lookbackDays: 400 },
  ], fakeDeps())
  check("EXECUTED: an expired pull is ONE request; a stale row (status 2026-05-01) is dropped for the 30-day territory, kept for the 400-day one — and still billed",
    expired.ledger.requests === 1 && expired.byTerritory.get("e1")?.records.length === 0 && expired.byTerritory.get("e1")?.staleDropped === 1
      && expired.byTerritory.get("e2")?.records.length === 1 && Math.round(expired.ledger.allocatedUsd * 100) === Math.round(expired.ledger.chargeUsd * 100))

  // Pagination stops at the funded cap.
  calls.length = 0
  const capped = await pp.runPooledBatchDataLane("batchdata_motivated", [
    { territory: T("c1", "b-A", { state: "TX", zip_codes: Array.from({ length: 30 }, (_, i) => String(78000 + i)), max_records_per_run: 10 }), triggers: ["high_equity"], lookbackDays: null },
  ], fakeDeps())
  check("EXECUTED: a pool never pulls past its funded cap (Σ members' max_records_per_run): 10 records, one request with take 10",
    capped.ledger.requests === 1 && calls[0]?.limit === 10 && capped.byTerritory.get("c1")?.records.length === 10)

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[C · the FSBO-site actor (multi-location input) and RentCast identical-area sweeps]")
  const fsboTerr = Array.from({ length: 12 }, (_, i) => T(`f${i}`, `b${i}`, { city: i === 11 ? "City0" : `City${i}`, state: "TX" }))
  let runs = 0
  const fsbo = await pp.runPooledFsboLane(fsboTerr, {
    run: async (locs) => { runs++; return { records: locs.map((l) => ({ source: "fsbo_site_listing", city: l.city, state: l.state } as any)), cost: 0.1 * locs.length } },
  }, () => null)
  check(`EXECUTED: 12 FSBO territories (11 distinct areas) → ${runs} actor runs at ≤${pp.APIFY_POOLED_LOCATIONS_PER_RUN} locations each (was 12 runs)`,
    runs === Math.ceil(11 / pp.APIFY_POOLED_LOCATIONS_PER_RUN) && fsbo.ledger.requests === runs && fsbo.ledger.perTerritoryRequestsReplaced === 12)
  check("EXECUTED: the shared-area listing reaches both territories that name it, and the run cost splits to the cent",
    fsbo.byTerritory.get("f0")?.records.length === 1 && fsbo.byTerritory.get("f11")?.records.length === 1
      && Math.round(fsbo.ledger.allocatedUsd * 100) === Math.round(fsbo.ledger.chargeUsd * 100))
  const areas = pp.groupIdenticalAreas(terr)
  check("EXECUTED: RentCast identical-area grouping collapses Round Rock ×2 and Austin ×2 (RentCast takes ONE city+state per request)",
    areas.length === 3 && areas.find((a) => a.key.startsWith("round rock"))?.members.length === 2)
  const rc = stripped("lib/property/rentcast.ts")
  check("the RentCast meter SPLITS a pooled sweep's ledger row through the ONE rule (splitPullCost), one row per brokerage",
    /pooledBrokerageIds/.test(rc) && /splitPullCost\(params\.cost/.test(rc) && /pooledBrokerageIds: params\.pooledBrokerageIds \?\? null/.test(rc))
  const pre = stripped("lib/lead-pipeline/expired-listing-prefilter.ts")
  const feed = stripped("lib/kernel/listings-batchdata-feed.ts")
  check("both RentCast area sweeps (the inactive prefilter, the discovery feed) carry the pool to the meter",
    /pooledBrokerageIds: q\.pooledBrokerageIds \?\? null/.test(pre) && /export async function runActiveListingDiscoveryPooled/.test(feed) && /sweepDiscoveryArea\(members\[0\], brokerages\.length > 1 \? brokerages : null\)/.test(feed))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[D · derived population — no vendor pull inside the per-territory loop; every other paid cron classified]")
  const CRON = "app/api/cron/lead-scraping/route.ts"
  const cron = code(CRON)
  const IN_LOOP_PULL = /new BatchDataClient\(|getMotivatedSellerDataWithCost\(|fetchMotivatedSellers\(|runExpiredListingPrefilter\(|sourceFsboSiteListings\(|runActiveListingDiscovery\w*\(|runPooled\w+\(/
  const loop = marketLoopBody(cron)
  const loopHits = (loop.match(new RegExp(IN_LOOP_PULL.source, "g")) ?? [])
  check(`the per-territory loop issues NO vendor pull for the pooled lanes (${loop.length} chars scanned, ${loopHits.length} hits)`, loop.length > 5000 && loopHits.length === 0, loopHits.join(","))
  const PRE93_FIXTURE = `for (const market of markets) {\n const motivatedPulls = await Promise.all(motivatedTriggers.map((t) => batchdata.getMotivatedSellerDataWithCost(location, [t], pullWindow)))\n}`
  check("POSITIVE CONTROL: the pre-93 loop shape is flagged by the same finder", IN_LOOP_PULL.test(marketLoopBody(PRE93_FIXTURE)))
  const phaseCalls = (cron.match(/runPooledBatchDataLane\(/g) ?? []).length
  check("the pooled phase runs ONCE before the loop and issues each BatchData lane once (motivated, cash buyer, expired fallback = 3 call sites) + the FSBO lane + the pooled discovery",
    cron.indexOf("await runPooledVendorPhase(supabase, markets)") > -1 && cron.indexOf("await runPooledVendorPhase(supabase, markets)") < cron.indexOf("for (const market of markets) {")
      && phaseCalls === 3 && /runPooledFsboLane\(/.test(cron) && /runActiveListingDiscoveryPooled\(supabase, discoveryMarkets\)/.test(cron))
  check("the cron's results carry each pooled lane's ledger (requests vs the per-territory requests they replaced)", /results\.pooled_pulls = pooled\.ledgers/.test(cron))
  check("the pooled phase honours the SAME budget gate as the loop (a spent territory funds no pooled pull)",
    /const live = markets\.filter\(\(m\) => \(m\.spend_this_month \?\? 0\) < \(m\.monthly_budget_usd \?\? 100\)\)/.test(cron))

  // Every OTHER paid cron — derived, each classified (a NEW unclassified paid cron fails this proof).
  // runPooled…( is a pull too (wave 93): the pooled lanes ARE the lead-scraping cron's vendor pulls.
  const PULL = /runPooled\w+\(|new BatchDataClient\(|fetchMotivatedSellers\(|exaSearch\(|runApifyScrape\(|fetchTopThreads\(|fetchExaCompetitorAds\(|refreshMarketData\(|generateMarketInsight\(|refreshInvestorOffMarketMatches\(|runAllActiveAlerts\(|runExternalMarketWatchForBuyer\(|runIntentCampaign\(|ingestBatchDataSellerSignals\(|searchRentcast\w*\(|getRentcastMarketStats\(/
  const crons = readdirSync(join(ROOT, "app/api/cron")).map((c) => `app/api/cron/${c}/route.ts`).filter((p) => existsSync(join(ROOT, p)))
  const paid = crons.filter((p) => PULL.test(code(p)))
  const CLASSIFIED: Record<string, string> = {
    "app/api/cron/lead-scraping/route.ts": "POOLED (this proof, A–C)",
    "app/api/cron/market-data-refresh/route.ts": "per-ZIP RentCast /markets — fact-cached 7 days per ZIP (rentcast.ts cachedRentcastRead `/markets|zip`), so N brokerages on one ZIP cost ONE request a week",
    "app/api/cron/market-insights-weekly/route.ts": "per-ZIP market stats — the same /markets fact cache",
    "app/api/cron/buyer-market-watch/route.ts": "TENANT-OWNED criteria (one buyer's saved search) — nothing to merge across brokerages",
    "app/api/cron/investor-offmarket-refresh/route.ts": "TENANT-OWNED criteria (one investor's buy box)",
    "app/api/cron/property-alerts/route.ts": "TENANT-OWNED criteria (each alert's own search)",
    "app/api/cron/content-intel-exa/route.ts": "Exa semantic queries — a merged multi-city query degrades relevance; 10 results included per $0.007 request",
    "app/api/cron/content-intel-apify/route.ts": "per-source content watch (hashtags/handles) — not a geography pull",
    "app/api/cron/content-intel-reddit/route.ts": "per-subreddit content watch — not a geography pull",
    "app/api/cron/competitor-ads-exa/route.ts": "per-competitor ad lookup — tenant-owned subject",
    "app/api/cron/intent-campaign/route.ts": "TENANT-OWNED campaign audience",
    "app/api/cron/permit-signal-scan/route.ts": "Exa permit search per territory — semantic query (see content-intel-exa)",
    "app/api/cron/batchdata-seller-signals/route.ts": "BatchData Smart Search webhook ingest — PUSH, already POOLED by quickList (wave 67 buildSmartSearchSubscriptionPlan)",
  }
  const unclassified = paid.filter((p) => !CLASSIFIED[p])
  console.log(`  denominator: ${crons.length} cron routes · ${paid.length} make a paid pull · classified: ${paid.filter((p) => CLASSIFIED[p]).length}`)
  for (const p of paid) console.log(`    ${p.replace(/^app\/api\/cron\/|\/route\.ts$/g, "")}: ${CLASSIFIED[p] ?? "UNCLASSIFIED"}`)
  check(`every paid cron is either POOLED or classified with why it is not (${paid.length - unclassified.length}/${paid.length})`, unclassified.length === 0 && paid.includes(CRON), unclassified.join(", "))
  check("the per-ZIP market crons' dedupe is REAL: the /markets reader is fact-cached per ZIP",
    /`\/markets\|\$\{zip\}`, RENTCAST_CACHE_TTL_DAYS\.markets/.test(rc))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[E · POOLED SAVE (wave 93, lane 93B2) — no paid pooled record can be dropped by a timeout]")
  // The lanes executed in B are the shares a real tick would hand on. Plan their persistence.
  const lanesForSave = [
    { lane: "batchdata_motivated", byTerritory: lane.byTerritory },
    { lane: "expired_listing", byTerritory: expired.byTerritory },
    { lane: "fsbo_site_listing", byTerritory: fsbo.byTerritory },
  ]
  const sumShares = (k: "records" | "cost") => lanesForSave.reduce((s, l) => s + [...l.byTerritory.values()].reduce((t, sh) => t + (k === "records" ? sh.records.length : Math.round(sh.costUsd * 100)), 0), 0)
  const plan2 = pp.planPooledPersistence<any>(lanesForSave)
  const plannedRecords = plan2.reduce((s, b) => s + b.records.length, 0)
  const plannedCents = plan2.reduce((s, b) => s + Math.round(b.costUsd * 100), 0)
  check(`EXECUTED: the pooled save persists EVERY paid record and EVERY cent before the loop (${plannedRecords}/${sumShares("records")} records, ${plannedCents}/${sumShares("cost")}¢)`,
    plannedRecords === sumShares("records") && plannedCents === sumShares("cost") && plannedRecords > 0)
  check("EXECUTED: a territory that received only STALE (billed, window-dropped) rows still gets a batch — its share of the charge is booked, not lost",
    plan2.some((b) => b.territoryId === "e1" && b.records.length === 0 && b.staleDropped === 1 && b.costUsd > 0))
  // POSITIVE CONTROL — replay the pre-93B2 shape: the loop persists shares as it reaches them and the
  // tick dies after the FIRST territory. Everything the loop did not reach was paid and lost.
  const reachedBeforeTimeout = new Set([[...lane.byTerritory.keys()][0]])
  const lostByLoop = lanesForSave.reduce((s, l) => s + [...l.byTerritory.entries()].filter(([id]) => !reachedBeforeTimeout.has(id)).reduce((t, [, sh]) => t + sh.records.length, 0), 0)
  check(`POSITIVE CONTROL: the per-territory-loop save replayed with a timeout after one territory loses ${lostByLoop} paid record(s) — the pooled save loses 0`,
    lostByLoop > 0)
  const cronS = stripped(CRON)
  const phaseBody = cronS.slice(cronS.indexOf("async function runPooledVendorPhase("), cronS.indexOf("async function persistPooledShares("))
  check("the cron's pooled phase runs the save (persistPooledShares) before it returns — i.e. before the per-territory loop starts",
    /await persistPooledShares\(supabase, markets, out\)[\s\S]{0,600}return out/.test(phaseBody)
      && cronS.indexOf("await runPooledVendorPhase(supabase, markets)") < cronS.indexOf("for (const market of markets) {"))
  const saveBody = cronS.slice(cronS.indexOf("async function persistPooledShares("), cronS.indexOf("async function insertRawBatch("))
  check("the save covers all four pooled record lanes, inserts each batch to raw, books its cost per source, counts the territory spend, and EMPTIES the share it handed the loop",
    ["batchdata_motivated", "expired_listing", "batchdata_cash_buyer", "fsbo_site_listing"].every((l) => saveBody.includes(`lane: "${l}"`))
      && /await insertRawBatch\(\{ records, marketId: market\.id/.test(saveBody) && /await bookSourceSpend\(\{ source: b\.lane, cost: b\.costUsd/.test(saveBody)
      && /spend_this_month: market\.spend_this_month/.test(saveBody) && /share\.records = \[\]; share\.costUsd = 0/.test(saveBody))
  check("a refused save keeps the records ON the share (the loop still tries them) — the share is emptied only after the insert + booking succeeded",
    saveBody.indexOf("share.records = []") > saveBody.indexOf("await bookSourceSpend(") && /records kept on the share for the loop/.test(saveBody))
  check("the loop counts what the save persisted ONCE (results at the phase, execution rows per territory) and never re-inserts it",
    /for \(const p of pooled\.persisted\.values\(\)\) \{\s*results\.total_leads_found \+= p\.found/.test(cronS) && /sourceItemsFound \+= preFound/.test(cronS))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ ONE_PULL_FAIL"); process.exit(1) }
  console.log(" ✅ ONE_PULL_PASS — per vendor per cycle every active territory rides ONE merged, deduped criteria set (chunked only by the vendor's own limits), records fan back by territory containment, and the charge splits per brokerage by records received, to the cent")
}

main().catch((e) => { console.error(e); process.exit(1) })
