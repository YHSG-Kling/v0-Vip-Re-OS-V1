// lib/lead-pipeline/exa-sourcer.ts
// Exa neural-search INTENT source — AI-native discovery of people describing a
// home search, a sale, a move, an agent hunt or an investment in their own words
// across the open web (forums, blogs, social), which keyword scrapers miss. Each
// result is classified by the Exa intent normalizer + detectIntent and anchored
// on the author handle (the viability gate drops anonymous/identity-less pages).
//
// Lane 89B (wave 89; owner 2026-09-29, verbatim: "exa is also another lead scrapping source") —
// the lane ran THREE buyer queries per territory. It now runs ONE query set per population the
// acquisition registry declares for it (acquisition-coverage.ts::SOURCE_ACQUISITION.exa_buyer_intent:
// buy / relocate / sell / realtor_seeking / investor), each rendered from the territory, and every
// result carries the lexicon's canonical population + distress signals (scrape-keywords.ts) so the
// coverage guard can PROVE the population is produced, not just declared. The SourceKey keeps its
// historical spelling (it is the ledger's usage_type on every Exa row already booked).
//
// Cost (exa.ai/pricing, 2026-09-29): $7 / 1k `/search` requests with 10 results included, $1 / 1k
// results above 10 — so EXA_RESULTS_PER_QUERY is 10 (the base price already covers them) and a
// territory run of EXA_QUERIES_PER_POPULATION × 5 populations is ≈ $0.07 at list price. The
// provider's own `costDollars.total` wins whenever it is present (exa-client.ts).

import { exaSearch, type ExaResult } from "@/lib/external/exa-client"
import { normalizeExaIntentRow } from "@/lib/external/exa-intent-normalizer"
import { detectIntent } from "./social-sourcer"
import { isViableRecord, type NormalizedScrapedRecord } from "./raw-record-types"
import { intentSignalsFromText, distressSignalsFromText } from "./scrape-keywords"
import { SOURCE_ACQUISITION, type AcquisitionIntent } from "./acquisition-coverage"

export interface ExaMarket {
  city: string | null
  state: string | null
}

/** Results per query — the base request price includes 10 (exa-client.ts::EXA_SEARCH_INCLUDED_RESULTS). */
export const EXA_RESULTS_PER_QUERY = 10
/** Queries per population per run — bounds spend (5 populations × 2 = 10 requests ≈ $0.07/territory). */
export const EXA_QUERIES_PER_POPULATION = 2
/** Recent content only — intent is time-sensitive. */
export const EXA_LOOKBACK_DAYS = 120

/** The query TEMPLATES per population; `{where}` is the territory ("Austin, TX"). Two per population. */
const EXA_QUERY_TEMPLATES: Record<AcquisitionIntent, readonly string[]> = {
  buy:             ["first-time homebuyer looking to buy a house in {where}", "pre-approved and house hunting in {where}"],
  relocate:        ["relocating to {where} and need to buy a home", "moving to {where} for a new job, looking at neighborhoods"],
  sell:            ["thinking of selling my house in {where}, what is my home worth", "for sale by owner in {where} — selling my home myself"],
  realtor_seeking: ["looking for a realtor in {where}, recommendations for a real estate agent", "need a good real estate agent in {where} to buy or sell"],
  investor:        ["real estate investor looking for rental property or fix and flip deals in {where}", "cash buyer seeking off-market investment property in {where}"],
}

export interface ExaIntentQuery {
  query: string
  population: AcquisitionIntent
}

/**
 * PURE — the territory's query set: every population SOURCE_ACQUISITION declares for this lane
 * (never a hand list; a population declared without a template here fails the coverage guard),
 * capped at EXA_QUERIES_PER_POPULATION each. Territory-honest: no city and no state ⇒ zero queries.
 */
export function buildExaIntentQueries(market: ExaMarket): ExaIntentQuery[] {
  const where = [market.city, market.state].filter(Boolean).join(", ")
  if (!where) return []
  const out: ExaIntentQuery[] = []
  for (const population of SOURCE_ACQUISITION.exa_buyer_intent.intents) {
    for (const t of (EXA_QUERY_TEMPLATES[population] ?? []).slice(0, EXA_QUERIES_PER_POPULATION)) {
      out.push({ query: t.replace(/\{where\}/g, where), population })
    }
  }
  return out
}

