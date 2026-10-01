/**
 * scripts/rentcast-platform-guard.ts — `npm run test:rentcast-platform`
 *
 * WAVE 92, LANE 92B. Owner rulings (2026-10-01, verbatim):
 *   "use rentcast as much as possible regarding property listings, market, comparable, home values
 *    and use any other attributes that are available, also can use it for a simple property
 *    lookup. this is supposed to run for the full platform."
 *   "checking the active territories before scrapping and pulling data will cutdown on runs."
 *   "batchdata is to be used more for scrapping leads."
 *   "pulling recent data should be only on where it is appropriate."
 *
 * Proves, with no network and no DB (every scan reads COMMENT-STRIPPED source — a tombstone that
 * names a retired call is not a call, CLAUDE.md §2 — and every absence carries a positive control):
 *   A  RENTCAST FOR THE FULL PLATFORM — the ONE gate asks the tenant-IDX substitute question only
 *      for a for-sale listing search (EXECUTED: a property-data read is eligible without an IDX read);
 *      every RentCast reader names its read kind, and only the sale search can be suppressed by IDX
 *      (derived population: every exported reader in lib/property/rentcast.ts); property FACTS are
 *      cached, listings are not; every attribute is carried (listing extras on both readers, the
 *      rental half of /markets EXECUTED, the full record reader); RentCast's 500-row ceiling holds
 *      (EXECUTED builder).
 *   B  NO BATCHDATA ON PROPERTY READS — the population of property readers is DERIVED (every file
 *      that imports the RentCast client, plus lib/property, lib/avm, lib/cma) and none imports or
 *      reaches BatchData outside a published LEAD-lane allowlist; the retired BatchData property
 *      readers are gone; "valuation" is refused by the ONE BatchData gate (EXECUTED).
 *   C  ACTIVE-TERRITORY PRE-CHECK ON EVERY PULL — resolveActivePullGate EXECUTED against a fake
 *      client (live tenant / dead tenant / outside area / unspecified area / refused read — fail
 *      closed / tally); the population of PULL crons is DERIVED from their pull calls and every one
 *      reaches the gate (directly or through its one delegate); the lead-scraping cron logs skipped runs.
 *   D  RECENCY ONLY WHERE APPROPRIATE + THE INACTIVE PREFILTER — no window on property facts / AVM
 *      / markets / record lookups; windows on listings / status changes; BatchData standing-fact
 *      triggers carry no date window while recorder events do (EXECUTED); the RentCast inactive-
 *      listing prefilter selects fresh removals by removedDate, dedupes, drops sold-after-removal,
 *      skips BatchData when nothing is fresh, and yields to the area pull when RentCast is dark
 *      (EXECUTED with injected providers); the cron wires it before the BatchData expired pull.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "fs"
import { join } from "path"
import { createRequire } from "node:module"
import { stripComments, blankStrings } from "./strip-comments"

// lib/property/rentcast-eligibility.ts reaches server-only modules only through dynamic imports;
// the shim keeps a transitive import from throwing (the import then fails CLOSED inside its own catch).
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
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${e}`
    if (e === "node_modules" || e.startsWith(".")) continue
    const st = statSync(join(ROOT, rel))
    if (st.isDirectory()) walk(rel, out)
    else if (/\.(ts|tsx)$/.test(e) && !/\.d\.ts$/.test(e)) out.push(rel)
  }
  return out
}
/** The body of `export async function <name>(` up to the next top-level `export ` / `function `. */
function fnBody(src: string, name: string): string {
  const i = src.search(new RegExp(`(?:export )?(?:async )?function ${name}(?:<[^>]*>)?\\(`))
  if (i < 0) return ""
  const rest = src.slice(i + 10)
  const j = rest.search(/\n(?:export |async function |function )/)
  return j < 0 ? src.slice(i) : src.slice(i, i + 10 + j)
}
const CORPUS = [...walk("lib"), ...walk("app")]

