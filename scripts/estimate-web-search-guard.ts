#!/usr/bin/env tsx
/**
 * scripts/estimate-web-search-guard.ts   (npm run test:estimate-web-search)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 83, LANE 83C — owner verbatim: "since we can't use the screenshots for
 * the real estate sites showing the homes value except for zillow for
 * marketing campaigns, we should use ai to search the internet for the
 * property and what realtor.com, homes.com and redfin [show]."
 *
 * Proves lib/marketing/estimate-web-search.ts — the RULE, each absence with a
 * positive control:
 *   1. VOCABULARY — the web-searched sources are DERIVED (evidenceVia), the
 *      three portals, each with the names its figure goes by.
 *   2. TERRITORY — only a territory property is searched: own listing, a
 *      territory ZIP, or city + state; outside / unplaceable / not a street
 *      address refuses (fail closed); an in-territory address passes (control).
 *   3. SUBJECT PAGE — only the portal page whose URL/title carries the house
 *      number + street word is read (neighbour, off-host, generic pages never).
 *   4. VERIFY — the model is never trusted: the figure must be printed on the
 *      page, the quote verbatim and carrying it; a list/sold price, a
 *      neighbour's address, a hallucinated figure, the tail of a longer number
 *      are refused; a faithful extraction passes (control).
 *   5. ONE PORTAL — search through dispatchWebSearch (purpose
 *      estimate_comparison, the portal host only, the session tenant), extract
 *      through the routed rail, found / not_found / refused kept distinct.
 *   6. STAGE — territory refusal searches nothing; every staged row is a
 *      PENDING snippet with no pixels, source URL + dates, comparison-only,
 *      customer_facing_value:false; idempotent per portal; the typed fallback
 *      lands pending with its figure confirmed by the person who typed it.
 *   7. COMPOSER SEES IT — listComparisonEvidence maps an approved web figure to
 *      a confirmed figure and a pending one to none.
 *   8. DOORS + RAILS — dispatchWebSearch refuses a tenant-less / keyless call
 *      without the network; the routing table names the extraction feature;
 *      the module calls generateObjectRouted with feature + brokerageId and
 *      never a screenshot entry.
 *
 * Fixtures are shaped on real Exa results (2026-09-26 research: realtor.com's
 * RealEstimate panel lists up to three providers plus NEIGHBOUR rows — the
 * reason step 3 and the address check exist).
 *
 * No network, no browser, no DB, no model (injected stubs).
 * Run: npx tsx --conditions=react-server scripts/estimate-web-search-guard.ts
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments, blankStrings } from "./strip-comments"
import { COMPARISON_ESTIMATE_SOURCES, comparisonEstimateSource } from "../lib/marketing/estimate-sources"
import {
  WEB_SEARCH_ESTIMATE_SOURCES, ESTIMATE_WEB_FIGURE_KIND, parseAddressGeo, addressInTerritory, pickSubjectPage, excerptForExtraction,
  verifyExtraction, figureLabelDetail, estimateSearchRequest, searchPortalEstimate, stageWebEstimateFigures, recordTypedComparisonFigure,
  type FigureExtraction, type SearchHit,
} from "../lib/marketing/estimate-web-search"
import { listComparisonEvidence, planComparisonCards } from "../lib/marketing/estimate-comparison"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const stripped = (p: string) => stripComments(readFileSync(join(root, p), "utf8"))
const TENANT = "33333333-3333-4333-8333-333333333333"

// ── Fixtures (shaped on real Exa output) ─────────────────────────────────────
const SUBJECT = "2016 Main St, Houston, TX 77002"
const realtor = comparisonEstimateSource("realtor_estimate")!
const redfin = comparisonEstimateSource("redfin_estimate")!
const REALTOR_URL = "https://www.realtor.com/realestateandhomes-detail/2016-Main-St-Apt-PH6_Houston_TX_77002_M85468-04114"
const REALTOR_TEXT = [
  "## Home value", "## RealEstimate℠", "Current list price$399,900", "### May 2026",
  "| Valuation provider | Estimate |", "| --- | --- |", "| Collateral Analytics | - |", "| Cotality™ | $398,600 |", "| Quantarium | $396,804 |",
  "The estimate(s) shown, which come from one or more automated valuation model providers independent of Realtor.com®, represent information that may provide a helpful starting point for discussions with a real estate agent.",
  "| Address | RealEstimate℠ | Bed | Bath | Sqft |", "| 2016 Main St Apt 1513, Houston, TX 77002 | $171,113 | 1 | 1 | 809 |",
  "| 1234 Main St, Houston, TX 77002 | $1,398,600 | 5 | 4 | 3100 |",
].join("\n")
const realtorHit: SearchHit = { url: REALTOR_URL, title: "2016 Main St Apt Ph 6, Houston, TX 77002", text: REALTOR_TEXT, highlights: null, publishedDate: null }
const neighbourHit: SearchHit = { url: "https://www.realtor.com/realestateandhomes-detail/1234-Main-St_Houston_TX_77002_M1", title: "1234 Main St, Houston, TX 77002", text: "RealEstimate $500,000" }
const offHostHit: SearchHit = { url: "https://www.highrises.com/realestateandhomes-detail/2016-Main-St_Houston_TX_77002_M2", title: "2016 Main St", text: "Real Estimate $272,200" }
const genericHit: SearchHit = { url: "https://www.realtor.com/estimates/", title: "RealEstimate Valuation Information", text: "Now you can estimate a home's value" }
const faithful: FigureExtraction = { found: true, figureUsd: 398600, figureLabel: "Cotality™", asOfText: "May 2026", subjectAddressOnPage: "2016 Main St Apt Ph 6, Houston, TX 77002", evidenceQuote: "| Cotality™ | $398,600 |" }

type Rec = { table: string; op: string; preds: Array<[string, unknown]>; row?: Record<string, unknown> }
function makeSvc(data: Record<string, Array<Record<string, unknown>>> = {}, opts: { refuse?: string } = {}) {
  const log: Rec[] = []
  const inserted: Array<Record<string, unknown>> = []
  const from = (table: string) => {
    const rec: Rec = { table, op: "select", preds: [] }
    log.push(rec)
    const q: any = {}
    for (const m of ["select", "order", "limit", "not", "in", "or", "gte", "neq", "is"]) q[m] = () => q
    q.eq = (k: string, v: unknown) => { rec.preds.push([k, v]); return q }
    q.ilike = (k: string, v: unknown) => { rec.preds.push([`ilike:${k}`, v]); return q }
    q.insert = (row: Record<string, unknown>) => { rec.op = "insert"; rec.row = row; inserted.push(row); return q }
    q.single = async () => ({ data: { id: `ins-${inserted.length}` }, error: null })
    q.maybeSingle = async () => ({ data: null, error: null })
    q.then = (res: any, rej: any) => {
      if (opts.refuse === table) return Promise.resolve({ data: null, error: { message: `${table} refused` } }).then(res, rej)
      const assetType = rec.preds.find(([k]) => k === "asset_type")?.[1]
      const rows = (data[table] ?? []).filter((r) => assetType == null || r.asset_type === assetType)
      return Promise.resolve({ data: rows, error: null }).then(res, rej)
    }
    return q
  }
  return { log, inserted, from }
}
const TERRITORY_DATA = { lead_scraping_markets: [{ city: "Houston", state: "TX", zip_codes: ["77002", "77003"] }], farm_territories: [], listings: [] }

async function main() {
  console.log("\n[1 · vocabulary — the web-searched sources are derived]")
  check("WEB_SEARCH_ESTIMATE_SOURCES = the vocabulary's evidenceVia:web_search rows = realtor + redfin + homes", WEB_SEARCH_ESTIMATE_SOURCES.map((s) => s.key).join() === COMPARISON_ESTIMATE_SOURCES.filter((s) => s.evidenceVia === "web_search").map((s) => s.key).join() && WEB_SEARCH_ESTIMATE_SOURCES.map((s) => s.host).sort().join() === "homes.com,realtor.com,redfin.com")
  check("each carries the names its figure goes by, and the Zestimate is NOT web-searched (it is the campaign still)", WEB_SEARCH_ESTIMATE_SOURCES.every((s) => s.estimateNames.length > 0) && !WEB_SEARCH_ESTIMATE_SOURCES.some((s) => s.key === "zillow_zestimate"))
  const req = estimateSearchRequest("  2016  Main St, Houston, TX 77002 ", realtor)
  check("the search is the address + the portal's own figure name, restricted to the portal host", req.query === "2016 Main St, Houston, TX 77002 RealEstimate home value" && req.includeDomains.join() === "realtor.com")

  console.log("\n[2 · territory — only a territory property is searched (fail closed)]")
  const g = parseAddressGeo("123 N Main St, Austin, TX 78701")
  check("parseAddressGeo: 123 / main (directional skipped) / austin / TX / 78701", g.houseNumber === "123" && g.streetWord === "main" && g.city === "austin" && g.state === "TX" && g.zip === "78701")
  const terr = [{ city: "Houston", state: "TX", zip_codes: ["77002"] }]
  check("POSITIVE CONTROL: an address in a territory ZIP passes (basis territory_zip)", (() => { const r = addressInTerritory(SUBJECT, terr); return r.ok && r.basis === "territory_zip" })())
  check("an address in the territory city + state (no ZIP) passes (basis territory_city)", (() => { const r = addressInTerritory("2016 Main St, Houston, TX", [{ city: "Houston", state: "TX", zip_codes: [] }]); return r.ok && r.basis === "territory_city" })())
  check("the tenant's own listing passes even outside every territory (basis listing)", (() => { const r = addressInTerritory("77 Oak Ave, Dallas, TX 75201", terr, [{ address: "77 Oak Ave", city: "Dallas", state: "TX", zip: "75201" }]); return r.ok && r.basis === "listing" })())
  check("an address OUTSIDE every territory is refused", (() => { const r = addressInTerritory("5 Elm St, Dallas, TX 75201", terr); return !r.ok && /outside every territory/.test(r.reason) })())
  check("an address with no ZIP and no city + state is refused (cannot be placed — never 'checked and inside')", (() => { const r = addressInTerritory("5 Elm St", terr); return !r.ok && /cannot be placed/.test(r.reason) })())
  check("a non-street address (no house number) is refused", !addressInTerritory("Main St, Houston, TX 77002", terr).ok)
  check("no territories at all → every address refused (fail closed)", !addressInTerritory(SUBJECT, []).ok)

  console.log("\n[3 · the subject page — never a neighbour's, never off-host, never a generic page]")
  check("POSITIVE CONTROL: the realtor.com detail page for 2016 Main St is picked out of a mixed result list", pickSubjectPage([genericHit, neighbourHit, offHostHit, realtorHit], SUBJECT, "realtor.com")?.url === REALTOR_URL)
  check("a neighbour's page (1234 Main St), an off-host page (highrises.com) and the generic estimates page are never picked", pickSubjectPage([genericHit, neighbourHit, offHostHit], SUBJECT, "realtor.com") === null)
  const ex = excerptForExtraction(realtorHit, realtor)
  check("the excerpt is a bounded window that holds the portal's figure block", ex.includes("RealEstimate") && ex.includes("$398,600") && ex.length <= 9000)

  console.log("\n[4 · verify — the model is never trusted on its own]")
  const ok = verifyExtraction(ex, faithful, SUBJECT, realtor)
  check("POSITIVE CONTROL: a faithful extraction (figure printed, quote verbatim) passes → 398,600", ok.ok && ok.figureUsd === 398600)
  check("a HALLUCINATED figure (not printed on the page) is refused", !verifyExtraction(ex, { ...faithful, figureUsd: 402000, evidenceQuote: "| Cotality™ | $402,000 |" }, SUBJECT, realtor).ok)
  check("a quote that is NOT verbatim is refused even when the figure is on the page", (() => { const v = verifyExtraction(ex, { ...faithful, evidenceQuote: "Cotality says the home is worth $398,600" }, SUBJECT, realtor); return !v.ok && /verbatim/.test(v.reason) })())
  check("the TAIL of a longer number ($1,398,600 → 398,600) is never read as the figure", (() => { const page = "| 1234 Main St | $1,398,600 |"; const v = verifyExtraction(page, { ...faithful, evidenceQuote: "$1,398,600 |" }, SUBJECT, realtor); return !v.ok })())
  check("a LIST PRICE quote is refused (a price is not the site's estimate)", (() => { const page = "Listed for $399,900 · 3 beds"; const v = verifyExtraction(page, { ...faithful, figureUsd: 399900, figureLabel: "list price", evidenceQuote: "Listed for $399,900" }, SUBJECT, realtor); return !v.ok && /price/.test(v.reason) })())
  check("a NEIGHBOUR's figure (the page's subject address is another house number) is refused", (() => { const page = "Redfin Estimate for 1240 Main St: $512,000"; const v = verifyExtraction(page, { found: true, figureUsd: 512000, figureLabel: "Redfin Estimate", asOfText: null, subjectAddressOnPage: "1240 Main St", evidenceQuote: "Redfin Estimate for 1240 Main St: $512,000" }, SUBJECT, redfin); return !v.ok && /is not/.test(v.reason) })())
  check("found:false and an out-of-band figure are refused", !verifyExtraction(ex, { ...faithful, found: false }, SUBJECT, realtor).ok && !verifyExtraction("$500", { ...faithful, figureUsd: 500, evidenceQuote: "$500" }, SUBJECT, realtor).ok)
  check("the card detail is a plain provider name (glyph stripped) and never repeats the portal's own name", figureLabelDetail("Cotality™", realtor) === "Cotality" && figureLabelDetail("RealEstimate℠", realtor) === null && figureLabelDetail("Redfin Estimate", redfin) === null)

  console.log("\n[5 · one portal — dispatchWebSearch → subject page → routed extraction → verify]")
  {
    const calls: any[] = []
    const search = async (p: any) => { calls.push(p); return { ok: true, provider: "exa" as const, results: [neighbourHit, realtorHit] as any, costUsd: 0.007, reason: "2 result(s)" } }
    const extractCalls: any[] = []
    const extract = async (a: any) => { extractCalls.push(a); return faithful }
    const f = await searchPortalEstimate({ brokerageId: TENANT, userId: "u1", address: SUBJECT, source: "realtor_estimate" }, { search, extract, now: new Date("2026-09-26T12:00:00Z") })
    check("the search rides dispatchWebSearch with the SESSION tenant, purpose estimate_comparison, the portal host only", calls.length === 1 && calls[0].brokerageId === TENANT && calls[0].purpose === "estimate_comparison" && calls[0].includeDomains.join() === "realtor.com")
    check("found: the figure, its source URL, the as-of text, a verbatim quote and the retrieval time come back; the extractor got the tenant + the facts-only system prompt", f.state === "found" && f.figureUsd === 398600 && f.sourceUrl === REALTOR_URL && f.asOfText === "May 2026" && f.retrievedAt === "2026-09-26T12:00:00.000Z" && f.labelDetail === "Cotality" && extractCalls[0]?.brokerageId === TENANT && /FACTS ONLY/.test(extractCalls[0]?.system ?? ""))
    const nf = await searchPortalEstimate({ brokerageId: TENANT, userId: null, address: SUBJECT, source: "realtor_estimate" }, { search: async () => ({ ok: true, provider: "exa" as const, results: [neighbourHit] as any, costUsd: 0.007, reason: "" }), extract })
    check("no subject page → not_found (the typed fallback), the extractor never called for a neighbour", nf.state === "not_found" && extractCalls.length === 1)
    const bad = await searchPortalEstimate({ brokerageId: TENANT, userId: null, address: SUBJECT, source: "realtor_estimate" }, { search, extract: async () => ({ ...faithful, figureUsd: 402000 }) })
    check("an extraction that fails verification → not_found (never staged)", bad.state === "not_found")
    const down = await searchPortalEstimate({ brokerageId: TENANT, userId: null, address: SUBJECT, source: "realtor_estimate" }, { search, extract: async () => { throw new Error("model unavailable") } })
    const refused = await searchPortalEstimate({ brokerageId: TENANT, userId: null, address: SUBJECT, source: "realtor_estimate" }, { search: async () => ({ ok: false, provider: "none" as const, results: [], costUsd: 0, reason: "Exa not configured" }), extract })
    check("a model outage and a refused search are REFUSED (distinct from not_found — nobody could check)", down.state === "refused" && refused.state === "refused" && /Exa not configured/.test((refused as any).reason))
    const zill = await searchPortalEstimate({ brokerageId: TENANT, userId: null, address: SUBJECT, source: "zillow_zestimate" }, { search, extract })
    const noT = await searchPortalEstimate({ brokerageId: "", userId: null, address: SUBJECT, source: "redfin_estimate" }, { search, extract })
    check("the Zestimate is refused here (it is the campaign still) and a tenant-less call is refused before any search", zill.state === "refused" && noT.state === "refused" && calls.length === 3)
  }

  console.log("\n[6 · stage — pending snippet rows, territory first, idempotent, typed fallback]")
  {
    let searches = 0
    const search = async (p: any) => { searches++; const host = p.includeDomains[0]; return { ok: true, provider: "exa" as const, results: host === "realtor.com" ? [realtorHit] as any : [], costUsd: 0.007, reason: "" } }
    const extract = async () => faithful
    const outside = await stageWebEstimateFigures({ svc: makeSvc({ lead_scraping_markets: [{ city: "Dallas", state: "TX", zip_codes: ["75201"] }], farm_territories: [], listings: [] }), brokerageId: TENANT, userId: "u1", address: SUBJECT }, { search, extract })
    check("OUTSIDE the territory → refused and NOTHING searched (no spend)", !outside.ok && searches === 0)
    const svc = makeSvc(TERRITORY_DATA)
    const r = await stageWebEstimateFigures({ svc, brokerageId: TENANT, userId: "u1", address: SUBJECT, listingId: "lst-1" }, { search, extract, now: new Date("2026-09-26T12:00:00Z") })
    const row = svc.inserted[0] as any
    check("in territory → one search per web-searched portal; realtor staged, redfin + homes not_found (the fallback)", r.ok && searches === WEB_SEARCH_ESTIMATE_SOURCES.length && r.outcomes.find((o) => o.source === "realtor_estimate")?.state === "staged" && r.outcomes.filter((o) => o.state === "not_found").length === 2 && svc.inserted.length === 1)
    check("the staged row is a PENDING snippet with NO pixels, tenant-owned, comparison-only, customer_facing_value:false", !!row && row.approval_status === "pending" && row.asset_type === "snippet" && row.asset_url === null && row.brokerage_id === TENANT && row.metadata.comparison_only === true && row.metadata.customer_facing_value === false && row.metadata.screenshot === false && row.metadata.asset_kind === ESTIMATE_WEB_FIGURE_KIND)
    check("…carrying the figure, source URL, as-of text, retrieval time, verbatim quote and territory basis — and NO confirmed figure until a human approves", !!row && row.metadata.figure_usd === 398600 && row.metadata.source_url === REALTOR_URL && row.metadata.as_of_text === "May 2026" && row.metadata.retrieved_at === "2026-09-26T12:00:00.000Z" && /398,600/.test(row.metadata.evidence_quote) && row.metadata.territory_basis === "territory_zip" && row.metadata.confirmed_figure_usd === undefined)
    check("every tenant read carries the tenant predicate (markets, farm, listings, staged figures)", ["lead_scraping_markets", "farm_territories", "listings", "marketing_assets"].every((t) => svc.log.filter((l) => l.table === t && l.op === "select").every((l) => l.preds.some(([k, v]) => k === "brokerage_id" && v === TENANT))))
    const svc2 = makeSvc({ ...TERRITORY_DATA, marketing_assets: [{ id: "have-1", asset_type: "snippet", approval_status: "pending", metadata: { estimate_source: "realtor_estimate", address: SUBJECT } }] })
    searches = 0
    const again = await stageWebEstimateFigures({ svc: svc2, brokerageId: TENANT, userId: "u1", address: SUBJECT }, { search, extract })
    check("idempotent: a pending realtor figure is left alone (already_staged, not searched again); the other two are searched", again.ok && again.outcomes.find((o) => o.source === "realtor_estimate")?.state === "already_staged" && searches === 2 && svc2.inserted.length === 0)
    const refusedRead = await stageWebEstimateFigures({ svc: makeSvc(TERRITORY_DATA, { refuse: "lead_scraping_markets" }), brokerageId: TENANT, userId: "u1", address: SUBJECT }, { search, extract })
    check("a refused territory read REFUSES (never read as 'no territory' or 'inside')", !refusedRead.ok && /territory check refused/.test(refusedRead.reason))
  }
  {
    const svc = makeSvc(TERRITORY_DATA)
    const off = await recordTypedComparisonFigure({ svc, brokerageId: TENANT, userId: "u1", address: SUBJECT, source: "redfin_estimate", figure: "$531,750", sourceUrl: "https://www.zillow.com/x" })
    const z = await recordTypedComparisonFigure({ svc, brokerageId: TENANT, userId: "u1", address: SUBJECT, source: "zillow_zestimate", figure: 500000 })
    check("the typed fallback refuses a link off the portal's host and refuses the Zestimate (its figure is read off the still)", !off.ok && /redfin\.com/.test(off.reason) && !z.ok && svc.inserted.length === 0)
    const t = await recordTypedComparisonFigure({ svc, brokerageId: TENANT, userId: "u1", address: SUBJECT, source: "redfin_estimate", figure: "$531,750", sourceUrl: "https://www.redfin.com/TX/Houston/2016-Main-St/home/1", now: new Date("2026-09-26T13:00:00Z") })
    const row = svc.inserted[0] as any
    check("a typed figure lands PENDING, figure_via human_typed, confirmed by the person who typed it", t.ok && t.figureUsd === 531750 && !!row && row.approval_status === "pending" && row.metadata.figure_via === "human_typed" && row.metadata.confirmed_figure_usd === 531750 && row.metadata.figure_confirmed_by === "u1")
  }

  console.log("\n[7 · the composer sees an APPROVED web figure, never a pending one]")
  {
    const snippet = (id: string, source: string, status: string, fig: number) => ({ id, asset_type: "snippet", asset_url: null, approval_status: status, metadata: { asset_kind: ESTIMATE_WEB_FIGURE_KIND, estimate_source: source, address: SUBJECT, figure_usd: fig, figure_via: "web_search", source_url: `https://www.${source.split("_")[0]}.com/x`, retrieved_at: "2026-09-26T12:00:00Z", label_detail: source === "realtor_estimate" ? "Cotality" : null } })
    const still = { id: "z1", asset_type: "image", asset_url: "https://cdn.example.test/z.png", approval_status: "approved", metadata: { asset_kind: "screenshot", estimate_source: "zillow_zestimate", address: SUBJECT, captured_at: "2026-09-26T11:00:00Z", confirmed_figure_usd: 512300 } }
    const ev = await listComparisonEvidence(makeSvc({ marketing_assets: [still, snippet("r1", "realtor_estimate", "approved", 398600), snippet("h1", "homes_estimate", "pending", 389000)] }), TENANT, SUBJECT)
    const r1 = ev.find((e) => e.assetId === "r1"), h1 = ev.find((e) => e.assetId === "h1")
    check("an APPROVED web figure maps to a confirmed figure with its source page; a PENDING one maps to none", r1?.confirmedFigureUsd === 398600 && r1?.via === "web_search" && /realtor\.com/.test(r1?.url ?? "") && h1?.confirmedFigureUsd === null)
    const plan = planComparisonCards(ev)
    check("the plan composes the Zillow still + the approved realtor figure (labelled with its provider), and names the pending homes figure", plan.ok && plan.cards.map((c) => c.source).sort().join() === "realtor_estimate,zillow_zestimate" && plan.cards.find((c) => c.source === "realtor_estimate")?.label === "Realtor.com estimate · Cotality" && plan.omitted.some((o) => o.source === "homes_estimate" && /approve it first/.test(o.reason)))
  }

  console.log("\n[8 · doors + rails — booked search, routed model, no screenshot]")
  {
    const { dispatchWebSearch } = await import("../lib/providers/dispatch")
    const saved = process.env.EXA_API_KEY; delete process.env.EXA_API_KEY
    const noTenant = await dispatchWebSearch({ brokerageId: null, query: SUBJECT, purpose: "estimate_comparison" })
    const noKey = await dispatchWebSearch({ brokerageId: TENANT, query: SUBJECT, purpose: "estimate_comparison" })
    if (saved) process.env.EXA_API_KEY = saved
    check("dispatchWebSearch refuses a tenant-less call and a keyless call without touching the network (fail closed)", !noTenant.ok && /no tenant/.test(noTenant.reason) && !noKey.ok && /EXA_API_KEY/.test(noKey.reason))
  }
  const disp = stripped("lib/providers/dispatch.ts")
  check("the dispatch purpose vocabulary names estimate_comparison, and the spend is booked to vendor exa", /purpose: "search_enrichment" \| "intent_acquisition" \| "estimate_comparison"/.test(disp) && /vendorName: "exa"/.test(disp))
  check("the routing table names estimate_figure_extraction (a schema-strict extraction model)", /estimate_figure_extraction:\s*\{ model: "gpt-4o"/.test(stripped("lib/ai/models.ts")))
  const mod = stripped("lib/marketing/estimate-web-search.ts")
  const code = blankStrings(mod)
  check("the module calls generateObjectRouted with the feature AND the session brokerageId (the AI spend is booked)", /generateObjectRouted\(\{\s*feature: "estimate_figure_extraction", brokerageId: args\.brokerageId/.test(mod))
  const SHOT_RE = /captureScreenshot\(|capturePublicPropertyPage\(|captureTenantEstimateStill\(|screenshot-capture/
  check("the module never takes a screenshot (no seam entry, no seam import — stripped, strings blanked for calls)", !SHOT_RE.test(code) && !/["']@\/lib\/assets\/screenshot-capture["']/.test(mod))
  check("POSITIVE CONTROL: the screenshot finder catches a specimen seam call", SHOT_RE.test(blankStrings(stripComments(`await capturePublicPropertyPage(q, deps)`))))
  check("the module never writes approval_status 'approved' (a human approves on the existing rail)", !/approval_status: "approved"/.test(mod) && /approval_status: "pending"/.test(mod))

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log(" blind spots: no live Exa call (the sandbox proves the chain on fixtures shaped from real 2026-09-26 Exa results — whether Exa indexes a given address on redfin.com / homes.com is live-only; homes.com was the least indexed in research, so expect more typed fallbacks there); no live model call (the extractor is stubbed — the deterministic verify step is what guarantees a figure is printed on the page); realtor.com multi-unit buildings share a house number, so an apartment's figure can pass the house-number check (the human approval sees the source link + quote); address parsing is US-format; the territory check reads lead_scraping_markets + farm_territories + listings only.")
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ ESTIMATE_WEB_SEARCH_PASS")
}

main().catch((e) => { console.error(e); process.exit(1) })
