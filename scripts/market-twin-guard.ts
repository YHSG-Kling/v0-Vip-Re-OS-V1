#!/usr/bin/env tsx
/**
 * scripts/market-twin-guard.ts (test:market-twin) — THE TENANT LOCAL MARKET TWIN + HOUSING MATCH GAP (wave 150, lane 150KLMO;
 * directive 150O + 150M, contract C41, ruling R8, canary 17).
 *
 *   A  LABELS (canary 17): a RentCast /markets reading is labelled LISTING asking statistics; a sold median exists only from
 *      recorded closed sales and is labelled as such; tenant-pinned (another tenant's rows never answer).
 *   B  MONTHS OF SUPPLY only from a feed that observed it (MLS / IDX); RentCast + a sample of closed sales → null WITH the reason;
 *      a 0 written by the refresher is unknown, never a market class.
 *   C  ONE SHARED READ per region/period: the twin asks the provider at most once per zip per load and never without an
 *      authorized refresh; lib/property/rentcast.ts getRentcastMarketStats rides the platform-wide cache keyed by ZIP (no tenant
 *      in the key) and meters only inside the miss fetcher (stripped source; positive control on a mutant).
 *   D  HOUSING MATCH GAP (C41): consented demand only (a SAID field on a stated consent basis), k-floor suppression, stale
 *      inventory excluded and counted, no buyer identity anywhere in the output, never "a buyer has been found".
 *   E  THE REPORT TREND (canary 17): a market_trends month prints only when a RentCast listing reading backs it, labelled
 *      listing asking price; the PDF header says so; topics + topic themes label asking prices as asking.
 *   F  TENANT-BRANDED per agent / office (C34 cascade): the same report differs per office; a refused office read fails closed.
 *   G  TOPICS: demand-gap evidence reaches the strategist and may carry a topic; never the topic bank.
 *   M  REI PLAYBOOK v5.5 (directive 150M): investor-only, one overlay, preview-only (purchase 0), confirmed criterion names,
 *      unconfirmed ones labelled, benchmarks labelled heuristics; the planner reads the playbook (no inline twin).
 *   W  WIRING: market-watch reads every { error }.
 *
 * BLIND SPOTS (published): the platform cache's once-per-window behaviour is proven on the SOURCE of rentcast.ts (no live
 * RentCast call in a proof); RentCast's own update cadence is not observed; consented demand counts only buyers who STATED
 * criteria with a recorded basis; inventory freshness is the listing's sync/seen timestamp, not an MLS status re-check.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createRequire } from "node:module"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"

const _require = createRequire(import.meta.url)
try { const so = _require.resolve("server-only"); _require.cache[so] = { id: so, filename: so, loaded: true, exports: {} } as any } catch { /* not installed */ }

const ROOT = process.cwd()
const code = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"))
let passed = 0, failed = 0
function check(name: string, ok: boolean, detail = "") { if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) } }
const section = (t: string) => console.log(`\n[${t}]`)

const B1 = "00000000-0000-4000-8000-0000000000b1", B2 = "00000000-0000-4000-8000-0000000000b2"
const U1 = "00000000-0000-4000-8000-0000000000a1", U2 = "00000000-0000-4000-8000-0000000000a2"
const NOW = new Date("2026-11-06T12:00:00Z")
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString()
const stats = (over: Record<string, unknown> = {}) => ({ median_sale_price: 455000, avg_days_on_market: 38, active_listings: 180, new_listings_30d: 52, price_trend_yoy_pct: 3.1, median_price_per_sqft: 241, total_listings_at: "2026-11-01T00:00:00Z", rental: { median_rent: 2150 }, ...over })
const sold = (i: number, b = B1, zip = "32503") => ({ id: `s-${b}-${i}`, brokerage_id: b, zip, status: "sold", deleted_at: null, sold_price: 400000 + i * 10000, sold_date: day(-20 - i).slice(0, 10) })
const said = (value: unknown, basis = "self_service_portal") => ({ source: "said", value, evidence: "their words", channel: "portal", at: day(-3), reason: null, consent: { basis, ref: "u" } })
const pref = (contact: string, o: Record<string, unknown> = {}) => ({ id: `p-${contact}`, brokerage_id: B1, contact_id: contact, preferred_price_max: null, inferred_max_price: null, inferred_beds_min: null, inferred_zip_codes: null, inferred_cities: null, listing_type: "sale", criteria_provenance: { maxPrice: said(480000), minBeds: said(3), zipCodes: said(["32503"]) }, ...o })
const activeListing = (i: number, o: Record<string, unknown> = {}) => ({ id: `a-${i}`, brokerage_id: B1, status: "active", deleted_at: null, zip: "32503", city: "Pensacola", list_price: 450000, bedrooms: 3, updated_at: day(-2), last_provider_sync_at: day(-1), ...o })

