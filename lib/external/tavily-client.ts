// lib/external/tavily-client.ts
// Tavily — agentic AI search API (real-time web answers + ranked results with
// snippets). Used two ways in this app: (1) discover real-estate BUYER / SELLER /
// INVESTOR intent content for lead sourcing, and (2) as a fast web-search tool
// for enrichment, sales research, and AI chats (see lib/ai/web-search.ts).
// Real REST API; no stubs.  Docs: https://docs.tavily.com (POST /search)

import { TAVILY_CREDITS_PER_SEARCH, TAVILY_CREDIT_USD } from "@/lib/vendor-governance/cost-normalizer"

const TAVILY_BASE = "https://api.tavily.com"

export interface TavilyResult {
  title: string | null
  url: string | null
  content: string | null
  score: number | null
  /** Full page text when include_raw_content is set — preserves signal Tavily's snippet drops. */
  rawContent?: string | null
  publishedDate?: string | null
}

export interface TavilyResponse {
  answer: string | null
  results: TavilyResult[]
  /** Image URLs returned when include_images is set — useful for downstream UI / listing context. */
  images: string[]
  cost: number
}

/**
 * Tavily web search. `topic: "general"` for intent discovery; `searchDepth`
 * "advanced" for deeper research. Never throws (returns empty answer/results).
 */
export async function tavilySearch(params: {
  query: string
  maxResults?: number
  searchDepth?: "basic" | "advanced"
  includeAnswer?: boolean
  days?: number
  /** Tavily's search category — "news" for dated news results (wave 139, 139B: merged from the
   *  platform-brand harvest's duplicate raw call). Omitted = Tavily's default ("general"). */
  topic?: "general" | "news"
}): Promise<TavilyResponse> {
  const apiKey = process.env.TAVILY_API_KEY
  if (!apiKey) return { answer: null, results: [], images: [], cost: 0 }

  // Single egress: route through the connector-gateway (one way in/out). Never throws.
  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const res = await callConnector<{ answer?: string; results?: any[]; images?: any[] }>({
    connector: "tavily",
    baseUrl: TAVILY_BASE,
    path: "search",
    method: "POST",
    auth: { style: "bearer", token: apiKey },
    body: {
      query: params.query,
      max_results: params.maxResults ?? 20,
      search_depth: params.searchDepth ?? "basic",
      include_answer: params.includeAnswer ?? true,
      // Max-info scrape: pull the full raw page content + images so downstream extraction has
      // the most signal possible (snippet alone drops 80%+ of the page).
      include_raw_content: true,
      include_images: true,
      ...(params.days ? { days: params.days } : {}),
      ...(params.topic ? { topic: params.topic } : {}),
    },
  })
  if (!res.ok || !res.data) return { answer: null, results: [], images: [], cost: 0 }
  const rows: any[] = res.data.results ?? []
  const images: string[] = Array.isArray(res.data.images)
    ? res.data.images.map((i: any) => typeof i === "string" ? i : i?.url).filter(Boolean)
    : []
  return {
    answer: typeof res.data.answer === "string" ? res.data.answer : null,
    results: rows.map((r) => normalizeTavilyRow(r)),
    images,
    // Wave 139 (139C): credits × the ONE per-credit price (cost-normalizer — VARIABLE by plan; the
    // pay-as-you-go list rate is booked). Was 0.005 / 0.01, the Growth-plan rate, written here.
    cost: TAVILY_CREDITS_PER_SEARCH[params.searchDepth === "advanced" ? "advanced" : "basic"] * TAVILY_CREDIT_USD,
  }
}

/** Pure: a raw Tavily result row → normalized TavilyResult (defensive mapping). */
export function normalizeTavilyRow(r: Record<string, any>): TavilyResult {
  return {
    title: r.title ?? null,
    url: r.url ?? null,
    content: r.content ?? r.snippet ?? null,
    score: typeof r.score === "number" ? r.score : null,
    rawContent: typeof r.raw_content === "string" ? r.raw_content : null,
    publishedDate: typeof r.published_date === "string" ? r.published_date : null,
  }
}
