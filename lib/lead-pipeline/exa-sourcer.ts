// lib/lead-pipeline/exa-sourcer.ts
// Exa PUBLIC-MARKET RESEARCH source — cited public pages about a territory's housing market, its civic and employment events
// and the anonymous questions people ask about it. NEVER a people finder.
//
// REVERSED (wave 150, lane 150KLMO — owner ruling R9 / directive 150L, 2026-11-06: "Exa for public-market research with
// citations, never for people"; canary 8: "a market signal generates an attributed report/page/idea without inventing private
// people or identifying anonymous social accounts"). Until wave 150 this lane (lane 89B, 2026-09-29: "exa is also another lead
// scrapping source") searched for PEOPLE describing a home search and anchored each result on the AUTHOR HANDLE so the raw row
// could walk toward the Lead door. That is exactly what the ruling now forbids: the author is no longer read, no handle or name
// rides the record, and every result enters THE ONE RawData producer (lib/kernel/scraping.ts ingestRawSourceBatch, contract C35)
// as EVIDENCE — subject_kind 'job_civic_event' (employer expansions, WARN closures, base / campus / infrastructure, corridors,
// permits, zoning), 'market' (inventory, prices, rents, carrying-cost shifts) or 'anonymous_question' (a public question about
// the local market) — which lib/lead-pipeline/canonical-lead-eligibility.ts subjectKindLeadProblem keeps out of every Lead door
// and processRawRecord keeps away from every paid person lookup. Each record carries its citation (url, title, publisher,
// published, retrieved), the source rights the vendor contract names (source-intent-map.ts sourceRightsFor), and the C35 TTL
// for its subject kind. Only a short excerpt is kept — Exa returns pages it does not license for reuse (directive: "no
// assumption it has legal permission to reuse all page content").
//
// The populations stay (acquisition-coverage.ts SOURCE_ACQUISITION.exa_buyer_intent: buy / relocate / sell / realtor_seeking /
// investor) — each now names the MARKET question that population turns on, and the lexicon's population signals ride the record
// as topic tags so the topic bank / market twin can route the evidence. The SourceKey keeps its historical spelling (it is the
// ledger's usage_type on every Exa row already booked).
//
// Cost (exa.ai/pricing, 2026-09-29): $7 / 1k `/search` requests with 10 results included — EXA_RESULTS_PER_QUERY is 10 and a
// territory run of EXA_QUERIES_PER_POPULATION x 5 populations is about $0.07 at list price. The provider's own
// `costDollars.total` wins whenever it is present (exa-client.ts).

import { exaSearch, type ExaResult } from "@/lib/external/exa-client"
import { normalizeExaIntentRow } from "@/lib/external/exa-intent-normalizer"
import { detectIntent } from "./social-sourcer"
import { isViableRecord, type NormalizedScrapedRecord, type RawDataSubjectKind } from "./raw-record-types"
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

/** The research subject each query is about — never a person (C35 vocabulary, raw_scraped_leads.subject_kind CHECK m961). */
type ExaResearchSubject = Extract<RawDataSubjectKind, "job_civic_event" | "market" | "anonymous_question">

/** The query TEMPLATES per population — the MARKET question that population turns on; `{where}` is the territory. Two each. */
const EXA_QUERY_TEMPLATES: Record<AcquisitionIntent, ReadonlyArray<{ template: string; subject: ExaResearchSubject }>> = {
  buy:             [{ template: "{where} housing inventory and new home construction this year", subject: "market" }, { template: "first-time homebuyer assistance program announced for {where}", subject: "job_civic_event" }],
  relocate:        [{ template: "major employer expansion or new jobs announced in {where}", subject: "job_civic_event" }, { template: "military base, university campus or infrastructure expansion near {where}", subject: "job_civic_event" }],
  sell:            [{ template: "{where} home prices, listings and days on market local report", subject: "market" }, { template: "{where} property tax or homeowners insurance cost increase", subject: "market" }],
  realtor_seeking: [{ template: "questions people ask about buying or selling a home in {where}", subject: "anonymous_question" }, { template: "{where} rezoning or new subdivision approved by the city or county", subject: "job_civic_event" }],
  investor:        [{ template: "{where} rental market rents and vacancy report", subject: "market" }, { template: "WARN notice layoffs or plant closure in {where}", subject: "job_civic_event" }],
}