/** Pure: an Exa neural result → intent raw record (author = identity anchor). */
export function normalizeExaResult(result: ExaResult, market: ExaMarket): NormalizedScrapedRecord {
  const text = `${result.title ?? ""} ${result.text ?? ""}`
  const legacy = detectIntent(text)

  // Rich intent — buyer / seller / investor / agent / generic with persona, property addresses,
  // prices, and a context blob. Feeds downstream lead-creation + AI-ISA scripts via
  // raw_data.normalized_preview.intent.
  const rich = normalizeExaIntentRow(result)
  // Coarse legacy bucket for back-compat with the existing intentType union. Honor rich result when
  // confident; fall back to the keyword detector. Investor/agent fold into 'unknown' since the legacy
  // union is buyer/seller/unknown only.
  const intentType: "buyer" | "seller" | "unknown" =
    rich.intent === "buyer"  ? "buyer"  :
    rich.intent === "seller" ? "seller" :
    rich.intent === "generic" || rich.intent === "investor" || rich.intent === "agent"
      ? (legacy === "seller" ? "seller" : legacy === "buyer" ? "buyer" : "unknown")
      : "unknown"

  // Lane 89B — the lexicon's canonical population signals (selling / looking_to_buy / relocating /
  // need_a_realtor / investor) + distress signals ride beside the rich match so recordAcquisitionIntents
  // reads every population this result evidences (the same stamping seam every social normalizer uses).
  const lexicon = [...intentSignalsFromText(text), ...distressSignalsFromText(text)]

  return {
    sourceRecordId: `exa-${result.id}`,
    source: "exa_buyer_intent",
    behaviorType: "search_signal",
    intentType,
    intentSignals: Array.from(new Set([
      intentType,
      rich.persona ?? "no_persona",
      "ai_neural_match",
      ...(rich.intent === "investor" ? ["investor"] : []),
      ...rich.matched.slice(0, 3),
      ...lexicon,
    ])),
    username: result.author ?? undefined,
    city: market.city,
    state: market.state,
    sourceUrl: result.url,
    motivationScore: Math.round(Math.max(rich.scores.buyer, rich.scores.seller, rich.scores.investor) * 100),
    // Rich intent flows into raw_data.normalized_preview.intent (canonical lead-gate downstream).
    intent: {
      winner:            rich.intent,
      persona:           rich.persona,
      scores:            rich.scores,
      matched:           rich.matched,
      propertyAddresses: rich.propertyAddresses,
      prices:            rich.prices,
    },
    propertyAddress: rich.propertyAddresses[0] ?? null,
    rawPayload: {
      id: result.id, url: result.url, title: result.title, author: result.author,
      published: result.publishedDate,
      // Preserve the full normalized intent + extracted addresses/prices for audit + AI-ISA.
      intent: rich,
    },
  }
}

/**
 * Discover intent content for a territory via Exa neural search — every declared population
 * (buildExaIntentQueries). The historical name is kept: it is the cron's import and the
 * simulator's anchor; the lane it names is no longer buyer-only (lane 89B).
 */
export async function sourceExaBuyerIntent(market: ExaMarket): Promise<{ records: NormalizedScrapedRecord[]; cost: number }> {
  const queries = buildExaIntentQueries(market)
  if (queries.length === 0) return { records: [], cost: 0 }
  const since = new Date(Date.now() - EXA_LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10)
  const all: NormalizedScrapedRecord[] = []
  const seen = new Set<string>()
  let cost = 0
  for (const { query } of queries) {
    const r = await exaSearch({ query, numResults: EXA_RESULTS_PER_QUERY, startPublishedDate: since }).catch(() => ({ results: [] as ExaResult[], cost: 0 }))
    cost += r.cost ?? 0
    for (const result of r.results ?? []) {
      const rec = normalizeExaResult(result, market)
      // The same page answers more than one population's query — one raw row, not five.
      if (seen.has(rec.sourceRecordId)) continue
      seen.add(rec.sourceRecordId)
      if (isViableRecord(rec)) all.push(rec)
    }
  }
  return { records: all, cost }
}
