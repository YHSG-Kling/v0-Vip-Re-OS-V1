#!/usr/bin/env tsx
/**
 * scripts/market-report-producer-guard.ts   (run: tsx scripts/market-report-producer-guard.ts — key to add: test:market-report-producer)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 147, LANE 147E — owner ruling 6 (2026-10-31: "Build the market report producer"). In memory, no network, no provider,
 * no model (every external is a seam; the pure halves run for real):
 *
 *   A. NO GENERIC TEXT — the validator passes a dated, sourced, territory-specific report and REFUSES (positive controls, one
 *      per rule): generic boilerplate, < 3 data, an undated / unsourced datum, a stale datum, an invented figure, a forecast
 *      stated as fact, a wrong "not available" label, an unnamed territory, an unresolved token, an undeclared comp basis.
 *   B. HONEST RESEARCH — RentCast's median is labelled an ASKING price (never "sold"); a zero-filled market_data column is
 *      UNAVAILABLE with the exact label; cma_aggregate (opinion) is excluded and said; a stale row is unavailable; fewer than 3
 *      closed sales is no median; ≥ 3 computes medians from the tenant's MLS records; a refused read is an ERROR (fail closed);
 *      the refresher runs only when nothing fresh is on record; tenant-pinned (another tenant's rows are invisible).
 *   C. THE TERRITORY GRAIN — street only with ≥ 3 comps, else ZIP, else city; resolution hint → farm territory → brokerage.
 *   D. THE PRODUCER — topic → research → narrative (tokens only) → fair housing → final phase → validator → C5 approver →
 *      branded asset under the action ledger → narrated video COMMISSIONED (staged, never published); a writer that types a
 *      figure / trips fair housing falls back to the data composer; insufficient data and a refused read refuse with nothing
 *      rendered; the real fair-housing scan passes the data composer's copy.
 *   E. TOPICS WITH EVIDENCE — from the topic bank + market rows; an invented evidence id is dropped; a suggestion with only
 *      invented ids is discarded (fallback said).
 *   F. EXPERT PROMPTS — role, context, facts-only rule, decision, output contract, compliance boundary, escalation.
 *   G. THE CHAIN — topic → research → verified report → branded asset → approval → form → Contact → promise → delivery →
 *      follow-up → attribution, on the real C11 deliverable + C4 ledger.
 *   H. WIRING (stripped source) — validator before render, the ledger action name, routed AI features, no vendor call from
 *      lib/market-reports, the market_data writer's two live refusals fixed.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"
import { formatDatumValue, unavailableLabel, type MarketReport, type MarketReportTerritory } from "../lib/market-reports/contract"
import { validateMarketReport, MIN_DATED_SOURCED_DATA } from "../lib/market-reports/validator"
import { researchMarket, chooseTerritoryGrain, resolveReportTerritory } from "../lib/market-reports/research"
import { MARKET_REPORT_WRITER_SYSTEM, MARKET_REPORT_TOPIC_SYSTEM, buildMarketReportWriterPrompt } from "../lib/market-reports/prompts"
import { suggestMarketReportTopics } from "../lib/market-reports/topics"
import { produceMarketReport, type ProducerDeps } from "../lib/market-reports/producer"
import { createLeadMagnet, publishLeadMagnet } from "../lib/kernel/lead-magnets"
import { recordPromisedDeliverable, deliverPromised } from "../lib/lead-magnets/promised-deliverables"

const ROOT = process.cwd()
const raw = (p: string) => readFileSync(join(ROOT, p), "utf8")
const code = (p: string) => stripComments(raw(p))
const codeNoStrings = (p: string) => blankStrings(stripComments(raw(p)))
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}
const section = (t: string) => console.log(`\n[${t}]`)

const B1 = "00000000-0000-4000-8000-0000000000b1", B2 = "00000000-0000-4000-8000-0000000000b2"
const AG = "00000000-0000-4000-8000-0000000000d1", U1 = "00000000-0000-4000-8000-0000000000a1", U2 = "00000000-0000-4000-8000-0000000000a2"
const C1 = "00000000-0000-4000-8000-0000000000c1"
const NOW = new Date("2026-10-31T12:00:00Z")
const TODAY = "2026-10-31"
const ZIP: MarketReportTerritory = { grain: "zip", label: "78704", zip: "78704", city: "Austin", state: "TX" }
const PDF = "https://cdn.example.com/client-docs/b1/market_report-1.pdf"

const rentcastRow = (over: Record<string, unknown> = {}) => ({ id: "md-1", brokerage_id: B1, market_area: "78704", zip_code: "78704", city: "Austin", state: "TX", data_date: "2026-10-20", source_type: "rentcast", active_listings: 214, new_listings_30d: 61, sold_listings_30d: 0, median_sale_price: 612000, avg_days_on_market: 44, list_to_sale_ratio: 0, months_of_inventory: 0, price_trend_pct_1yr: -2.4, ...over })
const sold = (i: number, over: Record<string, unknown> = {}) => ({ id: `l-${i}`, brokerage_id: B1, status: "sold", deleted_at: null, zip: "78704", city: "Austin", state: "TX", address: `${100 + i} Elm St`, sold_price: 580000 + i * 10000, sold_date: `2026-0${7 + (i % 3)}-1${i}`, list_price: 590000 + i * 10000, listing_date: `2026-0${6 + (i % 3)}-0${i + 1}`, bedrooms: 3, bathrooms: 2, sqft: 1800, ...over })

function world(extra: Record<string, any[]> = {}, opts: Parameters<typeof memSupabase>[1] = {}) {
  return memSupabase({
    market_data: [rentcastRow(), rentcastRow({ id: "md-other", brokerage_id: B2, median_sale_price: 999999 })],
    market_trends: [], listings: [sold(1), sold(2), sold(3), sold(4)],
    farm_territories: [], brokerages: [{ id: B1, city: "Austin", state: "TX", zip: "78704", name: "Elm Realty" }],
    agents: [{ id: AG, brokerage_id: B1, user_id: U1, is_active: true }],
    content_topic_bank: [], agent_action_ledger: [], generated_documents: [],
    ...extra,
  }, { uuidIds: true, ...opts })
}

/** A valid report for the validator matrix — produced by the REAL producer (research + the data composer; the model is off). */
async function goodReport(): Promise<MarketReport> {
  const r = await produceMarketReport(world() as never, { brokerageId: B1, agentUserId: U1, agentId: AG, actor: { type: "system" }, territory: ZIP, topic: { title: "78704 market snapshot", angle: null, evidenceIds: [] }, purpose: "proof" }, seams({ write: async () => { throw new Error("model off") } }).deps)
  if (!r.ok) throw new Error(`the good report was not produced: ${r.stage}: ${r.reason}`)
  return r.report
}

