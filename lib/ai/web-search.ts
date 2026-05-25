// lib/ai/web-search.ts
// Unified web-search helper for app-wide AI use (lead/contact enrichment, sales
// research, and AI chats). Tavily is primary (it returns a synthesized answer +
// ranked snippets, ideal for grounding an LLM); Exa is the neural fallback when
// Tavily yields nothing (no key, no results). Both underlying clients never
// throw, so this helper degrades gracefully to an empty result.
//
// The core merge/fallback logic is split into a pure function (runWebSearch)
// that takes injected searchers, so it is unit-testable without the network.

import { tavilySearch } from "@/lib/external/tavily-client"
import { exaSearch } from "@/lib/external/exa-client"

export interface WebSearchHit {
  title: string | null
  url: string | null
  snippet: string | null
}

export interface WebSearchResult {
  /** Synthesized answer (Tavily only); null when unavailable. */
  answer: string | null
  hits: WebSearchHit[]
  provider: "tavily" | "exa" | "none"
  cost: number
}

type TavilyFn = typeof tavilySearch
type ExaFn = typeof exaSearch

/** Pure: Tavily-primary, Exa-fallback merge over injected searchers. */
export async function runWebSearch(
  params: { query: string; maxResults?: number; deep?: boolean },
  deps: { tavily: TavilyFn; exa: ExaFn },
): Promise<WebSearchResult> {
  const max = params.maxResults ?? 8
  const t = await deps.tavily({
    query: params.query,
    maxResults: max,
    searchDepth: params.deep ? "advanced" : "basic",
    includeAnswer: true,
  })
  if ((t.results?.length ?? 0) > 0 || t.answer) {
    return {
      answer: t.answer,
      hits: (t.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })),
      provider: "tavily",
      cost: t.cost ?? 0,
    }
  }

  const e = await deps.exa({ query: params.query, numResults: max })
  if ((e.results?.length ?? 0) > 0) {
    return {
      answer: null,
      hits: e.results.map((r) => ({ title: r.title, url: r.url, snippet: r.text })),
      provider: "exa",
      cost: e.cost ?? 0,
    }
  }

  return { answer: null, hits: [], provider: "none", cost: (t.cost ?? 0) + (e.cost ?? 0) }
}

/** App-facing web search — Tavily primary, Exa fallback. Never throws. */
export async function webSearch(params: {
  query: string
  maxResults?: number
  deep?: boolean
}): Promise<WebSearchResult> {
  return runWebSearch(params, { tavily: tavilySearch, exa: exaSearch })
}

/** Compact text block suitable for grounding an LLM prompt (answer + sources). */
export function formatWebSearchContext(result: WebSearchResult, maxHits = 5): string {
  if (result.provider === "none") return ""
  const lines: string[] = []
  if (result.answer) lines.push(`Summary: ${result.answer}`)
  result.hits.slice(0, maxHits).forEach((h, i) => {
    const snippet = (h.snippet ?? "").replace(/\s+/g, " ").slice(0, 300)
    lines.push(`[${i + 1}] ${h.title ?? "Untitled"} — ${h.url ?? ""}\n${snippet}`)
  })
  return lines.join("\n")
}
