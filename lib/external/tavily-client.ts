// lib/external/tavily-client.ts
// Tavily — agentic AI search API (real-time web answers + ranked results with
// snippets). Used two ways in this app: (1) discover real-estate BUYER / SELLER /
// INVESTOR intent content for lead sourcing, and (2) as a fast web-search tool
// for enrichment, sales research, and AI chats (see lib/ai/web-search.ts).
// Real REST API; no stubs.  Docs: https://docs.tavily.com (POST /search)

const TAVILY_BASE = "https://api.tavily.com"

export interface TavilyResult {
  title: string | null
  url: string | null
  content: string | null
  score: number | null
}

export interface TavilyResponse {
  answer: string | null
  results: TavilyResult[]
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
}): Promise<TavilyResponse> {
  const apiKey = process.env.TAVILY_API_KEY
  if (!apiKey) return { answer: null, results: [], cost: 0 }

  try {
    const res = await fetch(`${TAVILY_BASE}/search`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: params.query,
        max_results: params.maxResults ?? 20,
        search_depth: params.searchDepth ?? "basic",
        include_answer: params.includeAnswer ?? true,
        ...(params.days ? { days: params.days } : {}),
      }),
    })
    if (!res.ok) return { answer: null, results: [], cost: 0 }
    const json = await res.json()
    const rows: any[] = json?.results ?? []
    return {
      answer: typeof json?.answer === "string" ? json.answer : null,
      results: rows.map((r) => normalizeTavilyRow(r)),
      // Tavily basic ≈ 1 credit; advanced ≈ 2. Approximate $ for cost tracking.
      cost: params.searchDepth === "advanced" ? 0.01 : 0.005,
    }
  } catch {
    return { answer: null, results: [], cost: 0 }
  }
}

/** Pure: a raw Tavily result row → normalized TavilyResult (defensive mapping). */
export function normalizeTavilyRow(r: Record<string, any>): TavilyResult {
  return {
    title: r.title ?? null,
    url: r.url ?? null,
    content: r.content ?? r.snippet ?? null,
    score: typeof r.score === "number" ? r.score : null,
  }
}
