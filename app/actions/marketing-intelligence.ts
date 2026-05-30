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

export interface TrendingKeyword {
  keyword: string
  searchVolume: number | null
  competitionScore: number | null
  trendChangePct: number | null
  intentCategory: string | null
  relatedKeywords: string[]
  zipCode: string | null
}

export interface CompetitorPost {
  id: string
  competitorName: string
  platform: string
  contentType: string
  caption: string | null
  contentUrl: string | null
  mediaUrl: string | null
  postedAt: string | null
  likesCount: number | null
  engagementRate: number | null
  detectedTopics: string[]
  detectedKeywords: string[]
  hookType: string | null
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
        "intent_category, related_keywords, zip_code"
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
  }>).map((row) => ({
    keyword: row.keyword,
    searchVolume: row.search_volume_monthly,
    competitionScore: row.competition_score,
    trendChangePct: row.trend_change_pct,
    intentCategory: row.intent_category,
    relatedKeywords: row.related_keywords ?? [],
    zipCode: row.zip_code,
  }))
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
        "likes_count, engagement_rate, detected_topics, detected_keywords, hook_type, " +
        "competitor_id, competitor_profiles!inner(competitor_name)"
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
    engagement_rate: number | null
    detected_topics: string[] | null
    detected_keywords: string[] | null
    hook_type: string | null
    competitor_profiles: { competitor_name: string } | { competitor_name: string }[] | null
  }>).map((row) => ({
    id: row.id,
    competitorName: Array.isArray(row.competitor_profiles)
      ? row.competitor_profiles[0]?.competitor_name ?? "Unknown"
      : row.competitor_profiles?.competitor_name ?? "Unknown",
    platform: row.platform,
    contentType: row.content_type,
    caption: row.caption,
    contentUrl: row.content_url,
    mediaUrl: row.media_url,
    postedAt: row.posted_at,
    likesCount: row.likes_count,
    engagementRate: row.engagement_rate,
    detectedTopics: row.detected_topics ?? [],
    detectedKeywords: row.detected_keywords ?? [],
    hookType: row.hook_type,
  }))
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
    .select("detected_topics, detected_keywords, hook_type, emotional_tone, content_type, platform")
    .eq("id", competitorPostId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()

  if (error || !data) return null

  const row = data as unknown as {
    detected_topics: string[] | null
    detected_keywords: string[] | null
    hook_type: string | null
    emotional_tone: string | null
    content_type: string
    platform: string
  }

  const inspirationPrompt =
    `Create a ${row.platform} ${row.content_type} on the topic of ` +
    `"${(row.detected_topics ?? []).join(", ")}" using a ${row.hook_type ?? "story"} hook. ` +
    `Emotional tone: ${row.emotional_tone ?? "warm and informative"}. ` +
    `Target keywords: ${(row.detected_keywords ?? []).join(", ")}. ` +
    `Apply MY brand voice — do not copy the original. Lead with audience value (Them First).`

  return {
    topics: row.detected_topics ?? [],
    keywords: row.detected_keywords ?? [],
    hookType: row.hook_type,
    emotionalTone: row.emotional_tone,
    inspirationPrompt,
  }
}
