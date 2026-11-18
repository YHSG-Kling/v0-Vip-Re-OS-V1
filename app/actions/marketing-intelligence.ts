"use server"

/**
 * MARKETING INTELLIGENCE — keyword + competitor reads
 *
 * Server actions consumed by content creation surfaces:
 *   - Marketing Studio: trending keywords for the agent's market
 *   - Newsletter / Blog editors: keyword suggestions ranked by search volume
 *   - Omnipresence: competitor high-performing posts to draw inspiration from
 *
 * NOTE: These actions read from keyword_intelligence and competitor_content.
 * Population of those tables is handled by background scrapers (Google Trends,
 * Facebook Ad Library, social listening) running on cron — outside this file.
 *
 * SECURITY: Every export is auth-gated and tenant-scoped via getAgentContext().
 * Caller-supplied brokerageId is IGNORED — we always derive it from the
 * authenticated session. Cross-tenant reads are not possible from this surface.
 */

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { displaySearchVolume, type VolumeBasisKind } from "@/lib/content-intel/search-demand-volume"

export interface TrendingKeyword {
  keyword: string
  /** A search COUNT — non-null ONLY from a licensed keyword-volume source (wave 154, lane 154B; none is licensed today, so
   *  this is null for every row). The stored number of an Exa / NewsAPI row is a RELATIVE index — see relativeIndex. */
  searchVolume: number | null
  /** The relative index (0–100) when the row's source is one — never a number of searches. */
  relativeIndex: number | null
  /** What the number is: licensed_volume / relative_index / unknown, with its plain-words label. */
  volumeBasis: VolumeBasisKind
  volumeLabel: string
  competitionScore: number | null
  trendChangePct: number | null
  intentCategory: string | null
  relatedKeywords: string[]
  zipCode: string | null
}

export interface CompetitorPost {
  id: string
  competitorName: string
  /** competitor_profiles.competitor_type — 'brokerage' from the watchlist scan
   *  (lib/competitive-intel/content-intel-scan.ts:114); other values when a
   *  profile is added by hand. Lets the panel say what KIND of rival this is. */
  competitorType: string | null
  platform: string
  contentType: string
  caption: string | null
  contentUrl: string | null
  mediaUrl: string | null
  postedAt: string | null
  likesCount: number | null
  commentsCount: number | null
  sharesCount: number | null
  viewsCount: number | null
  /** likes + comments + shares + views over whichever hard counts exist.
   *  NULL — not 0 — when every count is NULL, which is every row the Exa scan
   *  writes (hard counts need platform auth; content-intel-scan.ts:165 keeps
   *  them honest-NULL). A 0 here would read as "nobody interacted". */
  interactionsTotal: number | null
  engagementRate: number | null
  /** Provenance of engagementRate, from raw_engagement_data.source: 'exa' means
   *  a citation-weighted PROXY (0-100), not a platform metric. A UI that shows
   *  the number without this label presents a proxy as a fact. */
  engagementSource: string | null
  detectedTopics: string[]
  detectedKeywords: string[]
  hookType: string | null
  ctaPresent: boolean | null
}

/** Sum the hard interaction counts; null when none is known (see interactionsTotal). */
function sumInteractions(counts: Array<number | null | undefined>): number | null {
  const known = counts.filter((c): c is number => typeof c === "number")
  return known.length === 0 ? null : known.reduce((s, c) => s + c, 0)
}

/**
 * Get trending keywords for the agent's market — used to suggest topic ideas
 * in Marketing Studio, blog editor, newsletter editor, etc.
 */
