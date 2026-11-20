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
import { meterVendorSpend } from "@/lib/vendor-governance/meter-vendor"

export type WebSearchMode = "intent" | "research"

export interface WebSearchHit {
  title: string | null
  url: string | null
  snippet: string | null
  /** Wave 139H (brand listening) — the fields both engines already return and this mapper used to
   *  drop: WHO wrote it (Exa `author`), WHEN it was published (Exa `publishedDate` / Tavily
   *  `published_date`) and the engine's own relevance score 0..1. Null when the engine gave none —
   *  never guessed. Read by lib/competitive-intel/brand-listening.ts (mention author / published_at /
   *  reach index). */
  author?: string | null
  publishedAt?: string | null
  score?: number | null
}

export interface WebSearchResult {
  /** Synthesized answer (Tavily only); null when unavailable. */
  answer: string | null
  hits: WebSearchHit[]
  provider: "tavily" | "exa" | "none"
  cost: number
  /** final = the provider reported the charge (Exa costDollars); estimated = credits × list price. */
  costBasis?: "final" | "estimated"
  /** true when `spend` was given and the search's cost landed on vendor_usage_tracking. */
  booked?: boolean
}

/**
 * WHO THE SEARCH'S SPEND BELONGS TO (wave 139, lane 139C). Six callers reached Exa / Tavily through
 * this helper and booked NOTHING (the agentic-API invoke + MCP routes, the AI-search citation monitor,
 * the capability radar, content topics); the two that did book (perplexity-enrichment,
 * regulatory-watcher's caller) metered the returned cost themselves and still do — they omit `spend`.
 * Search / listening / research is PLATFORM-COVERED (owner, wave 139): tenant-attributed when a tenant
 * exists, `platformPaid` when none does (m750). Never billed to the tenant separately.
 */
interface WebSearchSpend {
  brokerageId: string | null
  systemSource: string
  platformPaid?: boolean
  idempotencyKey?: string | null
}

type TavilyFn = typeof tavilySearch
type ExaFn = typeof exaSearch

async function viaExa(exa: ExaFn, query: string, max: number, withinDays?: number): Promise<WebSearchResult | null> {
  const startPublishedDate = withinDays && withinDays > 0 ? new Date(Date.now() - withinDays * 86_400_000).toISOString() : undefined
  const e = await exa({ query, numResults: max, ...(startPublishedDate ? { startPublishedDate } : {}) })
  if ((e.results?.length ?? 0) === 0) return null
  return {
    answer: null,
    hits: e.results.map((r) => ({ title: r.title, url: r.url, snippet: r.text, author: r.author ?? null, publishedAt: r.publishedDate ?? null, score: r.score ?? null })),
    provider: "exa",
    cost: e.cost ?? 0,
    costBasis: e.costBasis ?? "estimated",
  }
}

async function viaTavily(tavily: TavilyFn, query: string, max: number, deep: boolean, withinDays?: number): Promise<WebSearchResult | null> {
  const t = await tavily({ query, maxResults: max, searchDepth: deep ? "advanced" : "basic", includeAnswer: true, ...(withinDays && withinDays > 0 ? { days: withinDays } : {}) })
  if ((t.results?.length ?? 0) === 0 && !t.answer) return null
  return {
    answer: t.answer,
    hits: (t.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content, author: null, publishedAt: r.publishedDate ?? null, score: r.score ?? null })),
    provider: "tavily",
    cost: t.cost ?? 0,
    costBasis: "estimated",
  }
}

/**
 * Pure: primary→fallback merge over injected searchers.
 *   mode "intent"   → Exa primary (behavior/intent discovery), Tavily fallback.
 *   mode "research" → Tavily primary (synthesized answer), Exa fallback.
 */
export async function runWebSearch(
  params: { query: string; maxResults?: number; deep?: boolean; mode?: WebSearchMode; withinDays?: number },
  deps: { tavily: TavilyFn; exa: ExaFn },
): Promise<WebSearchResult> {
  const max = params.maxResults ?? 8
  const deep = params.deep ?? false
  const mode = params.mode ?? "intent"
  // Recency window (wave 139H): unset → both engines search exactly as before.
  const days = params.withinDays

  if (mode === "research") {
    const primary = await viaTavily(deps.tavily, params.query, max, deep, days)
    if (primary) return primary
    const fallback = await viaExa(deps.exa, params.query, max, days)
    if (fallback) return fallback
  } else {
    const primary = await viaExa(deps.exa, params.query, max, days)
    if (primary) return primary
    const fallback = await viaTavily(deps.tavily, params.query, max, deep, days)
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
  /** Only content published in the last N days (Exa startPublishedDate / Tavily days). */
  withinDays?: number
  spend?: WebSearchSpend
}, deps: { tavily?: TavilyFn; exa?: ExaFn; meter?: typeof meterVendorSpend } = {}): Promise<WebSearchResult> {
  // deps: injectable searchers + meter for the proof (scripts/cost-completeness-guard.ts) — never set in production.
  const res = await runWebSearch(params, { tavily: deps.tavily ?? tavilySearch, exa: deps.exa ?? exaSearch })
  if (!params.spend) return res
  return { ...res, booked: await bookWebSearchSpend(res, params.spend, { meter: deps.meter }) }
}

/** Book ONE search's spend under the provider that SERVED it (a "none" result spent nothing). */
async function bookWebSearchSpend(
  res: Pick<WebSearchResult, "provider" | "cost" | "costBasis">,
  spend: WebSearchSpend,
  deps: { meter?: typeof meterVendorSpend } = {},
): Promise<boolean> {
  if (res.provider === "none" || !(res.cost > 0)) return false
  return (deps.meter ?? meterVendorSpend)({
    vendorName: res.provider,
    usageType: "web_search",
    cost: res.cost,
    unitCount: 1,
    brokerageId: spend.brokerageId,
    platformPaid: spend.platformPaid,
    systemSource: spend.systemSource,
    priceState: "variable",
    costBasis: res.costBasis ?? "estimated",
    coverage: "platform_covered",
    idempotencyKey: spend.idempotencyKey ?? null,
  })
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
