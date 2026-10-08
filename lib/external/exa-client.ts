// lib/external/exa-client.ts
// Exa.ai — an AI-NATIVE (neural / embeddings) web search API. Unlike keyword
// scrapers, Exa retrieves pages/posts by MEANING, so it surfaces buyer-intent
// content that keyword matching misses (e.g. someone describing their home
// search in their own words on a blog, forum, or social post). We use it to
// discover real-estate BUYER intent across the open web, then classify + enrich.
// Real REST API; no stubs.  Docs: https://docs.exa.ai (POST /search)

export interface ExaResult {
  id: string
  url: string | null
  title: string | null
  text: string | null
  author: string | null
  publishedDate: string | null
  /** Top relevance highlights — sentences Exa picked as most matching the query. */
  highlights?: string[] | null
  /** Model-generated summary of the page (when Exa returns one). */
  summary?: string | null
  /** Exa relevance score 0..1. */
  score?: number | null
  /** Favicon + image URL when Exa returns them — useful for downstream UI. */
  image?: string | null
  favicon?: string | null
}

/**
 * Neural search over the open web. Returns ranked results with page text.
 * Never throws (returns []). `type: "neural"` is the embeddings-based mode.
 */
export async function exaSearch(params: {
  query: string
  numResults?: number
  /** Restrict to recent content (ISO date) — buyer intent is time-sensitive. */
  startPublishedDate?: string
  includeDomains?: string[]
}): Promise<{ results: ExaResult[]; cost: number; costBasis?: "final" | "estimated" }> {
  const apiKey = process.env.EXA_API_KEY
  if (!apiKey) return { results: [], cost: 0 }

  // Official Exa SDK adapter (lib/providers/exa/client.ts) — same request
  // shape, same price. Never throws (the adapter maps a thrown SDK error to
  // ok:false), so the no-results fallback is preserved.
  const { neuralSearch } = await import("@/lib/providers/exa/client")
  const res = await neuralSearch(apiKey, {
    query: params.query,
    numResults: params.numResults,
    startPublishedDate: params.startPublishedDate,
    includeDomains: params.includeDomains,
  })
  if (!res.ok || !res.data) return { results: [], cost: 0 }
  const rows = res.data.results
  return {
    results: rows.map((r) => normalizeExaRow(r)),
    cost: typeof res.data.costDollarsTotal === "number" ? res.data.costDollarsTotal : exaSearchListCost(params.numResults ?? rows.length),
    // Wave 139 (139C): the SDK-reported charge is FINAL; the list-price fallback is an estimate.
    costBasis: typeof res.data.costDollarsTotal === "number" ? "final" : "estimated",
  }
}

/**
 * Lane 89B — Exa's PUBLISHED list price (exa.ai/pricing, read 2026-09-29): `/search` is $7 per 1k
 * requests with the first 10 results (text + highlights) included, plus $1 per 1k results above 10;
 * summaries $1 per 1k pages; `/monitors` $15 per 1k requests. The old fallback billed
 * `0.005 × rows` — a 20-result query read as $0.10 when the list price is $0.017, so the platform
 * ledger overstated every Exa lane ~6× whenever the response carried no `costDollars`. Used ONLY
 * when the provider omits its own total (which wins whenever present).
 */
export const EXA_SEARCH_REQUEST_COST_USD = 0.007
export const EXA_SEARCH_INCLUDED_RESULTS = 10
export const EXA_SEARCH_EXTRA_RESULT_COST_USD = 0.001

/** PURE — list-price cost of ONE `/search` request that asked for `numResults`. */
export function exaSearchListCost(numResults: number): number {
  const n = Math.max(0, Math.floor(numResults))
  return EXA_SEARCH_REQUEST_COST_USD + Math.max(0, n - EXA_SEARCH_INCLUDED_RESULTS) * EXA_SEARCH_EXTRA_RESULT_COST_USD
}

/** Pure: a raw Exa result row → normalized ExaResult (defensive field mapping). */
export function normalizeExaRow(r: Record<string, any>): ExaResult {
  return {
    id: String(r.id ?? r.url ?? `${Date.now()}-${Math.random()}`),
    url: r.url ?? null,
    title: r.title ?? null,
    text: r.text ?? (typeof r.contents?.text === "string" ? r.contents.text : null),
    author: r.author ?? null,
    publishedDate: r.publishedDate ?? null,
    highlights: Array.isArray(r.highlights) ? r.highlights : null,
    summary: typeof r.summary === "string" ? r.summary : null,
    score: typeof r.score === "number" ? r.score : null,
    image: r.image ?? null,
    favicon: r.favicon ?? null,
  }
}
