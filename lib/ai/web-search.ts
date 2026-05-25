// lib/ai/web-search.ts
// Unified web-search helper for app-wide AI use (lead/contact enrichment, sales
// research, and AI chats). Two modes, because the two jobs want different engines:
//
//   • "intent" (DEFAULT) — Exa neural is PRIMARY. Exa retrieves pages by MEANING,
//     so it is the strongest engine for finding people describing buyer/seller/
//     investor BEHAVIOR in their own words. This is the lead-acquisition use that
//     the whole scraping subsystem exists for, so it leads. Tavily is the fallback.
//   • "research" — Tavily is PRIMARY. Tavily returns a synthesized ANSWER plus
//     ranked snippets, which is ideal for grounding an LLM in a Q&A / chat / fact
//     lookup. Exa is the fallback.
//
// Both underlying clients never throw, so this helper degrades gracefully to an
// empty result. The merge/fallback logic is a pure function (runWebSearch) that
// takes injected searchers, so it is unit-testable without the network.

import { tavilySearch } from "@/lib/external/tavily-client"
import { exaSearch } from "@/lib/external/exa-client"

export type WebSearchMode = "intent" | "research"

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

async function viaExa(exa: ExaFn, query: string, max: number): Promise<WebSearchResult | null> {
  const e = await exa({ query, numResults: max })
  if ((e.results?.length ?? 0) === 0) return null
  return {
    answer: null,
    hits: e.results.map((r) => ({ title: r.title, url: r.url, snippet: r.text })),
    provider: "exa",
    cost: e.cost ?? 0,
  }
}

async function viaTavily(tavily: TavilyFn, query: string, max: number, deep: boolean): Promise<WebSearchResult | null> {
  const t = await tavily({ query, maxResults: max, searchDepth: deep ? "advanced" : "basic", includeAnswer: true })
  if ((t.results?.length ?? 0) === 0 && !t.answer) return null
  return {
    answer: t.answer,
    hits: (t.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })),
    provider: "tavily",
    cost: t.cost ?? 0,
  }
}

/**
 * Pure: primary→fallback merge over injected searchers.
 *   mode "intent"   → Exa primary (behavior/intent discovery), Tavily fallback.
 *   mode "research" → Tavily primary (synthesized answer), Exa fallback.
 */
export async function runWebSearch(
  params: { query: string; maxResults?: number; deep?: boolean; mode?: WebSearchMode },
  deps: { tavily: TavilyFn; exa: ExaFn },
): Promise<WebSearchResult> {
  const max = params.maxResults ?? 8
  const deep = params.deep ?? false
  const mode = params.mode ?? "intent"

  if (mode === "research") {
    const primary = await viaTavily(deps.tavily, params.query, max, deep)
    if (primary) return primary
    const fallback = await viaExa(deps.exa, params.query, max)
    if (fallback) return fallback
  } else {
    const primary = await viaExa(deps.exa, params.query, max)
    if (primary) return primary
    const fallback = await viaTavily(deps.tavily, params.query, max, deep)
    if (fallback) return fallback
  }

  return { answer: null, hits: [], provider: "none", cost: 0 }
}

/**
 * App-facing web search. Defaults to "intent" mode (Exa-first) — the
 * lead-acquisition behavior-discovery use. Pass mode:"research" for Q&A grounding
 * where a synthesized answer (Tavily) is preferred. Never throws.
 */
export async function webSearch(params: {
  query: string
  maxResults?: number
  deep?: boolean
  mode?: WebSearchMode
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