/** Every producer seam, recording calls. */
function seams(over: Partial<ProducerDeps> & { draft?: any } = {}) {
  const calls = { writes: 0, renders: [] as any[], videos: [] as any[], refreshes: 0, topics: 0 }
  const deps: ProducerDeps = {
    now: NOW,
    refreshMarketData: async () => { calls.refreshes++; return { source: "rentcast", success: true } },
    topics: async () => { calls.topics++; return { suggestions: [{ title: "78704: what your equity did", angle: "How asking prices moved this year", format: "equity_this_quarter", evidence: [{ id: "market:md-1", kind: "market_signal", summary: "asking prices down", observedAt: "2026-10-20", source: "market_data" }], whyNow: "prices moved", by: "ai" }], evidenceCount: 1, notes: [] } },
    write: async () => { calls.writes++; return { draft: over.draft ?? {
      insufficient_data: false, insufficient_reason: null,
      headline: "78704 asking prices: the median listing sits at {{median_asking_price}}",
      sections: [
        { heading: "Prices in 78704", body: "The median asking price in 78704 was {{median_asking_price}}, and it changed {{asking_price_yoy_pct}} from a year earlier.", datum_keys: ["median_asking_price", "asking_price_yoy_pct"] },
        { heading: "Supply and pace", body: "There are {{active_listings}} active listings and {{new_listings_30d}} new ones; listings average {{avg_days_on_market}} on market.", datum_keys: ["active_listings", "new_listings_30d", "avg_days_on_market"] },
      ],
      buyer_takeaways: ["Compare against the {{active_listings}} active listings before writing an offer."],
      seller_takeaways: ["Price against competing listings near {{median_asking_price}}."],
      call_to_action: "Ask for a street-level look at what sold near you.",
    }, tokens: 900, model: "claude-sonnet" } },
    fairHousing: async () => ({ ok: true, findings: [] }),
    finalize: async (a) => ({ ok: true, texts: a.texts, tagline: "Elm Realty — your neighbours in real estate" }),
    brand: async () => ({ brokerageName: "Elm Realty", agentName: "Ann Agent", licenseLine: "Lic #1 (TX)", primaryColor: "#1144aa" }),
    render: async (a) => { calls.renders.push(a); return { ok: true, pdfUrl: PDF, documentId: "doc-1", error: null } },
    approver: async () => ({ ok: true, permittedUserIds: [U1], primaryUserIds: [U1], basis: "owner", reason: "the agent approves their own asset" }),
    commissionVideo: async (a) => { calls.videos.push(a); return { ok: true, status: "staged", videoProjectId: "vid-1" } },
    ...over,
  }
  return { deps, calls }
}

