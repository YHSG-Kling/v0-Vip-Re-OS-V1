// lib/content-intel/newsapi-ai.ts
// ─────────────────────────────────────────────────────────────────────────────
// NEWSAPI.AI (Event Registry) adapter — the owner-selected news intelligence
// provider: real articles PLUS the semantic layer (per-article social score,
// concepts, sentiment) that plain headline APIs don't carry. One adapter, all
// egress through the connector gateway (which now also meters every call).
//
// KEY CASCADE (same licensing principle as before): the tenant's own connected
// key (integration_credentials provider 'newsapi_ai') wins; the platform env
// key NEWSAPI_AI_KEY is the fallback and must hold a plan licensed for SaaS
// use. No key → callers degrade honestly (pool/Exa-only).

import "server-only"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

const BASE = "https://eventregistry.org"

export interface NewsApiAiArticle {
  title: string
  body: string | null
  url: string
  dateTimePub: string | null
  source: string | null
  /** Event Registry's cross-network share count — a REAL popularity signal. */
  socialScore: number
  sentiment: number | null
  /** Semantic concept labels Event Registry tagged on the article. */
  concepts: string[]
}

export async function resolveNewsApiAiKey(
  svc: { from: (t: string) => any },
  brokerageId: string | null,
): Promise<string | null> {
  if (brokerageId) {
    const { data: cred } = await svc
      .from("integration_credentials")
      .select("api_key")
      .eq("brokerage_id", brokerageId)
      .eq("provider_name", "newsapi_ai")
      .eq("is_active", true)
      .maybeSingle()
    if (cred?.api_key) return cred.api_key as string
  }
  return process.env.NEWSAPI_AI_KEY || null
}

/**
 * Article search. sortBy 'date' = freshest local coverage (newsletter blocks);
 * sortBy 'socialScore' = what people actually SHARED (the trending/popularity
 * lane for keyword intelligence). Event Registry's documented getArticles
 * endpoint; the response's shareCounts/sentiment/concepts ride back typed.
 */
export async function searchNewsApiAiArticles(params: {
  apiKey: string
  keyword: string
  /** Extra keyword AND-ed in (e.g. a city name for local scoping). */
  locationKeyword?: string | null
  sortBy: "date" | "socialScore" | "rel"
  count?: number
  sinceDays?: number
}): Promise<NewsApiAiArticle[]> {
  const body: Record<string, unknown> = {
    action: "getArticles",
    resultType: "articles",
    articlesSortBy: params.sortBy,
    articlesCount: Math.min(params.count ?? 10, 50),
    lang: "eng",
    dataType: ["news"],
    includeArticleSocialScore: true,
    includeArticleSentiment: true,
    includeArticleConcepts: true,
    apiKey: params.apiKey,
    keyword: params.locationKeyword ? [params.keyword, params.locationKeyword] : params.keyword,
    keywordOper: "and",
  }
  if (params.sinceDays) {
    body.dateStart = new Date(Date.now() - params.sinceDays * 86_400_000).toISOString().slice(0, 10)
  }
  const res = await callConnector<{ articles?: { results?: Array<Record<string, any>> } }>({
    connector: "newsapi_ai",
    baseUrl: BASE,
    path: "/api/v1/article/getArticles",
    method: "POST",
    body,
  })
  if (!res.ok) return []
  const results = res.data?.articles?.results ?? []
  return results
    .filter((a) => a?.title && a?.url)
    .map((a) => ({
      title: String(a.title),
      body: a.body ? String(a.body).slice(0, 2000) : null,
      url: String(a.url),
      dateTimePub: a.dateTimePub ?? a.dateTime ?? null,
      source: a.source?.title ?? null,
      socialScore: Number(a.socialScore ?? a.shares?.facebook ?? 0) || 0,
      sentiment: typeof a.sentiment === "number" ? a.sentiment : null,
      concepts: Array.isArray(a.concepts)
        ? a.concepts.slice(0, 8).map((c: any) => String(c?.label?.eng ?? c?.label ?? "")).filter(Boolean)
        : [],
    }))
}