async function main() {
  const { loadMarketTwin } = await import("../lib/market-reports/market-twin")
  const twinDeps = (calls: { n: number }, over: Record<string, unknown> = {}) => ({ now: NOW, providerRead: async () => { calls.n++; return stats(over) }, activeStatuses: async () => ["active", "coming_soon"] })

  section("A. labels — listing asking vs recorded sale (canary 17)")
  {
    const db = memSupabase({ listings: [sold(1), sold(2), sold(3), sold(9, B2)], market_data: [], property_preferences: [], market_active_listings: [] })
    const calls = { n: 0 }
    const t = await loadMarketTwin(db as never, { brokerageId: B1, zips: ["32503"], allowProviderRead: true }, twinDeps(calls))
    const z = t.zips[0]
    check("the RentCast median is a LISTING asking price, labelled so", z?.listing.medianAskingPrice?.basis === "listing_asking" && /asking price/i.test(z.listing.medianAskingPrice.label) && !/sold|sale price/i.test(z.listing.medianAskingPrice.label), JSON.stringify(z?.listing.medianAskingPrice))
    check("the rental half is labelled asking RENT of rental listings", z?.rental.medianRent?.basis === "listing_rent" && /rent/i.test(z.rental.medianRent.label))
    check("the sold median comes from RECORDED closed sales only, labelled so (3 of this tenant's sales → $420,000)", z?.sold.medianSoldPrice?.basis === "recorded_sale" && z.sold.medianSoldPrice.value === 420000 && /sold/i.test(z.sold.medianSoldPrice.label) && z.sold.closedSales === 3, JSON.stringify(z?.sold))
    check("tenant-pinned: the other tenant's sale never enters the median", z?.sold.closedSales === 3)
    check("the provenance names RentCast /markets, the platform cache and the rights", z?.source.provider === "rentcast" && z.source.endpoint === "/markets" && /platform-wide provider cache rentcast:\/markets\|32503/.test(z.source.cache) && /licensed_vendor/.test(z.source.rights))
    const thin = await loadMarketTwin(memSupabase({ listings: [sold(1), sold(2)], market_data: [] }) as never, { brokerageId: B1, zips: ["32503"], allowProviderRead: true }, twinDeps({ n: 0 }))
    check("POSITIVE CONTROL: two sales are not a median (null, count kept)", thin.zips[0].sold.medianSoldPrice === null && thin.zips[0].sold.closedSales === 2)
  }

  section("B. months of supply — only from a feed that observed it")
  {
    const base = { listings: [], property_preferences: [], market_active_listings: [] }
    const rc = await loadMarketTwin(memSupabase({ ...base, market_data: [{ brokerage_id: B1, zip_code: "32503", data_date: day(-5).slice(0, 10), source_type: "rentcast", months_of_inventory: 0 }] }) as never, { brokerageId: B1, zips: ["32503"], allowProviderRead: true }, twinDeps({ n: 0 }))
    check("RentCast only (months_of_inventory written 0 = unknown) → null WITH the reason, never derived from a sample", rc.marketGap.monthsOfSupply === null && /no sold counts/.test(rc.marketGap.reason), rc.marketGap.reason)
    const mls = await loadMarketTwin(memSupabase({ ...base, market_data: [{ brokerage_id: B1, zip_code: "32503", data_date: day(-5).slice(0, 10), source_type: "mls_feed", months_of_inventory: 2.4 }, { brokerage_id: B2, zip_code: "32503", data_date: day(-1).slice(0, 10), source_type: "mls_feed", months_of_inventory: 9 }] }) as never, { brokerageId: B1, zips: ["32503"] }, twinDeps({ n: 0 }))
    check("an MLS feed reading of 2.4 months is published with its date and source (the planner's MarketGap shape); the other tenant's 9 never answers", mls.marketGap.monthsOfSupply === 2.4 && mls.marketGap.source === "market_data (mls_feed)" && typeof mls.marketGap.asOf === "string", JSON.stringify(mls.marketGap))
    const refused = await loadMarketTwin(memSupabase({ ...base, market_data: [] }, { refuse: { market_data: "permission denied" } }) as never, { brokerageId: B1, zips: ["32503"] }, twinDeps({ n: 0 }))
    check("a refused supply read → null, said (fail closed)", refused.marketGap.monthsOfSupply === null && /refused/.test(refused.marketGap.reason))
    const { marketThemes } = await import("../lib/content-intel/topic-themes")
    const zero = marketThemes([{ zip_code: "32503", city: "Pensacola", state: "FL", market_area: null, data_date: day(-3).slice(0, 10), source_type: "rentcast", median_sale_price: 455000, price_trend_pct_1yr: null, months_of_inventory: 0, avg_days_on_market: 38 }], NOW)
    check("topic themes: a 0 months-of-supply (unknown) never files a 'strong seller's market' change", !zero.themes.some((t) => /seller's/.test(t.title)), JSON.stringify(zero.themes.map((t) => t.title)))
  }

  section("C. one shared provider read per region / period")
  {
    const calls = { n: 0 }
    await loadMarketTwin(memSupabase({ listings: [], market_data: [] }) as never, { brokerageId: B1, zips: ["32503", "32503", "32504"], allowProviderRead: true }, twinDeps(calls))
    check("duplicate zips are read once each (3 asked, 2 distinct → 2 provider reads)", calls.n === 2, String(calls.n))
    const none = { n: 0 }
    const t = await loadMarketTwin(memSupabase({ listings: [], market_data: [{ id: "md1", brokerage_id: B1, zip_code: "32503", data_date: day(-4).slice(0, 10), source_type: "rentcast", median_sale_price: 450000, active_listings: 170, new_listings_30d: 40, avg_days_on_market: 35, price_trend_pct_1yr: 2 }] }) as never, { brokerageId: B1, zips: ["32503"] }, twinDeps(none))
    check("without an authorized refresh the provider is NEVER asked; the tenant's stored RentCast reading answers, still labelled asking", none.n === 0 && t.zips[0].via === "tenant_reading" && t.zips[0].listing.medianAskingPrice?.basis === "listing_asking")
    const rc = code("lib/property/rentcast.ts")
    const fn = rc.slice(rc.indexOf("export async function getRentcastMarketStats"), rc.indexOf("export async function getRentcastMarketStats") + 2200)
    const sharedKey = /cachedRentcastRead<RentcastMarketsResponse>\(\s*`\/markets\|\$\{zip\}`,\s*RENTCAST_CACHE_TTL_DAYS\.markets,\s*async \(\) => \{\s*const res = await callRentcastGet\("\/markets"[\s\S]{0,80}meterCall\(/
    check("getRentcastMarketStats rides the platform cache keyed by ZIP only (no tenant in the key) and meters ONLY inside the miss fetcher", sharedKey.test(fn) && (fn.match(/meterCall\(/g) ?? []).length === 1)
    const cache = rc.slice(rc.indexOf("async function cachedRentcastRead"), rc.indexOf("async function cachedRentcastRead") + 1400)
    check("…and the cache answers a hit BEFORE the fetcher runs (memory, then the shared store), storing only a success", cache.indexOf("getCachedProviderPayload") > 0 && cache.indexOf("getCachedProviderPayload") < cache.indexOf("await fetcher()") && /fresh\.ok && fresh\.data != null/.test(cache))
    const mutant = fn.replace("const read = await cachedRentcastRead", "meterCall({}); const read = await cachedRentcastRead")
    check("POSITIVE CONTROL: a meter outside the fetcher is caught", (mutant.match(/meterCall\(/g) ?? []).length !== 1)
  }

  section("D. housing match gap — consented demand × fresh inventory, no identities (C41)")
  {
    const prefs = [pref("c1"), pref("c2"), pref("c3"), pref("c4"),
      pref("c5", { criteria_provenance: { maxPrice: { source: "inferred", value: 470000 } }, inferred_max_price: 470000, inferred_beds_min: 3, inferred_zip_codes: ["32503"] }),
      pref("c6", { criteria_provenance: { maxPrice: said(900000), zipCodes: said(["32503"]) } }),
      pref("c7", { criteria_provenance: { maxPrice: { ...said(480000), consent: null }, zipCodes: said(["32503"], "") } }),
      pref("cx", { brokerage_id: B2 }), pref("cy", { brokerage_id: B2 }), pref("cz", { brokerage_id: B2 }),
    ]
    const inv = [activeListing(1), activeListing(2, { updated_at: day(-40), last_provider_sync_at: day(-40) }), activeListing(3, { list_price: 700000 })]
    const db = memSupabase({ property_preferences: prefs, listings: inv, market_active_listings: [{ id: "f1", brokerage_id: B1, current_status: "active", zip: "32503", city: "Pensacola", list_price: 430000, beds: 4, last_seen_at: day(-30) }], market_data: [] })
    const t = await loadMarketTwin(db as never, { brokerageId: B1, zips: ["32503"], brandName: "Gulf Breeze Homes" }, twinDeps({ n: 0 }))
    const seg = t.demandGap.segments.find((s) => s.area === "32503" && s.priceBand === "$300k–$500k" && s.beds === "3+ bedrooms")
    check("4 buyers who SAID their criteria with a consent basis form the segment (inferred-only c5 and the consent-less c7 are not demand)", seg?.consentedBuyers === 4, JSON.stringify(t.demandGap))
    check("fresh inventory only: 1 matching active listing fits; the 40-day-stale listing and the 30-day-unseen feed row are excluded and counted", seg?.freshInventory === 1 && t.demandGap.staleInventoryExcluded === 2 && seg.undersupplied === true, JSON.stringify(seg))
    check("a 1-buyer segment ($750k–$1M) is SUPPRESSED under the k-floor, counted", t.demandGap.suppressedSegments >= 1 && !t.demandGap.segments.some((s) => s.consentedBuyers < 3))
    const json = JSON.stringify(t)
    check("no buyer identity anywhere in the twin (contact ids planted: c1…c7)", !/"c[1-7]"|p-c[1-7]/.test(json), json.slice(0, 200))
    check("POSITIVE CONTROL: the identity probe sees a planted id", /"c[1-7]"/.test(JSON.stringify({ x: "c3" })))
    check("the attribution states counts, the brand and the date — and never a found buyer", !!seg && /4 buyers working with Gulf Breeze Homes/.test(seg.attribution) && /as of 2026-11-06/.test(seg.attribution) && !t.demandGap.segments.some((s) => /buyer (has been|was|is) found|I have a buyer|buyer for your (home|house)/i.test(s.attribution)) && /Never say a buyer has been found/.test(seg.claimBoundary))
    check("POSITIVE CONTROL: the found-buyer probe flags the forbidden sentence", /I have a buyer|buyer (has been|was|is) found/i.test("Good news — I have a buyer for your home"))
    check("tenant-pinned: the other tenant's three buyers never count", t.demandGap.consentedBuyers === 5, String(t.demandGap.consentedBuyers))
    const refused = await loadMarketTwin(memSupabase({ property_preferences: prefs, listings: inv }, { refuse: { listings: "permission denied" } }) as never, { brokerageId: B1, zips: ["32503"] }, twinDeps({ n: 0 }))
    check("a refused inventory read → no segments (fail closed: a gap on unread inventory would overstate demand), said", refused.demandGap.segments.length === 0 && refused.notes.some((n) => /refused/.test(n)))
  }

  section("E. the report trend + every asking-price label (canary 17)")
  {
    const { researchMarket } = await import("../lib/market-reports/research")
    const ZIP = { grain: "zip" as const, label: "32503", zip: "32503", city: "Pensacola", state: "FL" }
    const md = (d: string, src = "rentcast") => ({ id: `md-${d}-${src}`, brokerage_id: B1, zip_code: "32503", city: "Pensacola", state: "FL", data_date: d, source_type: src, active_listings: 180, new_listings_30d: 50, median_sale_price: 455000, avg_days_on_market: 38, price_trend_pct_1yr: 3 })
    const trends = [{ brokerage_id: B1, zip_code: "32503", snapshot_month: "2026-10-01", median_price: 455000, active_inventory: 180 }, { brokerage_id: B1, zip_code: "32503", snapshot_month: "2026-09-01", median_price: 300000, active_inventory: 1 }]
    const r = await researchMarket(memSupabase({ market_data: [md("2026-10-28"), md("2026-09-15", "cma_aggregate")], market_trends: trends, listings: [] }) as never, { brokerageId: B1, territory: ZIP }, { now: NOW, refreshMarketData: async () => ({ source: "rentcast", success: true }) })
    check("a trend month backed only by a CMA opinion row is NOT printed, said; the RentCast month is, labelled listing asking", r.trend.length === 1 && r.trend[0].month === "2026-10" && r.trend[0].priceBasis === "listing_asking" && r.notes.some((n) => /2026-09 not printed/.test(n)), JSON.stringify({ trend: r.trend, notes: r.notes }))
    const r2 = await researchMarket(memSupabase({ market_data: [md("2026-10-28"), md("2026-09-15")], market_trends: trends, listings: [] }) as never, { brokerageId: B1, territory: ZIP }, { now: NOW, refreshMarketData: async () => ({ source: "rentcast", success: true }) })
    check("POSITIVE CONTROL: with both months backed, both print", r2.trend.length === 2)
    const prod = code("lib/market-reports/producer.ts")
    check("the PDF trend table says 'Median asking price (listings)', never a bare 'Median price'", /"Median asking price \(listings\)"/.test(prod) && !/"Median price"/.test(prod))
    const topics = code("lib/market-reports/topics.ts")
    check("the topic evidence says the median ASKING price of listed homes", /median asking price of listed homes/.test(topics) && !/`median price \$\{/.test(topics))
    const { marketThemes } = await import("../lib/content-intel/topic-themes")
    const rcTheme = marketThemes([{ zip_code: "32503", city: "Pensacola", state: "FL", market_area: null, data_date: day(-3).slice(0, 10), source_type: "rentcast", median_sale_price: 455000, price_trend_pct_1yr: 3.1, months_of_inventory: 0, avg_days_on_market: 38 }], NOW)
    check("topic themes: a RentCast row is an ASKING price of listed homes, never 'Median sale price'", rcTheme.themes.length > 0 && rcTheme.themes.every((t) => (t.evidence.facts ?? []).every((f) => !/Median sale/.test(f))) && rcTheme.themes.some((t) => (t.evidence.facts ?? []).some((f) => /asking/.test(f))), JSON.stringify(rcTheme.themes.map((t) => t.evidence.facts)))
    const cma = marketThemes([{ zip_code: "32503", city: "Pensacola", state: "FL", market_area: null, data_date: day(-3).slice(0, 10), source_type: "cma_aggregate", median_sale_price: 455000, price_trend_pct_1yr: 3.1, months_of_inventory: null, avg_days_on_market: null }], NOW)
    check("topic themes: an agents' CMA average is opinion — dropped, counted", cma.themes.length === 0 && cma.dropped.opinion_not_market_data === 1)
  }

  section("F. tenant-branded per agent and office (C34 cascade)")
  {
    const { produceMarketReport } = await import("../lib/market-reports/producer")
    const ZIP = { grain: "zip" as const, label: "32503", zip: "32503", city: "Pensacola", state: "FL" }
    const L1 = "00000000-0000-4000-8000-00000000e001", L2 = "00000000-0000-4000-8000-00000000e002"
    const world = (opts: Parameters<typeof memSupabase>[1] = {}) => memSupabase({
      market_data: [{ id: "md-1", brokerage_id: B1, zip_code: "32503", city: "Pensacola", state: "FL", data_date: "2026-11-01", source_type: "rentcast", active_listings: 180, new_listings_30d: 50, median_sale_price: 455000, avg_days_on_market: 38, price_trend_pct_1yr: 3 }],
      market_trends: [], listings: [], agent_action_ledger: [], generated_documents: [],
      users: [{ id: U1, brokerage_id: B1, location_id: L1 }, { id: U2, brokerage_id: B1, location_id: L2 }],
      locations: [{ id: L1, brokerage_id: B1, name: "Downtown", legal_name: "Gulf Breeze Homes Downtown LLC", dba: "Gulf Breeze Downtown", license_number: "BK111", license_state: "FL", brand_overrides: { primary_color: "#0a5c36", tagline: "Downtown, door to door" } }, { id: L2, brokerage_id: B1, name: "Beaches", legal_name: "Gulf Breeze Homes Beaches LLC", dba: null, license_number: "BK222", license_state: "FL", brand_overrides: {} }],
    }, { uuidIds: true, ...opts })
    const renders: any[] = []
    const deps = (over: Record<string, unknown> = {}) => ({
      now: NOW, refreshMarketData: async () => ({ source: "rentcast", success: true }),
      write: async () => { throw new Error("model off") }, fairHousing: async () => ({ ok: true, findings: [] }),
      finalize: async (a: { texts: string[] }) => ({ ok: true as const, texts: a.texts, tagline: "Gulf Breeze Homes — neighbours first" }),
      brand: async () => ({ brokerageName: "Gulf Breeze Homes", agentName: "Ann Agent", licenseLine: "Brokerage Lic #BK000 (FL)", primaryColor: "#1144aa" }),
      render: async (a: any) => { renders.push(a); return { ok: true, pdfUrl: "https://cdn.example.com/r.pdf", documentId: `doc-${renders.length}`, error: null } },
      approver: async () => ({ ok: true, permittedUserIds: [U1], primaryUserIds: [U1], basis: "owner", reason: "x" }),
      ...over,
    })
    const input = (u: string) => ({ brokerageId: B1, agentUserId: u, actor: { type: "system" as const }, territory: ZIP, topic: { title: "32503 snapshot", angle: null, evidenceIds: [] }, purpose: "proof" })
    const r1 = await produceMarketReport(world() as never, input(U1), deps() as never)
    const r2 = await produceMarketReport(world() as never, input(U2), deps() as never)
    const b1 = renders[0]?.spec?.brand, b2 = renders[1]?.spec?.brand
    check("both reports produced", r1.ok && r2.ok, JSON.stringify([!r1.ok && (r1 as any).reason, !r2.ok && (r2 as any).reason]))
    check("office A: its DBA, its office licence, its colour and its tagline", b1?.brokerageName === "Gulf Breeze Downtown" && /Office Lic #BK111 \(FL\)/.test(b1?.licenseLine ?? "") && b1?.primaryColor === "#0a5c36" && b1?.tagline === "Downtown, door to door", JSON.stringify(b1))
    check("office B: its legal name and licence; the tenant colour where it sets none — the SAME territory report differs per office", b2?.brokerageName === "Gulf Breeze Homes Beaches LLC" && /BK222/.test(b2?.licenseLine ?? "") && b2?.primaryColor === "#1144aa" && b2?.brokerageName !== b1?.brokerageName, JSON.stringify(b2))
    const r3 = await produceMarketReport(world({ refuse: { locations: "permission denied" } }) as never, input(U1), deps() as never)
    check("a refused office read fails CLOSED (no report under the wrong office's licence line)", !r3.ok && /office brand could not be resolved/.test((r3 as any).reason))
    const r4 = await produceMarketReport(world() as never, { ...input(U1), agentUserId: null }, deps() as never)
    check("POSITIVE CONTROL: no presenting agent → the tenant brand unchanged", r4.ok && renders[renders.length - 1]?.spec?.brand?.brokerageName === "Gulf Breeze Homes")
  }

  section("G. topics — demand-gap evidence, never the topic bank")
  {
    const { suggestMarketReportTopics } = await import("../lib/market-reports/topics")
    const ZIP = { grain: "zip" as const, label: "32503", zip: "32503", city: null, state: null }
    const reads: string[] = []
    const base = memSupabase({ market_data: [{ id: "md-1", brokerage_id: B1, zip_code: "32503", data_date: "2026-11-01", source_type: "rentcast", median_sale_price: 455000, active_listings: 180, avg_days_on_market: 38, price_trend_pct_1yr: 3 }], market_trends: [], listings: [], content_topic_bank: [{ id: "t1", topic_title: "planted bank topic" }], market_dataset_verifications: [] })
    const rec = { ...base, from: (t: string) => { reads.push(t); return base.from(t) } }
    let prompt = ""
    const twin = async () => ({ brokerageId: B1, asOf: "2026-11-06", zips: [], marketGap: { monthsOfSupply: null, asOf: null, source: null, reason: "x" }, demandGap: { segments: [{ area: "32503", priceBand: "$300k–$500k", beds: "3+ bedrooms", consentedBuyers: 4, freshInventory: 1, undersupplied: true, attribution: "4 buyers working with Gulf Breeze Homes told us …", claimBoundary: "Never say a buyer has been found." }], suppressedSegments: 1, consentedBuyers: 5, staleInventoryExcluded: 2, freshInventory: 3 }, notes: [], blindSpots: [] })
    const r = await suggestMarketReportTopics(rec as never, { brokerageId: B1, territory: ZIP }, { now: NOW, twin: twin as never, rank: async (a) => { prompt = a.prompt; return { suggestions: [{ title: "Homes like yours are in demand in 32503", angle: "x", format: "inventory_watch", evidence_ids: ["demand:32503:$300k–$500k:3+_bedrooms"], why_now: "x" }] } } })
    check("the demand gap reaches the strategist as demand_gap evidence (counts, no identity)", /\(demand_gap\) 4 buyers working with Gulf Breeze Homes/.test(prompt), prompt.slice(0, 400))
    check("a demand_gap may CARRY a topic (a market fact)", r.suggestions.length === 1 && r.suggestions[0].by === "ai" && r.suggestions[0].evidence[0]?.kind === "demand_gap", JSON.stringify(r.suggestions))
    check("never the topic bank (the recorded client never read content_topic_bank)", !reads.includes("content_topic_bank") && !/planted bank topic/.test(prompt))
    check("the suppressed-segment count is said", r.notes.some((n) => /under the k-floor suppressed/.test(n)))
  }

  section("M. REI Playbook v5.5 — investor plays only, preview first, labelled heuristics")
  {
    const { investorPlay } = await import("../lib/investor/rei-playbook")
    const bb = investorPlay({ audience: "investor", play: "buy_box", overlay: "preforeclosure", arvTarget: 400000, zip: "32503" })
    const crit = bb.ok && bb.kind === "play" ? bb.preview.criteria : []
    const names = crit.map((c) => c.name)
    check("Buy Box + ONE overlay → PropertyRadar's confirmed names (PropertyType→PType SFR, isListedForSale 0, EquityPercent 30–100, YearBuilt 1980+, ForeclosureStage, ZipFive), each once", ["PropertyType", "isListedForSale", "EquityPercent", "YearBuilt", "ForeclosureStage", "ZipFive"].every((n) => names.filter((x) => x === n).length === 1) && JSON.stringify(crit).includes('"PType","value":["SFR"]'), JSON.stringify(crit))
    check("the value ceiling is ~80% of the ARV target (AVM ≤ 320,000) — only because the ARV was stated", JSON.stringify(crit.find((c) => c.name === "AVM")?.value) === "[[0,320000]]")
    const noArv = investorPlay({ audience: "investor", play: "buy_box" })
    check("no ARV → no AVM band, said (never an arbitrary range)", noArv.ok && noArv.kind === "play" && !noArv.preview.criteria.some((c) => c.name === "AVM") && noArv.unconfirmed.some((u) => /median single-family sale price/.test(u)))
    check("PREVIEW ONLY: purchase is 0 and the limit 1 on every play this module builds", [bb, noArv, investorPlay({ audience: "investor", play: "exit", exit: "cash_buyers" })].every((p) => p.ok && p.kind === "play" && p.preview.purchase === 0 && p.preview.limit === 1))
    check("criteria the reference does not confirm stay DISPLAY labels marked to verify (divorce)", (() => { const d = investorPlay({ audience: "investor", play: "buy_box", overlay: "divorce" }); return d.ok && d.kind === "play" && d.unconfirmed.includes("Divorce?: Yes") && !d.preview.criteria.some((c) => /divorce/i.test(c.name)) })())
    check("benchmarks + cycle are LABELLED historical heuristics; DistressScore ranks, never a probability", bb.ok && bb.kind === "play" && bb.heuristic === true && /historical planning heuristics/.test(bb.benchmarks.label) && /rank, never filter; never a probability/.test(bb.rank))
    const retail = investorPlay({ audience: "retail_seller", play: "buy_box" })
    check("a RETAIL seller is refused — no 30% equity floor, never a buy box", !retail.ok && /retail seller needs no 30% equity floor/.test(retail.reason))
    check("exit plays (cash buyers / flippers / trustee-sale investors) are investor-only and carry no equity floor", (() => { const e = investorPlay({ audience: "investor", play: "exit", exit: "trustee_sale_investors" }); return e.ok && e.kind === "play" && e.mode === "exit" && e.equityPercentMin === null && e.preview.criteria.some((c) => c.name === "ForeclosureStage") })())
    const mm = (n: number | null) => { const r = investorPlay({ audience: "market_mode", distressPreviewCount: n }); return r.ok && r.kind === "market_mode" ? r.marketMode : "x" }
    check("hunting vs farming from the distress preview count (8 → farming, 60 → hunting, none → unknown)", mm(8) === "farming" && mm(60) === "hunting" && mm(null) === "unknown")
    const { planSourceDiscovery } = await import("../lib/lead-pipeline/source-discovery-planner")
    const plan = planSourceDiscovery({ territory: { id: "m1", brokerageId: B1, label: "Pensacola, FL" }, budgetUsd: 100, history: {}, previews: { batchdata_cash_buyer: { count: 40, at: day(0), via: "preview" } } as never, quotes: {}, distressPreviewCount: 8 })
    const inv = plan.lines.find((l) => l.source === "batchdata_cash_buyer")
    check("the planner reads the playbook: investor line carries equityPercentMin 30 + the preview criteria; a retail seller line carries none; farming read", (inv?.criteria as any)?.equityPercentMin === 30 && (inv?.criteria as any)?.preview?.purchase === 0 && plan.lines.filter((l) => !l.plays.includes("investor_buy_box")).every((l) => l.criteria === null) && plan.marketMode === "farming")
    const pl = code("lib/lead-pipeline/source-discovery-planner.ts")
    check("no inline twin of the method remains in the planner (FARMING_DISTRESS_FLOOR / an equity literal)", !/FARMING_DISTRESS_FLOOR\s*=/.test(pl) && !/equityPercentMin:\s*30/.test(pl))
    check("no live PropertyRadar call / token in the playbook module", !/fetch\(|api\.propertyradar\.com|PROPERTYRADAR_API_TOKEN|purchase:\s*1/.test(code("lib/investor/rei-playbook.ts")))
  }

  section("W. wiring")
  {
    const mw = code("lib/buyer-search/market-watch.ts")
    check("market-watch reads every { error } (contact, listings, active feed, matches)", ["cErr", "lErr", "mErr", "eErr"].every((e) => new RegExp(`error: ${e}`).test(mw) && new RegExp(`if \\(${e}\\)`).test(mw)))
    const twinSrc = code("lib/market-reports/market-twin.ts")
    check("the twin never calls RentCast except through getRentcastMarketStats, and never writes a cache", /getRentcastMarketStats\(/.test(twinSrc) && !/callRentcastGet|api\.rentcast|setCachedProviderPayload|\.insert\(|\.upsert\(/.test(twinSrc))
    check("topics consumes the twin (one product consumer)", /loadMarketTwin\(/.test(code("lib/market-reports/topics.ts")))
  }

  console.log(`\nMARKET TWIN — ${passed} passed, ${failed} failed ${failed === 0 ? "✅ MARKET_TWIN_PASS" : "❌ MARKET_TWIN_FAIL"}`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
