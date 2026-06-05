/**
 * lib/content-intel/exa-scraper.ts
 *
 * Exa (exa.ai) neural-search scraper. Exa is "Google for AI" — returns
 * semantically-relevant URLs + summaries + scores for natural-language
 * queries. Far higher signal than Google for "what are agents talking
 * about this week" — the results are weighted toward expert content,
 * not SEO bait.
 *
 *   POST https://api.exa.ai/search
 *   Header: x-api-key: <key>
 *   Body: {
 *     query:          string,
 *     type:           "neural" | "keyword" | "auto",
 *     useAutoprompt:  boolean,
 *     numResults:     number,
 *     startPublishedDate?: ISO8601,
 *     endPublishedDate?:   ISO8601,
 *     category?:      string,     // "news", "tweet", "company", etc.
 *     includeText?:   boolean,    // returns full text passages
 *   }
 *
 * Routes through callConnector for the canonical single egress.
 */
import "server-only"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

export interface ExaSearchResult {
  result_id:        string
  url:              string
  title:            string
  /** Exa's relevance score 0-1, normalized to 0-100 for the topic bank. */
  engagement_score: number
  /** Short summary (Exa's "highlight" or first 240 chars of full text). */
  summary:          string
  /** Published date when known. */
  published_date:   string | null
  /** Heuristic category tags. */
  categories:       string[]
}

interface ExaResultItem {
  id?:     string
  url:     string
  title?:  string
  score?:  number
  publishedDate?: string
  highlights?: string[]
  text?:   string
}

interface ExaResponse {
  results?: ExaResultItem[]
}

export async function exaSearch(args: {
  query:        string
  numResults?:  number
  /** "neural" lets Exa interpret the query; "keyword" is exact-match.
   *  "auto" lets Exa pick. We default to "neural" for content intel. */
  type?:        "neural" | "keyword" | "auto"
  /** Filter to results published in the last N days. */
  withinDays?:  number
  /** Optional category filter — e.g. "news" for HousingWire / Inman shape. */
  category?:    string
  /** Restrict results to specific domains. Pass bare domains (no
   *  scheme, no path) — e.g. ["facebook.com", "inman.com"]. Exa's
   *  canonical domain-scope mechanism; far more reliable than putting
   *  `site:` operators in the query string (neural interpretation
   *  often drops them). */
  includeDomains?: string[]
  /** Skip results from these domains. */
  excludeDomains?: string[]
}): Promise<ExaSearchResult[]> {
  const apiKey = process.env.EXA_API_KEY
  if (!apiKey) return [] // graceful no-op when key not configured

  const body: Record<string, unknown> = {
    query:        args.query,
    type:         args.type ?? "neural",
    useAutoprompt: true,
    numResults:   Math.min(args.numResults ?? 15, 25),
    includeText:  true,
  }
  if (args.withinDays != null && args.withinDays > 0) {
    const start = new Date(Date.now() - args.withinDays * 86_400_000).toISOString()
    body.startPublishedDate = start
  }
  if (args.category) body.category = args.category
  if (args.includeDomains && args.includeDomains.length > 0) {
    body.includeDomains = args.includeDomains
  }
  if (args.excludeDomains && args.excludeDomains.length > 0) {
    body.excludeDomains = args.excludeDomains
  }

  const res = await callConnector<ExaResponse>({
    connector: "exa",
    baseUrl:   "https://api.exa.ai",
    path:      "search",
    method:    "POST",
    auth:      { style: "header", name: "x-api-key", value: apiKey },
    body,
    responseType: "json",
    timeoutMs:    25_000,
  })
  if (!res.ok || !res.data?.results) return []

  return res.data.results.map((r) => {
    const summary = (r.highlights && r.highlights.length > 0)
      ? r.highlights.join(" … ")
      : (r.text ?? "").slice(0, 240)
    // Exa scores are 0-1 floats; map to 0-100 with a mild compression so
    // even the top result tops out around 90 (lets brokerage-local boosts
    // still meaningfully reorder).
    const score = Math.min(95, Math.round((r.score ?? 0.5) * 100))
    return {
      result_id:        r.id ?? r.url,
      url:              r.url,
      title:            (r.title ?? r.url).slice(0, 240),
      engagement_score: score,
      summary:          summary.slice(0, 4000),
      published_date:   r.publishedDate ?? null,
      categories:       inferCategoriesFromText(`${r.title ?? ""} ${summary}`),
    }
  })
}

function inferCategoriesFromText(text: string): string[] {
  const t = text.toLowerCase()
  const cats: string[] = []
  const add = (c: string) => { if (!cats.includes(c)) cats.push(c) }
  if (/\b(rate|mortgage|interest|refi|refinance|points|apr|fha|va loan|conforming|jumbo)\b/.test(t)) add("finance")
  if (/\b(first time|first-time|down payment|closing cost|escrow|earnest|pre[- ]approval)\b/.test(t)) add("buyer_advice")
  if (/\b(sell|seller|listing agreement|cma|home prep|stag|comp|appraisal)\b/.test(t)) add("seller_advice")
  if (/\b(market|inventory|home prices|appreciation|trend|case[- ]shiller|housing market|forecast)\b/.test(t)) add("market_education")
  if (/\b(neighborhood|school district|hoa|gated|walkable|commute|downtown)\b/.test(t)) add("neighborhood")
  if (/\b(renovation|remodel|fix and flip|diy|home improvement|inspection|repair)\b/.test(t)) add("home_improvement")
  if (/\b(nar|tcpa|fair housing|disclosure|article 16|regulation|lawsuit|settlement)\b/.test(t)) add("regulation")
  if (cats.length === 0) add("market_education")
  return cats
}
