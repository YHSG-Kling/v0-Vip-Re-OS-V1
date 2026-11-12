// lib/marketing/estimate-web-search.ts
// ─────────────────────────────────────────────────────────────────────────────
// AI-SEARCHED PORTAL ESTIMATES FOR THE COMPARISON PIECE (wave 83, lane 83C —
// owner verbatim: "since we can't use the screenshots for the real estate
// sites showing the homes value except for zillow for marketing campaigns, we
// should use ai to search the internet for the property and what realtor.com,
// homes.com and redfin [show].").
//
// ALREADY EXISTED — REUSED, never rebuilt:
//   · lib/providers/dispatch.ts dispatchWebSearch — THE web-search door (Exa,
//     tenant required, spend booked to vendor "exa" via meterVendorSpend). The
//     purpose vocabulary gained `estimate_comparison`.
//   · lib/external/exa-client.ts + lib/providers/exa/client.ts — the one Exa
//     adapter; /search already returns each page's text + highlights, so no
//     second /contents call is paid for (exa.ai pricing 2026-09: /search
//     $7 / 1k requests incl. contents for ≤10 results).
//   · lib/ai/models.ts generateObjectRouted — the routed, cost-booked model
//     rail (feature `estimate_figure_extraction`, brokerageId from the session).
//   · lib/marketing/estimate-sources.ts COMPARISON_ESTIMATE_SOURCES — the ONE
//     vocabulary; the three portals carry `evidenceVia: "web_search"`.
//   · lib/marketing/estimate-comparison.ts — the composer (validateConfirmedFigure,
//     listComparisonEvidence, planComparisonCards) and the approval rail it
//     composes from; app/actions/marketing-studio.ts approveAsset is the human stop.
//
// WHAT HAPPENS, per portal (realtor.com, redfin.com, homes.com):
//   1. TERRITORY — the address must be the tenant's own listing or fall inside
//      one of its territories (lead_scraping_markets / farm_territories zips or
//      city+state). Fail closed: no territory match, no search.
//   2. SEARCH — dispatchWebSearch restricted to the portal's host, the address
//      + the portal's own name for its figure.
//   3. SUBJECT PAGE — only a result whose URL/title carries the address's house
//      number AND street word counts (a neighbour's page never does).
//   4. EXTRACT — a routed model reads the page excerpt and returns ONLY what is
//      printed there: the figure, its label, the as-of text, a verbatim quote.
//      FACTS ONLY: it never estimates, averages or corrects.
//   5. VERIFY (deterministic, the model is not trusted) — the figure must be
//      printed in the excerpt, the quote must be a verbatim substring carrying
//      the figure, and a quote that is a list/sold price is refused.
//   6. STAGE — a `marketing_assets` snippet row (no pixels, no asset_url),
//      PENDING, with source URL, as-of text, published date and retrieval time.
//      A human approves it on the existing rail before any piece is composed.
//   When the search finds nothing, the outcome says so and the card offers the
//   FALLBACK: a human types the figure the portal shows (recordTypedComparisonFigure),
//   which lands pending on the same rail.
//
// NEVER A CUSTOMER-FACING VALUATION: the figure is the portal's, staged as
// comparison-piece evidence only (estimateStillUseVerdict → estimate_comparison),
// customer_facing_value false on every row; no value surface imports this file
// (scripts/estimate-comparison-guard.ts sweeps). Nothing here takes a screenshot.
//
// Every DB / provider / model dependency is lazy or injected so the pure parts
// load under tsx for scripts/estimate-web-search-guard.ts.

import {
  COMPARISON_ESTIMATE_SOURCES, comparisonEstimateSource, ESTIMATE_STILL_DISCLAIMER,
  type ComparisonEstimateSource, type ComparisonEstimateSourceKey,
} from "@/lib/marketing/estimate-sources"
import { validateConfirmedFigure } from "@/lib/marketing/estimate-comparison"

/** The sources whose figure arrives by AI web search (derived, never restated). */
export const WEB_SEARCH_ESTIMATE_SOURCES: readonly ComparisonEstimateSource[] = COMPARISON_ESTIMATE_SOURCES.filter((s) => s.evidenceVia === "web_search")

/** metadata.asset_kind of a staged web figure row (asset_type 'snippet'). */
export const ESTIMATE_WEB_FIGURE_KIND = "estimate_web_figure"

