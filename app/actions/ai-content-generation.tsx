"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { generateAIResponse } from "@/lib/ai"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { generateContent } from "@/lib/services/content-generation.service"
// THE canonical AI price table. There used to be a second one in this file
// (calculateAICost) keyed on a provider-prefixed namespace the system never
// emits — see the COST TRACKING note below for why it is gone.
import { calculateCost, type AIModel } from "@/lib/ai/cost-tracking"
// The one feature vocabulary shared by BOTH content-generation lanes.
import { CONTENT_GENERATION_FEATURES } from "@/lib/ai/content-features"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { applyBrandVoice } from "@/lib/kernel/brand-voice"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import {
  GENERATED_CONTENT_STATUSES,
  type GeneratedContentStatus,
  AB_TEST_VARIABLES,
  type ABTestVariable,
  type HashtagPlatform,
  type DescriptionType,
} from "./ai-content-generation.utils"

function parseAIJsonResponse(text: string) {
  let cleanText = text.trim()
  if (cleanText.startsWith("```json")) {
    cleanText = cleanText.replace(/^```json\s*/, "").replace(/```\s*$/, "")
  } else if (cleanText.startsWith("```")) {
    cleanText = cleanText.replace(/^```\s*/, "").replace(/```\s*$/, "")
  }
  return JSON.parse(cleanText.trim())
}

/**
 * Session-derived actor. Every write in this file that used to take an
 * agentId FROM THE CALLER now goes through here instead: a "use server"
 * action that trusts a caller-supplied tenant key lets any signed-in user
 * write into any brokerage.
 *
 * ID SPACES — verified against the live database, do not collapse with `??`:
 *   content_templates.agent_id            -> agents(id)
 *   content_calendar.agent_id             -> agents(id)   NOT NULL
 *   content_ab_tests.agent_id             -> agents(id)   NOT NULL
 *   content_generation_logs.agent_id      -> agents(id)   NOT NULL
 *   content_performance_tracking.agent_id -> agents(id)
 *   hashtag_performance.agent_id          -> agents(id)   NOT NULL
 *   seo_keywords.agent_user_id            -> users(id)    DIFFERENT SPACE
 *   seo_keywords.created_by               -> users(id)
 *   seo_keywords.brokerage_id             -> brokerages(id) NOT NULL
 *
 * brokerage_id must be stamped AT THE INSERT. Every RLS policy on the content
 * tables reads `(brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id())`
 * and brokerage_id is nullable, so a row written without it is readable by
 * EVERY brokerage on the platform. ai_generated_content is stricter still:
 * has_brokerage_access(NULL) returns false, so an unstamped insert there is
 * refused outright and the caller sees an empty result, not an error.
 */
type ContentActor = { agentId: string; userId: string; brokerageId: string }

async function requireContentActor(): Promise<
  { ok: true; actor: ContentActor } | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Not authenticated" }
  if (!ctx.brokerageId) {
    return { ok: false, error: "No brokerage on this account — finish account setup." }
  }
  if (!ctx.agentId) {
    return { ok: false, error: "No agent profile for this user yet — finish account setup." }
  }
  return {
    ok: true,
    actor: { agentId: ctx.agentId, userId: ctx.userId, brokerageId: ctx.brokerageId },
  }
}

// ============================================
// BRAND VOICE PROFILE
// ============================================

export async function getBrandVoiceProfile(agentId: string) {
  if (!isValidUUID(agentId)) {
    return {
      tone: "professional yet approachable",
      style: "conversational",
      keywords: ["expertise", "local market", "personalized service"],
      avoid_words: ["cheap", "deal", "discount"],
    }
  }

  const supabase = await createClient()

  const { data, error } = await supabase.from("brand_voice_profile").select("*").eq("agent_id", agentId).maybeSingle()

  if (error) {
    console.error("Error fetching brand voice profile:", error)
    return null
  }

  return data
}

export async function updateBrandVoiceProfile(data: {
  agentId: string
  tone?: string
  style?: string
  keywords?: string[]
  avoidWords?: string[]
  targetAudience?: string
  brandPersonality?: string
  contentGuidelines?: Record<string, unknown>
  examplePosts?: string[]
}) {
  const supabase = await createClient()
  const ctx = await getAgentContext()
  const agentId = ctx.agentId ?? data.agentId
  if (!agentId) throw new Error("No agent profile for this user yet — finish account setup.")

  const fields = {
    tone: data.tone,
    style: data.style,
    preferred_words: data.keywords,
    prohibited_words: data.avoidWords,
    target_audience: data.targetAudience,
    brand_personality: data.brandPersonality,
    content_guidelines: data.contentGuidelines,
    tone_examples: data.examplePosts,
    updated_at: new Date().toISOString(),
  }

  // NOT .upsert(). brand_voice_profile has no unique constraint on agent_id —
  // its only partial unique index covers (brokerage_id) WHERE agent_id IS NULL.
  // A bare upsert therefore conflict-targets the PRIMARY KEY, and with no id
  // supplied it can never conflict: every save INSERTED a brand-new profile.
  // getBrandVoiceProfile then calls .maybeSingle() over the duplicates and
  // errors out, which is why brand voice went blank after a second save.
  const { data: existing, error: readError } = await supabase
    .from("brand_voice_profile")
    .select("id")
    .eq("agent_id", agentId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (readError) throw readError

  const { data: profile, error } = existing
    ? await supabase.from("brand_voice_profile").update(fields).eq("id", existing.id).select().single()
    : await supabase
        .from("brand_voice_profile")
        .insert({ ...fields, agent_id: agentId, brokerage_id: ctx.brokerageId })
        .select()
        .single()

  if (error) throw error

  revalidatePath("/settings/brand-voice")
  return profile
}

// ============================================
// CONTENT TEMPLATES
// ============================================

export async function getContentTemplates(filters?: { category?: string; contentType?: string }): Promise<
  { success: true; templates: any[] } | { success: false; error: string }
> {
  const auth = await requireContentActor()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createClient()

  // Scope explicitly to this brokerage. The RLS policy alone would also admit
  // every untenanted (brokerage_id IS NULL) template on the platform.
  let query = supabase
    .from("content_templates")
    .select("*")
    .eq("brokerage_id", auth.actor.brokerageId)
    .eq("is_active", true)
    .order("usage_count", { ascending: false })

  if (filters?.category) {
    query = query.eq("category", filters.category)
  }
  if (filters?.contentType) {
    query = query.eq("content_type", filters.contentType)
  }

  const { data, error } = await query

  // A refused read is NOT an empty library. Say so.
  if (error) {
    console.error("[getContentTemplates] Query failed:", error)
    return { success: false, error: error.message }
  }

  return { success: true, templates: data ?? [] }
}

export async function saveContentTemplate(data: {
  templateName: string
  contentType: string
  category: string
  structure: Record<string, unknown>
  placeholders?: string[]
  seoGuidelines?: Record<string, unknown>
  exampleOutput?: string
}): Promise<{ success: true; template: any } | { success: false; error: string }> {
  const auth = await requireContentActor()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!data.templateName?.trim()) return { success: false, error: "Template name is required" }
  if (!data.contentType?.trim()) return { success: false, error: "Content type is required" }

  const supabase = await createClient()

  const { data: template, error } = await supabase
    .from("content_templates")
    .insert({
      // Tenant stamped AT THE INSERT — never patched on afterwards.
      brokerage_id: auth.actor.brokerageId,
      agent_id: auth.actor.agentId,
      template_name: data.templateName.trim(),
      content_type: data.contentType,
      category: data.category,
      structure: data.structure,
      placeholders: data.placeholders,
      seo_guidelines: data.seoGuidelines,
      example_output: data.exampleOutput,
      is_active: true,
    })
    .select()
    .single()

  if (error) {
    console.error("[saveContentTemplate] Insert failed:", error)
    return { success: false, error: error.message }
  }

  revalidatePath("/dashboard/content")
  return { success: true, template }
}

// ============================================
// AI GENERATED CONTENT
// ============================================

export async function getGeneratedContent(filters?: {
  contentType?: string
  status?: string
  limit?: number
}): Promise<{ success: true; content: any[] } | { success: false; error: string }> {
  const auth = await requireContentActor()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createClient()

  let query = supabase
    .from("ai_generated_content")
    .select("*")
    .eq("agent_id", auth.actor.agentId)
    .eq("brokerage_id", auth.actor.brokerageId)
    // Generation-log and usage-signal rows share this table; they are
    // bookkeeping, not drafts, and do not belong in a drafts list.
    .not("metadata->>is_log", "eq", "true")
    .not("metadata->>is_usage_signal", "eq", "true")
    .order("created_at", { ascending: false })
    .limit(filters?.limit ?? 100)

  if (filters?.contentType) {
    query = query.eq("content_type", filters.contentType)
  }
  if (filters?.status) {
    query = query.eq("status", filters.status)
  }

  const { data, error } = await query

  if (error) {
    console.error("[getGeneratedContent] Query failed:", error)
    return { success: false, error: error.message }
  }

  return { success: true, content: data ?? [] }
}

export async function createGeneratedContent(data: {
  contentType: string
  platform?: string
  title?: string
  content: string
  seoKeywords?: string[]
  hashtags?: string[]
  targetAudience?: string
  metadata?: Record<string, unknown>
  scheduledFor?: string
}): Promise<{ success: true; content: any } | { success: false; error: string }> {
  const auth = await requireContentActor()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!data.content?.trim()) return { success: false, error: "Content cannot be empty" }
  if (!data.contentType?.trim()) return { success: false, error: "Content type is required" }

  const supabase = await createClient()

  const { data: content, error } = await supabase
    .from("ai_generated_content")
    .insert({
      agent_id: auth.actor.agentId,
      // Without this the agc_insert policy (has_brokerage_access(brokerage_id))
      // refuses the row outright — has_brokerage_access(NULL) is false.
      brokerage_id: auth.actor.brokerageId,
      content_type: data.contentType,
      platform: data.platform,
      title: data.title,
      content: data.content,
      seo_keywords: data.seoKeywords,
      hashtags: data.hashtags,
      target_audience: data.targetAudience,
      metadata: data.metadata ?? {},
      scheduled_for: data.scheduledFor,
      status: data.scheduledFor ? "scheduled" : "draft",
      compliance_approved: false,
    })
    .select()
    .single()

  if (error) {
    console.error("[createGeneratedContent] Insert failed:", error)
    return { success: false, error: error.message }
  }

  revalidatePath("/dashboard/content")
  return { success: true, content }
}

export async function updateContentStatus(
  contentId: string,
  status: string,
  publishedUrl?: string
): Promise<{ success: true; content: any } | { success: false; error: string }> {
  const auth = await requireContentActor()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!isValidUUID(contentId)) return { success: false, error: "Invalid content ID" }
  if (!(GENERATED_CONTENT_STATUSES as readonly string[]).includes(status)) {
    return { success: false, error: `Unknown status "${status}"` }
  }

  const supabase = await createClient()

  const updateData: Record<string, unknown> = {
    status: status as GeneratedContentStatus,
    updated_at: new Date().toISOString(),
  }

  if (status === "published") {
    updateData.published_at = new Date().toISOString()
    updateData.published_url = publishedUrl
  }

  // Tenant-scope the predicate as well as relying on RLS: agc_update admits
  // any row this brokerage can see, and .eq("id") alone would happily target
  // an id guessed from another workspace if the policy ever loosens.
  const { data, error } = await supabase
    .from("ai_generated_content")
    .update(updateData)
    .eq("id", contentId)
    .eq("brokerage_id", auth.actor.brokerageId)
    .select()
    .maybeSingle()

  if (error) {
    console.error("[updateContentStatus] Update failed:", error)
    return { success: false, error: error.message }
  }
  if (!data) {
    return { success: false, error: "Content not found in your workspace" }
  }

  revalidatePath("/dashboard/content")
  return { success: true, content: data }
}

// ============================================
// SEO KEYWORDS
// ============================================

/**
 * The AGENT-SCOPED keyword list (seo_keywords.agent_user_id = this user).
 *
 * Deliberately NOT merged into blog.ts:getSeoKeywords — that one is
 * brokerage-wide (`.eq("brokerage_id", …)` only) and has no notion of an
 * individual agent's list. The two read the same table on different axes.
 *
 * seo_keywords.agent_user_id FKs users(id), NOT agents(id). Passing an
 * agents.id here is a guaranteed FK rejection on write and a silent
 * zero-row read.
 */
export async function getSEOKeywords(): Promise<
  { success: true; keywords: any[] } | { success: false; error: string }
> {
  const auth = await requireContentActor()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("seo_keywords")
    .select("*")
    .eq("brokerage_id", auth.actor.brokerageId)
    .eq("agent_user_id", auth.actor.userId) // users(id) — not agents(id)
    .eq("is_active", true)
    .order("search_volume", { ascending: false })

  if (error) {
    console.error("[getSEOKeywords] Query failed:", error)
    return { success: false, error: error.message }
  }

  return { success: true, keywords: data ?? [] }
}

export async function addSEOKeyword(data: {
  keyword: string
  searchVolume?: number
  competition?: number
  isPrimary?: boolean
}): Promise<{ success: true; keyword: any } | { success: false; error: string }> {
  const auth = await requireContentActor()
  if (!auth.ok) return { success: false, error: auth.error }

  const kw = data.keyword?.trim()
  if (!kw) return { success: false, error: "Keyword cannot be empty" }

  const supabase = await createClient()

  // Same-keyword guard within this agent's own list.
  const { data: existing, error: dupeError } = await supabase
    .from("seo_keywords")
    .select("id")
    .eq("brokerage_id", auth.actor.brokerageId)
    .eq("agent_user_id", auth.actor.userId)
    .eq("keyword", kw)
    .maybeSingle()

  if (dupeError) {
    console.error("[addSEOKeyword] Duplicate check failed:", dupeError)
    return { success: false, error: dupeError.message }
  }
  if (existing) return { success: false, error: "You are already tracking that keyword" }

  const { data: keyword, error } = await supabase
    .from("seo_keywords")
    .insert({
      agent_user_id: auth.actor.userId, // users(id)
      brokerage_id: auth.actor.brokerageId, // NOT NULL in the database
      created_by: auth.actor.userId, // users(id)
      visibility_scope: "agent", // CHECK member; 'private' is NOT one
      keyword: kw,
      // keyword_type is CHECK-constrained (primary/secondary/long_tail/local/question);
      // map the primary flag onto it.
      keyword_type: data.isPrimary ? "primary" : "secondary",
      search_volume: data.searchVolume,
      competition: data.competition,
      is_primary: data.isPrimary || false,
      is_active: true,
    })
    .select()
    .single()

  if (error) {
    console.error("[addSEOKeyword] Insert failed:", error)
    return { success: false, error: error.message }
  }

  revalidatePath("/dashboard/content")
  return { success: true, keyword }
}

// ============================================
// CONTENT PERFORMANCE TRACKING
// ============================================

export async function trackContentPerformance(data: {
  contentId: string
  platform: string
  impressions?: number
  clicks?: number
  likes?: number
  shares?: number
  comments?: number
  saves?: number
  engagement_rate?: number
  reach?: number
}): Promise<{ success: true; performance: any } | { success: false; error: string }> {
  const auth = await requireContentActor()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!isValidUUID(data.contentId)) return { success: false, error: "Invalid content ID" }
  if (!data.platform?.trim()) return { success: false, error: "Platform is required" }

  const supabase = await createClient()

  // The content must belong to this workspace before we attach numbers to it.
  const { data: owner, error: ownerError } = await supabase
    .from("ai_generated_content")
    .select("id")
    .eq("id", data.contentId)
    .eq("brokerage_id", auth.actor.brokerageId)
    .maybeSingle()

  if (ownerError) {
    console.error("[trackContentPerformance] Ownership check failed:", ownerError)
    return { success: false, error: ownerError.message }
  }
  if (!owner) return { success: false, error: "Content not found in your workspace" }

  // ON CONFLICT resolves against uq_content_performance_content_platform,
  // a real unique index on (content_id, platform) — verified live.
  const { data: performance, error } = await supabase
    .from("content_performance_tracking")
    .upsert(
      {
        content_id: data.contentId,
        platform: data.platform,
        agent_id: auth.actor.agentId,
        brokerage_id: auth.actor.brokerageId,
        impressions: data.impressions || 0,
        clicks: data.clicks || 0,
        likes: data.likes || 0,
        shares: data.shares || 0,
        comments: data.comments || 0,
        saves: data.saves || 0,
        engagement_rate: data.engagement_rate || 0,
        reach: data.reach || 0,
        last_synced_at: new Date().toISOString(),
      },
      { onConflict: "content_id,platform" }
    )
    .select()
    .single()

  if (error) {
    console.error("[trackContentPerformance] Upsert failed:", error)
    return { success: false, error: error.message }
  }

  revalidatePath("/dashboard/content")
  return { success: true, performance }
}

