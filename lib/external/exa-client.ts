// lib/external/exa-client.ts
// Exa.ai — an AI-NATIVE (neural / embeddings) web search API. Unlike keyword
// scrapers, Exa retrieves pages/posts by MEANING, so it surfaces buyer-intent
// content that keyword matching misses (e.g. someone describing their home
// search in their own words on a blog, forum, or social post). We use it to
// discover real-estate BUYER intent across the open web, then classify + enrich.
// Real REST API; no stubs.  Docs: https://docs.exa.ai (POST /search)

const EXA_BASE = "https://api.exa.ai"

export interface ExaResult {
  id: string
  url: string | null
  title: string | null
  text: string | null
  author: string | null
  publishedDate: string | null
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
}): Promise<{ results: ExaResult[]; cost: number }> {
  const apiKey = process.env.EXA_API_KEY
  if (!apiKey) return { results: [], cost: 0 }

  // Single egress: route through the connector-gateway (one way in/out). callConnector
  // never throws, so the no-results fallback is preserved.
  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const res = await callConnector<{ results?: any[]; costDollars?: { total?: number } }>({
    connector: "exa",
    baseUrl: EXA_BASE,
    path: "search",
    method: "POST",
    auth: { style: "header", name: "x-api-key", value: apiKey },
    body: {
      query: params.query,
      type: "neural",
      numResults: params.numResults ?? 25,
      ...(params.startPublishedDate ? { startPublishedDate: params.startPublishedDate } : {}),
      ...(params.includeDomains ? { includeDomains: params.includeDomains } : {}),
      contents: { text: { maxCharacters: 1000 } },
    },
  })
  if (!res.ok || !res.data) return { results: [], cost: 0 }
  const rows: any[] = res.data.results ?? []
  return {
    results: rows.map((r) => normalizeExaRow(r)),
    cost: typeof res.data.costDollars?.total === "number" ? res.data.costDollars.total : 0.005 * rows.length,
  }
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
  }
}