export async function getTrendingKeywords(params: {
  brokerageId?: string // ignored — derived from session
  zipCodes?: string[]
  intentCategory?: string
  limit?: number
}): Promise<TrendingKeyword[]> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return []

  const supabase = await createClient()
  const limit = params.limit ?? 20

  let query = supabase
    .from("keyword_intelligence")
    .select(
      "keyword, search_volume_monthly, competition_score, trend_change_pct, " +
        "intent_category, related_keywords, zip_code, source"
    )
    .eq("brokerage_id", ctx.brokerageId)
    .eq("trend_direction", "rising")
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .order("trend_change_pct", { ascending: false })
    .limit(limit)

  if (params.zipCodes && params.zipCodes.length > 0) {
    query = query.in("zip_code", params.zipCodes)
  }
  if (params.intentCategory) {
    query = query.eq("intent_category", params.intentCategory)
  }

  const { data, error } = await query
  if (error || !data) return []

  return (data as unknown as Array<{
    keyword: string
    search_volume_monthly: number | null
    competition_score: number | null
    trend_change_pct: number | null
    intent_category: string | null
    related_keywords: string[] | null
    zip_code: string | null
    source: string | null
  }>).map((row) => {
    // WAVE 154 (lane 154B): the stored number is classified by its SOURCE before it is shown — the Exa / NewsAPI rows hold
    // a relative index, which used to reach the panel as "N searches". Only a licensed volume source yields a count.
    const vol = displaySearchVolume(row.source, row.search_volume_monthly)
    return {
    keyword: row.keyword,
    searchVolume: vol.searchCount,
    relativeIndex: vol.relativeIndex,
    volumeBasis: vol.basis.kind,
    volumeLabel: vol.basis.label,
    competitionScore: row.competition_score,
    trendChangePct: row.trend_change_pct,
    intentCategory: row.intent_category,
    relatedKeywords: row.related_keywords ?? [],
    zipCode: row.zip_code,
  }})
}

/**
 * SEARCH DEMAND — the dashboard reader for Google / search demand intelligence (wave 154, lane 154B; owner ruling R5(b),
 * directive B3 "Google regional demand / keywords → topical intelligence, content queue and market report ideas"). Runs
 * the search-demand producers for the SESSION tenant WITHOUT storing (intake null) and returns each producer's honest
 * status and its topic ideas. Never a person: the producers emit category labels, counts and relative indexes only.
 */
export async function getSearchDemandIntelligence(): Promise<
  | { ok: true; producers: Array<{ producer: string; status: string; reason: string | null; caveats: string[]; ideas: Array<{ title: string; angle: string | null; evidence: { kind: string; metric: string | null; value: number | null; unit: string | null; note: string | null }; categories: string[] }> }> }
  | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { ok: false, error: "Unauthorized" }
  const supabase = await createClient()
  const { data: br, error: brErr } = await supabase.from("brokerages").select("city, state").eq("id", ctx.brokerageId).maybeSingle()
  if (brErr) console.error("[marketing-intelligence] brokerage geo read refused:", brErr.message)
  const sd = await import("@/lib/content-intel/search-demand")
  const r = await sd.runSearchDemandScan(supabase, {
    brokerageId: ctx.brokerageId,
    geo: { city: (br as { city?: string | null } | null)?.city ?? null, state: (br as { state?: string | null } | null)?.state ?? null },
  }, { intake: null, trends: sd.productionTrendsTransport(), searchConsole: sd.productionSearchConsoleTransport() })
  return {
    ok: true,
    producers: r.producers.map((p) => ({
      producer: p.producer, status: p.status, reason: p.reason, caveats: p.caveats,
      ideas: p.ideas.slice(0, 8).map((i) => ({
        title: i.title, angle: i.angle ?? null, categories: i.categories ?? [],
        evidence: { kind: i.evidence.kind, metric: i.evidence.metric ?? null, value: i.evidence.value ?? null, unit: i.evidence.unit ?? null, note: i.evidence.note ?? null },
      })),
    })),
  }
}

/**
 * Get high-performing competitor posts in the agent's market. Surfaces in
 * Omnipresence as "what's working for competitors" inspiration.
 */