export async function getContentPerformanceStats(dateRange?: { start: string; end: string }): Promise<
  | {
      success: true
      stats: {
        totalImpressions: number
        totalEngagement: number
        avgEngagementRate: number
        topPerformingContent: Array<{ contentId: string; title: string; impressions: number; engagement: number }>
        performanceByType: Record<string, { impressions: number; engagement: number }>
      }
    }
  | { success: false; error: string }
> {
  const auth = await requireContentActor()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createClient()

  const { data: content, error: contentError } = await supabase
    .from("ai_generated_content")
    .select("id, title, content_type")
    .eq("agent_id", auth.actor.agentId)
    .eq("brokerage_id", auth.actor.brokerageId)

  if (contentError) {
    console.error("[getContentPerformanceStats] Content query failed:", contentError)
    return { success: false, error: contentError.message }
  }

  const rows = content ?? []
  if (rows.length === 0) {
    return {
      success: true,
      stats: {
        totalImpressions: 0,
        totalEngagement: 0,
        avgEngagementRate: 0,
        topPerformingContent: [],
        performanceByType: {},
      },
    }
  }

  const byId = new Map<string, { id: string; title: string | null; content_type: string | null }>(
    rows.map((c: any) => [c.id as string, c])
  )

  let query = supabase
    .from("content_performance_tracking")
    .select("*")
    .in("content_id", Array.from(byId.keys()))

  if (dateRange) {
    query = query.gte("created_at", dateRange.start).lte("created_at", dateRange.end)
  }

  const { data: performance, error: perfError } = await query

  if (perfError) {
    console.error("[getContentPerformanceStats] Performance query failed:", perfError)
    return { success: false, error: perfError.message }
  }

  const perf = performance ?? []
  const engagementOf = (p: any) => (p.likes || 0) + (p.shares || 0) + (p.comments || 0) + (p.saves || 0)

  const totalImpressions = perf.reduce((sum, p) => sum + (p.impressions || 0), 0)
  const totalEngagement = perf.reduce((sum, p) => sum + engagementOf(p), 0)
  const avgEngagementRate =
    perf.length > 0 ? perf.reduce((sum, p) => sum + Number(p.engagement_rate || 0), 0) / perf.length : 0

  // performanceByType and topPerformingContent used to be hardcoded []/{} —
  // the screen showed a shape with nothing in it no matter what was tracked.
  const performanceByType: Record<string, { impressions: number; engagement: number }> = {}
  const perContent = new Map<string, { impressions: number; engagement: number }>()

  for (const p of perf) {
    const meta = byId.get(p.content_id)
    const type = meta?.content_type || "unknown"
    if (!performanceByType[type]) performanceByType[type] = { impressions: 0, engagement: 0 }
    performanceByType[type].impressions += p.impressions || 0
    performanceByType[type].engagement += engagementOf(p)

    const agg = perContent.get(p.content_id) ?? { impressions: 0, engagement: 0 }
    agg.impressions += p.impressions || 0
    agg.engagement += engagementOf(p)
    perContent.set(p.content_id, agg)
  }

  const topPerformingContent = Array.from(perContent.entries())
    .map(([contentId, agg]) => ({
      contentId,
      title: byId.get(contentId)?.title || "Untitled",
      impressions: agg.impressions,
      engagement: agg.engagement,
    }))
    .sort((a, b) => b.engagement - a.engagement)
    .slice(0, 5)

  return {
    success: true,
    stats: { totalImpressions, totalEngagement, avgEngagementRate, topPerformingContent, performanceByType },
  }
}

// ============================================
// HASHTAG PERFORMANCE
// ============================================

export async function getHashtagPerformance(): Promise<
  { success: true; hashtags: any[] } | { success: false; error: string }
> {
  const auth = await requireContentActor()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("hashtag_performance")
    .select("*")
    .eq("agent_id", auth.actor.agentId)
    .eq("brokerage_id", auth.actor.brokerageId)
    // avg_engagement is now actually written by trackHashtagUsage below. It
    // previously never was, so this ORDER BY sorted every row on a NULL and
    // the "leaderboard" was in arbitrary order.
    .order("avg_engagement", { ascending: false, nullsFirst: false })
    .limit(20)

  if (error) {
    console.error("[getHashtagPerformance] Query failed:", error)
    return { success: false, error: error.message }
  }

  return { success: true, hashtags: data ?? [] }
}

export async function trackHashtagUsage(data: {
  hashtag: string
  platform?: string
  engagement: number
  reach: number
}): Promise<{ success: true; hashtag: any } | { success: false; error: string }> {
  const auth = await requireContentActor()
  if (!auth.ok) return { success: false, error: auth.error }

  const tag = data.hashtag?.trim()
  if (!tag) return { success: false, error: "Hashtag cannot be empty" }
  if (!Number.isFinite(data.engagement) || data.engagement < 0) {
    return { success: false, error: "Engagement must be a non-negative number" }
  }
  if (!Number.isFinite(data.reach) || data.reach < 0) {
    return { success: false, error: "Reach must be a non-negative number" }
  }

  const normalized = tag.startsWith("#") ? tag : `#${tag}`
  const platform = data.platform?.trim() || "all"
  const supabase = await createClient()

  const { data: existing, error: readError } = await supabase
    .from("hashtag_performance")
    .select("*")
    .eq("agent_id", auth.actor.agentId)
    .eq("brokerage_id", auth.actor.brokerageId)
    .eq("hashtag", normalized)
    .eq("platform", platform)
    .maybeSingle()

  // A refused read here would have been silently treated as "no row exists"
  // and turned an update into a duplicate insert.
  if (readError) {
    console.error("[trackHashtagUsage] Read failed:", readError)
    return { success: false, error: readError.message }
  }

  if (existing) {
    const priorCount = existing.posts_count || 0
    const newPostsCount = priorCount + 1
    // engagement/reach are INTEGER columns holding cumulative totals; the
    // running average belongs in avg_engagement (numeric), which is what the
    // leaderboard sorts by.
    const newEngagement = (existing.engagement || 0) + Math.round(data.engagement)
    const newReach = (existing.reach || 0) + Math.round(data.reach)

    const { data: updated, error } = await supabase
      .from("hashtag_performance")
      .update({
        posts_count: newPostsCount,
        engagement: newEngagement,
        reach: newReach,
        avg_engagement: newEngagement / newPostsCount,
        last_used_at: new Date().toISOString(),
      })
      .eq("id", existing.id)
      .select()
      .single()

    if (error) {
      console.error("[trackHashtagUsage] Update failed:", error)
      return { success: false, error: error.message }
    }

    revalidatePath("/dashboard/content")
    return { success: true, hashtag: updated }
  }

  const { data: created, error } = await supabase
    .from("hashtag_performance")
    .insert({
      agent_id: auth.actor.agentId,
      brokerage_id: auth.actor.brokerageId,
      hashtag: normalized,
      platform,
      posts_count: 1,
      engagement: Math.round(data.engagement),
      reach: Math.round(data.reach),
      avg_engagement: data.engagement,
    })
    .select()
    .single()

  if (error) {
    console.error("[trackHashtagUsage] Insert failed:", error)
    return { success: false, error: error.message }
  }

  revalidatePath("/dashboard/content")
  return { success: true, hashtag: created }
}

// ============================================
// CONTENT A/B TESTS
// ============================================

// createContentABTest lived here. It was DELETED in favour of
// `createABTest` (below in the A/B TESTING SYSTEM section), which does the
// same job — insert one row into content_ab_tests representing one test —
// and additionally generates variant B with the AI variant writer instead of
// demanding the caller already have two pieces of content.
//
// Ported onto the survivor BEFORE the deletion, because createABTest lacked
// all four:
//   1. agent_id stamping        (content_ab_tests.agent_id is NOT NULL; without
//                                it every createABTest call died on SQLSTATE
//                                23502 — verified live. It could never have run.)
//   2. test_metric              (the metric the test is judged on)
//   3. target_sample_size       (the caller-declared target, distinct from
//                                sample_size_per_variant)
//   4. an explicit variant-B path, so a caller that ALREADY has two pieces of
//      content can register them directly — createContentABTest's only
//      distinctive behaviour.
// brokerage_id stamping was added at the same time; it was absent from both.

/**
 * Record externally-measured results on a test.
 *
 * Kept alongside analyzeABTest deliberately: analyzeABTest DERIVES the winner
 * from content_performance_tracking, while this one accepts numbers the agent
 * measured elsewhere (a platform export, an email tool). Neither can do the
 * other's job, so neither is a duplicate of the other.
 */
export async function updateABTestResults(
  testId: string,
  results: {
    variantA: Record<string, unknown>
    variantB: Record<string, unknown>
    winner?: "A" | "B"
  }
): Promise<{ success: true; test: any } | { success: false; error: string }> {
  const auth = await requireContentActor()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!isValidUUID(testId)) return { success: false, error: "Invalid test ID" }
  if (results.winner && results.winner !== "A" && results.winner !== "B") {
    return { success: false, error: "Winner must be A or B" }
  }

  const supabase = await createClient()

  const { data: test, error } = await supabase
    .from("content_ab_tests")
    .update({
      variant_a_performance: results.variantA,
      variant_b_performance: results.variantB,
      winner: results.winner ?? null,
      // CHECK (status IN ('running','completed','cancelled')). This used to
      // write "active", which the constraint refuses outright — verified live,
      // SQLSTATE 23514. Every no-winner save was rejected.
      status: results.winner ? "completed" : "running",
      completed_at: results.winner ? new Date().toISOString() : null,
    })
    .eq("id", testId)
    .eq("brokerage_id", auth.actor.brokerageId)
    .select()
    .maybeSingle()

  if (error) {
    console.error("[updateABTestResults] Update failed:", error)
    return { success: false, error: error.message }
  }
  if (!test) return { success: false, error: "Test not found in your workspace" }

  revalidatePath("/dashboard/content")
  return { success: true, test }
}

// ============================================
// CONTENT GENERATION LOGS
// ============================================
//
// ── CONSOLIDATION, m386 ────────────────────────────────────────────────────
// TWO functions in this file wrote the SAME generation telemetry — model,
// token counts, elapsed ms, success flag, error message — into TWO different
// tables. They are now ONE.
//
//   DELETED   logContentGeneration → ai_generated_content, telemetry buried in
//             metadata under is_log = true. THAT TABLE HAS NO success, NO
//             generation_time_ms AND NO tokens_used COLUMN — verified against
//             the live schema — so its only reader, getContentGenerationStats,
//             selected three columns that do not exist and reported
//             0% success / 0ms / 0 tokens on every call it ever made. Same
//             defect class as the analyzeABTest / engagement_metrics bug.
//             It also took agentId FROM THE CALLER on a "use server" export,
//             returned hard-coded demo numbers (156 / 98.5 / 2.3 / 45230) for
//             a non-uuid id, and shared its name with
//             lib/content-generation/generation-logger.ts::logContentGeneration,
//             which writes an entirely different row into `activities`. That
//             name collision is why "what has this agent generated?" returned
//             half the truth depending on which lane you asked.
//
//   SURVIVOR  logGenerationCost → content_generation_logs, which carries a
//             typed column for every one of those fields plus cost_usd.
//             Session-resolved actor, brokerage_id stamped at the insert,
//             error destructured and returned.
//
// DELETED   getContentGenerationStats. Its four fields are served, correctly
//           and from the table that actually has the columns, by
//           getMonthlyAICosts (volume, cost, and now total_tokens — ported
//           below) and getContentPerformanceMetrics (avg_generation_time_ms,
//           usage_rate). The surviving getContentGenerationStats is the one in
//           lib/content-generation/generation-logger.ts, which aggregates
//           `activities` and is correct against its own writer.
//
// PORTED BEFORE DELETING: the prompt text. logContentGeneration stored the
// first 500 chars of the prompt; content_generation_logs had nowhere to put
// it, so m386 adds `prompt text` and logGenerationCost now writes it. Nothing
// the deleted pair could record is unrecordable now.
//
// CONTENT-GENERATION HISTORY NOW LIVES IN EXACTLY TWO PLACES, by design:
//   · `activities`               — the draft-only System 4.1 lane
//     (app/actions/content-generation-engine.ts). One signal row per
//     generation, no raw content. Read by generation-logger's history/stats.
//   · `content_generation_logs`  — the Content OS per-ARTIFACT telemetry lane:
//     content_id, content_type, prompt, success/error_message and elapsed ms
//     for one generated piece. Read by getContentPerformanceMetrics.
//     NO LONGER THE COST SOURCE OF RECORD — see logGenerationCost's header.
// `ai_generated_content` keeps ARTIFACTS (and usage signals), never telemetry.
//
// COST, separately and for the whole platform, lives in `ai_tool_usage`
// (lib/ai/cost-tracking.ts::logAIUsage). getMonthlyAICosts reads THAT, filtered
// by CONTENT_GENERATION_FEATURES so it spans both content lanes.

// ============================================
// AI CONTENT GENERATION FUNCTIONS
// ============================================