export type WebFigureVia = "web_search" | "human_typed"

// ── Pure: address + territory ────────────────────────────────────────────────

export interface AddressGeo { houseNumber: string | null; streetWord: string | null; city: string | null; state: string | null; zip: string | null }

const DIRECTIONALS = new Set(["n", "s", "e", "w", "ne", "nw", "se", "sw", "north", "south", "east", "west"])

/** PURE: the parts of a US street address the gates need. "123 N Main St,
 *  Austin, TX 78701" → 123 / main / austin / TX / 78701. */
export function parseAddressGeo(address: string): AddressGeo {
  const a = (address ?? "").trim().replace(/\s+/g, " ")
  const parts = a.split(",").map((p) => p.trim()).filter(Boolean)
  const street = parts[0] ?? ""
  const m = street.match(/^(\d+[A-Za-z]?)\s+(.+)$/)
  const houseNumber = m ? m[1].toLowerCase() : null
  const streetWord = m ? (m[2].toLowerCase().split(/\s+/).find((w) => !DIRECTIONALS.has(w.replace(/\./g, ""))) ?? null) : null
  const zipM = a.match(/\b(\d{5})(?:-\d{4})?\s*$/)
  const zip = zipM ? zipM[1] : null
  const stateM = a.match(/,\s*([A-Za-z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*$/)
  const state = stateM ? stateM[1].toUpperCase() : null
  // City: the segment before the state segment (when there are ≥3 segments),
  // else the second segment with any state/zip tail removed.
  const citySeg = parts.length >= 3 ? parts[parts.length - 2] : parts.length === 2 ? parts[1].replace(/\s+[A-Za-z]{2}(\s+\d{5}(-\d{4})?)?$/, "") : ""
  const city = citySeg && !/^\d/.test(citySeg) ? citySeg.toLowerCase() : null
  return { houseNumber, streetWord: streetWord ? streetWord.replace(/[^a-z0-9]/g, "") : null, city, state, zip }
}

export interface TerritoryRow { city?: string | null; state?: string | null; zip_codes?: string[] | null }
export interface ListingRow { address?: string | null; city?: string | null; state?: string | null; zip?: string | null }

const normAddr = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim()

/**
 * PURE, FAIL-CLOSED: is this address a TERRITORY PROPERTY of the tenant? One of
 * its own listings (house number + street word + city/zip agree), or inside a
 * territory by ZIP, or by city + state. An address with neither a ZIP nor a
 * city + state cannot be placed and is refused — "nobody could check" never
 * reads as "checked and inside".
 */
export function addressInTerritory(address: string, territories: readonly TerritoryRow[], listings: readonly ListingRow[] = []): { ok: true; basis: "listing" | "territory_zip" | "territory_city" } | { ok: false; reason: string } {
  const g = parseAddressGeo(address)
  if (!g.houseNumber || !g.streetWord) return { ok: false, reason: `"${address}" is not a street address (house number + street) — the estimate search runs only for a specific property` }
  const listingHit = listings.some((l) => {
    const lg = parseAddressGeo([l.address, l.city, [l.state, l.zip].filter(Boolean).join(" ")].filter(Boolean).join(", "))
    if (lg.houseNumber !== g.houseNumber || lg.streetWord !== g.streetWord) return false
    return (!!g.zip && lg.zip === g.zip) || (!!g.city && lg.city === g.city) || normAddr(l.address) === normAddr(address.split(",")[0])
  })
  if (listingHit) return { ok: true, basis: "listing" }
  if (g.zip && territories.some((t) => (t.zip_codes ?? []).some((z) => (z ?? "").trim() === g.zip))) return { ok: true, basis: "territory_zip" }
  if (g.city && g.state && territories.some((t) => (t.city ?? "").trim().toLowerCase() === g.city && (t.state ?? "").trim().toUpperCase() === g.state)) return { ok: true, basis: "territory_city" }
  if (!g.zip && !(g.city && g.state)) return { ok: false, reason: `REFUSED: "${address}" carries no ZIP and no city + state, so it cannot be placed in your territory — add them` }
  return { ok: false, reason: `REFUSED: "${address}" is not one of your listings and is outside every territory you have set up — the estimate search runs only for properties in your territory` }
}

// ── Pure: search → subject page → excerpt ────────────────────────────────────

/** PURE: the search the door runs for one portal. */
export function estimateSearchRequest(address: string, src: ComparisonEstimateSource): { query: string; includeDomains: string[] } {
  return { query: `${address.trim().replace(/\s+/g, " ")} ${src.searchHint}`.trim(), includeDomains: [src.host] }
}

export interface SearchHit { url: string | null; title?: string | null; text?: string | null; highlights?: string[] | null; publishedDate?: string | null }

const tokensOf = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

/** PURE: the result that is THE SUBJECT PROPERTY's page on the portal — on the
 *  host, and its URL or title carries the house number AND the street word.
 *  A neighbour's page (another house number) never matches. */
export function pickSubjectPage(results: readonly SearchHit[], address: string, host: string): SearchHit | null {
  const g = parseAddressGeo(address)
  if (!g.houseNumber || !g.streetWord) return null
  return results.find((r) => {
    if (!r.url) return false
    let u: URL
    try { u = new URL(r.url) } catch { return false }
    const h = u.hostname.toLowerCase()
    if (!(h === host || h.endsWith(`.${host}`))) return false
    const toks = new Set([...tokensOf(decodeURIComponent(u.pathname)), ...tokensOf(r.title ?? "")])
    return toks.has(g.houseNumber!) && toks.has(g.streetWord!)
  }) ?? null
}

/** PURE: the part of the page the model reads — a window around the first
 *  mention of the portal's own name for its figure (else the page head),
 *  highlights first. Bounded so the prompt stays cheap. */
export function excerptForExtraction(hit: SearchHit, src: ComparisonEstimateSource, max = 7000): string {
  const text = (hit.text ?? "").replace(/\r/g, "")
  const low = text.toLowerCase()
  const idx = src.estimateNames.map((n) => low.indexOf(n.toLowerCase())).filter((i) => i >= 0).sort((a, b) => a - b)[0]
  const body = idx == null ? text.slice(0, max) : text.slice(Math.max(0, idx - 1500), Math.max(0, idx - 1500) + max)
  const hl = (hit.highlights ?? []).join("\n…\n")
  return [hl, body].filter(Boolean).join("\n…\n").slice(0, max + 2000)
}

// ── The extraction contract ──────────────────────────────────────────────────

export interface FigureExtraction {
  found: boolean
  /** The portal's figure for the SUBJECT home, whole USD, exactly as printed. */
  figureUsd: number | null
  /** The label printed beside it ("Redfin Estimate", or a named provider). */
  figureLabel: string | null
  /** The date the page says the figure is as of, verbatim (null if none). */
  asOfText: string | null
  /** The subject address as the page prints it. */
  subjectAddressOnPage: string | null
  /** ≤ 240 chars copied VERBATIM from the page, containing the figure. */
  evidenceQuote: string | null
}

export const EXTRACTION_SYSTEM = [
  "You read ONE public home-value web page and report ONLY what it prints. FACTS ONLY.",
  "Return the website's own automated estimate for the SUBJECT home named in the task — never a neighbour's row, never a comparable, never a list price, a sold price, a tax assessment or a rent estimate.",
  "Never estimate, average, round, adjust or correct a number. If the page shows several providers' estimates for the subject home, return the first one printed and name its provider in figureLabel.",
  "evidenceQuote must be copied character-for-character from the page and must contain the figure.",
  "If the page does not clearly print an estimate for the subject home, return found=false and nulls.",
].join(" ")

export function extractionPrompt(address: string, src: ComparisonEstimateSource, hit: SearchHit, excerpt: string): string {
  return `Subject home: ${address}\nWebsite: ${src.host} (its figure is called: ${src.estimateNames.join(" / ")})\nPage URL: ${hit.url ?? ""}\nPage title: ${hit.title ?? ""}\n\nPAGE TEXT (excerpt):\n${excerpt}`
}

/** Default extractor — the routed, cost-booked model rail. Throws if the model
 *  is unavailable (the caller reports it; nothing is staged). */
async function modelExtract(args: { brokerageId: string; userId: string | null; system: string; prompt: string }): Promise<FigureExtraction> {
  const { z } = await import("zod")
  const { generateObjectRouted } = await import("@/lib/ai/models")
  const schema = z.object({
    found: z.boolean(),
    figureUsd: z.number().nullable(),
    figureLabel: z.string().nullable(),
    asOfText: z.string().nullable(),
    subjectAddressOnPage: z.string().nullable(),
    evidenceQuote: z.string().nullable(),
  })
  const { object } = await generateObjectRouted({
    feature: "estimate_figure_extraction", brokerageId: args.brokerageId, userId: args.userId,
    schema, system: args.system, prompt: args.prompt, maxTokens: 400, temperature: 0,
  })
  return object as FigureExtraction
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim()
const PRICE_NOT_ESTIMATE_RE = /\b(list(ing)?\s+price|listed\s+(at|for)|asking|sold\s+(for|price)|last\s+sold|sale\s+price|tax\s+assess|rent(al)?\s+estimate|est\.?\s+rent|per\s+month|\/mo\b)/i

/** PURE, FAIL-CLOSED: the deterministic check the model answer must pass
 *  before anything is staged — the model is never trusted on its own. */
export function verifyExtraction(excerpt: string, x: FigureExtraction | null | undefined, address: string, src: ComparisonEstimateSource): { ok: true; figureUsd: number } | { ok: false; reason: string } {
  if (!x || !x.found || x.figureUsd == null) return { ok: false, reason: "the page does not clearly print this site's estimate for the address" }
  const fig = validateConfirmedFigure(x.figureUsd)
  if (!fig.ok) return { ok: false, reason: `extracted figure refused: ${fig.reason}` }
  const withCommas = fig.figureUsd.toLocaleString("en-US")
  // The figure as printed: "$398,600" / "398,600" / "398600" — never the tail
  // of a longer number ("$1,398,600") and never a prefix of one.
  const printed = new RegExp(`(^|[^\\d,.])\\$?\\s?(${withCommas}|${fig.figureUsd})(?![\\d,]*\\d)`)
  const page = squash(excerpt)
  if (!printed.test(page)) return { ok: false, reason: `the figure ${"$" + withCommas} is not printed on the page — refused (the model is never trusted on its own)` }
  const quote = squash(x.evidenceQuote ?? "")
  if (quote.length < 6 || !page.includes(quote)) return { ok: false, reason: "the evidence quote is not a verbatim line of the page — refused" }
  if (!printed.test(quote)) return { ok: false, reason: "the evidence quote does not carry the figure — refused" }
  const namesEstimate = src.estimateNames.some((n) => quote.toLowerCase().includes(n.toLowerCase())) || /estimat|valuation|value/i.test(`${quote} ${x.figureLabel ?? ""}`)
  if (PRICE_NOT_ESTIMATE_RE.test(quote) && !namesEstimate) return { ok: false, reason: "the quoted figure is a price (list / sold / rent / tax), not the site's estimate — refused" }
  const g = parseAddressGeo(address)
  if (x.subjectAddressOnPage && g.houseNumber && !tokensOf(x.subjectAddressOnPage).includes(g.houseNumber)) return { ok: false, reason: `the page's subject address "${x.subjectAddressOnPage}" is not ${address} — refused` }
  return { ok: true, figureUsd: fig.figureUsd }
}

/** PURE: a plain, nominative detail for the card label (a named provider on
 *  realtor.com's multi-provider panel) — trademark glyphs stripped, bounded;
 *  null when it only repeats the portal's own name. */
export function figureLabelDetail(label: string | null | undefined, src: ComparisonEstimateSource): string | null {
  const t = (label ?? "").replace(/[®™℠©]/g, "").replace(/\s+/g, " ").trim().slice(0, 28)
  if (!t) return null
  const low = t.toLowerCase()
  if (src.estimateNames.some((n) => low === n.toLowerCase() || low.includes(n.toLowerCase())) || low.includes(src.host.split(".")[0])) return null
  if (/logo/i.test(t)) return null
  return t
}

// ── Search one portal (IO, injectable) ───────────────────────────────────────

type SearchFn = (p: import("@/lib/providers/dispatch").DispatchWebSearchParams) => Promise<import("@/lib/providers/dispatch").DispatchWebSearchResult>
type ExtractFn = (args: { brokerageId: string; userId: string | null; system: string; prompt: string }) => Promise<FigureExtraction>

export interface WebEstimateDeps { search?: SearchFn; extract?: ExtractFn; now?: Date }

export type WebFigureFind =
  | { state: "found"; source: ComparisonEstimateSourceKey; figureUsd: number; figureLabel: string | null; labelDetail: string | null; sourceUrl: string; pageTitle: string | null; asOfText: string | null; publishedDate: string | null; evidenceQuote: string; retrievedAt: string; costUsd: number }
  | { state: "not_found"; source: ComparisonEstimateSourceKey; reason: string; costUsd: number }
  | { state: "refused"; source: ComparisonEstimateSourceKey; reason: string; costUsd: number }

/** Search ONE portal for the address and extract + verify its figure. */
export async function searchPortalEstimate(
  args: { brokerageId: string; userId: string | null; address: string; source: ComparisonEstimateSourceKey },
  deps: WebEstimateDeps = {},
): Promise<WebFigureFind> {
  const src = comparisonEstimateSource(args.source)
  if (!src || src.evidenceVia !== "web_search") return { state: "refused", source: args.source, reason: `"${args.source}" is not a web-searched estimate source (${WEB_SEARCH_ESTIMATE_SOURCES.map((s) => s.key).join(" | ")})`, costUsd: 0 }
  if (!args.brokerageId) return { state: "refused", source: src.key, reason: "REFUSED: the estimate search needs the session's brokerage id", costUsd: 0 }
  const search: SearchFn = deps.search ?? (async (p) => (await import("@/lib/providers/dispatch")).dispatchWebSearch(p))
  const extract: ExtractFn = deps.extract ?? modelExtract
  const req = estimateSearchRequest(args.address, src)
  const r = await search({ brokerageId: args.brokerageId, query: req.query, includeDomains: req.includeDomains, numResults: 5, purpose: "estimate_comparison", metadata: { source: src.key } })
  if (!r.ok) return { state: "refused", source: src.key, reason: `web search refused: ${r.reason}`, costUsd: r.costUsd ?? 0 }
  const hit = pickSubjectPage(r.results as SearchHit[], args.address, src.host)
  if (!hit || !hit.url) return { state: "not_found", source: src.key, reason: `the web search found no ${src.host} page for this exact address (${r.results.length} result(s), none for the house number + street)`, costUsd: r.costUsd }
  const excerpt = excerptForExtraction(hit, src)
  let x: FigureExtraction
  try { x = await extract({ brokerageId: args.brokerageId, userId: args.userId, system: EXTRACTION_SYSTEM, prompt: extractionPrompt(args.address, src, hit, excerpt) }) }
  catch (e) { return { state: "refused", source: src.key, reason: `figure extraction unavailable: ${(e as Error).message}`, costUsd: r.costUsd } }
  const v = verifyExtraction(excerpt, x, args.address, src)
  if (!v.ok) return { state: "not_found", source: src.key, reason: v.reason, costUsd: r.costUsd }
  return {
    state: "found", source: src.key, figureUsd: v.figureUsd, figureLabel: x.figureLabel ?? null, labelDetail: figureLabelDetail(x.figureLabel, src),
    sourceUrl: hit.url, pageTitle: hit.title ?? null, asOfText: x.asOfText ?? null, publishedDate: hit.publishedDate ?? null,
    evidenceQuote: squash(x.evidenceQuote ?? "").slice(0, 240), retrievedAt: (deps.now ?? new Date()).toISOString(), costUsd: r.costUsd,
  }
}

// ── Stage (DB) ───────────────────────────────────────────────────────────────

/** PURE: the marketing_assets row a staged web figure is filed as — a snippet
 *  (no pixels, no asset_url), PENDING, comparison-piece evidence only. */
export function webFigureRow(args: {
  brokerageId: string; userId: string | null; address: string; listingId?: string | null; src: ComparisonEstimateSource; via: WebFigureVia
  figureUsd: number; labelDetail?: string | null; sourceUrl?: string | null; pageTitle?: string | null; asOfText?: string | null; publishedDate?: string | null
  evidenceQuote?: string | null; retrievedAt: string; territoryBasis: string
}): Record<string, unknown> {
  const human = args.via === "human_typed"
  return {
    brokerage_id: args.brokerageId, created_by: args.userId, visibility_scope: "brokerage", asset_type: "snippet",
    asset_name: `${args.src.cardLabel} — ${args.address}`.slice(0, 160), asset_url: null, thumbnail_url: null,
    preview_text: `${args.src.cardLabel} for ${args.address}: ${"$" + args.figureUsd.toLocaleString("en-US")} (${human ? "typed by a person" : "found by web search"}) — comparison-piece evidence, pending approval`.slice(0, 280),
    tags: ["estimate_comparison", ESTIMATE_WEB_FIGURE_KIND, args.src.key],
    approval_status: "pending",
    metadata: {
      asset_kind: ESTIMATE_WEB_FIGURE_KIND, estimate_source: args.src.key, address: args.address, listing_id: args.listingId ?? null,
      figure_via: args.via, figure_usd: args.figureUsd, label_detail: args.labelDetail ?? null,
      ...(human ? { confirmed_figure_usd: args.figureUsd, figure_confirmed_by: args.userId, figure_confirmed_at: args.retrievedAt } : {}),
      source_url: args.sourceUrl ?? null, page_title: args.pageTitle ?? null, as_of_text: args.asOfText ?? null, published_date: args.publishedDate ?? null,
      evidence_quote: args.evidenceQuote ?? null, retrieved_at: args.retrievedAt, captured_at: args.retrievedAt, territory_basis: args.territoryBasis,
      comparison_only: true, customer_facing_value: false, usage: "estimate_comparison_evidence_only", screenshot: false,
      disclaimer: ESTIMATE_STILL_DISCLAIMER,
    },
  }
}

/** DB: is the address a territory property of the tenant? Three
 *  tenant-predicated reads (listings, lead_scraping_markets, farm_territories). */
export async function resolvePropertyTerritory(svc: any, brokerageId: string, address: string): Promise<{ ok: true; basis: string } | { ok: false; reason: string }> {
  if (!brokerageId) return { ok: false, reason: "REFUSED: the territory check needs the session's brokerage id" }
  const g = parseAddressGeo(address)
  const [mk, farm, lst] = await Promise.all([
    svc.from("lead_scraping_markets").select("city, state, zip_codes").eq("brokerage_id", brokerageId).eq("is_active", true).limit(200),
    svc.from("farm_territories").select("city, state, zip_codes").eq("brokerage_id", brokerageId).eq("is_active", true).limit(200),
    svc.from("listings").select("address, city, state, zip").eq("brokerage_id", brokerageId).ilike("address", `${g.houseNumber ?? ""}%`).limit(50),
  ])
  for (const [name, r] of [["territories", mk], ["farm territories", farm], ["listings", lst]] as const) {
    if (r.error) return { ok: false, reason: `territory check refused (${name} read): ${r.error.message}` }
  }
  return addressInTerritory(address, [...(mk.data ?? []), ...(farm.data ?? [])] as TerritoryRow[], (lst.data ?? []) as ListingRow[])
}

export type StageOutcome =
  | { source: ComparisonEstimateSourceKey; state: "staged"; assetId: string; figureUsd: number; sourceUrl: string }
  | { source: ComparisonEstimateSourceKey; state: "already_staged"; assetId: string }
  | { source: ComparisonEstimateSourceKey; state: "not_found"; reason: string }
  | { source: ComparisonEstimateSourceKey; state: "refused"; reason: string }

/**
 * DB: search every web-searched portal for a territory property and stage what
 * is found, PENDING. Idempotent per tenant × address × portal: a pending or
 * approved figure is left alone (a rejected one is searched again).
 */
export async function stageWebEstimateFigures(
  args: { svc: any; brokerageId: string; userId: string | null; address: string; listingId?: string | null },
  deps: WebEstimateDeps = {},
): Promise<{ ok: true; territoryBasis: string; outcomes: StageOutcome[]; costUsd: number } | { ok: false; reason: string }> {
  if (!args.brokerageId) return { ok: false, reason: "REFUSED: the estimate search needs the session's brokerage id" }
  const address = (args.address ?? "").trim().replace(/\s+/g, " ")
  if (address.length < 6) return { ok: false, reason: "the estimate search needs a street address (6+ characters)" }
  const terr = await resolvePropertyTerritory(args.svc, args.brokerageId, address)
  if (!terr.ok) return { ok: false, reason: terr.reason }
  const { data: have, error: haveErr } = await args.svc.from("marketing_assets").select("id, approval_status, metadata")
    .eq("brokerage_id", args.brokerageId).eq("asset_type", "snippet").eq("metadata->>asset_kind", ESTIMATE_WEB_FIGURE_KIND)
    .order("updated_at", { ascending: false }).limit(200)
  if (haveErr) return { ok: false, reason: `staged-figure read refused: ${haveErr.message}` }
  const want = normAddr(address)
  const outcomes: StageOutcome[] = []
  let cost = 0
  for (const src of WEB_SEARCH_ESTIMATE_SOURCES) {
    const live = ((have ?? []) as Array<{ id: string; approval_status: string | null; metadata: Record<string, any> | null }>)
      .find((r) => r.metadata?.estimate_source === src.key && normAddr(r.metadata?.address) === want && r.approval_status !== "rejected")
    if (live) { outcomes.push({ source: src.key, state: "already_staged", assetId: live.id }); continue }
    const f = await searchPortalEstimate({ brokerageId: args.brokerageId, userId: args.userId, address, source: src.key }, deps)
    cost += f.costUsd
    if (f.state !== "found") { outcomes.push({ source: src.key, state: f.state, reason: f.reason }); continue }
    const row = webFigureRow({ brokerageId: args.brokerageId, userId: args.userId, address, listingId: args.listingId ?? null, src, via: "web_search", figureUsd: f.figureUsd, labelDetail: f.labelDetail, sourceUrl: f.sourceUrl, pageTitle: f.pageTitle, asOfText: f.asOfText, publishedDate: f.publishedDate, evidenceQuote: f.evidenceQuote, retrievedAt: f.retrievedAt, territoryBasis: terr.basis })
    const { data: ins, error } = await args.svc.from("marketing_assets").insert(row).select("id").single()
    if (error || !ins) { outcomes.push({ source: src.key, state: "refused", reason: `staging refused: ${error?.message ?? "no row"}` }); continue }
    outcomes.push({ source: src.key, state: "staged", assetId: (ins as { id: string }).id, figureUsd: f.figureUsd, sourceUrl: f.sourceUrl })
  }
  return { ok: true, territoryBasis: terr.basis, outcomes, costUsd: cost }
}

/**
 * DB — THE FALLBACK: when the search finds nothing, a person types the figure
 * the portal shows (optionally with the page link). Same territory gate, same
 * pending rail: it reaches a piece only after approval.
 */
export async function recordTypedComparisonFigure(
  args: { svc: any; brokerageId: string; userId: string | null; address: string; source: string; figure: unknown; sourceUrl?: string | null; listingId?: string | null; now?: Date },
): Promise<{ ok: true; assetId: string; figureUsd: number } | { ok: false; reason: string }> {
  if (!args.brokerageId) return { ok: false, reason: "REFUSED: typing a figure needs the session's brokerage id" }
  const src = comparisonEstimateSource(args.source)
  if (!src || src.evidenceVia !== "web_search") return { ok: false, reason: `"${String(args.source)}" is not a site whose figure is typed or searched (${WEB_SEARCH_ESTIMATE_SOURCES.map((s) => s.key).join(" | ")})` }
  const fig = validateConfirmedFigure(args.figure)
  if (!fig.ok) return fig
  let sourceUrl: string | null = null
  if (args.sourceUrl) {
    try { const u = new URL(args.sourceUrl); const h = u.hostname.toLowerCase(); if (!(h === src.host || h.endsWith(`.${src.host}`))) return { ok: false, reason: `the page link must be on ${src.host}` }; sourceUrl = u.toString() }
    catch { return { ok: false, reason: "the page link is not a valid URL" } }
  }
  const address = (args.address ?? "").trim().replace(/\s+/g, " ")
  const terr = await resolvePropertyTerritory(args.svc, args.brokerageId, address)
  if (!terr.ok) return { ok: false, reason: terr.reason }
  const row = webFigureRow({ brokerageId: args.brokerageId, userId: args.userId, address, listingId: args.listingId ?? null, src, via: "human_typed", figureUsd: fig.figureUsd, sourceUrl, retrievedAt: (args.now ?? new Date()).toISOString(), territoryBasis: terr.basis })
  const { data: ins, error } = await args.svc.from("marketing_assets").insert(row).select("id").single()
  if (error || !ins) return { ok: false, reason: `typed figure refused: ${error?.message ?? "no row"}` }
  return { ok: true, assetId: (ins as { id: string }).id, figureUsd: fig.figureUsd }
}