export interface ExaIntentQuery {
  query: string
  population: AcquisitionIntent
  subject: ExaResearchSubject
}

/** The excerpt kept from a page — enough to cite and route, never the page (no reuse licence is assumed). */
const EXA_EXCERPT_CHARS = 280

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
      out.push({ query: t.template.replace(/\{where\}/g, where), population, subject: t.subject })
    }
  }
  return out
}

const hostOf = (url: string | null) => { try { return url ? new URL(url).hostname.replace(/^www\./, "") : null } catch { return null } }

/**
 * Pure: an Exa result → a CITED public-market evidence record. The author is never read; no name, handle, email or phone rides
 * the record. The subject kind is the query's (a question-shaped page is an anonymous question), stated on the envelope so the
 * ONE producer writes it and every Lead door refuses it.
 */
export function normalizeExaResult(result: ExaResult, market: ExaMarket, subject: ExaResearchSubject = "anonymous_question"): NormalizedScrapedRecord {
  const text = `${result.title ?? ""} ${result.text ?? ""}`
  const legacy = detectIntent(text)
  // The SIDE of the market the page is about (buyer / seller) — a routing tag for the topic bank, never a person's intent.
  // The weighted page classifier (exa-intent-normalizer.ts) decides when confident; the keyword detector otherwise. Only
  // its market-side BUCKET is kept: the persona, the addresses and the prices it extracts describe an author and are
  // discarded here (owner ruling R9).
  const side = normalizeExaIntentRow(result).intent
  const intentType: "buyer" | "seller" | "unknown" =
    side === "buyer" || side === "seller" ? side : legacy === "seller" ? "seller" : legacy === "buyer" ? "buyer" : "unknown"
  const lexicon = [...intentSignalsFromText(text), ...distressSignalsFromText(text)]
  const excerpt = (result.highlights?.[0] ?? result.summary ?? result.text ?? "").replace(/\s+/g, " ").trim().slice(0, EXA_EXCERPT_CHARS)
  const retrievedAt = new Date().toISOString()
  return {
    sourceRecordId: `exa-${result.id}`,
    source: "exa_buyer_intent",
    behaviorType: "market_research",
    intentType,
    intentSignals: Array.from(new Set([subject, "public_market_research", ...lexicon])),
    city: market.city,
    state: market.state,
    sourceUrl: result.url,
    rawPayload: {
      id: result.id, url: result.url, title: result.title, published: result.publishedDate, excerpt,
      publisher: hostOf(result.url),
    },
    envelope: {
      subjectKind: subject,
      externalEventId: `exa:${result.id}`,
      proofUrls: result.url ? [result.url] : [],
      evidence: {
        citation: { url: result.url, title: result.title, publisher: hostOf(result.url), published: result.publishedDate, retrieved_at: retrievedAt },
        research: "public-market research (owner ruling R9) — cited public page; never a person, never an identified account",
      },
    },
  }
}

/**
 * Research a territory's public market via Exa — every declared population's market questions (buildExaIntentQueries), each
 * result a cited evidence record. The historical name is kept: it is the cron's import and the simulators' anchor.
 */
export async function sourceExaBuyerIntent(market: ExaMarket): Promise<{ records: NormalizedScrapedRecord[]; cost: number }> {
  const queries = buildExaIntentQueries(market)
  if (queries.length === 0) return { records: [], cost: 0 }
  const since = new Date(Date.now() - EXA_LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10)
  const all: NormalizedScrapedRecord[] = []
  const seen = new Set<string>()
  let cost = 0
  for (const { query, subject } of queries) {
    const r = await exaSearch({ query, numResults: EXA_RESULTS_PER_QUERY, startPublishedDate: since }).catch(() => ({ results: [] as ExaResult[], cost: 0 }))
    cost += r.cost ?? 0
    for (const result of r.results ?? []) {
      const rec = normalizeExaResult(result, market, subject)
      // The same page answers more than one population's query — one raw row, not five.
      if (seen.has(rec.sourceRecordId)) continue
      seen.add(rec.sourceRecordId)
      if (isViableRecord(rec)) all.push(rec)
    }
  }
  return { records: all, cost }
}