export async function getCompetitorHighPerformers(params: {
  brokerageId?: string // ignored — derived from session
  daysBack?: number
  platform?: string
  limit?: number
}): Promise<CompetitorPost[]> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return []

  const supabase = await createClient()
  const daysBack = params.daysBack ?? 14
  const limit = params.limit ?? 20
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString()

  let query = supabase
    .from("competitor_content")
    .select(
      "id, platform, content_type, caption, content_url, media_url, posted_at, " +
        "likes_count, comments_count, shares_count, views_count, engagement_rate, raw_engagement_data, " +
        "detected_topics, detected_keywords, hook_type, cta_present, " +
        "competitor_id, competitor_profiles!inner(competitor_name, competitor_type)"
    )
    .eq("brokerage_id", ctx.brokerageId)
    .eq("is_high_performing", true)
    .gte("observed_at", since)
    .order("engagement_rate", { ascending: false })
    .limit(limit)

  if (params.platform) {
    query = query.eq("platform", params.platform)
  }

  const { data, error } = await query
  if (error || !data) return []

  return (data as unknown as Array<{
    id: string
    platform: string
    content_type: string
    caption: string | null
    content_url: string | null
    media_url: string | null
    posted_at: string | null
    likes_count: number | null
    comments_count: number | null
    shares_count: number | null
    views_count: number | null
    engagement_rate: number | null
    raw_engagement_data: { source?: string | null } | null
    detected_topics: string[] | null
    detected_keywords: string[] | null
    hook_type: string | null
    cta_present: boolean | null
    competitor_profiles:
      | { competitor_name: string; competitor_type: string | null }
      | { competitor_name: string; competitor_type: string | null }[]
      | null
  }>).map((row) => {
    const profile = Array.isArray(row.competitor_profiles) ? row.competitor_profiles[0] : row.competitor_profiles
    return {
      id: row.id,
      competitorName: profile?.competitor_name ?? "Unknown",
      competitorType: profile?.competitor_type ?? null,
      platform: row.platform,
      contentType: row.content_type,
      caption: row.caption,
      contentUrl: row.content_url,
      mediaUrl: row.media_url,
      postedAt: row.posted_at,
      likesCount: row.likes_count,
      commentsCount: row.comments_count,
      sharesCount: row.shares_count,
      viewsCount: row.views_count,
      interactionsTotal: sumInteractions([row.likes_count, row.comments_count, row.shares_count, row.views_count]),
      engagementRate: row.engagement_rate,
      engagementSource: row.raw_engagement_data?.source ?? null,
      detectedTopics: row.detected_topics ?? [],
      detectedKeywords: row.detected_keywords ?? [],
      hookType: row.hook_type,
      ctaPresent: row.cta_present,
    }
  })
}

/**
 * "Repurpose this concept" — given a competitor post id, return the topic +
 * hook + keywords so the agent can recreate it in their own brand voice.
 *
 * Returns the building blocks; actual rewrite uses the agent's brand voice
 * profile via the AI content generation surface (NOT a direct copy).
 *
 * Tenant-scoped: caller can only access competitor_content rows owned by
 * their brokerage.
 */
export async function getCompetitorPostInspiration(
  competitorPostId: string
): Promise<{
  topics: string[]
  keywords: string[]
  hookType: string | null
  emotionalTone: string | null
  inspirationPrompt: string
} | null> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return null

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("competitor_content")
    .select("detected_topics, detected_keywords, hook_type, emotional_tone, cta_present, content_type, platform")
    .eq("id", competitorPostId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()

  if (error || !data) return null

  const row = data as unknown as {
    detected_topics: string[] | null
    detected_keywords: string[] | null
    hook_type: string | null
    emotional_tone: string | null
    cta_present: boolean | null
    content_type: string
    platform: string
  }

  // cta_present is the third leg of the brief beside hook_type and
  // emotional_tone: the scan classifies whether the rival's post asked for
  // anything (content-intel-scan.ts:177) and until now the repurpose prompt
  // never heard the answer. A post that won WITHOUT a CTA is a value play
  // worth keeping that way; one that won WITH a CTA earned its ask.
  const ctaDirective =
    row.cta_present === true  ? "The original closed with a call to action and still performed — keep a clear, low-pressure CTA. " :
    row.cta_present === false ? "The original had NO call to action — it won on value alone; lead with value and keep any CTA soft. " :
                                ""

  const inspirationPrompt =
    `Create a ${row.platform} ${row.content_type} on the topic of ` +
    `"${(row.detected_topics ?? []).join(", ")}" using a ${row.hook_type ?? "story"} hook. ` +
    `Emotional tone: ${row.emotional_tone ?? "warm and informative"}. ` +
    `Target keywords: ${(row.detected_keywords ?? []).join(", ")}. ` +
    ctaDirective +
    `Apply MY brand voice — do not copy the original. Lead with audience value (Them First).`

  return {
    topics: row.detected_topics ?? [],
    keywords: row.detected_keywords ?? [],
    hookType: row.hook_type,
    emotionalTone: row.emotional_tone,
    inspirationPrompt,
  }
}