export async function generateListingDescription(params: {
  propertyId?: string
  agentId: string
  targetPersona?: string
  length: "short" | "medium" | "long"
  emphasize?: string[]
  propertyDetails?: any
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  // Hoisted so the FAILURE log can record the real prompt and elapsed time.
  // The deleted logContentGeneration was handed the literal string
  // "Error occurred" here, so every failed listing description was logged
  // against a prompt nobody wrote.
  let promptText: string | null = null
  const startTime = Date.now()

  try {
    // ── LAYER 0.1: Feature Access Gate ────────────────────────────────────────
    const agentContext = await getAgentContext()
    const featureCheck = await canAccessFeature(agentContext.userId, "ai_listing_generation")
    if (!featureCheck.allowed) {
      return { success: false, error: featureCheck.reason || "Feature access denied" }
    }

    const supabase = await createClient()

    let propertyData = params.propertyDetails
    if (params.propertyId && isValidUUID(params.propertyId)) {
      const { data } = await supabase.from("listings").select("*").eq("id", params.propertyId).single()
      propertyData = data
    }

    const { data: brandVoice } = await supabase
      .from("brand_voice_profile")
      .select("*")
      .eq("agent_id", params.agentId)
      .maybeSingle()

    const prompt = buildListingDescriptionPrompt(propertyData, params, brandVoice)
    promptText = prompt

    const response = await generateAIResponse({
      prompt,
      metadata: {
        userId: agentContext.userId,
        brokerageId: agentContext.brokerageId,
        agentId: agentContext.agentId,
        feature: "listing_description",
      },
    })

    const result = parseAIJsonResponse(response.text)
    const generationTime = Date.now() - startTime

    const { data: savedContent, error: saveError } = await supabase
      .from("ai_generated_content")
      .insert({
        agent_id: params.agentId,
        // agc_insert is has_brokerage_access(brokerage_id), and
        // has_brokerage_access(NULL) is false — without this the row is
        // refused and contentId comes back undefined to every caller.
        brokerage_id: agentContext.brokerageId,
        property_id: params.propertyId,
        content_type: "listing_description",
        content_subtype: params.length,
        generated_content: result,
        target_persona: params.targetPersona,
        ai_model_used: response.model,
        compliance_status: result.compliance_status || "pending",
        seo_keywords: result.seo_keywords_used,
        compliance_approved: false,
      })
      .select()
      .single()

    if (saveError) {
      console.error("[generateListingDescription] Content insert failed:", saveError)
    }

    // Repointed off the deleted logContentGeneration onto the survivor. This
    // is a strict upgrade, not a like-for-like swap: the log now lands in
    // content_generation_logs where success / generation_time_ms / total_tokens
    // are REAL COLUMNS (they are not on ai_generated_content, which is why the
    // old reader reported zeroes), it books the actual cost from the split
    // prompt/completion counts instead of a single opaque total, and it links
    // the telemetry row to the artifact row via content_id.
    const costLog = await logGenerationCost({
      contentId: savedContent?.id,
      contentType: "listing_description",
      prompt,
      model: response.model,
      promptTokens: response.tokensUsed?.input,
      completionTokens: response.tokensUsed?.output,
      totalTokens: response.tokensUsed?.total,
      // The CANONICAL cost — the exact figure logAIUsage has already written to
      // ai_tool_usage.cost_cents for this same call. Passing it instead of
      // letting this row be re-priced is what makes the two ledgers agree.
      costUsd: response.costCents / 100,
      generationTimeMs: generationTime,
      success: true,
    })
    if (!costLog.success) {
      console.error("[generateListingDescription] Generation log failed:", costLog.error)
    }

    // ── LAYER 0.1: Track usage after successful generation ──────────────────
    await incrementFeatureUsage(agentContext.userId, "ai_listing_generation")

    revalidatePath("/dashboard/content")
    return { success: true, data: result, contentId: savedContent?.id }
  } catch (error) {
    console.error("Generate listing description error:", error)
    // model is deliberately omitted: a throw can happen before the model call,
    // and attributing a failure to a model that never ran would put a fake
    // charge in the cost ledger. logGenerationCost books $0 for a failure log.
    const failLog = await logGenerationCost({
      contentType: "listing_description",
      prompt: promptText ?? undefined,
      generationTimeMs: Date.now() - startTime,
      success: false,
      errorMessage: error instanceof Error ? error.message : "Unknown error",
    })
    if (!failLog.success) {
      console.error("[generateListingDescription] Failure log failed:", failLog.error)
    }
    return { success: false, error: "Failed to generate listing description" }
  }
}

/**
 * Generate social media post using consolidated service
 */
export async function generateSocialPost(params: {
  agentId: string
  platform: "facebook" | "linkedin" | "twitter" | "tiktok" | "instagram"
  postType: string
  context?: string
  propertyId?: string
  targetPersona?: string
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  try {
    // ── LAYER 0.1: Feature Access Gate ────────────────────────────────────────
    const agentContext = await getAgentContext()
    const featureCheck = await canAccessFeature(agentContext.userId, "ai_social_content")
    if (!featureCheck.allowed) {
      return { success: false, error: featureCheck.reason || "Feature access denied" }
    }

    // Use consolidated content generation service
    const result = await generateContent({
      agentId: params.agentId,
      contentType: "social_post",
      targetAudience: params.targetPersona || "general",
      context: {
        postType: params.postType,
        propertyId: params.propertyId,
        additionalContext: params.context,
      },
      platform: params.platform,
    })

    if (!result.success) {
      return { success: false, error: result.error || "Failed to generate social post" }
    }

    // ── BRAND VOICE & COMPLIANCE LAYER ────────────────────────────────────────
    const generatedContent = result.content?.generated_content || ""
    
    // Apply brand voice to ensure consistency
    const brandVoiceResult = await applyBrandVoice({
      brokerageId: agentContext.brokerageId ?? "",
      actorUserId: agentContext.userId,
      actorRole: agentContext.role,
      journeyType: "seller", // Default to seller for social posts
      persona: (params.targetPersona as any) || "homeowner",
      messageType: "social",
      content: generatedContent,
    })

    const finalContent = brandVoiceResult.violations.length === 0 ? brandVoiceResult.content : generatedContent

    // Check compliance (fair housing, brand guidelines)
    const complianceResult = await evaluateOutbound({
      actorContext: {
        userId: agentContext.userId,
        role: agentContext.role as any,
        brokerageId: agentContext.brokerageId ?? "",
      },
      journeyType: "seller",
      persona: (params.targetPersona as any) || "other",
      messageType: "social",
      content: finalContent,
      contact: {
        id: "",
        first_name: "",
        last_name: "",
        contact_type: "buyer",
        tcpa_consent: true,
        isa_reengage_allowed: false,
        dnc_status: false,
      },
    })

    if (!complianceResult.allowed) {
      console.error("[v0] Social post failed compliance:", complianceResult.violations)
      return {
        success: false,
        error: `Compliance check failed: ${complianceResult.violations?.join(", ")}`,
        violations: complianceResult.violations,
      }
    }

    // Update content with compliant version
    if (result.content?.id) {
      const supabase = await createClient()
      await supabase
        .from("ai_generated_content")
        .update({
          generated_content: finalContent,
          compliance_approved: true,
          compliance_status: "approved",
        })
        .eq("id", result.content.id)
    }

    // Log kernel event for content generation
    await processKernelEvent({
      event: KernelEvent.SOCIAL_POST_PUBLISHED,
      brokerageId: agentContext.brokerageId ?? "",
      entityType: "ai_generated_content",
      entityId: result.content?.id || "",
    })

    // ── LAYER 0.1: Track usage after successful generation ──────────────────
    await incrementFeatureUsage(agentContext.userId, "ai_social_content")

    revalidatePath("/dashboard/content/social")
    return {
      success: true,
      data: result.content,
      contentId: result.content?.id,
      caption: finalContent,
      hashtags: result.content?.hashtags ?? [],
    }
  } catch (error) {
    console.error("Generate social post error:", error)
    return handleError(error, "generateSocialPost")
  }
}

/**
 * Generate email content using consolidated service
 * This function now uses the unified content generation service
 */
export async function generateEmail(params: {
  agentId: string
  emailType: "welcome" | "follow_up" | "property_alert" | "market_update" | "check_in" | "reengagement" | "newsletter"
  contactId?: string
  propertyIds?: string[]
  targetPersona?: string
  context?: string
  urgency?: "low" | "medium" | "high"
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  try {
    // Use consolidated content generation service
    const result = await generateContent({
      agentId: params.agentId,
      contentType: "email",
      targetAudience: params.targetPersona || "general",
      context: {
        emailType: params.emailType,
        contactId: params.contactId,
        propertyIds: params.propertyIds,
        urgency: params.urgency,
        additionalContext: params.context,
      },
      platform: "email",
    })

    if (!result.success) {
      return { success: false, error: result.error || "Failed to generate email" }
    }

    // ── BRAND VOICE & COMPLIANCE LAYER ────────────────────────────────────────
    const agentContext = await getAgentContext()
    const generatedContent = result.content?.generated_content || ""
    
    // Apply brand voice to ensure consistency
    const brandVoiceResult = await applyBrandVoice({
      brokerageId: agentContext.brokerageId ?? "",
      actorUserId: agentContext.userId,
      actorRole: agentContext.role,
      journeyType: params.emailType === "welcome" || params.emailType === "follow_up" ? "buyer" : "seller",
      persona: (params.targetPersona as any) || "homebuyer",
      messageType: "email",
      content: generatedContent,
    })

    const finalContent = brandVoiceResult.violations.length === 0 ? brandVoiceResult.content : generatedContent

    // ── DNC & UNSUBSCRIBE CHECK ────────────────────────────────────────────────
    // Check compliance including DNC/opt-out verification for email channel
    const complianceResult = await evaluateOutbound({
      actorContext: {
        userId: agentContext.userId,
        role: agentContext.role as any,
        brokerageId: agentContext.brokerageId ?? "",
      },
      journeyType: params.emailType === "welcome" || params.emailType === "follow_up" ? "buyer" : "seller",
      persona: (params.targetPersona as any) || "other",
      messageType: "email",
      content: finalContent,
      contact: {
        id: params.contactId ?? "",
        first_name: "",
        last_name: "",
        contact_type: "buyer",
        tcpa_consent: true,
        isa_reengage_allowed: false,
        dnc_status: false,
      },
    })

    if (!complianceResult.allowed) {
      console.error("[v0] Email failed compliance:", complianceResult.violations)
      return {
        success: false,
        error: `Email cannot be sent: ${complianceResult.violations?.join(", ")}`,
        violations: complianceResult.violations,
      }
    }

    // Update content with compliant version
    if (result.content?.id) {
      const supabase = await createClient()
      await supabase
        .from("ai_generated_content")
        .update({
          generated_content: finalContent,
          compliance_approved: true,
          compliance_status: "approved",
        })
        .eq("id", result.content.id)
    }

    // Log kernel event for content generation
    await processKernelEvent({
      event: KernelEvent.EMAIL_CAMPAIGN_SENT,
      brokerageId: agentContext.brokerageId ?? "",
      entityType: "ai_generated_content",
      entityId: result.content?.id || "",
    })

    revalidatePath("/dashboard/content/email")
    return {
      success: true,
      data: result.content,
      contentId: result.content?.id,
      subject: result.content?.subject,
      body: finalContent,
    }
  } catch (error) {
    console.error("Generate email error:", error)
    return handleError(error, "generateEmail")
  }
}

export async function generateBlogPost(params: {
  agentId: string
  topic: string
  targetPersona?: string
  keywords?: string[]
  length?: number
  tone?: string
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()
  const startTime = Date.now()

  try {
    const { data: brandVoice } = await supabase
      .from("brand_voice_profile")
      .select("*")
      .eq("agent_id", params.agentId)
      .maybeSingle()

    const prompt = buildBlogPostPrompt(params, brandVoice)

    // Get agent context for AI routing
    const agentContext = await getAgentContext()

    const response = await generateAIResponse({
      prompt,
      metadata: {
        userId: agentContext.userId,
        brokerageId: agentContext.brokerageId,
        agentId: agentContext.agentId,
        feature: "blog_post_generation",
      },
    })

    const result = parseAIJsonResponse(response.text)
    const generationTime = Date.now() - startTime

    const { data: savedContent } = await supabase
      .from("ai_generated_content")
      .insert({
        agent_id: params.agentId,
        content_type: "blog_post",
        generated_content: result,
        target_persona: params.targetPersona,
        ai_model_used: response.model,
        compliance_status: "pending",
        seo_keywords: result.seo_keywords_used,
        compliance_approved: false,
      })
      .select()
      .single()

    // The keywords used are already stored on the content row above
    // (ai_generated_content.seo_keywords). The previous per-keyword insert into the seo_keywords
    // LIBRARY was redundant and invalid (a library entry is brokerage-scoped, not content-scoped, and
    // it omitted the required brokerage_id/visibility_scope) — removed to avoid duplication.

    // Repointed off the deleted logContentGeneration onto the survivor, exactly
    // as generateListingDescription was: content_generation_logs has success /
    // generation_time_ms / total_tokens as REAL COLUMNS, books the cost from the
    // split prompt/completion counts, and links telemetry to the artifact via
    // content_id. The old call also took agentId FROM THE CALLER on a
    // "use server" export; the survivor derives the actor from the session.
    const costLog = await logGenerationCost({
      contentId: savedContent?.id,
      contentType: "blog_post",
      prompt,
      model: response.model,
      promptTokens: response.tokensUsed?.input,
      completionTokens: response.tokensUsed?.output,
      totalTokens: response.tokensUsed?.total,
      // Canonical cost, same as ai_tool_usage booked. See logGenerationCost.
      costUsd: response.costCents / 100,
      generationTimeMs: generationTime,
      success: true,
    })
    if (!costLog.success) {
      console.error("[generateBlogPost] Generation log failed:", costLog.error)
    }

    revalidatePath("/dashboard/content/blog")
    return { success: true, data: result, contentId: savedContent?.id }
  } catch (error) {
    console.error("Generate blog post error:", error)
    // The failure half of the ledger. logGenerationCost takes `model` as
    // OPTIONAL precisely for this case — a catch block may never have reached
    // the model call, and refusing those would lose every failure record.
    await logGenerationCost({
      contentType: "blog_post",
      success: false,
      errorMessage: error instanceof Error ? error.message : "Unknown error",
    })
    return { success: false, error: "Failed to generate blog post" }
  }
}

// ============================================
// PROMPT BUILDERS
// ============================================

function buildListingDescriptionPrompt(propertyData: any, params: any, brandVoice: any): string {
  return `You are an expert real estate copywriter specializing in compelling listing descriptions.

CREATE LISTING DESCRIPTION for:

PROPERTY DETAILS:
${JSON.stringify(propertyData, null, 2)}

TARGET BUYER PERSONA: ${params.targetPersona || "general"}
${getPersonaGuidance(params.targetPersona)}

DESCRIPTION LENGTH: ${params.length}
- Short: 160 characters (social media preview)
- Medium: 500-800 words (MLS standard)
- Long: 1200+ words (dedicated property website)

${brandVoice ? `BRAND VOICE: Tone: ${brandVoice.tone}, Language: ${brandVoice.style}` : ""}

EMPHASIZE: ${params.emphasize?.join(", ") || "key features"}

WRITING STRUCTURE:

**HEADLINE:**
- Benefit-driven, not feature-driven
- Create emotional pull

**OPENING PARAGRAPH:**
Paint picture of LIVING here. Start with lifestyle vision.

**FEATURE HIGHLIGHTS:**
Present features as BENEFITS:
❌ "Granite countertops" 
✅ "Chef's kitchen with granite countertops perfect for entertaining"

**NEIGHBORHOOD SECTION:**
${getNeighborhoodGuidance(params.targetPersona)}

**COMPLIANCE:**
✓ No discriminatory language
✓ Use "Primary bedroom" not "Master bedroom"

POWER WORDS: Spacious, sun-drenched, updated, pristine, thoughtfully designed

OUTPUT FORMAT (JSON):
{
  "short_description": "160 char version",
  "medium_description": "500-800 words",
  "long_description": "1200+ words",
  "headline": "Benefit-driven headline",
  "key_features_bullets": ["5-7 features as benefits"],
  "neighborhood_paragraph": "Neighborhood section",
  "seo_keywords_used": ["keyword1", "keyword2"],
  "compliance_status": "approved",
  "compliance_flags": [],
  "target_persona_match_score": 0.87,
  "unique_selling_propositions": ["USP1", "USP2"]
}`
}

function buildSocialPostPrompt(params: any, brandVoice: any): string {
  const platformGuidance = getPlatformGuidance(params.platform, params.postType)

  return `${platformGuidance}

${brandVoice ? `BRAND VOICE: ${brandVoice.tone} tone, ${brandVoice.style} style` : ""}

TARGET PERSONA: ${params.targetPersona || "general"}

CONTEXT: ${params.context || "General real estate content"}

Generate engaging ${params.platform} post following platform best practices.

OUTPUT FORMAT (JSON):
{
  "post_text": "Main post content",
  "hashtags": ["hashtag1", "hashtag2"],
  "character_count": 280,
  "cta": "Call to action",
  "image_suggestions": ["suggestion1"],
  "best_posting_time": "9:00 AM",
  "variations": [{"text": "variation 1"}, {"text": "variation 2"}]
}`
}

function buildEmailPrompt(params: any, contactData: any, brandVoice: any): string {
  return `You are an expert email copywriter for real estate professionals.

CREATE: ${params.emailType} email

RECIPIENT PROFILE:
${contactData ? `- Name: ${contactData.first_name} ${contactData.last_name}
- Persona: ${contactData.buyer_persona || params.targetPersona}` : `- Persona: ${params.targetPersona || "general"}`}

${brandVoice ? `BRAND VOICE: ${brandVoice.tone}, ${brandVoice.style}` : ""}

URGENCY: ${params.urgency || "medium"}

EMAIL COMPONENTS TO GENERATE:

1. SUBJECT LINE (5 variations):
   - 40-50 characters optimal
   - Personalization when possible
   - Avoid spam triggers

2. PREVIEW TEXT (40-50 characters)

3. EMAIL BODY:
   - Personalized greeting
   - 3-4 short paragraphs
   - Single clear CTA

4. P.S. LINE

COMPLIANCE:
- No discriminatory language
- Unsubscribe link required

OUTPUT FORMAT (JSON):
{
  "subject_lines": [
    {"text": "...", "type": "question", "predicted_open_rate": 0.24}
  ],
  "preview_text": "...",
  "email_body_html": "<html>...</html>",
  "email_body_plain_text": "...",
  "ps_line": "...",
  "cta_button_text": "...",
  "estimated_read_time": 2,
  "spam_score": 0.3,
  "mobile_friendly": true
}`
}

function buildBlogPostPrompt(params: any, brandVoice: any): string {
  return `You are an expert real estate content writer.

CREATE BLOG POST:

TOPIC: ${params.topic}
TARGET PERSONA: ${params.targetPersona || "general"}
TARGET LENGTH: ${params.length || 1200} words
SEO KEYWORDS: ${params.keywords?.join(", ") || "None"}

${brandVoice ? `BRAND VOICE: ${brandVoice.tone}, ${brandVoice.style}` : ""}

STRUCTURE:
1. HEADLINE: SEO-optimized
2. INTRODUCTION: Hook with question
3. MAIN CONTENT: H2/H3 subheadings
4. ACTIONABLE TAKEAWAYS: 3-5 tips
5. CONCLUSION: Summary + CTA

OUTPUT FORMAT (JSON):
{
  "headline": "SEO headline",
  "meta_description": "155 chars",
  "introduction": "Opening paragraphs",
  "main_content_html": "<article>...</article>",
  "conclusion": "Closing",
  "key_takeaways": ["takeaway1"],
  "seo_keywords_used": ["keyword1"],
  "estimated_read_time": 6,
  "word_count": 1200
}`
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function getPersonaGuidance(persona?: string): string {
  const guidance: Record<string, string> = {
    first_time_buyer: "TONE: Reassuring, educational. INCLUDE: Move-in ready status.",
    luxury_buyer: "TONE: Sophisticated, exclusive. INCLUDE: Architectural details.",
    investor: "TONE: Data-driven. INCLUDE: Numbers, cash flow potential.",
    downsizer: "TONE: Practical. INCLUDE: Low-maintenance, single-level.",
    family_with_kids: "TONE: Warm. INCLUDE: Schools, safety, space.",
  }
  return guidance[persona || ""] || "TONE: Professional and engaging"
}

function getNeighborhoodGuidance(persona?: string): string {
  if (persona === "family_with_kids") return "Emphasize: Schools, parks, safety"
  if (persona === "young_professional") return "Emphasize: Commute times, walkability"
  if (persona === "investor") return "Emphasize: Rental potential, appreciation"
  return "Emphasize: Community, convenience"
}

function getPlatformGuidance(platform: string, postType: string): string {
  const guidance: Record<string, string> = {
    facebook: `Create Facebook post for ${postType}
SPECS: 40-80 characters optimal, questions drive engagement
STRUCTURE: Question opening, 2-4 paragraphs, 1-3 hashtags
TONE: Conversational, community-focused`,

    linkedin: `Create LinkedIn post for ${postType}
SPECS: 150-300 words, professional tone
STRUCTURE: Strong hook, professional insight, 3-5 hashtags
TONE: Professional but authentic`,

    twitter: `Create Twitter post for ${postType}
SPECS: 280 chars max, 120-160 optimal
STRUCTURE: Hook, value, 1-2 hashtags
TONE: Direct, valuable, concise`,

    tiktok: `Create TikTok caption for ${postType}
SPECS: Up to 2,200 chars, first 1-2 lines critical
STRUCTURE: Hook, context, value, CTA, 3-5 hashtags
TONE: Casual, energetic, authentic`,

    instagram: `Create Instagram post for ${postType}
SPECS: Up to 2,200 chars, first line critical
STRUCTURE: Hook, story, CTA, hashtags (20-30)
TONE: Visual-first, authentic`,
  }
  return guidance[platform] || "Create engaging social media post"
}

// ============================================
// AUTO-HASHTAG GENERATION
// ============================================

export async function generateHashtags(params: {
  content: string
  platform: HashtagPlatform
  propertyType?: string
  location?: string
  maxHashtags?: number
}): Promise<{ success: true; data: any } | { success: false; error: string }> {
  const auth = await requireContentActor()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!params.content?.trim()) return { success: false, error: "Content cannot be empty" }

  const supabase = await createClient()

  try {
    // Historical hashtag performance for THIS agent feeds the prompt.
    const { data: performanceData, error: perfError } = await supabase
      .from("hashtag_performance")
      .select("hashtag, avg_engagement")
      .eq("agent_id", auth.actor.agentId)
      .eq("brokerage_id", auth.actor.brokerageId)
      .order("avg_engagement", { ascending: false, nullsFirst: false })
      .limit(50)

    // A refused history read must not masquerade as "this agent has no history".
    if (perfError) {
      console.error("[generateHashtags] History read failed:", perfError)
      return { success: false, error: perfError.message }
    }

    const topPerformingHashtags = performanceData?.map((h) => h.hashtag) ?? []

    const prompt = `Analyze this content and generate optimal hashtag strategy for ${params.platform}:

CONTENT: "${params.content}"

CONTEXT:
- Platform: ${params.platform}
- Location: ${params.location || "Not specified"}
- Property Type: ${params.propertyType || "General real estate"}

HASHTAG STRATEGY REQUIREMENTS:

Mix of sizes:
- Broad reach (100k+ posts): Include 2-3 for discovery
  Examples: #RealEstate #HomeForSale #DreamHome
  
- Medium reach (10k-100k): Include 5-7 for targeted audience
  Examples: #${params.location}RealEstate #${params.propertyType}Homes
  
- Niche reach (<10k posts): Include 3-5 for engaged community
  Examples: Specific neighborhood, unique features

${topPerformingHashtags.length > 0 ? `HISTORICAL TOP PERFORMERS (prioritize these if relevant): ${topPerformingHashtags.slice(0, 10).join(", ")}` : ""}

PLATFORM-SPECIFIC RULES:
${getPlatformHashtagRules(params.platform)}

AVOID (Banned/Spammy):
- #FollowForFollow #Like4Like #InstaFollow
- Overly generic: #Love #Instagood #Beautiful
- Unrelated tags

OUTPUT FORMAT (JSON):
{
  "recommended_hashtags": {
    "high_reach": ["tag1", "tag2"],
    "medium_reach": ["tag1", "tag2"],
    "niche": ["tag1", "tag2"]
  },
  "platform_optimized_string": "all hashtags formatted for platform",
  "performance_prediction": "Estimated reach",
  "banned_tags_avoided": ["tag1"]
}`

    // Get agent context for AI routing
    const agentContext = await getAgentContext()

    const response = await generateAIResponse({
      prompt,
      metadata: {
        userId: agentContext.userId,
        brokerageId: agentContext.brokerageId,
        agentId: agentContext.agentId,
        feature: "tag_classification",
      },
    })

    const result = parseAIJsonResponse(response.text)

    return { success: true, data: result }
  } catch (error) {
    console.error("Generate hashtags error:", error)
    return { success: false, error: error instanceof Error ? error.message : "Failed to generate hashtags" }
  }
}

function getPlatformHashtagRules(platform: string): string {
  const rules: Record<string, string> = {
    instagram: "Total: 10-15 hashtags (optimal for reach), place in first comment OR at end of caption",
    facebook: "Total: 1-3 hashtags only, hashtags less effective on FB",
    linkedin: "Total: 3-5 professional hashtags, industry-specific",
    twitter: "Total: 1-2 hashtags maximum, more = lower engagement",
    tiktok: "Total: 3-5 hashtags, mix trending + niche",
  }
  return rules[platform] || "Use relevant hashtags only"
}

// ============================================
// BRAND VOICE LEARNING FROM EDITS
// ============================================

export async function learnFromEdits(params: {
  contentId: string
  originalContent: string
  editedContent: string
}): Promise<{ success: true; learnings: any } | { success: false; error: string }> {
  const auth = await requireContentActor()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!isValidUUID(params.contentId)) return { success: false, error: "Invalid content ID" }
  if (!params.originalContent?.trim() || !params.editedContent?.trim()) {
    return { success: false, error: "Both the original and the edited text are required" }
  }
  if (params.originalContent.trim() === params.editedContent.trim()) {
    return { success: false, error: "Nothing changed — there is nothing to learn from." }
  }

  const supabase = await createClient()

  try {
    // Confirm the piece is ours. agent_id is then taken from the SESSION, not
    // from the row, so a caller cannot steer learnings onto another profile.
    const { data: content, error: contentError } = await supabase
      .from("ai_generated_content")
      .select("id")
      .eq("id", params.contentId)
      .eq("brokerage_id", auth.actor.brokerageId)
      .maybeSingle()

    if (contentError) {
      console.error("[learnFromEdits] Content read failed:", contentError)
      return { success: false, error: contentError.message }
    }
    if (!content) return { success: false, error: "Content not found in your workspace" }

    const prompt = `Analyze the differences between AI-generated content and human-edited version to learn preferences:

ORIGINAL AI CONTENT:
"${params.originalContent}"

EDITED BY HUMAN:
"${params.editedContent}"

Analyze:
1. Tone adjustments (more formal/casual, energetic/calm, etc.)
2. Word substitutions (what words were removed/added)
3. Structural changes (paragraph breaks, formatting)
4. Recurring additions or deletions

OUTPUT FORMAT (JSON):
{
  "tone_adjustments": "description of tone changes",
  "words_to_avoid": ["word1", "word2"],
  "preferred_phrases": ["phrase1", "phrase2"],
  "style_notes": "summary of style preferences",
  "formality_shift": "more casual" or "more formal" or "no change"
}`

    // Get agent context for AI routing
    const agentContext = await getAgentContext()

    const response = await generateAIResponse({
      prompt,
      metadata: {
        userId: agentContext.userId,
        brokerageId: agentContext.brokerageId,
        agentId: agentContext.agentId,
        feature: "tag_classification",
      },
    })

    const learnings = parseAIJsonResponse(response.text)

    // brand_voice_profile.agent_id FKs agents(id) — session agentId, not the
    // users id and not a value taken off the content row.
    const { data: brandVoice, error: voiceError } = await supabase
      .from("brand_voice_profile")
      .select("*")
      .eq("agent_id", auth.actor.agentId)
      .maybeSingle()

    if (voiceError) {
      console.error("[learnFromEdits] Brand voice read failed:", voiceError)
      return { success: false, error: voiceError.message }
    }
    if (!brandVoice) {
      return {
        success: false,
        error: "No brand voice profile yet — create one in Settings before teaching it from edits.",
      }
    }

    const updatedAvoidWords = [...(brandVoice.prohibited_words || []), ...(learnings.words_to_avoid || [])]
    const updatedKeyPhrases = [...(brandVoice.key_brand_messages || []), ...(learnings.preferred_phrases || [])]

    const { error: writeError } = await supabase
      .from("brand_voice_profile")
      .update({
        prohibited_words: Array.from(new Set(updatedAvoidWords)),
        key_brand_messages: Array.from(new Set(updatedKeyPhrases)),
        writing_style_notes: `${brandVoice.writing_style_notes || ""}\n${learnings.style_notes || ""}`.trim(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", brandVoice.id)

    // Reporting "learned!" over a write the database refused is the whole
    // failure mode this file is being audited for.
    if (writeError) {
      console.error("[learnFromEdits] Brand voice update failed:", writeError)
      return { success: false, error: writeError.message }
    }

    revalidatePath("/settings/brand-voice")
    revalidatePath("/dashboard/content")
    return { success: true, learnings }
  } catch (error) {
    console.error("Learn from edits error:", error)
    return { success: false, error: error instanceof Error ? error.message : "Failed to learn from edits" }
  }
}

// ============================================
// SEO OPTIMIZATION
// ============================================

export async function calculateSEOScore(params: {
  content: string
  title: string
  metaDescription: string
  primaryKeyword: string
  images?: Array<{ alt_text: string }>
}): Promise<
  | {
      success: true
      score: number
      recommendations: string[]
      wordCount: number
      keywordDensity: number
      readabilityScore: number
    }
  | { success: false; error: string }
> {
  // Pure computation — no tenant data is read or written, so no actor gate.
  // It still must not be handed junk: an empty keyword makes the density
  // calculation divide the content into zero-length windows and score 25/25.
  if (!params.content?.trim()) return { success: false, error: "Content cannot be empty" }
  if (!params.primaryKeyword?.trim()) return { success: false, error: "A primary keyword is required" }

  let score = 0

  // Keyword density (25 points)
  const keywordDensity = calculateKeywordDensity(params.content, params.primaryKeyword)
  if (keywordDensity >= 1 && keywordDensity <= 2) score += 25
  else if (keywordDensity > 0) score += 15

  // Title optimization (15 points)
  if (params.title.toLowerCase().includes(params.primaryKeyword.toLowerCase())) score += 10
  if (params.title.length >= 50 && params.title.length <= 60) score += 5

  // Meta description (10 points)
  if (params.metaDescription.toLowerCase().includes(params.primaryKeyword.toLowerCase())) score += 5
  if (params.metaDescription.length >= 150 && params.metaDescription.length <= 160) score += 5

  // Headers (15 points)
  const headers = extractHeaders(params.content)
  if (headers.h1.some((h) => h.toLowerCase().includes(params.primaryKeyword.toLowerCase()))) score += 5
  if (headers.h2.some((h) => h.toLowerCase().includes(params.primaryKeyword.toLowerCase()))) score += 5
  if (headers.all.length >= 3) score += 5

  // Content length (10 points)
  const wordCount = params.content.split(/\s+/).length
  if (wordCount >= 800 && wordCount <= 1500) score += 10
  else if (wordCount >= 500) score += 5

  // Readability (10 points)
  const readabilityScore = calculateFleschKincaid(params.content)
  if (readabilityScore >= 60 && readabilityScore <= 80) score += 10

  // Internal/external links (10 points)
  const internalLinks = (params.content.match(/\[.*?\]\(\/.*?\)/g) || []).length
  const externalLinks = (params.content.match(/\[.*?\]\(https?:\/\/.*?\)/g) || []).length
  if (internalLinks >= 2) score += 5
  if (externalLinks >= 1) score += 5

  // Image alt text (5 points)
  if (params.images && params.images.length > 0 && params.images.every((img) => img.alt_text)) score += 5

  const recommendations = generateSEORecommendations(params, score)

  return { success: true, score, recommendations, wordCount, keywordDensity, readabilityScore }
}

function calculateKeywordDensity(content: string, keyword: string): number {
  const words = content.toLowerCase().split(/\s+/)
  const keywordWords = keyword.toLowerCase().split(/\s+/)
  let count = 0

  for (let i = 0; i <= words.length - keywordWords.length; i++) {
    if (keywordWords.every((kw, j) => words[i + j] === kw)) {
      count++
    }
  }

  return (count / words.length) * 100
}

function extractHeaders(content: string): { h1: string[]; h2: string[]; all: string[] } {
  const h1Matches = content.match(/^#\s+(.+)$/gm) || []
  const h2Matches = content.match(/^##\s+(.+)$/gm) || []

  return {
    h1: h1Matches.map((h) => h.replace(/^#\s+/, "")),
    h2: h2Matches.map((h) => h.replace(/^##\s+/, "")),
    all: [...h1Matches, ...h2Matches],
  }
}

function calculateFleschKincaid(content: string): number {
  const sentences = content.split(/[.!?]+/).filter((s) => s.trim().length > 0).length
  const words = content.split(/\s+/).filter((w) => w.length > 0).length
  const syllables = content.split(/\s+/).reduce((count, word) => count + countSyllables(word), 0)

  if (sentences === 0 || words === 0) return 0

  return 206.835 - 1.015 * (words / sentences) - 84.6 * (syllables / words)
}

function countSyllables(word: string): number {
  word = word.toLowerCase().replace(/[^a-z]/g, "")
  if (word.length <= 3) return 1
  const vowels = word.match(/[aeiouy]+/g)
  let count = vowels ? vowels.length : 1
  if (word.endsWith("e")) count--
  return Math.max(count, 1)
}

function generateSEORecommendations(params: any, score: number): string[] {
  const recommendations = []

  if (score < 70) {
    if (!params.content.toLowerCase().includes(params.primaryKeyword.toLowerCase())) {
      recommendations.push(`Add primary keyword '${params.primaryKeyword}' naturally in first paragraph`)
    }
    const wordCount = params.content.split(/\s+/).length
    if (wordCount < 800) {
      recommendations.push("Expand content to at least 800 words for better SEO")
    }
    const headers = extractHeaders(params.content)
    if (headers.all.length < 3) {
      recommendations.push("Add more H2/H3 headers to structure content")
    }
  }

  return recommendations
}

// ============================================
// COMPLIANCE CHECKING
// ============================================

export async function checkCompliance(params: { contentId: string; content: string; contentType: string }) {
  const fairHousingCheck = checkFairHousing(params.content)
  const flags = [...fairHousingCheck.violations]

  const supabase = await createClient()

  await supabase
    .from("ai_generated_content")
    .update({
      compliance_approved: flags.length === 0,
      compliance_flags: flags,
      compliance_status: flags.length > 0 ? "needs_revision" : "approved",
    })
    .eq("id", params.contentId)

  return {
    passed: flags.length === 0,
    flags,
  }
}

function checkFairHousing(text: string): { violations: Array<{ matched: string; message: string; fix: string }> } {
  const violations: Array<{ matched: string; message: string; fix: string }> = []

  const prohibitedPatterns = [
    { pattern: /master bedroom/gi, fix: 'Use "primary bedroom" instead' },
    { pattern: /walk to church/gi, fix: 'Use "walk to places of worship"' },
    { pattern: /perfect for families/gi, fix: 'Use "spacious layout" or "multiple bedrooms"' },
    { pattern: /great schools/gi, fix: "Cite specific school ratings instead" },
    { pattern: /young professional/gi, fix: "Avoid age implications" },
    { pattern: /empty nester/gi, fix: 'Use "those seeking low-maintenance"' },
  ]

  for (const { pattern, fix } of prohibitedPatterns) {
    const matches = text.match(pattern)
    if (matches) {
      violations.push({
        matched: matches[0],
        message: `Potential Fair Housing violation: "${matches[0]}"`,
        fix,
      })
    }
  }

  return { violations }
}

// ============================================
// CONTENT REPURPOSING
// ============================================

export async function repurposeContent(params: { sourceContentId: string; targetFormats: string[] }) {
  if (!isValidUUID(params.sourceContentId)) {
    return { success: false, error: "Invalid content ID" }
  }

  const supabase = await createClient()

  try {
    const { data: source } = await supabase.from("ai_generated_content").select("*").eq("id", params.sourceContentId).single()

    if (!source) {
      return { success: false, error: "Content not found" }
    }

    const repurposed: any = {}

    if (params.targetFormats.includes("social_posts") && source.content_type === "blog_post") {
      repurposed.social_posts = await generateSocialFromBlog(source)
    }

    if (params.targetFormats.includes("email") && source.content_type === "blog_post") {
      repurposed.email = await generateEmailFromBlog(source)
    }

    return { success: true, data: repurposed }
  } catch (error) {
    console.error("Repurpose content error:", error)
    return { success: false, error: "Failed to repurpose content" }
  }
}

async function generateSocialFromBlog(blogContent: any): Promise<any[]> {
  const prompt = `Extract 5 social media posts from this blog post:

BLOG TITLE: ${blogContent.title || ""}
BLOG CONTENT: ${blogContent.content || blogContent.generated_content}

Generate 5 different social posts (varying lengths and angles) suitable for Instagram/Facebook.

OUTPUT FORMAT (JSON):
{
  "posts": [
    {"platform": "instagram", "text": "...", "hook": "..."},
    {"platform": "facebook", "text": "...", "hook": "..."}
  ]
}`

  // Get agent context for AI routing
  const agentContext = await getAgentContext()

  const response = await generateAIResponse({
    prompt,
    metadata: {
      userId: agentContext.userId,
      brokerageId: agentContext.brokerageId,
      agentId: agentContext.agentId,
      feature: "social_post_generation",
    },
  })

  const result = parseAIJsonResponse(response.text)
  return result.posts || []
}

async function generateEmailFromBlog(blogContent: any): Promise<any> {
  const prompt = `Convert this blog post into an email newsletter:

BLOG TITLE: ${blogContent.title || ""}
BLOG CONTENT: ${blogContent.content || blogContent.generated_content}

Create email with subject line, preview text, and condensed body.

OUTPUT FORMAT (JSON):
{
  "subject_line": "...",
  "preview_text": "...",
  "email_body": "..."
}`

  // Get agent context for AI routing
  const agentContext = await getAgentContext()

  const response = await generateAIResponse({
    prompt,
    metadata: {
      userId: agentContext.userId,
      brokerageId: agentContext.brokerageId,
      agentId: agentContext.agentId,
      feature: "email_generation",
    },
  })

  return parseAIJsonResponse(response.text)
}

// ============================================
// CONTENT CALENDAR INTEGRATION
// ============================================

export async function generateContentPlan(params: {
  month: Date
  includeListings?: boolean
}): Promise<{ success: true; data: any; scheduled: number } | { success: false; error: string }> {
  const auth = await requireContentActor()
  if (!auth.ok) return { success: false, error: auth.error }

  const month = params.month instanceof Date ? params.month : new Date(params.month)
  if (Number.isNaN(month.getTime())) return { success: false, error: "Invalid month" }

  const supabase = await createClient()

  try {
    // THREE DIFFERENT ID SPACES in this one block. They used to all receive
    // the same caller-supplied value:
    //   users.id            <- the auth user
    //   transactions.agent_id -> agents(id)
    //   content_calendar.agent_id -> agents(id)
    // Substituting one for another returns zero rows on read and is rejected
    // by the FK on write.
    const { data: listings, error: listingsError } = await supabase
      .from("transactions")
      .select("id, listing_id")
      .eq("agent_id", auth.actor.agentId) // agents(id)
      .eq("status", "active")

    if (listingsError) {
      console.error("[generateContentPlan] Listings read failed:", listingsError)
      return { success: false, error: listingsError.message }
    }

    const { data: personas } = await supabase
      .from("client_detailed_personas")
      .select("persona_type")
      .limit(5)

    const { data: topContent } = await supabase
      .from("ai_generated_content")
      .select("metadata, performance_score")
      .eq("agent_id", auth.actor.agentId) // agents(id)
      .eq("brokerage_id", auth.actor.brokerageId)
      .order("performance_score", { ascending: false, nullsFirst: false })
      .limit(10)

    const topTopics = topContent?.map((c) => (c.metadata as any)?.topic || "general") || []

    const prompt = `Create 30-day content marketing plan for real estate agent.

AGENT CONTEXT:
- Active Listings: ${listings?.length || 0}
- Lead Personas: ${personas?.map((p) => p.persona_type).join(", ") || "general"}
- Past Content Performance: Top topics - ${topTopics.slice(0, 5).join(", ")}

CONTENT MIX REQUIREMENTS:
- 40% Educational (tips, guides, market insights)
- 30% Listings (property promotions)
- 20% Personal brand (agent story, testimonials)
- 10% Community (local events, businesses)

FREQUENCY:
- Blog posts: 1-2 per week
- Social posts: 5-7 per week
- Email campaigns: 1 per week
- Market reports: 1 per month

STRATEGIC TIMING:
- New listings: Announce day they go live
- Market reports: First week of month
- Educational content: Mid-week (Tue-Thu)
- Personal content: Weekends

Generate specific content ideas for each day with:
- Date (YYYY-MM-DD)
- Topic
- Content type
- Target persona
- Platform(s)
- Why this timing
- Priority (1-5)

OUTPUT FORMAT (JSON):
{
  "plan": [
    {
      "date": "2024-02-01",
      "topic": "First-time buyer tips",
      "content_type": "blog_post",
      "persona": "first_time_buyer",
      "platforms": ["blog", "linkedin"],
      "reasoning": "First of month, educational content",
      "priority": 4
    }
  ],
  "monthly_themes": ["February market trends", "Spring buying season prep"],
  "recommended_frequency": {
    "blog": 6,
    "social": 25,
    "email": 4
  }
}`

    // Get agent context for AI routing
    const agentContext = await getAgentContext()

    const response = await generateAIResponse({
      prompt,
      metadata: {
        userId: agentContext.userId,
        brokerageId: agentContext.brokerageId,
        agentId: agentContext.agentId,
        feature: "blog_post_generation",
      },
    })

    const plan = parseAIJsonResponse(response.text)

    // Save to content calendar as ONE batch insert. The per-item loop ignored
    // every error it got, so a plan could report success having written
    // nothing at all.
    let scheduled = 0
    if (Array.isArray(plan?.plan) && plan.plan.length > 0) {
      const rows = plan.plan
        .filter((item: any) => item?.topic && item?.content_type)
        .map((item: any) => ({
          agent_id: auth.actor.agentId, // agents(id), NOT NULL
          brokerage_id: auth.actor.brokerageId, // stamped at the insert
          title: String(item.topic),
          content_type: String(item.content_type),
          scheduled_date: item.date || null,
          platform: item.platforms?.[0] ?? null,
          status: "draft", // CHECK member
          notes: item.reasoning ?? null,
        }))

      if (rows.length > 0) {
        const { data: inserted, error: insertError } = await supabase
          .from("content_calendar")
          .insert(rows)
          .select("id")

        if (insertError) {
          console.error("[generateContentPlan] Calendar insert failed:", insertError)
          return { success: false, error: `Plan generated but could not be saved: ${insertError.message}` }
        }
        scheduled = inserted?.length ?? 0
      }
    }

    if (scheduled === 0) {
      return { success: false, error: "The planner returned no usable calendar entries — try again." }
    }

    revalidatePath("/dashboard/content")
    return { success: true, data: plan, scheduled }
  } catch (error) {
    console.error("Generate content plan error:", error)
    return { success: false, error: error instanceof Error ? error.message : "Failed to generate content plan" }
  }
}

export async function getContentCalendar(params: { agentId: string; startDate?: string; endDate?: string }) {
  if (!isValidUUID(params.agentId)) {
    return []
  }

  const supabase = await createClient()

  let query = supabase.from("content_calendar").select("*").eq("agent_id", params.agentId).order("scheduled_date")

  if (params.startDate) {
    query = query.gte("scheduled_date", params.startDate)
  }
  if (params.endDate) {
    query = query.lte("scheduled_date", params.endDate)
  }

  const { data, error } = await query

  if (error) {
    console.error("Get content calendar error:", error)
    return []
  }

  return data || []
}

export async function scheduleContent(params: {
  contentId: string
  scheduledDate: string
  scheduledTime?: string
  platform?: string
}) {
  const supabase = await createClient()

  const { data: content } = await supabase.from("ai_generated_content").select("*").eq("id", params.contentId).single()

  if (!content) {
    return { success: false, error: "Content not found" }
  }

  const { data: scheduled, error } = await supabase
    .from("content_calendar")
    .insert({
      agent_id: content.agent_id,
      // content_calendar's RLS is `(brokerage_id IS NULL) OR (brokerage_id =
      // current_user_brokerage_id())` — an unstamped calendar entry is visible
      // to every brokerage on the platform.
      brokerage_id: content.brokerage_id,
      content_id: params.contentId,
      title: content.metadata?.title || `${content.content_type} content`,
      content_type: content.content_type,
      scheduled_date: params.scheduledDate,
      scheduled_time: params.scheduledTime,
      platform: params.platform,
      status: "scheduled",
    })
    .select()
    .single()

  if (error) {
    console.error("Schedule content error:", error)
    return { success: false, error: "Failed to schedule content" }
  }

  revalidatePath("/dashboard/content/calendar")
  return { success: true, data: scheduled }
}

// ============================================
// A/B TESTING SYSTEM
// ============================================

/**
 * Create an A/B test.
 *
 * SURVIVOR of the createContentABTest / createABTest pair. Two modes:
 *   · variantBId omitted  -> variant B is written by the AI variant generator
 *     from variant A along `testVariable` (this function's original behaviour).
 *   · variantBId supplied -> both variants are registered as-is (the behaviour
 *     ported over from createContentABTest before it was deleted).
 */
export async function createABTest(params: {
  baseContentId: string
  testVariable: ABTestVariable
  sampleSize?: number
  /** Ported from createContentABTest: register an existing second variant. */
  variantBId?: string
  /** Ported from createContentABTest: the metric the test is judged on. */
  testMetric?: string
  /** Ported from createContentABTest: caller-declared total sample target. */
  targetSampleSize?: number
  /** Ported from createContentABTest: override the generated test name. */
  testName?: string
}): Promise<{ success: true; test: any } | { success: false; error: string }> {
  const auth = await requireContentActor()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!isValidUUID(params.baseContentId)) {
    return { success: false, error: "Invalid content ID" }
  }
  if (!(AB_TEST_VARIABLES as readonly string[]).includes(params.testVariable)) {
    return { success: false, error: `Unknown test variable "${params.testVariable}"` }
  }
  if (params.variantBId && !isValidUUID(params.variantBId)) {
    return { success: false, error: "Invalid variant B ID" }
  }
  if (params.variantBId && params.variantBId === params.baseContentId) {
    return { success: false, error: "Variant B must be different from variant A" }
  }

  const supabase = await createClient()

  try {
    const { data: baseContent, error: baseError } = await supabase
      .from("ai_generated_content")
      .select("*")
      .eq("id", params.baseContentId)
      .eq("brokerage_id", auth.actor.brokerageId)
      .maybeSingle()

    if (baseError) {
      console.error("[createABTest] Base content read failed:", baseError)
      return { success: false, error: baseError.message }
    }
    if (!baseContent) {
      return { success: false, error: "Content not found in your workspace" }
    }

    let variantBId = params.variantBId

    if (variantBId) {
      // Explicit-variant path (ported): confirm B is ours too, or the FK
      // to ai_generated_content would attach another tenant's row to our test.
      const { data: variantB, error: variantError } = await supabase
        .from("ai_generated_content")
        .select("id")
        .eq("id", variantBId)
        .eq("brokerage_id", auth.actor.brokerageId)
        .maybeSingle()

      if (variantError) {
        console.error("[createABTest] Variant B read failed:", variantError)
        return { success: false, error: variantError.message }
      }
      if (!variantB) return { success: false, error: "Variant B not found in your workspace" }
    } else {
      const variant = await generateVariant(baseContent, params.testVariable, auth.actor)
      if (!variant?.id) {
        return { success: false, error: "Could not generate the B variant" }
      }
      variantBId = variant.id
    }

    const { data: test, error } = await supabase
      .from("content_ab_tests")
      .insert({
        // content_ab_tests.agent_id is NOT NULL and FKs agents(id). Its
        // absence here is why this function could never complete a single run.
        agent_id: auth.actor.agentId,
        brokerage_id: auth.actor.brokerageId,
        test_name: params.testName?.trim() || `${params.testVariable} test - ${baseContent.content_type}`,
        content_type: baseContent.content_type,
        variant_a_id: baseContent.id,
        variant_b_id: variantBId,
        test_variable: params.testVariable,
        test_metric: params.testMetric ?? "engagement_rate",
        target_sample_size: params.targetSampleSize ?? 1000,
        sample_size_per_variant: params.sampleSize || 100,
        status: "running", // CHECK member
        started_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (error) {
      console.error("[createABTest] Insert failed:", error)
      return { success: false, error: error.message }
    }

    revalidatePath("/dashboard/content")
    return { success: true, test }
  } catch (error) {
    console.error("Create A/B test error:", error)
    return { success: false, error: error instanceof Error ? error.message : "Failed to create A/B test" }
  }
}

/** Deterministic seed from content hash — avoids non-reproducible Math.random() in AI contexts */
function getVariationSeed(content: string): number {
  return Math.abs([...content.slice(0, 50)].reduce((h, c) =>
    (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0))
}

async function generateVariant(baseContent: any, testVariable: string, actor: ContentActor) {
  const seed = getVariationSeed(baseContent.generated_content ?? baseContent.metadata?.subject_line ?? testVariable)

  const prompts: Record<string, string> = {
    subject_line: `Generate alternative subject line for this email.
Original: "${baseContent.metadata?.subject_line || ""}"
Requirements: Different approach (question vs statement, curiosity vs benefit, etc.)
Keep same topic but fresh angle.`,

    opening_hook: `Rewrite opening paragraph with different hook strategy.
Original: "${baseContent.generated_content?.substring(0, 200) || ""}"
Try a ${["question", "statistic", "story", "bold statement"][seed % 4]} approach.`,

    cta: `Generate alternative call-to-action.
Original: "${baseContent.metadata?.cta_text || ""}"
Make it more ${["urgent", "soft", "benefit-focused", "curiosity-driven"][seed % 4]}.`,

    length: `${baseContent.generated_content?.length > 500 ? "Shorten" : "Expand"} this content while keeping key points.
Original length: ${baseContent.generated_content?.length} characters
Target: ${baseContent.generated_content?.length > 500 ? "50%" : "150%"} of original`,

    tone: `Rewrite entire content with different tone.
Original: ${baseContent.generated_content}
New tone: ${["more professional", "more casual", "more energetic", "more empathetic"][seed % 4]}
Keep same information, change how it's presented.`,
  }

  // Get agent context for AI routing
  const agentContext = await getAgentContext()

  const response = await generateAIResponse({
    prompt: prompts[testVariable] || prompts.subject_line,
    metadata: {
      userId: agentContext.userId,
      brokerageId: agentContext.brokerageId,
      agentId: agentContext.agentId,
      feature: "email_generation",
    },
  })

  const supabase = await createClient()

  // Save variant. brokerage_id is mandatory here: the agc_insert policy is
  // has_brokerage_access(brokerage_id) and has_brokerage_access(NULL) is false,
  // so an unstamped variant is refused and the test has no B side.
  const { data: variant, error } = await supabase
    .from("ai_generated_content")
    .insert({
      agent_id: actor.agentId,
      brokerage_id: actor.brokerageId,
      content_type: baseContent.content_type,
      generated_content: response.text,
      ai_model_used: response.model,
      prompt_used: prompts[testVariable],
      metadata: {
        ...baseContent.metadata,
        ab_test_variant: "B",
        original_content_id: baseContent.id,
      },
      compliance_approved: false,
    })
    .select()
    .single()

  if (error) {
    console.error("[generateVariant] Variant insert failed:", error)
    return null
  }

  return variant
}

export async function analyzeABTest(testId: string): Promise<
  | {
      success: true
      data: {
        winner: "A" | "B"
        variantARate: number
        variantBRate: number
        improvement: string
        confidence: string
        recommendation: string
      }
    }
  | { success: false; error: string }
> {
  const auth = await requireContentActor()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!isValidUUID(testId)) {
    return { success: false, error: "Invalid test ID" }
  }

  const supabase = await createClient()

  try {
    const { data: test, error: testError } = await supabase
      .from("content_ab_tests")
      .select("*")
      .eq("id", testId)
      .eq("brokerage_id", auth.actor.brokerageId)
      .maybeSingle()

    if (testError) {
      console.error("[analyzeABTest] Test read failed:", testError)
      return { success: false, error: testError.message }
    }
    if (!test) {
      return { success: false, error: "Test not found in your workspace" }
    }
    if (!test.variant_a_id || !test.variant_b_id) {
      return { success: false, error: "This test has no second variant to compare against" }
    }

    // Engagement comes from content_performance_tracking — the table
    // trackContentPerformance writes. The previous implementation read
    // `ai_generated_content.engagement_metrics`, a column that DOES NOT EXIST
    // (verified live). Both sides were therefore always 0, which made
    // `metricA > metricB` false every time and declared B the winner of every
    // test ever analysed, at a confidence derived from a zero difference.
    const { data: perf, error: perfError } = await supabase
      .from("content_performance_tracking")
      .select("content_id, engagement_rate, impressions, likes, shares, comments, saves")
      .in("content_id", [test.variant_a_id, test.variant_b_id])

    if (perfError) {
      console.error("[analyzeABTest] Performance read failed:", perfError)
      return { success: false, error: perfError.message }
    }

    const rows = perf ?? []
    if (rows.length === 0) {
      return {
        success: false,
        error: "No performance has been recorded for either variant yet — track results first.",
      }
    }

    const rateFor = (contentId: string) => {
      const forVariant = rows.filter((r) => r.content_id === contentId)
      if (forVariant.length === 0) return 0
      const explicit = forVariant.reduce((sum, r) => sum + Number(r.engagement_rate || 0), 0)
      if (explicit > 0) return explicit / forVariant.length
      // Fall back to a derived rate when the platform only gave us raw counts.
      const impressions = forVariant.reduce((sum, r) => sum + (r.impressions || 0), 0)
      if (impressions === 0) return 0
      const engagement = forVariant.reduce(
        (sum, r) => sum + (r.likes || 0) + (r.shares || 0) + (r.comments || 0) + (r.saves || 0),
        0
      )
      return (engagement / impressions) * 100
    }

    const metricA = rateFor(test.variant_a_id)
    const metricB = rateFor(test.variant_b_id)

    if (metricA === 0 && metricB === 0) {
      return { success: false, error: "Both variants are still at zero engagement — nothing to compare." }
    }

    const winner: "A" | "B" = metricA >= metricB ? "A" : "B"
    const improvement = (Math.abs(metricA - metricB) / Math.min(metricA || 1, metricB || 1)) * 100

    const sampleSize = test.sample_size_per_variant || 100
    const confidence = calculateConfidence(metricA, metricB, sampleSize)
    const decided = confidence > 0.95

    const { error: updateError } = await supabase
      .from("content_ab_tests")
      .update({
        winner_variant: winner,
        winner_id: winner === "A" ? test.variant_a_id : test.variant_b_id,
        confidence_level: confidence,
        results_summary: {
          variant_a_rate: metricA,
          variant_b_rate: metricB,
          improvement_percentage: improvement,
        },
        // CHECK (status IN ('running','completed','cancelled')) — only close
        // the test out once the confidence threshold is actually met.
        status: decided ? "completed" : "running",
        ended_at: decided ? new Date().toISOString() : null,
        completed_at: decided ? new Date().toISOString() : null,
        declared_winner_at: decided ? new Date().toISOString() : null,
      })
      .eq("id", testId)
      .eq("brokerage_id", auth.actor.brokerageId)

    // Do not report an analysis we failed to persist.
    if (updateError) {
      console.error("[analyzeABTest] Result write failed:", updateError)
      return { success: false, error: updateError.message }
    }

    revalidatePath("/dashboard/content")
    return {
      success: true,
      data: {
        winner,
        variantARate: metricA,
        variantBRate: metricB,
        improvement: `${improvement.toFixed(1)}%`,
        confidence: `${(confidence * 100).toFixed(1)}%`,
        recommendation: generateTestRecommendation(test, winner, improvement, confidence),
      },
    }
  } catch (error) {
    console.error("Analyze A/B test error:", error)
    return { success: false, error: error instanceof Error ? error.message : "Failed to analyze test" }
  }
}

function calculateConfidence(metricA: number, metricB: number, sampleSize: number): number {
  // Simplified confidence calculation
  const diff = Math.abs(metricA - metricB)
  const avg = (metricA + metricB) / 2
  const relativeDiff = avg > 0 ? diff / avg : 0

  // More samples + larger difference = higher confidence
  const baseConfidence = Math.min(sampleSize / 200, 1) * 0.7
  const diffBonus = Math.min(relativeDiff * 2, 0.3)

  return Math.min(baseConfidence + diffBonus, 0.99)
}

function generateTestRecommendation(test: any, winner: string, improvement: number, confidence: number): string {
  if (confidence < 0.8) {
    return "Continue test - not enough data for confident decision"
  }

  if (improvement < 5) {
    return `Variant ${winner} won, but improvement is minimal (${improvement.toFixed(1)}%). Consider testing a more different variation.`
  }

  return `Variant ${winner} is the clear winner with ${improvement.toFixed(1)}% improvement. Use this approach for future ${test.content_type} content.`
}

// ============================================
// BATCH CONTENT GENERATOR
// ============================================

export async function bulkGenerateContent(params: {
  contentType: "listing_description" | "social_post" | "email" | "blog_post"
  targets: string[]
  templateId?: string
  personalizationLevel?: "high" | "medium" | "low"
}): Promise<
  | {
      success: true
      data: {
        queued: number
        completed: number
        failed: number
        results: Array<{ target: string; success: boolean; data?: any; error?: string }>
      }
    }
  | { success: false; error: string }
> {
  const auth = await requireContentActor()
  if (!auth.ok) return { success: false, error: auth.error }

  const targets = (params.targets ?? []).filter((t) => isValidUUID(t))
  if (targets.length === 0) {
    return { success: false, error: "No valid targets to generate for" }
  }

  try {
    const jobs = targets.map((targetId, index) => ({
      target: targetId,
      status: "queued" as const,
      priority: calculateJobPriority(targetId, index),
    }))

    const results: Array<{ target: string; success: boolean; data?: any; error?: string }> = []

    for (const job of jobs) {
      try {
        let result: any

        switch (params.contentType) {
          case "listing_description":
            result = await generateListingDescription({
              agentId: auth.actor.agentId,
              propertyId: job.target,
              length: "medium",
            })
            break

          case "social_post":
            result = await generateSocialPost({
              agentId: auth.actor.agentId,
              platform: "instagram",
              postType: "general",
              context: `Property: ${job.target}`,
              propertyId: job.target,
            })
            break

          case "email":
            result = await generateEmail({
              agentId: auth.actor.agentId,
              emailType: "follow_up",
              contactId: job.target,
            })
            break

          case "blog_post":
            result = await generateBlogPost({
              agentId: auth.actor.agentId,
              topic: "Market update",
            })
            break
        }

        // These generators REPORT failure, they do not throw. Pushing
        // success:true unconditionally counted every refused generation as a
        // completed one, so the summary said "12 completed, 0 failed" over
        // twelve failures.
        if (result?.success) {
          results.push({ target: job.target, success: true, data: result })
        } else {
          results.push({
            target: job.target,
            success: false,
            error: result?.error ?? "Generation failed",
          })
        }
      } catch (error) {
        results.push({
          target: job.target,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return {
      success: true,
      data: {
        queued: jobs.length,
        completed: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
        results,
      },
    }
  } catch (error) {
    console.error("Bulk generate content error:", error)
    return { success: false, error: error instanceof Error ? error.message : "Failed to bulk generate content" }
  }
}

function calculateJobPriority(targetId: string, index: number): number {
  // Higher priority for newer items (lower index)
  return Math.max(1, 10 - Math.floor(index / 10))
}

export async function generateAllListingDescriptions(): Promise<
  | {
      success: true
      data: {
        queued: number
        completed: number
        failed: number
        results: Array<{ target: string; success: boolean; data?: any; error?: string }>
      }
    }
  | { success: false; error: string }
> {
  const auth = await requireContentActor()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createClient()

  const { data: listings, error } = await supabase
    .from("transactions")
    .select("listing_id")
    .eq("agent_id", auth.actor.agentId) // transactions.agent_id -> agents(id)
    .eq("status", "active")

  // "No active listings" and "the database refused the question" are not the
  // same answer, and they must not render the same way.
  if (error) {
    console.error("[generateAllListingDescriptions] Transactions read failed:", error)
    return { success: false, error: error.message }
  }

  // transactions.listing_id is ON DELETE SET NULL, so it really can be null;
  // a null target used to be handed straight to the generator.
  const targets = (listings ?? []).map((l) => l.listing_id).filter((id): id is string => isValidUUID(id))

  if (targets.length === 0) {
    return { success: false, error: "No active listings with a linked property to write descriptions for" }
  }

  return await bulkGenerateContent({
    contentType: "listing_description",
    targets,
    personalizationLevel: "high",
  })
}

// ============================================
// ENHANCED LISTING DESCRIPTION WITH SEO & NEIGHBORHOOD DATA
// ============================================

export async function generateSEOKeywords(property: any, neighborhoodData?: any) {
  const keywords = []

  // Location keywords
  if (property.city) {
    keywords.push(property.city.toLowerCase())
    keywords.push(`${property.city.toLowerCase()} homes for sale`)
    keywords.push(`${property.city.toLowerCase()} real estate`)
  }

  if (neighborhoodData?.neighborhood) {
    keywords.push(`${neighborhoodData.neighborhood.toLowerCase()} ${property.city}`)
  }

  // Property type keywords
  if (property.bedrooms && property.city) {
    keywords.push(`${property.bedrooms} bedroom home ${property.city}`)
  }

  if (property.property_type) {
    keywords.push(`${property.property_type.toLowerCase()} for sale`)
  }

  // Feature keywords
  const features = property.features || property.property_features || []
  if (features.includes?.('pool') || features.includes?.('Pool')) {
    keywords.push(`${property.city} homes with pool`)
  }
  if ((property.lot_size_acres || 0) > 1) {
    keywords.push(`${property.city} homes on acreage`)
  }

  // School district keywords
  if (neighborhoodData?.school_district) {
    keywords.push(`${neighborhoodData.school_district} homes`)
  }

  // Price range keywords
  const price = property.list_price || property.price || property.listing_price || 0
  const priceRange = price < 300000 ? 'affordable' : price < 600000 ? 'mid-range' : price < 1000000 ? 'upscale' : 'luxury'
  keywords.push(`${priceRange} homes ${property.city}`)

  return keywords
}

export async function getNeighborhoodData(city: string, zip?: string) {
  // Routed through the platform AI rail (same generateAIResponse + JSON parse
  // pattern as every other generator in this file). The result is AI-estimated
  // and labeled as such — on failure this returns an honest error, never mock data.
  if (!city?.trim()) {
    return { success: false as const, error: "City is required for neighborhood data" }
  }

  try {
    const agentContext = await getAgentContext()

    const prompt = `You are a real estate data assistant. Provide a realistic neighborhood profile for the location below, for use in a listing description. Return ONLY valid JSON — no markdown, no explanation.

LOCATION: ${city.trim()}${zip ? ` (ZIP ${zip})` : ""}

Return this exact JSON structure:
{
  "neighborhood": "name of a prominent neighborhood/district in this city",
  "schools": "one-sentence summary of local school quality",
  "walk_score": 0-100 number (typical walkability for this area),
  "amenities": "one-sentence summary of nearby amenities",
  "school_district": "name of the local school district",
  "nearby_attractions": ["attraction1", "attraction2", "attraction3"]
}`

    const response = await generateAIResponse({
      prompt,
      metadata: {
        userId: agentContext.userId,
        brokerageId: agentContext.brokerageId,
        agentId: agentContext.agentId,
        feature: "listing_description",
      },
    })

    const result = parseAIJsonResponse(response.text)
    return { ...result, data_source: "ai_estimated" }
  } catch (error) {
    console.error("Get neighborhood data error:", error)
    return { success: false as const, error: "Failed to generate neighborhood data" }
  }
}

export async function detectTargetBuyer(property: any) {
  const bedrooms = property.bedrooms || 0
  const sqft = property.sqft || property.square_feet || property.square_footage || 0
  const price = property.list_price || property.price || property.listing_price || 0
  const features = property.features || property.property_features || []

  if (bedrooms >= 4 && sqft > 2500) {
    return 'Growing families / Move-up buyers'
  }
  if (bedrooms <= 2 && sqft < 1500) {
    return 'First-time buyers / Downsizers'
  }
  if (price > 800000) {
    return 'Luxury buyers'
  }
  if (features.includes?.('investment') || features.includes?.('rental potential')) {
    return 'Investors'
  }
  return 'General buyers'
}

export async function getComparableProperties(property: any) {
  if (!isValidUUID(property.id || '')) {
    return []
  }

  const supabase = await createClient()
  const sqft = property.sqft || property.square_feet || property.square_footage || 0

  const { data: comps } = await supabase
    .from('listings')
    .select('address, list_price, status, sold_date, sqft')
    .eq('city', property.city)
    .gte('sqft', sqft * 0.9)
    .lte('sqft', sqft * 1.1)
    .neq('id', property.id)
    .limit(5)

  return comps || []
}

export async function validateThemFirstContent(content: string, contentType: string) {
  // "Them First" validation - checks if content focuses on buyer benefits vs agent promotion
  
  const agentCentricPhrases = [
    /\b(i|me|my|our team|we offer|my expertise|i specialize|i can help)\b/gi,
    /\b(contact me|call me|reach out|my services)\b/gi,
  ]

  const buyerCentricPhrases = [
    /\b(you|your|imagine|picture yourself|envision|experience)\b/gi,
    /\b(perfect for|ideal for|great for families|enjoy)\b/gi,
  ]

  let agentCentricCount = 0
  let buyerCentricCount = 0

  for (const pattern of agentCentricPhrases) {
    const matches = content.match(pattern)
    agentCentricCount += matches?.length || 0
  }

  for (const pattern of buyerCentricPhrases) {
    const matches = content.match(pattern)
    buyerCentricCount += matches?.length || 0
  }

  const totalReferences = agentCentricCount + buyerCentricCount
  const buyerFocusRatio = totalReferences > 0 ? buyerCentricCount / totalReferences : 0.5

  const overallScore = buyerFocusRatio
  const passed = buyerFocusRatio >= 0.7 // At least 70% buyer-focused

  return {
    passed,
    overall_score: overallScore,
    agent_centric_count: agentCentricCount,
    buyer_centric_count: buyerCentricCount,
    recommendations: passed
      ? ['Great job keeping the focus on the buyer!']
      : [
          'Reduce agent-centric language (I, me, my)',
          'Increase buyer-focused language (you, your, imagine)',
          'Focus on buyer benefits rather than agent credentials',
        ],
  }
}

/**
 * The enhanced listing-description writer.
 *
 * NOT a duplicate of generateListingDescription — it CALLS it. This is a
 * decorator that adds neighborhood data, comparables, buyer-persona
 * detection, SEO keywords and a "Them First" validation pass around the base
 * generator. Deleting either one loses capability the other does not have.
 */
export async function enhancedGenerateListingDescription(params: {
  transactionId?: string
  propertyId?: string
  descriptionType?: DescriptionType
}): Promise<
  | { success: true; contentId: string | null; description: any; validation: any; seoKeywords: any; targetPersona: any }
  | { success: false; error: string }
> {
  const auth = await requireContentActor()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!params.transactionId && !params.propertyId) {
    return { success: false, error: 'Provide a transaction or a property to describe' }
  }

  const supabase = await createClient()

  try {
    // Get property details
    let property: any = null

    if (params.transactionId && isValidUUID(params.transactionId)) {
      const { data: transaction, error: txError } = await supabase
        .from('transactions')
        .select('*, listings(*), contacts(*)')
        .eq('id', params.transactionId)
        .eq('agent_id', auth.actor.agentId)
        .maybeSingle()

      if (txError) {
        console.error('[enhancedGenerateListingDescription] Transaction read failed:', txError)
        return { success: false, error: txError.message }
      }
      property = transaction?.listings
    } else if (params.propertyId && isValidUUID(params.propertyId)) {
      const { data, error: listingError } = await supabase
        .from('listings')
        .select('*')
        .eq('id', params.propertyId)
        .maybeSingle()

      if (listingError) {
        console.error('[enhancedGenerateListingDescription] Listing read failed:', listingError)
        return { success: false, error: listingError.message }
      }
      property = data
    }

    if (!property) {
      return { success: false, error: 'Property not found' }
    }

    // Get neighborhood data (AI-estimated; null when the AI rail fails —
    // downstream consumers all optional-chain into it)
    const neighborhoodResult = await getNeighborhoodData(property.city, property.zip)
    const neighborhoodData = (neighborhoodResult as any)?.success === false ? null : neighborhoodResult

    // Get comparable properties
    const comps = await getComparableProperties(property)

    // Detect target buyer persona
    const targetPersona = await detectTargetBuyer(property)

    // Generate SEO keywords
    const keywords = await generateSEOKeywords(property, neighborhoodData)

    // Determine description length
    const descriptionType = params.descriptionType || 'standard'
    const length = descriptionType === 'short_mls' ? 'short' : descriptionType === 'extended' ? 'long' : 'medium'

    // Generate description using the base generator
    const result = await generateListingDescription({
      propertyId: property.id,
      agentId: auth.actor.agentId,
      targetPersona,
      length,
      propertyDetails: {
        ...property,
        neighborhoodData,
        comps,
        seoKeywords: keywords,
      },
    })

    if (!result.success) {
      return { success: false, error: result.error ?? 'Failed to generate description' }
    }

    // CONTRACT WITH THE CALLEE. generateListingDescription returns
    //   { success, data: <parsed AI JSON>, contentId }
    // with contentId at the TOP level. This function used to read
    // `result.data.contentId` and `result.data.generated_content` — neither
    // key exists on that shape. Consequence: the metadata write below never
    // fired even once, and the validated text was always the empty string,
    // which scores 0.5 and fails the 0.7 gate. Every enhanced description
    // came back "not Them-First enough" regardless of what was written.
    const contentId: string | null = (result as any).contentId ?? null
    const payload: any = result.data
    const generatedText: string =
      typeof payload === 'string'
        ? payload
        : payload?.medium_description ??
          payload?.short_description ??
          payload?.long_description ??
          payload?.description ??
          ''

    if (!generatedText) {
      return { success: false, error: 'The generator returned no description text' }
    }

    const validation = await validateThemFirstContent(generatedText, 'listing_description')

    if (contentId) {
      const { error: metaError } = await supabase
        .from('ai_generated_content')
        .update({
          metadata: {
            them_first_score: validation.overall_score,
            them_first_validation: validation,
            seo_keywords: keywords,
            target_persona: targetPersona,
            neighborhood_data: neighborhoodData,
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', contentId)
        .eq('brokerage_id', auth.actor.brokerageId)

      if (metaError) {
        console.error('[enhancedGenerateListingDescription] Metadata write failed:', metaError)
        return { success: false, error: `Description written but enrichment failed: ${metaError.message}` }
      }
    }

    revalidatePath('/dashboard/content')
    return {
      success: true,
      contentId,
      description: generatedText,
      validation,
      seoKeywords: keywords,
      targetPersona,
    }
  } catch (error) {
    console.error('Enhanced generate listing description error:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Failed to generate description' }
  }
}

// ============================================
// COST TRACKING & ANALYTICS
// ============================================

// ── ONE PRICE TABLE ────────────────────────────────────────────────────────
//
// DELETED  calculateAICost. It was a SECOND AI price table living in this file,
//          and it shared ZERO KEYS with the platform's own.
//
//   NAMED DUPLICATE / SURVIVOR: lib/ai/cost-tracking.ts::calculateCost, backed
//   by getModelPricing(). Keyed on the `AIModel` union the system actually
//   emits ("claude-sonnet", "gpt-4o", "gemini-flash", …), dated provider
//   pricing (lastUpdated "2026-02-20") with links to the provider pricing
//   pages, 10 models. It is what logAIUsage uses to write ai_tool_usage.cost_cents,
//   and therefore what the monthly-aggregate RPC (increment_ai_usage_monthly)
//   and the ai_tokens_monthly fair-use counter are already based on.
//
//   calculateAICost was 4 rows keyed "openai/gpt-4o" / "openai/gpt-4o-mini" /
//   "gemini-2.0-flash" / "anthropic/claude-sonnet-4.5" — a provider-prefixed
//   namespace nothing in this codebase produces — and any unknown key fell
//   THROUGH TO gpt-4o-mini rates instead of refusing. Overlap between the two
//   key namespaces: none. So every real model missed and booked at mini rates:
//   claude-sonnet (the platform default for content) understated 25.6x,
//   claude-opus 119.7x, gpt-4-turbo 59.8x. Measured, not estimated — see
//   docs/lane-b-cost-ledger-notes.md.
//
//   NOTHING WAS PORTED because nothing was unique. Its four prices are the same
//   four prices getModelPricing() already carries under the canonical key
//   (2.50/10.00 == gpt-4o, 0.15/0.60 == gpt-4o-mini, 0.075/0.30 == gemini-flash,
//   3.0/15.0 == claude-sonnet). Its `totalTokens` argument was accepted and
//   never read. Its only other behaviours — dollars instead of cents, and the
//   silent mini fallback — are the two things that made it wrong.
//
// AND THE SAME CALL IS ALREADY PRICED ELSEWHERE. Every generation in this file
// goes through generateAIResponse (lib/ai/models.ts), which computes costCents
// from the canonical table and hands it to logAIUsage, which INSERTs a
// ai_tool_usage row with the real provider token counts. content_generation_logs.cost_usd
// was therefore a SECOND booking of a call the platform had already priced —
// and the two never agreed. logGenerationCost now takes the canonical figure as
// a parameter so that the two ledgers agree BY CONSTRUCTION, not by coincidence.

/**
 * Write one row to content_generation_logs — the CONTENT dimension of a
 * generation.
 *
 * ── WHAT THIS TABLE IS NOW, AND WHAT IT IS NOT ───────────────────────────────
 *
 * content_generation_logs is NO LONGER THE COST SOURCE OF RECORD. That is
 * `ai_tool_usage`, written by lib/ai/cost-tracking.ts::logAIUsage on the way
 * out of every generateAIResponse call, and it is what getMonthlyAICosts reads.
 * ai_tool_usage is also what the monthly-aggregate RPC and the ai_tokens_monthly
 * fair-use counter are computed from, so it is the platform's single accounting
 * basis; a second, differently-priced ledger could only ever contradict it.
 *
 * THE TABLE IS NOT GOING AWAY, and this function is not either, because
 * ai_tool_usage has no CONTENT dimension. Only here do you get, per artifact:
 *   · content_id      — which generated artifact this call produced
 *   · content_type    — listing_description / blog_post / …
 *   · prompt          — the audit trail of what was actually asked (m386)
 *   · success + error_message per artifact
 *   · generation_time_ms per artifact
 * ai_tool_usage carries none of those. getContentPerformanceMetrics reads this
 * table for exactly that reason and is unaffected.
 *
 * cost_usd is still written, and it is now the SAME number ai_tool_usage booked
 * (see COST RESOLUTION below) rather than a rival computation. Treat it as a
 * denormalised convenience copy on the content row — not as the bill.
 */
export async function logGenerationCost(params: {
  contentId?: string
  /**
   * Required for a SUCCESS log — a booked cost with no model attribution is a
   * bill nobody can audit. OPTIONAL for a failure log: the deleted
   * logContentGeneration was called from catch blocks that never reached the
   * model call, and refusing those would lose the failure half of the ledger
   * this function absorbed. See the CONSOLIDATION note above.
   */
  model?: string
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  /**
   * THE CANONICAL COST, IN DOLLARS — pass `response.costCents / 100` from
   * generateAIResponse.
   *
   * That is the exact number lib/ai/cost-tracking.ts::logAIUsage has already
   * written to ai_tool_usage.cost_cents for this same call. Passing it here
   * makes the two ledgers agree BY CONSTRUCTION instead of re-pricing the call
   * a second time from a second table and hoping the answers match (they did
   * not: see the ONE PRICE TABLE note above).
   *
   * Omit it and the cost is DERIVED from model + tokens via the same canonical
   * table (calculateCost, which returns CENTS — converted below). That path
   * exists for callers that have a model and token counts but no priced
   * response, e.g. the manual entry form on the performance/costs panel.
   */
  costUsd?: number
  generationTimeMs?: number
  success: boolean
  errorMessage?: string
  contentType?: string
  /**
   * PORTED from the deleted logContentGeneration, which stored the first 500
   * chars of the prompt on ai_generated_content.content. m386 adds
   * content_generation_logs.prompt so that capability survives the deletion.
   * Truncated here, not by the caller, so every call site records the same
   * amount. Audit trail only — never read back into a prompt.
   */
  prompt?: string
}): Promise<{ success: true; cost: number } | { success: false; error: string }> {
  const auth = await requireContentActor()
  if (!auth.ok) return { success: false, error: auth.error }

  if (params.success && !params.model?.trim()) {
    return { success: false, error: "Model is required to book a generation cost" }
  }
  if (params.contentId && !isValidUUID(params.contentId)) {
    return { success: false, error: "Invalid content ID" }
  }

  const supabase = await createClient()

  // ── COST RESOLUTION, in order of authority ───────────────────────────────
  //
  //   1. costUsd supplied  → book it verbatim. This is `response.costCents/100`,
  //      the SAME figure ai_tool_usage already holds for this call, so the two
  //      ledgers cannot drift.
  //   2. model supplied    → derive from the CANONICAL table. calculateCost
  //      returns CENTS (Math.ceil'd), so /100 for the numeric dollar column.
  //      An off-vocabulary model makes calculateCost warn and return 0 — it
  //      refuses to guess. The deleted calculateAICost silently charged
  //      gpt-4o-mini rates instead, which is how every real model got booked at
  //      a fraction of its price.
  //   3. neither           → $0.
  //
  // A FAILURE LOG STILL BOOKS $0, unchanged and deliberate: the catch blocks
  // that call this pass neither a model nor a cost, precisely because a throw
  // can happen before the model call ever ran. A failed generation that never
  // reached a provider must not put a charge in the ledger.
  const cost =
    typeof params.costUsd === "number" && Number.isFinite(params.costUsd) && params.costUsd >= 0
      ? params.costUsd
      : params.model?.trim()
        ? calculateCost(params.model.trim() as AIModel, params.promptTokens || 0, params.completionTokens || 0) / 100
        : 0

  const { error } = await supabase.from("content_generation_logs").insert({
    content_id: params.contentId ?? null,
    // content_generation_logs.agent_id is NOT NULL and FKs agents(id).
    // agentId was an OPTIONAL caller-supplied param, so every call that
    // omitted it died on SQLSTATE 23502 — verified live — and the error was
    // swallowed into a console line while the cost was returned as if booked.
    agent_id: auth.actor.agentId,
    brokerage_id: auth.actor.brokerageId,
    model_used: params.model?.trim() || null,
    prompt_tokens: params.promptTokens || 0,
    completion_tokens: params.completionTokens || 0,
    total_tokens: params.totalTokens || 0,
    cost_usd: cost,
    generation_time_ms: params.generationTimeMs,
    success: params.success,
    error_message: params.errorMessage,
    content_type: params.contentType,
    // m386. Ported off the deleted logContentGeneration.
    prompt: params.prompt ? params.prompt.slice(0, 500) : null,
  })

  if (error) {
    console.error("[logGenerationCost] Insert failed:", error)
    return { success: false, error: error.message }
  }

  revalidatePath("/dashboard/content")
  return { success: true, cost }
}

/**
 * Content AI spend for one calendar month, read from THE ONE LEDGER.
 *
 * ── WHY ai_tool_usage AND NOT content_generation_logs ────────────────────────
 *
 * This used to read content_generation_logs, which has two problems as a bill:
 *
 *   1. It only ever contains LANE B rows. Lane A
 *      (lib/content-generation/*) never writes it, so half the platform's
 *      content spend was simply absent from the content spend panel.
 *   2. Its cost_usd was priced by a rival table that shared no keys with the
 *      one the platform actually books against — see the ONE PRICE TABLE note
 *      above. Every figure it showed was understated, claude-sonnet by 25.6x.
 *
 * ai_tool_usage is written by lib/ai/cost-tracking.ts::logAIUsage on the way out
 * of EVERY generateAIResponse call, in both lanes, with the real provider token
 * counts and the dated provider price table. It is the same table the monthly
 * aggregate RPC and the ai_tokens_monthly fair-use counter are computed from.
 * Reading it means this panel, the billing rollup and the cap check can no
 * longer disagree about what a month cost.
 *
 * ── ROUNDING, STATED HONESTLY ────────────────────────────────────────────────
 *
 * ai_tool_usage.cost_cents is an INTEGER and calculateCost applies Math.ceil
 * PER CALL. A generation that truly cost $0.004 is stored as 1 cent. So:
 *   · total_cost is rounded UP, by up to (1 cent x number of generations);
 *   · avg_cost_per_generation inherits that and can never fall below $0.01 for
 *     a non-empty month, however cheap the model.
 * This is not a defect being papered over — it is the platform's own accounting
 * basis, the exact number the invoice rollup and the fair-use counter use,
 * which is precisely why it is the right source here. But a reader looking at
 * "Avg each" on a haiku-only month deserves to know the figure is a ceiling,
 * not a measurement.
 *
 * ── SCOPE ────────────────────────────────────────────────────────────────────
 * brokerage AND agent, both explicit. RLS on ai_tool_usage is
 * `(brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id())`, so
 * the policy alone would also admit every UNTENANTED row on the platform; the
 * explicit .eq("brokerage_id") is what excludes those. The .eq("agent_id")
 * preserves the agent scoping this function has always had.
 */
export async function getMonthlyAICosts(month?: Date): Promise<
  | {
      success: true
      costs: {
        /** Dollars. Rounded UP per generation — see the ROUNDING note above. */
        total_cost: number
        total_generations: number
        /** Dollars. Cannot be below $0.01 on a non-empty month — see ROUNDING. */
        avg_cost_per_generation: number
        /**
         * PORTED from the deleted getContentGenerationStats, whose
         * totalTokensUsed was the one field of its four that nothing else
         * served. It read ai_generated_content.tokens_used — a column that
         * does not exist — so it was always 0. ai_tool_usage.tokens_used is the
         * real number, written from the provider's own input+output counts.
         */
        total_tokens: number
        breakdown_by_model: Array<{ model: string; cost: number; count: number; tokens: number }>
      }
    }
  | { success: false; error: string }
> {
  const auth = await requireContentActor()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createClient()
  const targetMonth = month ? new Date(month) : new Date()
  if (Number.isNaN(targetMonth.getTime())) return { success: false, error: "Invalid month" }

  // ── MONTH BOUNDS AGAINST A `timestamp WITHOUT time zone` COLUMN ────────────
  //
  // ai_tool_usage.created_at is timestamp WITHOUT time zone, DEFAULT now(), and
  // the database's TimeZone is UTC — verified live — so every stored value is a
  // UTC wall-clock reading with the zone stripped off.
  //
  // Sending an ISO string ending in `Z` would be wrong here in a way that fails
  // silently: Postgres casts the literal to `timestamp` by DISCARDING the
  // offset, not by converting it. The old code built the bounds with
  // `new Date(year, month, 1)` — midnight LOCAL — and then .toISOString()'d it;
  // on any server not running in UTC that shifts the month boundary by the
  // offset and quietly moves generations into the neighbouring month.
  //
  // So: compute the bounds in UTC with Date.UTC, and emit them with NO zone
  // designator at all (`YYYY-MM-DDTHH:MM:SS`). There is then no offset for
  // Postgres to drop and nothing to misinterpret.
  //
  // The half-open [start, startOfNextMonth) shape is unchanged and stays: `lte`
  // on the last day at 00:00 used to drop everything generated after midnight
  // on the final day of the month.
  const naiveUtc = (d: Date) => d.toISOString().slice(0, 19)
  const year = targetMonth.getUTCFullYear()
  const monthIndex = targetMonth.getUTCMonth()
  const startOfMonth = naiveUtc(new Date(Date.UTC(year, monthIndex, 1)))
  const startOfNextMonth = naiveUtc(new Date(Date.UTC(year, monthIndex + 1, 1)))

  const { data: usage, error } = await supabase
    .from("ai_tool_usage")
    .select("cost_cents, tokens_used, model_used")
    .eq("brokerage_id", auth.actor.brokerageId)
    .eq("agent_id", auth.actor.agentId)
    // The ONE vocabulary, shared by both lanes (lib/ai/content-features.ts).
    // Deliberately narrower than "all AI spend": voice, CMA and lead scoring
    // also write ai_tool_usage and do not belong on a content panel.
    .in("feature", CONTENT_GENERATION_FEATURES as string[])
    .gte("created_at", startOfMonth)
    .lt("created_at", startOfNextMonth)

  // A denied cost query is not a $0 bill. supabase-js RESOLVES a refused read,
  // so without this the panel would render "$0.00 this month" over an RLS
  // rejection.
  if (error) {
    console.error("[getMonthlyAICosts] Query failed:", error)
    return { success: false, error: error.message }
  }

  const rows = usage ?? []
  // Sum in integer CENTS and divide ONCE, so 300 one-cent rows total exactly
  // $3.00 rather than accumulating float dust.
  const totalCents = rows.reduce((sum, row) => sum + Number(row.cost_cents || 0), 0)
  const totalGenerations = rows.length
  const totalTokens = rows.reduce((sum, row) => sum + Number(row.tokens_used || 0), 0)

  const modelBreakdown = rows.reduce(
    (acc: Record<string, { model: string; cents: number; count: number; tokens: number }>, row) => {
      const model = row.model_used || "unknown"
      if (!acc[model]) acc[model] = { model, cents: 0, count: 0, tokens: 0 }
      acc[model].cents += Number(row.cost_cents || 0)
      acc[model].count += 1
      acc[model].tokens += Number(row.tokens_used || 0)
      return acc
    },
    {}
  )

  return {
    success: true,
    costs: {
      total_cost: totalCents / 100,
      total_generations: totalGenerations,
      avg_cost_per_generation: totalGenerations > 0 ? totalCents / totalGenerations / 100 : 0,
      total_tokens: totalTokens,
      breakdown_by_model: Object.values(modelBreakdown)
        .map(({ model, cents, count, tokens }) => ({ model, cost: cents / 100, count, tokens }))
        .sort((a, b) => b.cost - a.cost),
    },
  }
}

export async function getContentPerformanceMetrics(dateRange?: { start: string; end: string }): Promise<
  | {
      success: true
      metrics: {
        avg_generation_time_ms: number
        approval_rate: number
        usage_rate: number
        content_volume: number
        most_used_content_type: string
        avg_edits_per_piece: number
        peak_usage_hours: number[]
      }
    }
  | { success: false; error: string }
> {
  const auth = await requireContentActor()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createClient()

  let logsQuery = supabase
    .from("content_generation_logs")
    .select("generation_time_ms, generated_at, content_type, success")
    .eq("agent_id", auth.actor.agentId)

  if (dateRange) {
    logsQuery = logsQuery.gte("generated_at", dateRange.start).lte("generated_at", dateRange.end)
  }

  const { data: logs, error: logsError } = await logsQuery

  if (logsError) {
    console.error("[getContentPerformanceMetrics] Logs query failed:", logsError)
    return { success: false, error: logsError.message }
  }

  if (!logs || logs.length === 0) {
    return {
      success: true,
      metrics: {
        avg_generation_time_ms: 0,
        approval_rate: 0,
        usage_rate: 0,
        content_volume: 0,
        most_used_content_type: "none",
        avg_edits_per_piece: 0,
        peak_usage_hours: [],
      },
    }
  }

  // Calculate metrics
  const avgGenerationTime = logs.reduce((sum, log) => sum + (log.generation_time_ms || 0), 0) / logs.length

  // Get content data for approval rate
  const { data: content, error: contentError } = await supabase
    .from("ai_generated_content")
    .select("id")
    .eq("agent_id", auth.actor.agentId)
    .eq("brokerage_id", auth.actor.brokerageId)
    .not("edited_at", "is", null)

  if (contentError) {
    console.error("[getContentPerformanceMetrics] Content query failed:", contentError)
    return { success: false, error: contentError.message }
  }

  const editedCount = content?.length ?? 0
  // Clamp: more edits than generations in the window would otherwise render a
  // negative "approval rate".
  const approvalRate = Math.max(0, Math.min(1, 1 - editedCount / logs.length))

  // Peak usage hours
  const usageHours = logs.map((log) => new Date(log.generated_at).getHours())
  const hourCounts = usageHours.reduce((acc: any, hour) => {
    acc[hour] = (acc[hour] || 0) + 1
    return acc
  }, {})
  const peakHours = Object.entries(hourCounts)
    .sort((a: any, b: any) => b[1] - a[1])
    .slice(0, 4)
    .map((entry: any) => Number.parseInt(entry[0]))

  // Most used content type
  const contentTypes = logs.map((log) => log.content_type).filter(Boolean)
  const typeCounts = contentTypes.reduce((acc: any, type) => {
    acc[type] = (acc[type] || 0) + 1
    return acc
  }, {})
  const mostUsedType = Object.entries(typeCounts).sort((a: any, b: any) => b[1] - a[1])[0]?.[0] || "none"

  // `engagement_improvement: 0.25` used to be returned here as a real metric.
  // It was a literal — nothing computed it and nothing could. Removed rather
  // than shipped as a number an agent might act on. Real engagement lives in
  // getContentPerformanceStats, which reads content_performance_tracking.
  return {
    success: true,
    metrics: {
      avg_generation_time_ms: avgGenerationTime,
      approval_rate: approvalRate,
      usage_rate: logs.filter((l) => l.success).length / logs.length,
      content_volume: logs.length,
      most_used_content_type: mostUsedType,
      avg_edits_per_piece: editedCount / logs.length,
      peak_usage_hours: peakHours,
    },
  }
}

export async function trackContentUsage(params: {
  contentType: string
  aiEdited: boolean
  timeToApprove?: number
  personaTarget?: string
  performanceScore?: number
}): Promise<{ success: true; usageId: string } | { success: false; error: string }> {
  const auth = await requireContentActor()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!params.contentType?.trim()) return { success: false, error: "Content type is required" }

  const supabase = await createClient()

  // This insert previously ran with NO brokerage_id, which the agc_insert
  // policy (has_brokerage_access(brokerage_id)) refuses outright, AND its
  // result was never destructured — so it returned { success: true } over a
  // row the database had just thrown away.
  const { data, error } = await supabase
    .from("ai_generated_content")
    .insert({
      agent_id: auth.actor.agentId,
      brokerage_id: auth.actor.brokerageId,
      content_type: params.contentType,
      target_persona: params.personaTarget ?? null,
      performance_score: params.performanceScore ?? null,
      edited_at: params.aiEdited ? new Date().toISOString() : null,
      status: "archived",
      metadata: {
        ai_edited: params.aiEdited,
        time_to_approve_seconds: params.timeToApprove,
        persona_target: params.personaTarget,
        performance_score: params.performanceScore,
        tracked_at: new Date().toISOString(),
        is_usage_signal: true,
      },
      compliance_approved: false,
    })
    .select("id")
    .single()

  if (error) {
    console.error("[trackContentUsage] Insert failed:", error)
    return { success: false, error: error.message }
  }

  revalidatePath("/dashboard/content")
  return { success: true, usageId: data.id }
}

export async function getContentInsights(): Promise<
  | {
      success: true
      insights: {
        total_pieces: number
        most_used_content_type: string
        edit_rate: number
        most_popular_personas: string[]
        peak_usage_hours: number[]
        recommendations: string[]
      }
    }
  | { success: false; error: string }
> {
  const auth = await requireContentActor()
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = await createClient()

  const { data: content, error } = await supabase
    .from("ai_generated_content")
    .select("content_type, target_persona, edited_at, created_at")
    .eq("agent_id", auth.actor.agentId)
    .eq("brokerage_id", auth.actor.brokerageId)
    .order("created_at", { ascending: false })
    .limit(500)

  if (error) {
    console.error("[getContentInsights] Query failed:", error)
    return { success: false, error: error.message }
  }

  const rows = content ?? []
  if (rows.length === 0) {
    return {
      success: true,
      insights: {
        total_pieces: 0,
        most_used_content_type: "none",
        edit_rate: 0,
        most_popular_personas: [],
        peak_usage_hours: [],
        recommendations: ["Start generating content to see insights."],
      },
    }
  }

  const typeCounts = rows.reduce((acc: Record<string, number>, c) => {
    const t = c.content_type || "unknown"
    acc[t] = (acc[t] || 0) + 1
    return acc
  }, {})
  const mostUsedType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "none"

  const personaCounts = rows
    .map((c) => c.target_persona)
    .filter((p): p is string => Boolean(p))
    .reduce((acc: Record<string, number>, p) => {
      acc[p] = (acc[p] || 0) + 1
      return acc
    }, {})
  const topPersonas = Object.entries(personaCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([p]) => p)

  // avg_edits_per_piece was the literal 2.3 and peak_usage_hours the literal
  // [9,10,14,15] — both presented as findings about this agent. Both are now
  // actually derived from the rows above.
  const editRate = rows.filter((c) => c.edited_at).length / rows.length

  const hourCounts = rows.reduce((acc: Record<number, number>, c) => {
    if (!c.created_at) return acc
    const h = new Date(c.created_at).getHours()
    if (Number.isNaN(h)) return acc
    acc[h] = (acc[h] || 0) + 1
    return acc
  }, {})
  const peakHours = Object.entries(hourCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([h]) => Number(h))

  const recommendations: string[] = []
  if (typeCounts.social_post > 50) {
    recommendations.push("You're creating a lot of social content — consider diversifying with blog posts.")
  }
  if (topPersonas.length > 0) {
    recommendations.push(`${topPersonas[0]} is your most-targeted persona.`)
  }
  if (editRate > 0.5) {
    recommendations.push(
      `You edit ${Math.round(editRate * 100)}% of generated pieces — run a few through "Learn from edits" to tighten your brand voice.`
    )
  }
  if (peakHours.length > 0) {
    recommendations.push(`You generate most often around ${peakHours[0]}:00.`)
  }
  if (recommendations.length === 0) {
    recommendations.push("Not enough signal yet — keep generating and check back.")
  }

  return {
    success: true,
    insights: {
      total_pieces: rows.length,
      most_used_content_type: mostUsedType,
      edit_rate: editRate,
      most_popular_personas: topPersonas,
      peak_usage_hours: peakHours,
      recommendations,
    },
  }
}

// ============================================
// DESCRIPTION SAVE-BACK — writes approved text to listings.public_remarks
// ============================================

/**
 * Save an approved AI-generated description into listings.public_remarks.
 * This is the single write-path that closes the loop between AI generation
 * (ai_generated_content) and the listing record (listings.public_remarks).
 *
 * Call this from the "Approve & Publish" button in DescriptionApprovalCard.
 */
export async function saveDescriptionToListing(params: {
  listingId: string
  contentId: string
  approvedText: string
}): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(params.listingId)) return { success: false, error: "Invalid listing ID" }
  if (!isValidUUID(params.contentId)) return { success: false, error: "Invalid content ID" }
  if (!params.approvedText?.trim()) return { success: false, error: "Approved text cannot be empty" }

  const supabase = await createClient()

  // TENANT SCOPE (added). Being signed in was the only check: `auth.getUser()`
  // established *that* someone was authenticated and nothing more, then both
  // writes keyed on a caller-supplied id with no brokerage predicate. Any signed-in
  // user of any brokerage could therefore overwrite ANY listing's
  // `public_remarks` — the MLS-facing marketing copy for a property they have
  // nothing to do with — and flip any `ai_generated_content` row to
  // `compliance_approved: true`. The second one is the worse of the pair: it is a
  // compliance attestation, and it was settable by a stranger.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Not authenticated" }

  // 1. Write the approved text to the listing's public_remarks field.
  //    `.select("id")` makes the scope enforceable: a scoped UPDATE that matches
  //    nothing is a successful no-op in postgrest, so without reading back the
  //    affected row this would report success while writing nothing.
  const { data: updatedListing, error: listingError } = await supabase
    .from("listings")
    .update({
      public_remarks: params.approvedText.trim(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.listingId)
    .eq("brokerage_id", ctx.brokerageId)
    .select("id")

  if (listingError) {
    console.error("[saveDescriptionToListing] Failed to update listing:", listingError)
    return { success: false, error: listingError.message }
  }
  if (!updatedListing || updatedListing.length === 0) {
    return { success: false, error: "Listing not found in your brokerage" }
  }

  // 2. Mark the ai_generated_content record as approved — same scope.
  await supabase
    .from("ai_generated_content")
    .update({
      compliance_approved: true,
      status: "approved",
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.contentId)
    .eq("brokerage_id", ctx.brokerageId)

  revalidatePath(`/dashboard/listings/${params.listingId}`)
  revalidatePath(`/dashboard/listings/${params.listingId}/lifecycle`)

  return { success: true }
}