async function main() {
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[A · RentCast for the full platform — gate per read kind, every attribute, facts cached]")
  process.env.RENTCAST_API_KEY = process.env.RENTCAST_API_KEY || "test-platform-key"
  const { resolveRentcastEligibility } = await import("../lib/property/rentcast-eligibility")
  const pd = await resolveRentcastEligibility({ brokerageId: "b-idx", readKind: "property_data" })
  check("EXECUTED: a PROPERTY-DATA read is eligible on the platform key without asking the IDX question",
    pd.eligible === true && pd.idx.status === "not_connected" && pd.platformKeyPresent === true, JSON.stringify({ e: pd.eligible, r: pd.reason, idx: pd.idx }))
  const elig = stripped("lib/property/rentcast-eligibility.ts")
  const IDX_GUARD = /\(ctx\.readKind \?\? "sale_listings"\) === "sale_listings"\s*\?\s*await resolveTenantIdxConnection\(ctx\)/
  check("the IDX substitute question is asked ONLY for a sale-listings read (default kind = the pre-92 meaning)", IDX_GUARD.test(elig))
  check("POSITIVE CONTROL: an unconditional IDX read is NOT matched by the same finder",
    !IDX_GUARD.test(`const idx = await resolveTenantIdxConnection(ctx)`))

  const rc = stripped("lib/property/rentcast.ts")
  const readers = [...rc.matchAll(/export async function (\w+)\(/g)].map((m) => m[1])
  const gated = readers.filter((r) => /gateRentcast\(|fetchRentcastPropertyRow\(|getRentcastAvmAndComps\(/.test(fnBody(rc, r)))
  const kindOf = (r: string) => {
    const b = fnBody(rc, r)
    if (/fetchRentcastPropertyRow\(|getRentcastAvmAndComps\(params\)/.test(b) && !/gateRentcast\(/.test(b)) return "delegates"
    const m = /gateRentcast\(\s*params,\s*([\s\S]{0,160}?)\)\s*\n?/.exec(b)
    return m ? m[1].replace(/\s+/g, " ").trim() : "NONE"
  }
  const kinds = Object.fromEntries(gated.map((r) => [r, kindOf(r)]))
  console.log(`  denominator: ${readers.length} exported functions in lib/property/rentcast.ts · ${gated.length} RentCast readers (gate or shared fetch)`)
  check(`every RentCast reader names its read kind (${gated.length}/${gated.length}) — none falls back to the caller's choice`,
    gated.length >= 8 && Object.values(kinds).every((k) => k !== "NONE"), JSON.stringify(kinds))
  const saleKind = Object.entries(kinds).filter(([, k]) => /sale_listings/.test(k)).map(([r]) => r)
  check("ONLY the for-sale listing search can be suppressed by a tenant IDX feed (the substitute)",
    saleKind.length === 1 && saleKind[0] === "searchRentcastSaleListings", saleKind.join(","))
  check("…and even that search reads as property data for an INACTIVE sweep or a market sweep",
    /status === "Inactive" \|\| params\.marketSweep === true \? "property_data" : "sale_listings"/.test(fnBody(rc, "searchRentcastSaleListings")))
  check("the shared /properties fetch, the AVM, the comps and the markets reader are property_data",
    /gateRentcast\(params, "property_data"\)/.test(fnBody(rc, "fetchRentcastPropertyRow"))
    && ["getRentcastAVM", "getRentcastMarketStats", "getRentcastAvmAndComps", "searchRentcastRentalListings", "getRentcastListingStatus"].every((r) => /"property_data"/.test(fnBody(rc, r))))
  // FACTS cached, LISTINGS not.
  const cachedIn = ["fetchRentcastPropertyRow", "getRentcastAVM", "getRentcastMarketStats", "getRentcastAvmAndComps"].filter((r) => /cachedRentcastRead</.test(fnBody(rc, r)))
  check("property FACTS are cached — record, AVM, comps, market stats (4/4)", cachedIn.length === 4, cachedIn.join(","))
  check("LISTINGS are never cached (MLS-licensed, time-sensitive) — neither search reader reads the cache",
    !/cachedRentcastRead/.test(fnBody(rc, "searchRentcastSaleListings")) && !/cachedRentcastRead/.test(fnBody(rc, "searchRentcastRentalListings")))
  check("a FAILED request is never cached (only ok + data is stored)", /if \(fresh\.ok && fresh\.data != null\)/.test(fnBody(rc, "cachedRentcastRead")))
  // Every attribute.
  check("both listing readers carry the wave-92 extras (dates, agent/office, coordinates, county, lot, HOA)",
    (rc.match(/\.\.\.listingRowExtras\(/g) ?? []).length === 2)
  check("the full property record reader exists and maps owner / history / features / tax years",
    /export async function getRentcastPropertyDetail\(/.test(rc) && /ownerNames:/.test(rc) && /history:/.test(rc) && /features:/.test(rc) && /taxAssessments:/.test(rc))
  check("/markets asks dataType \"All\" (sale + rental in ONE billed request)", /dataType: "All"/.test(fnBody(rc, "getRentcastMarketStats")) && !/dataType: "Sale"/.test(rc))
  const { normalizeRentcastRentalMarketStats } = await import("../lib/property/rentcast-normalize")
  const rental = normalizeRentcastRentalMarketStats({ medianRent: 2150, averageDaysOnMarket: 31, totalListings: 412, newListings: 88, medianRentPerSquareFoot: 1.42 })
  check("EXECUTED: the rental half normalizes (median rent, DOM, inventory, $/sqft) and a missing rent is null, never 0",
    rental?.median_rent === 2150 && rental?.active_listings === 412 && normalizeRentcastRentalMarketStats({ medianRent: 0 }) === null)
  const { buildRentcastListingQuery, RENTCAST_MAX_LISTINGS_PER_REQUEST } = await import("../lib/property/rentcast-query")
  const q900 = buildRentcastListingQuery({ city: "Austin", state: "TX", limit: 900, offset: 500 }, { defaultLimit: 30, endpoint: "sale" })
  check(`EXECUTED: RentCast's per-request ceiling holds — a 900-row ask is sent as ${RENTCAST_MAX_LISTINGS_PER_REQUEST}, paging by offset`,
    RENTCAST_MAX_LISTINGS_PER_REQUEST === 500 && q900.limit === 500 && (q900 as any).offset === 500)
  check("POSITIVE CONTROL: a small ask is not inflated and offset 0 is omitted",
    buildRentcastListingQuery({ city: "Austin", state: "TX", limit: 20, offset: 0 }, { defaultLimit: 30, endpoint: "sale" }).limit === 20
    && !("offset" in buildRentcastListingQuery({ city: "Austin", state: "TX" }, { defaultLimit: 30, endpoint: "sale" })))
  // The rail: a simple property lookup reads the RECORD.
  const rail = stripped("lib/ai-isa/property-lookup-rail.ts")
  const rung = fnBody(rail, "rentcastRung")
  check("the property-lookup rail's RentCast rung reads the PROPERTY RECORD for every purpose (a conversation asks the listing first)",
    /getRentcastPropertyRecord\(/.test(rung) && /req\.purpose === "conversation"/.test(rung) && rung.indexOf("searchRentcastSaleListings(") < rung.indexOf("getRentcastPropertyRecord("))

  // HOME VALUES — RentCast FIRST for every tenant call, background scans included (lane 92B2;
  // owner: "use rentcast as much as possible regarding … home values"). Perplexity is the fallback.
  const chain = stripped("lib/avm/provider-chain.ts")
  const avmBody = fnBody(chain, "getCurrentAvm")
  const rcAt = avmBody.indexOf("await tryRentcast(req)"), pxAt = avmBody.indexOf("await tryPerplexitySonar(req)")
  const firstOrder = (b: string) => { const r = b.indexOf("await tryRentcast(req)"), p = b.indexOf("await tryPerplexitySonar(req)"); return r > -1 && p > -1 && r < p }
  check("the AVM chain asks RentCast BEFORE the Perplexity fallback", firstOrder(avmBody), `rentcast@${rcAt} perplexity@${pxAt}`)
  check("POSITIVE CONTROL: the ordering check fails on a Perplexity-first fixture",
    !firstOrder(`const px = await tryPerplexitySonar(req)\nconst rc = await tryRentcast(req)`))
  const preRc = avmBody.slice(0, rcAt)
  check("…and RentCast-first does NOT wait for usePaidProviders (the premium flag governs only the Zillow scrape), but is gated by the ONE eligibility verdict (property_data) and the budget",
    !/usePaidProviders/.test(preRc) && /readKind: "property_data"/.test(preRc) && /const rentcastFirst = rentcastEligible && !overBudget/.test(preRc)
    && /if \(req\.usePaidProviders && !overBudget\)[\s\S]{0,200}tryZillowViaZenRows\(req\)/.test(avmBody))
  const scan = stripped("lib/wealth-advisor/scan-opportunities.ts")
  check("the daily wealth scan (the background value refresh) hands the chain its tenant, so RentCast is reachable from the scan",
    /getCurrentAvm\(\{[\s\S]{0,400}brokerageId: brokerageId \?\? null/.test(scan) && /cacheStaleAfterDays: 14/.test(scan))
  check("the cost bound is the 14-day window twice: the scan's own stale check AND RentCast's AVM fact cache",
    /RENTCAST_CACHE_TTL_DAYS = \{ record: 30, avm: 14, markets: 7 \}/.test(rc) && /> 14 \* 24 \* 60 \* 60 \* 1000/.test(scan))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[B · no BatchData on property reads — derived population, retired readers gone, valuation refused]")
  const BD_IMPORT = /["']@\/lib\/external\/batchdata-[a-z-]+["']|["']@\/lib\/batchdata-client["']|from ["']@\/lib\/external["']/
  const BD_REACH = /callBatchDataMcp\(|batchDataPreferMcp(?:<[^(]*?>)?\(|enrichPropertyDatasetsBatchData\(|fetchIncrementalPropertySearch\(|(?<!\.)searchProperties\(|fetchMotivatedSellers\(|enrichPropertyWithBatchData\(|fetchBatchDataComps\(|comparableProperty\w*\(|lookupBatchDataPropertiesByIds\(|new BatchDataClient\(/
  const RENTCAST_IMPORT = /["']@\/lib\/property\/rentcast["']|["']\.\/rentcast["']/
  const propertyReaders = CORPUS.filter((p) =>
    /^lib\/(property|avm|cma)\//.test(p) || RENTCAST_IMPORT.test(stripped(p))
    || ["lib/offers/public-record-preload.ts", "lib/agentic-os/deal-investigator.ts"].includes(p))
  // LEAD lanes that legitimately hold BOTH clients — each with its reason; the property half of each
  // is held separately below (a reach in the property half still fails).
  const LEAD_LANE_ALLOW: Record<string, string> = {
    "app/api/cron/lead-scraping/route.ts": "the lead-scraping cron (BatchData = lead lists; RentCast = the inactive prefilter)",
    "lib/lead-pipeline/expired-listing-prefilter.ts": "expired-seller LEADS: RentCast finds fresh removals, BatchData the owners",
    "lib/kernel/listings-batchdata-feed.ts": "incremental motivated-seller + Buy Box investor LEAD lanes (discovery body held below)",
    "lib/ai-isa/property-lookup-rail.ts": "the BatchData rung is reachable only for LEAD purposes (BATCHDATA_ELIGIBLE_PURPOSES held below)",
  }
  const offenders = propertyReaders.filter((p) => !LEAD_LANE_ALLOW[p] && (BD_IMPORT.test(stripped(p)) || BD_REACH.test(code(p))))
  console.log(`  denominator: ${CORPUS.length} files under app/ lib/ · ${propertyReaders.length} property readers (RentCast importers + lib/property|avm|cma + the 2 named) · ${Object.keys(LEAD_LANE_ALLOW).length} lead-lane exceptions`)
  check(`no property reader imports or reaches BatchData (${propertyReaders.length - offenders.length}/${propertyReaders.length})`, offenders.length === 0, offenders.join(", "))
  check("POSITIVE CONTROL: the same predicates flag a property module importing and calling BatchData",
    BD_IMPORT.test(`import { enrichPropertyWithBatchData } from "@/lib/external/batchdata-client"`) && BD_REACH.test(blankStrings(`await batchDataPreferMcp("lookup_property", {})`)))
  check("the four former 'valuation' callers are in the derived population and BatchData-free (comps, AVM, net-sheet tax, deal investigator)",
    ["lib/cma/comp-provider.ts", "lib/avm/provider-chain.ts", "lib/offers/public-record-preload.ts", "lib/agentic-os/deal-investigator.ts"]
      .every((p) => propertyReaders.includes(p) && !BD_IMPORT.test(stripped(p)) && !BD_REACH.test(code(p))))
  const feed = code("lib/kernel/listings-batchdata-feed.ts")
  const discovery = fnBody(feed, "runActiveListingDiscoveryForMarket")
  check("the active-listing DISCOVERY body (a listings read) reaches RentCast, never BatchData",
    discovery.length > 200 && /searchRentcastSaleListings\(/.test(discovery) && !BD_REACH.test(discovery))
  const bdc = stripped("lib/external/batchdata-client.ts"), bdm = stripped("lib/external/batchdata-mcp.ts")
  const retired = ["enrichPropertyWithBatchData", "fetchBatchDataComps", "readBatchDataComp"].filter((n) => new RegExp(`export (?:async )?function ${n}\\(`).test(bdc))
    .concat(["comparablePropertyPreview", "comparablePropertyCount", "comparablePropertyPage"].filter((n) => new RegExp(`export async function ${n}\\(`).test(bdm)))
  check("the retired BatchData PROPERTY readers are deleted (AVM enrichment, comps dataset, comps MCP mirrors)", retired.length === 0, retired.join(","))
  const { BATCHDATA_ELIGIBLE_PURPOSES, decideBatchDataAccess } = await import("../lib/ai-isa/property-lookup-rail")
  check("BATCHDATA_ELIGIBLE_PURPOSES is LEAD work only — acquisition / skip_trace / dnc",
    [...BATCHDATA_ELIGIBLE_PURPOSES].sort().join(",") === "acquisition,dnc,skip_trace")
  const ALLOW = { batchDataTier: "lean" as const, batchDataOptedIn: true }
  const refused = (["valuation", "conversation", "listing_intake", "public_facts"] as const).filter((purpose) => decideBatchDataAccess({ brokerageId: "b-1", purpose }, ALLOW).allowed)
  check("EXECUTED: every PROPERTY purpose is refused by the ONE BatchData gate under an allowing policy", refused.length === 0, refused.join(","))
  check("POSITIVE CONTROL: a LEAD purpose under the same policy IS allowed (the gate discriminates)",
    decideBatchDataAccess({ brokerageId: "b-1", purpose: "acquisition" }, ALLOW).allowed === true)

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[C · active-territory pre-check on every pull — executed gate, derived pull population]")
  const { resolveActivePullGate } = await import("../lib/lead-pipeline/scrape-territories")
  function fakeClient(o: { subs: any[]; subsError?: string; markets: any[] }) {
    return {
      from(table: string) {
        const result = table === "subscriptions"
          ? { data: o.subsError ? null : o.subs, error: o.subsError ? { message: o.subsError } : null }
          : { data: o.markets, error: null }
        const chain: any = { select: () => chain, eq: () => chain, in: () => chain, order: () => chain, then: (res: any, rej: any) => Promise.resolve(result).then(res, rej) }
        return chain
      },
    }
  }
  const markets = [{ id: "m1", brokerage_id: "b-live", city: "Austin", state: "TX", zip_codes: ["78701", "78702"] }]
  const gate = await resolveActivePullGate(fakeClient({ subs: [{ brokerage_id: "b-live", status: "active" }, { brokerage_id: "b-dead", status: "canceled" }], markets }))
  const d = {
    live: gate.check({ brokerageId: "b-live" }),
    dead: gate.check({ brokerageId: "b-dead" }),
    unknown: gate.check({ brokerageId: "b-nobody" }),
    inCity: gate.check({ brokerageId: "b-live", city: "austin", state: "tx" }, { requireArea: true }),
    inZip: gate.check({ brokerageId: "b-live", zip: "78702-1234" }, { requireArea: true }),
    outside: gate.check({ brokerageId: "b-live", city: "Dallas", state: "TX" }, { requireArea: true }),
    noArea: gate.check({ brokerageId: "b-live" }, { requireArea: true }),
  }
  check("EXECUTED: a live tenant with an active territory may pull", d.live.allowed)
  check("EXECUTED: a cancelled tenant and an unknown tenant are skipped (tenant_not_active)", !d.dead.allowed && d.dead.reason === "tenant_not_active" && d.unknown.reason === "tenant_not_active")
  check("EXECUTED: an AREA pull inside the territory runs (city+state case-folded, or ZIP+4 → ZIP)", d.inCity.allowed && d.inZip.allowed)
  check("EXECUTED: an AREA pull outside every territory is skipped (area_outside_territory)", !d.outside.allowed && d.outside.reason === "area_outside_territory")
  check("EXECUTED: an AREA pull naming no place is refused, not guessed (area_unspecified)", !d.noArea.allowed && d.noArea.reason === "area_unspecified")
  check("EXECUTED: every check is TALLIED — 7 checked, 3 allowed, 4 skipped runs counted by reason",
    gate.tally.checked === 7 && gate.tally.allowed === 3 && gate.tally.skipped === 4 && gate.tally.byReason.tenant_not_active === 2
      && gate.tally.byReason.area_outside_territory === 1 && gate.tally.byReason.area_unspecified === 1, JSON.stringify(gate.tally))
  const refusedRead = await resolveActivePullGate(fakeClient({ subs: [], subsError: "permission denied", markets }))
  const rr = refusedRead.check({ brokerageId: "b-live" })
  check("EXECUTED: a REFUSED subscription read fails CLOSED under its own reason (never 'no subscribers')", !rr.allowed && rr.reason === "subscription_query_failed")
  const nobody = await resolveActivePullGate(fakeClient({ subs: [{ brokerage_id: "b-x", status: "past_due" }], markets }))
  check("EXECUTED: no live subscriber → every pull is skipped (no_active_subscribers)", nobody.check({ brokerageId: "b-x" }).reason === "no_active_subscribers")

  // The PULL population — derived from the pull calls each cron makes.
  const PULL = /new BatchDataClient\(|fetchMotivatedSellers\(|exaSearch\(|runApifyScrape\(|fetchTopThreads\(|fetchExaCompetitorAds\(|refreshMarketData\(|generateMarketInsight\(|refreshInvestorOffMarketMatches\(|runAllActiveAlerts\(|runExternalMarketWatchForBuyer\(|runIntentCampaign\(|ingestBatchDataSellerSignals\(|searchRentcast\w*\(|getRentcastMarketStats\(/
  const GATE = /resolveActivePullGate\(|resolveActiveScrapeTerritories\(/
  // A cron that pulls through ONE library entry is gated when that entry's module asks the gate.
  const DELEGATE: Record<string, string> = { "runAllActiveAlerts(": "lib/property-alerts/alert-engine.ts", "runIntentCampaign(": "lib/kernel/intent-campaign.ts" }
  const crons = readdirSync(join(ROOT, "app/api/cron")).map((c) => `app/api/cron/${c}/route.ts`).filter((p) => existsSync(join(ROOT, p)))
  crons.push("app/api/property-alerts/run/route.ts")
  const pullCrons = crons.filter((p) => PULL.test(code(p)))
  const ungated = pullCrons.filter((p) => {
    const src = code(p)
    if (GATE.test(src)) return false
    return !Object.entries(DELEGATE).some(([tok, mod]) => src.includes(tok) && GATE.test(code(mod)))
  })
  console.log(`  denominator: ${crons.length} cron routes (+ the alerts run route) · ${pullCrons.length} make a paid/area pull: ${pullCrons.map((p) => p.replace(/^app\/api\/(cron\/)?|\/route\.ts$/g, "")).join(", ")}`)
  check(`every PULL cron asks the active-territory gate before pulling (${pullCrons.length - ungated.length}/${pullCrons.length})`, ungated.length === 0 && pullCrons.length >= 10, ungated.join(", "))
  check("POSITIVE CONTROL: a pull cron fixture with no gate IS flagged by the same predicates",
    (() => { const fx = `const items = await exaSearch({ query })`; return PULL.test(fx) && !GATE.test(fx) })())
  const lead = code("app/api/cron/lead-scraping/route.ts")
  check("the lead-scraping cron asks the ONE pull gate, area-checks each territory, and LOGS the skipped runs",
    /resolveActivePullGate\(supabase\)/.test(lead) && /pullGate\.check\(/.test(lead) && /skipped_runs: \{ no_op: 0, budget_exhausted: 0, expired_batchdata_pull: 0 \}/.test(stripped("app/api/cron/lead-scraping/route.ts"))
    && /results\.skipped_runs\.budget_exhausted\+\+/.test(lead) && /metadata: \{ \.\.\.results/.test(lead))
  const alerts = code("lib/property-alerts/alert-engine.ts")
  check("the property-alert sweep skips an inactive tenant BEFORE any provider call and counts it",
    alerts.indexOf("pullGate.check(") > -1 && alerts.indexOf("pullGate.check(") < alerts.indexOf("await runAlert(") && /skippedInactiveTenant/.test(alerts))

  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n[D · recency only where appropriate + the RentCast inactive prefilter]")
  const FACT_READERS = ["fetchRentcastPropertyRow", "getRentcastAVM", "getRentcastMarketStats"]
  check("NO recency window on property FACTS — the record, AVM and market readers send no daysOld / listedWithinDays",
    FACT_READERS.every((r) => { const b = fnBody(rc, r); return b.length > 0 && !/daysOld|listedWithinDays/.test(b) }))
  check("the rail's simple property lookup sends no window", !/listedWithinDays|daysOld/.test(rung))
  check("a LISTING search carries a window only when the caller asks (buyer listings) — the builder never invents one",
    !("daysOld" in buildRentcastListingQuery({ city: "Austin", state: "TX" }, { defaultLimit: 30, endpoint: "sale" }))
    && buildRentcastListingQuery({ city: "Austin", state: "TX", listedWithinDays: 30 }, { defaultLimit: 30, endpoint: "sale" }).daysOld === "*:30")
  const { dateWindowCriteria } = await import("../lib/external/batchdata-client")
  const today = new Date("2026-10-01T12:00:00Z")
  const standing = ["high_equity", "absentee", "vacant", "tired_landlord"].filter((t) => Object.keys(dateWindowCriteria(t, { lookbackDays: 30, today })).length > 0)
  check("EXECUTED: BatchData STANDING-FACT triggers (equity, absentee, vacancy, tenure) carry NO date window", standing.length === 0, standing.join(","))
  check("POSITIVE CONTROL: a recorder EVENT (pre-foreclosure) does carry its recording-date window",
    JSON.stringify(dateWindowCriteria("pre_foreclosure", { lookbackDays: 30, today })).includes("2026-09-01"))
  const { SOURCE_RECENCY, SOURCE_VENDOR } = await import("../lib/lead-pipeline/source-intent-map")
  const bdWindowed = Object.entries(SOURCE_VENDOR).filter(([k, v]) => v === "batchdata" && (SOURCE_RECENCY as any)[k]?.windowDays != null).map(([k]) => k)
  check("no BatchData source (property-record populations) is double-gated by a client-side post window (derived from SOURCE_VENDOR)", bdWindowed.length === 0, bdWindowed.join(","))

  const { runExpiredListingPrefilter } = await import("../lib/lead-pipeline/expired-listing-prefilter")
  const NOW = Date.parse("2026-10-01T12:00:00Z")
  const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString()
  const inactiveRows: any[] = [
    { address: "1 Fresh St", city: "Austin", state: "TX", zip: "78701", removedDate: day(5), price: 500000, daysOnMarket: 90 },
    { address: "1 FRESH ST.", city: "Austin", state: "TX", zip: "78701", removedDate: day(9), price: 510000, daysOnMarket: 80 },
    { address: "2 Sold St", city: "Austin", state: "TX", zip: "78701", removedDate: day(12), price: 400000, daysOnMarket: 30 },
    { address: "3 Old St", city: "Austin", state: "TX", zip: "78701", removedDate: day(100), price: 300000, daysOnMarket: 200 },
    { address: "4 Undated St", city: "Austin", state: "TX", zip: "78701", removedDate: null, price: 300000, daysOnMarket: 20 },
  ]
  const lookedUp: string[] = []
  const deps = (rows: any[], ok = true) => ({
    inactiveListings: async () => ({ success: ok, listings: rows, error: ok ? undefined : "RentCast not configured" }),
    lookupOwner: async (address: string) => {
      lookedUp.push(address)
      return /Sold/.test(address)
        ? ({ firstName: "S", lastName: "Old", listing: { soldDate: day(3) } } as any)
        : ({ firstName: "Fresh", lastName: "Owner", listing: {} } as any)
    },
    recordCostUsd: 0.05,
    nowMs: NOW,
  })
  const pre = await runExpiredListingPrefilter({ brokerageId: "b-live", city: "Austin", state: "TX", lookbackDays: 30, maxLookups: 50 }, deps(inactiveRows))
  check("EXECUTED: only removals inside the window are looked up — one per address (newest), the 100-day and undated rows never billed",
    pre.mode === "prefiltered" && pre.removalsSeen === 5 && pre.freshRemovals === 2 && lookedUp.length === 2 && !lookedUp.some((a) => /Old St|Undated/.test(a)), JSON.stringify({ pre: { ...pre, records: pre.records.length }, lookedUp }))
  check("EXECUTED: a home that SOLD after it came off the market is dropped (RentCast cannot tell sold from expired)",
    pre.soldDropped === 1 && pre.records.length === 1 && pre.records[0].lastName === "Owner")
  check("EXECUTED: the RentCast removal date becomes the record's status date; BatchData cost = matched rows × the per-record price",
    pre.records[0].listing?.statusUpdatedAt === day(5) && pre.batchDataCostUsd === 0.1)
  lookedUp.length = 0
  const none = await runExpiredListingPrefilter({ brokerageId: "b-live", city: "Austin", state: "TX", lookbackDays: 30 }, deps([inactiveRows[3]]))
  check("EXECUTED: nothing left the market inside the window → ZERO BatchData lookups (the expired pull is skipped)",
    none.mode === "prefiltered" && none.freshRemovals === 0 && lookedUp.length === 0 && none.records.length === 0)
  const dark = await runExpiredListingPrefilter({ brokerageId: "b-live", city: "Austin", state: "TX", lookbackDays: 30 }, deps(inactiveRows, false))
  check("EXECUTED: a dark RentCast lane yields to the BatchData area pull (mode unavailable — never a darkened lane)", dark.mode === "unavailable" && lookedUp.length === 0)
  lookedUp.length = 0
  const wide = await runExpiredListingPrefilter({ brokerageId: "b-live", city: "Austin", state: "TX", lookbackDays: 200 }, deps(inactiveRows))
  check("POSITIVE CONTROL: widening the market's lookback to 200 days admits the 100-day removal (the window is the market's own)",
    wide.freshRemovals === 3 && lookedUp.some((a) => /Old St/.test(a)))
  const preIdx = lead.indexOf("runExpiredListingPrefilter(")
  const areaPullIdx = lead.indexOf(`getMotivatedSellerDataWithCost(location, [`, preIdx)
  check("the lead-scraping cron runs the prefilter BEFORE its BatchData expired area pull, which runs only when RentCast is unavailable",
    preIdx > -1 && areaPullIdx > preIdx && /pre && pre\.mode === "prefiltered"/.test(stripped("app/api/cron/lead-scraping/route.ts")) && /results\.skipped_runs\.expired_batchdata_pull\+\+/.test(lead))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ RENTCAST_PLATFORM_FAIL"); process.exit(1) }
  console.log(" ✅ RENTCAST_PLATFORM_PASS — RentCast serves every property read for every tenant (IDX substitutes only the for-sale search), BatchData is lead work only, every pull asks the active-territory gate first and counts what it skipped, and recency windows sit on listings and status changes, never on property facts")
}

main().catch((e) => { console.error(e); process.exit(1) })