async function main() {
  // ── A ────────────────────────────────────────────────────────────────────
  section("A. no generic text passes as a market report (validator, one positive control per rule)")
  const good = await goodReport()
  const vGood = validateMarketReport(good, { now: NOW })
  check("a dated, sourced, territory-specific report PASSES (written by the data composer when the model is off — specific, never filler)", vGood.ok && vGood.counts.datedSourced >= MIN_DATED_SOURCED_DATA && good.narrative.authoredBy === "data_template", JSON.stringify(vGood.refusals))
  const generic: MarketReport = { ...good, data: [], unavailable: [], narrative: { headline: "The market is changing", sections: [{ heading: "Market update", body: "Now is a great time to buy or sell. Contact me today!", datumKeys: [] }], buyerTakeaways: [], sellerTakeaways: [], callToAction: "Call me today", authoredBy: "ai" } }
  const vGen = validateMarketReport(generic, { now: NOW })
  check("POSITIVE CONTROL: generic boilerplate with no data is REFUSED (V1 + V3 + V4 + V7)", !vGen.ok && ["V1", "V3", "V4", "V7"].every((r) => vGen.refusals.some((x) => x.startsWith(r))), JSON.stringify(vGen.refusals))
  check("fewer than 3 dated, sourced data is refused (V1)", validateMarketReport({ ...good, data: good.data.slice(0, 2) }, { now: NOW }).refusals.some((r) => r.startsWith("V1 only 2")))
  check("an UNDATED datum is refused (V1)", validateMarketReport({ ...good, data: good.data.map((d, i) => (i === 0 ? { ...d, asOf: "last month" } : d)) }, { now: NOW }).refusals.some((r) => r.startsWith("V1 datum")))
  check("an UNSOURCED datum is refused (V1)", validateMarketReport({ ...good, data: good.data.map((d, i) => (i === 0 ? { ...d, source: { provider: "rentcast", dataset: "" } } : d)) as never }, { now: NOW }).refusals.some((r) => r.startsWith("V1 datum")))
  check("a STALE datum (over a year old) is refused (V2)", validateMarketReport({ ...good, data: good.data.map((d, i) => (i === 0 ? { ...d, asOf: "2025-06-01" } : d)) }, { now: NOW }).refusals.some((r) => r.startsWith("V2")))
  const invented = { ...good, narrative: { ...good.narrative, sections: [...good.narrative.sections, { heading: "Rates", body: `In 78704 the median asking price is ${formatDatumValue(good.data[0])} and mortgage rates are 6.8%.`, datumKeys: [good.data[0].key] }] } }
  check("an INVENTED figure is refused (V5 — '6.8%' is no sourced datum)", validateMarketReport(invented, { now: NOW }).refusals.some((r) => r.startsWith("V5") && r.includes("6.8%")))
  const forecast = { ...good, narrative: { ...good.narrative, sections: [{ ...good.narrative.sections[0], body: `${good.narrative.sections[0].body} Prices will rise next spring.` }, ...good.narrative.sections.slice(1)] } }
  check("a forecast stated as FACT is refused (V6)", validateMarketReport(forecast, { now: NOW }).refusals.some((r) => r.startsWith("V6")))
  check("a wrong 'not available' label is refused (V8)", validateMarketReport({ ...good, unavailable: [{ key: "monthly_trend", label: "Monthly trend", text: "N/A", reason: "x" }] }, { now: NOW }).refusals.some((r) => r.startsWith("V8")))
  check("the producer's own unavailable items carry the exact label: " + unavailableLabel("78704", TODAY), good.unavailable.length > 0 && good.unavailable.every((u) => u.text === unavailableLabel("78704", TODAY)) && vGood.ok)
  check("a report that never names its territory is refused (V4)", validateMarketReport({ ...good, narrative: { ...good.narrative, headline: "Local market", sections: good.narrative.sections.map((s) => ({ ...s, heading: "Section", body: s.body.split("78704").join("the area") })) } }, { now: NOW }).refusals.some((r) => r.startsWith("V4")))
  check("an unresolved {{token}} never reaches the reader (V11)", validateMarketReport({ ...good, narrative: { ...good.narrative, callToAction: "Ask about {{median_sold_price}}" } }, { now: NOW }).refusals.some((r) => r.startsWith("V11")))
  check("a comparable with no declared price basis is refused (V10)", validateMarketReport({ ...good, comparables: [{ address: "1 A St", price: 500000, priceBasis: "estimate" as never, date: "2026-09-01", source: { provider: "tenant_mls", dataset: "listings" } }] }, { now: NOW }).refusals.some((r) => r.startsWith("V10")))
  check("one fact, one state: a datum both available and unavailable is refused (V9)", validateMarketReport({ ...good, unavailable: [{ key: good.data[0].key, label: "x", text: unavailableLabel("78704", TODAY), reason: "x" }] }, { now: NOW }).refusals.some((r) => r.startsWith("V9")))

  // ── B ────────────────────────────────────────────────────────────────────
  section("B. honest research (labels, zeros, opinion excluded, freshness, medians, fail closed, tenant-pinned)")
  {
    const db = world()
    const r = await researchMarket(db as never, { brokerageId: B1, territory: ZIP }, seams().deps)
    const ask = r.data.find((d) => d.key === "median_asking_price")
    check("RentCast's median is an ASKING price — labelled so, never 'sold'", !!ask && /asking/i.test(ask.label) && !/sold/i.test(ask.label) && /LISTINGS/.test(ask.caveat ?? "") && ask.source.provider === "rentcast" && ask.asOf === "2026-10-20")
    check("tenant-pinned: another tenant's market row (999,999) is invisible", ask?.value === 612000)
    check("every datum is dated and sourced", r.data.length > 0 && r.data.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.asOf) && !!d.source.provider && !!d.source.dataset))
    check("4 closed sales → median sold price + count + days to sell + sale-to-list, computed from MLS records", ["median_sold_price", "closed_sales_count", "median_days_to_sell", "sale_to_list_ratio_pct"].every((k) => r.data.some((d) => d.key === k && d.basis === "computed_from_records" && d.source.provider === "tenant_mls")), JSON.stringify(r.data.map((d) => d.key)))
    check("comparables are recorded sales with a date and a source", r.comparables.length === 4 && r.comparables.every((c) => c.priceBasis === "recorded_sale" && /^\d{4}-\d{2}-\d{2}$/.test(c.date)))
    check("a fresh row → the refresher is NOT called", r.refreshed.attempted === false)
    check("fewer than 2 monthly snapshots → the trend is UNAVAILABLE with the exact label", r.unavailable.some((u) => u.key === "monthly_trend" && u.text === unavailableLabel("78704", TODAY)))
    const zeros = await researchMarket(world({ market_data: [rentcastRow({ active_listings: 0, price_trend_pct_1yr: 0 })] }) as never, { brokerageId: B1, territory: ZIP }, seams().deps)
    check("a ZERO-filled column (0 = unknown on this writer) is UNAVAILABLE, never a fact", !zeros.data.some((d) => d.key === "active_listings" || d.key === "asking_price_yoy_pct") && zeros.unavailable.some((u) => u.key === "active_listings" && u.text === unavailableLabel("78704", TODAY)))
    const stale = await researchMarket(world({ market_data: [rentcastRow({ data_date: "2026-05-01" })] }) as never, { brokerageId: B1, territory: ZIP }, { now: NOW, refreshMarketData: async () => ({ source: "none", success: false }) })
    const staleKeys = ["median_asking_price", "active_listings", "new_listings_30d", "avg_days_on_market", "asking_price_yoy_pct"]
    check("a reading older than 120 days is unavailable (with its date in the reason), even after a failed refresh", !stale.data.some((d) => staleKeys.includes(d.key)) && stale.unavailable.filter((u) => staleKeys.includes(u.key)).every((u) => /2026-05-01/.test(u.reason)) && stale.refreshed.attempted)
    const few = await researchMarket(world({ listings: [] }) as never, { brokerageId: B1, territory: ZIP }, seams().deps)
    check("0 closed sales → no median (said: 'only 0 closed sale(s)'), and no comparables (said)", !few.data.some((d) => d.key === "median_sold_price") && few.unavailable.some((u) => u.key === "median_sold_price" && /only 0/.test(u.reason)) && few.unavailable.some((u) => u.key === "comparable_sales"))
    const two = await researchMarket(world({ listings: [sold(1), sold(2)] }) as never, { brokerageId: B1, territory: ZIP }, seams().deps)
    check("2 closed sales → still no median (the floor is 3, the CMA survivor's own number) — but the 2 are shown as comparables", !two.data.some((d) => d.key === "median_sold_price") && two.comparables.length === 2)
  }
  {
    const db = world({ market_data: [rentcastRow({ id: "md-cma", source_type: "cma_aggregate", data_date: "2026-10-30" })] })
    let refreshed = 0
    const r = await researchMarket(db as never, { brokerageId: B1, territory: ZIP }, { now: NOW, refreshMarketData: async () => { refreshed++; return { source: "none", success: false } } })
    check("cma_aggregate (agents' CMA opinions) is EXCLUDED and said", r.notes.some((n) => /cma_aggregate/.test(n)) && !r.data.some((d) => d.key === "median_asking_price"))
    check("nothing fresh on record → the waterfall refresher runs once, its failure said", refreshed === 1 && r.refreshed.attempted && r.notes.some((n) => /refresh did not land/.test(n)))
  }
  {
    const db = world({}, { refuse: { listings: "permission denied for table listings" } })
    const r = await researchMarket(db as never, { brokerageId: B1, territory: ZIP }, seams().deps)
    check("a REFUSED read is an error (the producer fails closed), never 'no sales'", r.errors.some((e) => /listings/.test(e)))
  }

  // ── C ────────────────────────────────────────────────────────────────────
  section("C. the territory grain")
  check("an address with ≥ 3 comps → STREET", chooseTerritoryGrain({ address: "120 Elm St", zip: "78704" }, { streetComps: 4 }).territory?.grain === "street")
  check("an address with 2 comps → ZIP (said why)", (() => { const c = chooseTerritoryGrain({ address: "120 Elm St", zip: "78704" }, { streetComps: 2 }); return c.territory?.grain === "zip" && /too few comparables/.test(c.reason) })())
  check("city + state, no ZIP → CITY", chooseTerritoryGrain({ city: "Austin", state: "tx" }).territory?.label === "Austin, TX")
  check("nothing → no territory (refused upstream, never 'the area')", chooseTerritoryGrain({}).territory === null)
  {
    const farm = await resolveReportTerritory(world({ farm_territories: [{ id: "f1", brokerage_id: B1, is_active: true, name: "South", city: "Austin", state: "TX", zip_codes: ["78745"], agent_id: AG }] }) as never, { brokerageId: B1, agentId: AG })
    check("no hint → the agent's active FARM territory", farm.hint?.zip === "78745" && /farm_territory/.test(farm.basis))
    const br = await resolveReportTerritory(world() as never, { brokerageId: B1 })
    check("no farm → the brokerage's own address", br.hint?.zip === "78704" && br.basis === "brokerage_address")
    const refused = await resolveReportTerritory(world({}, { refuse: { farm_territories: "denied" } }) as never, { brokerageId: B1 })
    check("a refused territory read is an error, never a guess", !!refused.error && refused.hint === null)
  }

  // ── D ────────────────────────────────────────────────────────────────────
  section("D. the producer (topic → research → narrative → fair housing → final → validator → C5 → asset under the ledger → staged video)")
  {
    const db = world()
    const s = seams()
    const r = await produceMarketReport(db as never, { brokerageId: B1, agentUserId: U1, agentId: AG, actor: { type: "user", userId: U1 }, territory: ZIP, narrate: true, purpose: "on_request" }, s.deps)
    check("produced: ok, hosted https asset, document id", r.ok && r.assetUrl === PDF && r.documentId === "doc-1", r.ok ? "" : `${r.stage}: ${r.reason}`)
    if (r.ok) {
      check("the narrative is the WRITER's, every figure substituted from a sourced datum", r.report.narrative.authoredBy === "ai" && r.report.narrative.headline.includes("$612,000") && !/\{\{/.test(JSON.stringify(r.report.narrative)))
      check("the topic came from the evidence-backed suggestion (format chosen with it)", r.report.topic.evidenceIds.includes("market:md-1") && r.report.format === "equity_this_quarter" && s.calls.topics === 1)
      check("the validator's counts ride the result (data, sections, numbers checked)", r.validation.ok && r.validation.counts.numbersChecked > 0)
      check("C5: the approver decision is recorded with the report", r.approver.ok && r.approver.primaryUserIds[0] === U1)
      const ledger = (db.tables.agent_action_ledger ?? []).filter((x: any) => x.action === "marketing.market_report.produce")
      check("LAW 5: ONE ledger row marketing.market_report.produce, executed, provider ref = the document, cost rails named", ledger.length === 1 && ledger[0].status === "executed" && ledger[0].provider_ref === "doc-1" && JSON.stringify(ledger[0].detail ?? {}).includes("ai_tool_usage"), JSON.stringify(ledger[0] ?? {}))
      const spec = s.calls.renders[0]?.spec as any
      check("TENANT-BRANDED: brokerage + agent + licence on the document, the approved tagline, the EHO mark, the disclaimer", spec?.brand?.brokerageName === "Elm Realty" && spec?.brand?.agentName === "Ann Agent" && spec?.brand?.tagline?.includes("Elm Realty") && spec?.brand?.showEhoMark === true && /not an appraisal/.test(spec?.disclaimer ?? "") && /asking prices and listing counts, not closed sales/.test(spec?.disclaimer ?? ""))
      check("the snapshot table prints every datum with its source AND date", (spec?.sections ?? []).some((x: any) => x.heading === "Market snapshot" && x.table.rows.every((row: string[]) => /as of \d{4}-\d{2}-\d{2}/.test(row[2]))))
      check("'Not available yet' lists the unavailable facts with the exact label", (spec?.sections ?? []).some((x: any) => x.heading === "Not available yet" && x.bullets.every((b: string) => b.includes(unavailableLabel("78704", TODAY)))))
      check("the document carries the structured report (data + unavailable + validation) in its metadata", !!s.calls.renders[0]?.metadata?.market_report?.data?.length && s.calls.renders[0]?.metadata?.market_report?.validation?.datedSourced >= 3)
      check("NARRATED: a market_update video is COMMISSIONED (staged for approval) — never published here", r.video.status === "commissioned" && s.calls.videos.length === 1 && /staged/.test(r.video.reason ?? ""))
    }
  }
  {
    const s = seams({ draft: { insufficient_data: false, insufficient_reason: null, headline: "78704: prices up 12% with rates at 6.5%", sections: [{ heading: "Prices in 78704", body: "Homes in 78704 rose 12% this year.", datum_keys: [] }], buyer_takeaways: [], seller_takeaways: [], call_to_action: "Call me" } })
    const r = await produceMarketReport(world() as never, { brokerageId: B1, agentUserId: U1, agentId: AG, actor: { type: "system" }, territory: ZIP, purpose: "on_request" }, s.deps)
    check("POSITIVE CONTROL: a writer that TYPES figures (12%, 6.5%) is refused — the data composer writes it, no invented figure ships", r.ok && r.report.narrative.authoredBy === "data_template" && !/12%|6\.5%/.test(JSON.stringify(r.report.narrative)) && r.notes.some((n) => /refused by the validator/.test(n)), r.ok ? JSON.stringify(r.notes) : r.reason)
  }
  {
    let fhCalls = 0
    const s = seams({ fairHousing: async (t) => { fhCalls++; return /neighbour|listing/i.test(t) && fhCalls === 1 ? { ok: false, findings: ["family-friendly — describe the home"] } : { ok: true, findings: [] } } })
    const r = await produceMarketReport(world() as never, { brokerageId: B1, agentUserId: U1, agentId: AG, actor: { type: "system" }, territory: ZIP, purpose: "on_request" }, s.deps)
    check("fair housing holds the writer's draft → the data composer (FH-safe by construction) writes it", r.ok && r.report.narrative.authoredBy === "data_template" && fhCalls === 2)
  }
  {
    const s = seams()
    const thin = world({ market_data: [rentcastRow({ active_listings: 0, new_listings_30d: 0, avg_days_on_market: 0, price_trend_pct_1yr: 0 })], listings: [] })
    const r = await produceMarketReport(thin as never, { brokerageId: B1, agentUserId: U1, agentId: AG, actor: { type: "system" }, territory: ZIP, purpose: "on_request" }, s.deps)
    check("ONE datum is not a market report → refused at VALIDATION (V1), nothing rendered, the writer not even asked", !r.ok && r.stage === "validation" && /V1/.test(r.reason) && s.calls.renders.length === 0 && s.calls.writes === 0, r.ok ? "produced" : r.reason)
  }
  {
    const s = seams()
    const r = await produceMarketReport(world({}, { refuse: { market_data: "permission denied" } }) as never, { brokerageId: B1, actor: { type: "system" }, territory: ZIP, purpose: "on_request" }, s.deps)
    check("a refused read → refused at RESEARCH, nothing rendered (fail closed)", !r.ok && r.stage === "research" && s.calls.renders.length === 0)
  }
  {
    const s = seams({ render: async () => ({ ok: false, pdfUrl: null, documentId: null, error: "storage down" }) })
    const db = world()
    const r = await produceMarketReport(db as never, { brokerageId: B1, agentUserId: U1, agentId: AG, actor: { type: "system" }, territory: ZIP, purpose: "on_request" }, s.deps)
    const row = (db.tables.agent_action_ledger ?? []).find((x: any) => x.action === "marketing.market_report.produce")
    check("a render failure is a failed ledger row and a refusal — never 'produced'", !r.ok && r.stage === "render" && row?.status === "failed")
  }
  {
    // The REAL fair-housing scan + the REAL data composer (no seam on either).
    const { fairHousing: _f, ...rest } = seams({ write: async () => { throw new Error("gateway down") } }).deps
    const r = await produceMarketReport(world() as never, { brokerageId: B1, agentUserId: U1, agentId: AG, actor: { type: "system" }, territory: ZIP, purpose: "on_request" }, rest)
    check("the REAL fair-housing scan passes the data composer's copy (model down → still a sourced report)", r.ok && r.report.narrative.authoredBy === "data_template" && r.notes.some((n) => /writer was unavailable/.test(n)), r.ok ? "" : r.reason)
  }

  // ── E ────────────────────────────────────────────────────────────────────
  section("E. topic suggestions carry their evidence")
  {
    const bank = [
      { id: "t1", brokerage_id: B1, status: "fresh", expires_at: "2026-12-01T00:00:00Z", scraped_at: "2026-10-28T00:00:00Z", topic_title: "Is now a good time to sell?", value_angle: "timing", raw_data: { topic_evidence: { source_class: "customer_questions", source: "communications", observed_at: "2026-10-27" } } },
      { id: "t2", brokerage_id: B1, status: "fresh", expires_at: "2026-12-01T00:00:00Z", scraped_at: "2026-10-26T00:00:00Z", topic_title: "Price-drop posts", value_angle: null, raw_data: { topic_evidence: { source_class: "competitor_posts", source: "competitor_content", observed_at: "2026-10-25" } } },
      { id: "t3", brokerage_id: B2, status: "fresh", expires_at: "2026-12-01T00:00:00Z", scraped_at: "2026-10-26T00:00:00Z", topic_title: "Other tenant", value_angle: null, raw_data: { topic_evidence: { source_class: "customer_questions" } } },
    ]
    let prompt = ""
    const r = await suggestMarketReportTopics(world({ content_topic_bank: bank }) as never, { brokerageId: B1, territory: ZIP }, {
      now: NOW,
      rank: async (a) => { prompt = a.prompt; return { suggestions: [
        { title: "When to sell in 78704", angle: "a seller's timing question", format: "equity_this_quarter", evidence_ids: ["topic:t1", "market:md-1", "topic:INVENTED"], why_now: "asked and moving" },
        { title: "Made up", angle: "x", format: "inventory_watch", evidence_ids: ["topic:NOPE"], why_now: "x" },
      ] } },
    })
    check("evidence gathered from the topic bank (audience question + competitor theme) and the market rows, tenant-pinned", prompt.includes("[topic:t1] (audience_question)") && prompt.includes("[topic:t2] (competitor_theme)") && prompt.includes("[market:md-1] (market_signal)") && !prompt.includes("Other tenant"))
    check("each suggestion carries its REAL evidence; an invented id is dropped and said", r.suggestions.length === 1 && r.suggestions[0].evidence.map((e) => e.id).join(",") === "topic:t1,market:md-1" && r.notes.some((n) => /invented/.test(n)))
    check("a suggestion citing only invented evidence is discarded", !r.suggestions.some((x) => x.title === "Made up"))
    const none = await suggestMarketReportTopics(world({ market_data: [] }) as never, { brokerageId: B1, territory: ZIP }, { now: NOW, rank: async () => { throw new Error("should not be asked") } })
    check("no evidence → the fallback snapshot, said (the model is not asked)", none.suggestions[0].by === "fallback" && none.notes.some((n) => /no evidence/.test(n)))
  }

  // ── F ────────────────────────────────────────────────────────────────────
  section("F. expert, structured prompts (preamble: prompt quality is a deliverable)")
  for (const [name, p] of [["writer", MARKET_REPORT_WRITER_SYSTEM], ["topic strategist", MARKET_REPORT_TOPIC_SYSTEM]] as const) {
    check(`${name}: ROLE · BUSINESS CONTEXT · FACTS · DECISION · OUTPUT CONTRACT · COMPLIANCE BOUNDARY · ESCALATION`, ["ROLE", "BUSINESS CONTEXT", "FACTS YOU MAY RELY ON", "DECISION YOU OWN", "OUTPUT CONTRACT", "COMPLIANCE BOUNDARY", "ESCALATION RULE"].every((h) => p.includes(h)))
  }
  check("writer: figures ONLY as {{tokens}}; asking ≠ sold; no school / demographic / steering; no forecast as fact", /Never type a\s+number/.test(MARKET_REPORT_WRITER_SYSTEM) && /Asking prices are LISTING statistics/.test(MARKET_REPORT_WRITER_SYSTEM) && /school quality/.test(MARKET_REPORT_WRITER_SYSTEM) && /forecasts stated as fact/.test(MARKET_REPORT_WRITER_SYSTEM))
  {
    const p = buildMarketReportWriterPrompt({ territory: ZIP, asOf: TODAY, topic: { title: "t", angle: null, evidenceIds: [] }, format: "territory_snapshot", brandName: "Elm Realty", data: good.data, unavailable: good.unavailable, comparables: [] })
    check("the fact table hands every datum WITH its source and date, and the unavailable list with its label", good.data.every((d) => p.includes(`{{${d.key}}}`)) && p.includes("as of 2026-10-20") && p.includes("NOT AVAILABLE"))
  }

  // ── G ────────────────────────────────────────────────────────────────────
  section("G. the chain: topic → research → verified report → branded asset → approval → form → Contact → promise → delivery → follow-up → attribution")
  {
    const FORM_SETTINGS = { market_report: { territory: { zip: "78704", city: "Austin", state: "TX" } } }
    const db = world({ lead_capture_forms: [], lead_magnet_deliverables: [], lead_magnet_promises: [], contacts: [{ id: C1, brokerage_id: B1, email: "rae@reader.test", first_name: "Rae", has_login: false, city: "Austin" }], activities: [], transparency_updates: [], manager_signals: [], lifecycle_events: [] })
    const s = seams()
    const created = await createLeadMagnet({ title: "78704 market report", description: "", magnetType: "market_report", brokerageId: B1, agentId: AG, createdBy: U1, publishState: "draft", settings: FORM_SETTINGS }, { client: db as never, deliverable: { now: NOW, report: s.deps } })
    const d = (db.tables.lead_magnet_deliverables ?? [])[0]
    check("FORM + ITS DELIVERABLE in one create: the report produced, validated and READY with the magnet", created.success && created.deliverable?.status === "ready" && d?.kind === "report" && d?.asset_url === PDF && d?.validation?.ok === true && d?.payload?.topic_evidence?.length === 1, JSON.stringify(created))
    const pub = await publishLeadMagnet({ magnetId: created.magnetId!, brokerageId: B1, channels: ["landing_page"], actorUserId: U1, baseUrl: "https://app.example.com" }, { client: db as never })
    const d2 = (db.tables.lead_magnet_deliverables ?? [])[0]
    check("APPROVAL (C5): the owner agent publishes; the approval lands on the deliverable", pub.success && d2?.approved_by === U1 && d2?.approver?.basis === "owner", pub.error)
    // Contact (C8 — lane A's consented-intake survivor creates it; the capture is lib/kernel/lead-magnets.ts captureFormSubmission today).
    const promise = await recordPromisedDeliverable(db as never, { brokerageId: B1, formId: created.magnetId!, submissionId: "00000000-0000-4000-8000-000000005001", contactId: C1, campaignId: "camp-1", attribution: { utm_source: "meta" }, magnetType: "market_report", tcpaConsentGiven: true, now: NOW })
    const prow = (db.tables.lead_magnet_promises ?? [])[0]
    check("PROMISE recorded against the READY deliverable (id + version on asset_ref) with campaign + attribution", promise.ok && promise.promised && prow?.asset_ref?.deliverable_id === d.id && prow?.campaign_id === "camp-1")
    const emails: any[] = [], acts: any[] = []
    const del = await deliverPromised(db as never, { brokerageId: B1, promiseId: prow.id }, { now: NOW, prepare: async () => { throw new Error("a per-person render must not run") }, sendEmail: async (p) => { emails.push(p); return { success: true, providerKey: "sendgrid", messageId: "m-1" } }, recordActivity: async (a) => { acts.push(a); return { ok: true } }, finalize: async (a) => ({ ok: true, text: a.text }), publishSignal: async () => ({ ok: true }) })
    check("DELIVERY of THE report (no per-person render), via the governed email, with the report link", del.ok && del.status === "delivered" && emails.length === 1 && emails[0].text.includes(PDF), JSON.stringify(del))
    if (del.ok && del.status === "delivered") {
      check("EVIDENCE closes the chain: deliverable + version + approver, recipient, source campaign + attribution", (del.evidence as any).deliverable?.id === d.id && (del.evidence as any).deliverable?.approved_by === U1 && (del.evidence as any).recipient?.contact_id === C1 && (del.evidence as any).source?.campaign_id === "camp-1" && (del.evidence as any).source?.attribution?.utm_source === "meta")
    }
    check("FOLLOW-UP: the AI ISA's timeline line (lead_magnet_delivered) is written ONCE, only after the verified delivery", acts.length === 1 && (db.tables.lead_magnet_promises ?? [])[0]?.status === "delivered")
  }

  // ── H ────────────────────────────────────────────────────────────────────
  section("H. wiring (stripped source)")
  const prod = code("lib/market-reports/producer.ts")
  check("the validator runs BEFORE anything is rendered", prod.indexOf("validateMarketReport(report") > 0 && prod.indexOf("validateMarketReport(report") < prod.indexOf("withActionLedger<"))
  check("the asset is produced under withActionLedger('marketing.market_report.produce')", /withActionLedger<[\s\S]*?action:\s*"marketing\.market_report\.produce"/.test(prod))
  check("routed AI only: the writer is feature 'market_report', the strategist 'market_insight_narrative' (both book ai_tool_usage)", /feature:\s*"market_report"/.test(prod) && /feature:\s*"market_insight_narrative"/.test(code("lib/market-reports/topics.ts")))
  const mrDir = ["contract", "validator", "prompts", "research", "topics", "producer"].map((f) => codeNoStrings(`lib/market-reports/${f}.ts`)).join("\n")
  check("LAW 3: no vendor call from lib/market-reports (no RentCast / BatchData client) — only the refresher + the CMA comps survivor", !/getRentcast\w*\(|fetchBatchData\w*\(|callRentcastGet\(/.test(mrDir) && /refreshMarketData/.test(code("lib/market-reports/research.ts")) && /sourceCompsForCma/.test(code("lib/market-reports/research.ts")))
  check("positive control: the same scan DOES see a planted vendor call", /getRentcast\w*\(/.test(mrDir + "\ngetRentcastAVM({})"))
  check("fair housing on the public copy: scanPublicCopy(…, 'lead_magnet')", /scanPublicCopy\(text,\s*"lead_magnet"\)/.test(prod))
  check("the narrated version goes through commissionVideo (staged) — no publish call in the producer", /commissionVideo\(/.test(prod) && !/queueYouTubeAutoPublish|publishVideoProjectLanding|approveStagedVideo/.test(prod))
  const mig = code("lib/intelligence/market-insight-generator.ts")
  check("market_data writer: the CHECK's vocabulary ('sellers'/'buyers'), no 'seller' / 'buyer' literal", /'sellers'/.test(mig) && /'buyers'/.test(mig) && !/'seller'|'buyer'/.test(mig))
  check("market_data writer: no onConflict on market_data (no matching unique constraint live) and a refused write returns success: false", !/from\('market_data'\)\.upsert/.test(mig) && /write refused[\s\S]{0,80}success: false/.test(mig))

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  console.log("\nBlind spots (published beside the number):")
  for (const b of [
    "every provider is a seam here: RentCast / the refresher / the CMA comps survivor / storage / the gateway are proven by their own proofs (test:provider-cost-routing, test:connector-gateway, test:asset-production); live market_data had 0 rows 2026-10-31",
    "a market_data 0 is read as UNKNOWN — a true 0.0% year-over-year change is therefore reported as not available (the writer cannot tell them apart)",
    "RentCast /markets dates: the row is dated by retrieval (refreshMarketData drops RentCast's lastUpdatedDate) — the caveat says so",
    "the closed-sale sample is this brokerage's MLS-synced listings, not every sale in the territory — the caveat says so on every computed figure",
    "the real humanize final phase runs on the deliverable path only through its own proof (test:content-distribution); here it is a seam",
    "the narrated video's render + staging are proven by test:video-pipeline-truth; this proof sees the commission only",
  ]) console.log(`  · ${b}`)
  if (failed) { console.log("\nFAILURES:"); for (const f of failures) console.log(`  - ${f}`); console.log("\n❌ MARKET_REPORT_PRODUCER_FAIL"); process.exit(1) }
  console.log("\n✅ MARKET_REPORT_PRODUCER_PASS — every market report is territory-specific, built from dated, sourced data, honest about what is unavailable, fair-housing checked, branded, approved and ledgered; generic text is refused")
}

main().catch((e) => { console.error(e); process.exit(1) })
