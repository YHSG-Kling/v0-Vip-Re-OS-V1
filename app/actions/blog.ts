"use server"

// app/actions/blog.ts
// Layer 9.6 — SEO & Blog Engine Actions
// Kernel gates: canAccessFeature('seo_blog_engine'), applyBrandVoice, evaluateOutbound, checkBrandCompliance

import { createClient } from "@/lib/supabase/server"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { applyBrandVoice } from "@/lib/kernel/brand-voice"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { checkBrandCompliance } from "@/lib/kernel/brand-compliance"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { generateTextRouted as generateText } from "@/lib/ai/models"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface GenerateBlogPostParams {
  brokerageId: string
  agentUserId?: string
  title?: string
  keywords: string[]
  campaignId?: string
  tone?: string
}

export interface UpdateBlogPostParams {
  title?: string
  slug?: string
  content?: string
  excerpt?: string
  featuredImageUrl?: string
  publishStatus?: "draft" | "pending_review" | "approved" | "published" | "rejected"
}

export interface BlogPostResult {
  title: string
  slug: string
  excerpt: string
  content: string
  featuredImagePrompt: string
}

// ─── generateBlogPost ─────────────────────────────────────────────────────────

export async function generateBlogPost(
  userId: string,
  params: GenerateBlogPostParams
): Promise<{ success: boolean; postId?: string; error?: string }> {
  const supabase = await createClient()

  // ── 1. Feature gate ─────────────────────────────────────────────────────────
  const accessCheck = await canAccessFeature(userId, "seo_blog_engine")
  if (!accessCheck.allowed) {
    return { success: false, error: accessCheck.reason || "Feature access denied" }
  }

  // ── 3. Apply brand voice ────────────────────────────────────────────────────
  const brandVoice = await applyBrandVoice({
    brokerageId: params.brokerageId,
    agentId: params.agentUserId,
    teamId: undefined,
  })

  const toneDescription = params.tone || brandVoice.tone || "professional and helpful"
  const topicKeywords = params.keywords.join(", ")

  // ── 4. Generate blog post via Claude API ────────────────────────────────────
  const systemPrompt = `You are a real estate content writer for a professional brokerage. Write in a ${toneDescription} style.
${brandVoice.customInstructions ? `Brand voice instructions: ${brandVoice.customInstructions}` : ""}
${brandVoice.keyBrandMessages?.length ? `Key messages to incorporate: ${brandVoice.keyBrandMessages.join(", ")}` : ""}
${brandVoice.prohibitedWords?.length ? `Avoid these words: ${brandVoice.prohibitedWords.join(", ")}` : ""}`

  const userPrompt = `Write a 600-800 word SEO-optimized blog post about real estate topics related to: ${topicKeywords}.
${params.title ? `Use this title: ${params.title}` : "Create an engaging title."}

Include these keywords naturally throughout the content: ${topicKeywords}

Return ONLY valid JSON with this exact structure (no markdown, no code blocks):
{
  "title": "The blog post title",
  "slug": "the-blog-post-slug",
  "excerpt": "A compelling 150-160 character meta description",
  "content": "The full blog post content with proper HTML headings (h2, h3) and paragraphs",
  "featuredImagePrompt": "A descriptive prompt for generating a featured image"
}`

  let blogResult: BlogPostResult
  try {
    const { text } = await generateText({
      feature: "blog_generation",
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0.7,
      brokerageId: params.brokerageId,
      userId,
    })

    // Parse JSON response
    const cleanedText = text.replace(/```json\n?|\n?```/g, "").trim()
    blogResult = JSON.parse(cleanedText) as BlogPostResult
  } catch (err) {
    console.error("[generateBlogPost] AI generation failed:", err)
    return { success: false, error: "Failed to generate blog content" }
  }

  // ── 5. Compliance check via evaluateOutbound ────────────────────────────────
  const complianceResult = await evaluateOutbound({
    actorContext: {
      userId,
      role: "agent",
      brokerageId: params.brokerageId,
    },
    journeyType: "buyer",
    persona: "first_time",
    messageType: "email",
    content: blogResult.content,
    contact: {
      id: "broadcast",
      first_name: "Broadcast",
      last_name: "Audience",
      contact_type: "buyer",
      tcpa_consent: true,
      isa_reengage_allowed: false,
      dnc_status: false,
    },
  })

  if (!complianceResult.allowed) {
    return {
      success: false,
      error: `Compliance check failed: ${complianceResult.violations.join(", ")}`,
    }
  }

  // ── 6. Insert blog_posts ────────────────────────────────────────────────────
  const { data: post, error: postError } = await supabase
    .from("blog_posts")
    .insert({
      brokerage_id: params.brokerageId,
      agent_user_id: params.agentUserId || null,
      marketing_campaign_id: params.campaignId || null,
      title: blogResult.title,
      slug: blogResult.slug,
      excerpt: blogResult.excerpt,
      content: blogResult.content,
      publish_status: "draft",
      visibility_scope: params.agentUserId ? "agent" : "brokerage",
      created_by: userId,
      compliance_approved: false,
    })
    .select("id")
    .maybeSingle()

  if (postError || !post) {
    console.error("[generateBlogPost] Insert failed:", postError)
    return { success: false, error: "Failed to save blog post" }
  }

  // ── 7. Link keywords via seo_keywords + blog_post_keywords ──────────────────
  for (let i = 0; i < params.keywords.length; i++) {
    const keyword = params.keywords[i]
    const isPrimary = i === 0 // First keyword is primary

    // Check if keyword exists in seo_keywords
    const { data: existingKeyword } = await supabase
      .from("seo_keywords")
      .select("id")
      .eq("brokerage_id", params.brokerageId)
      .eq("keyword", keyword)
      .maybeSingle()

    let seoKeywordId: string

    if (existingKeyword) {
      seoKeywordId = existingKeyword.id
    } else {
      // Insert new keyword into seo_keywords
      const { data: newKeyword, error: kwError } = await supabase
        .from("seo_keywords")
        .insert({
          brokerage_id: params.brokerageId,
          keyword: keyword,
          keyword_type: isPrimary ? "primary" : "secondary",
          search_intent: "informational",
          visibility_scope: params.agentUserId ? "agent" : "brokerage",
          created_by: userId,
          is_active: true,
        })
        .select("id")
        .maybeSingle()

      if (kwError || !newKeyword) {
        console.error("[generateBlogPost] Keyword insert failed:", kwError)
        continue
      }
      seoKeywordId = newKeyword.id
    }

    // Link keyword to blog post via blog_post_keywords
    await supabase.from("blog_post_keywords").insert({
      brokerage_id: params.brokerageId,
      blog_post_id: post.id,
      seo_keyword_id: seoKeywordId,
      is_primary: isPrimary,
    })
  }

  // ── 8. Increment feature usage ──────────────────────────────────────────────
  await incrementFeatureUsage(userId, "seo_blog_engine")

  // ── 9. Fire kernel event ────────────────────────────────────────────────────
  await processKernelEvent({
    event: KernelEvent.BLOG_POST_GENERATED,
    brokerageId: params.brokerageId,
    entityType: "blog_post",
    entityId: post.id,
  }).catch((err) => {
    console.error("[blog] generateBlogPost kernel event failed (non-blocking):", err)
  })

  return { success: true, postId: post.id }
}

// ─── updateBlogPost ───────────────────────────────────────────────────────────

export async function updateBlogPost(
  userId: string,
  postId: string,
  updates: UpdateBlogPostParams
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()

  // ── 1. Fetch post to get brokerageId ────────────────────────────────────────
  const { data: existingPost, error: fetchError } = await supabase
    .from("blog_posts")
    .select("brokerage_id, publish_status")
    .eq("id", postId)
    .maybeSingle()

  if (fetchError || !existingPost) {
    return { success: false, error: "Blog post not found" }
  }

  // ── 2. If moving to 'approved', run brand compliance ────────────────────────
  if (updates.publishStatus === "approved" && existingPost.publish_status !== "approved") {
    const { data: fullPost } = await supabase
      .from("blog_posts")
      .select("content")
      .eq("id", postId)
      .maybeSingle()

    if (fullPost?.content) {
      const complianceResult = await checkBrandCompliance({
        brokerageId: existingPost.brokerage_id,
        contentType: "blog_post",
        content: fullPost.content,
        agentId: undefined,
      })

      if (!complianceResult.passed) {
        return {
          success: false,
          error: `Brand compliance failed: ${complianceResult.issues?.join(", ")}`,
        }
      }
    }
  }

  // ── 3. Update blog_posts ────────────────────────────────────────────────────
  const updateData: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  }
  if (updates.title !== undefined) updateData.title = updates.title
  if (updates.slug !== undefined) updateData.slug = updates.slug
  if (updates.content !== undefined) updateData.content = updates.content
  if (updates.excerpt !== undefined) updateData.excerpt = updates.excerpt
  if (updates.featuredImageUrl !== undefined) updateData.featured_image_url = updates.featuredImageUrl
  if (updates.publishStatus !== undefined) updateData.publish_status = updates.publishStatus

  const { error: updateError } = await supabase.from("blog_posts").update(updateData).eq("id", postId)

  if (updateError) {
    console.error("[updateBlogPost] Update failed:", updateError)
    return { success: false, error: "Failed to update blog post" }
  }

  // ── 4. If published, fire kernel event ──────────────────────────────────────
  if (updates.publishStatus === "published") {
    await supabase.from("blog_posts").update({ published_at: new Date().toISOString() }).eq("id", postId)

    await processKernelEvent({
      event: KernelEvent.BLOG_POST_PUBLISHED,
      brokerageId: existingPost.brokerage_id,
      entityType: "blog_post",
      entityId: postId,
    }).catch((err) => {
      console.error("[blog] updateBlogPost kernel event failed (non-blocking):", err)
    })
  }

  return { success: true }
}

// ─── publishToWordPress ───────────────────────────────────────────────────────

export async function publishToWordPress(
  userId: string,
  postId: string
): Promise<{ success: boolean; wordpressPostId?: string; error?: string }> {
  const supabase = await createClient()

  // ── 1. Fetch post ───────────────────────────────────────────────────────────
  const { data: post, error: fetchError } = await supabase
    .from("blog_posts")
    .select("id, brokerage_id, title, content, excerpt, publish_status")
    .eq("id", postId)
    .maybeSingle()

  if (fetchError || !post) {
    return { success: false, error: "Blog post not found" }
  }

  if (post.publish_status !== "approved" && post.publish_status !== "published") {
    return { success: false, error: "Post must be approved before publishing to WordPress" }
  }

  // ── 2. Get WordPress credentials from platform_credentials ──────────────────
  const { data: credentials } = await supabase
    .from("platform_credentials")
    .select("api_url, api_key, access_token")
    .eq("brokerage_id", post.brokerage_id)
    .eq("platform", "wordpress")
    .eq("is_active", true)
    .maybeSingle()

  if (!credentials || !credentials.api_url) {
    return { success: false, error: "WordPress credentials not configured" }
  }

  // ── 3. Call WordPress REST API ──────────────────────────────────────────────
  try {
    const wpEndpoint = `${credentials.api_url}/wp-json/wp/v2/posts`
    const authHeader = credentials.access_token
      ? `Bearer ${credentials.access_token}`
      : `Basic ${Buffer.from(`admin:${credentials.api_key}`).toString("base64")}`

    const response = await fetch(wpEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify({
        title: post.title,
        content: post.content,
        excerpt: post.excerpt,
        status: "publish",
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error("[publishToWordPress] WordPress API error:", errorText)
      return { success: false, error: "WordPress API error" }
    }

    const wpPost = await response.json()

    // ── 4. Update blog_posts with wordpress_post_id ───────────────────────────
    await supabase
      .from("blog_posts")
      .update({
        wordpress_post_id: String(wpPost.id),
        published_at: new Date().toISOString(),
        publish_status: "published",
      })
      .eq("id", postId)

    return { success: true, wordpressPostId: String(wpPost.id) }
  } catch (err) {
    console.error("[publishToWordPress] Request failed:", err)
    return { success: false, error: "Failed to connect to WordPress" }
  }
}

// ─── getBlogPosts ──────────���────────────────────────────�����─────────────────────

export async function getBlogPosts(
  brokerageId: string,
  filters?: {
    publishStatus?: string
    agentUserId?: string
    startDate?: string
    endDate?: string
  }
): Promise<{
  success: boolean
  posts?: Array<{
    id: string
    title: string
    slug: string
    excerpt: string
    publish_status: string
    seo_score: number | null
    created_at: string
    published_at: string | null
    agent_user_id: string | null
  }>
  error?: string
}> {
  const supabase = await createClient()

  let query = supabase
    .from("blog_posts")
    .select("id, title, slug, excerpt, publish_status, seo_score, created_at, published_at, agent_user_id")
    .eq("brokerage_id", brokerageId)
    .order("created_at", { ascending: false })

  if (filters?.publishStatus) {
    query = query.eq("publish_status", filters.publishStatus)
  }
  if (filters?.agentUserId) {
    query = query.eq("agent_user_id", filters.agentUserId)
  }
  if (filters?.startDate) {
    query = query.gte("created_at", filters.startDate)
  }
  if (filters?.endDate) {
    query = query.lte("created_at", filters.endDate)
  }

  const { data, error } = await query

  if (error) {
    console.error("[getBlogPosts] Query failed:", error)
    return { success: false, error: "Failed to fetch blog posts" }
  }

  return { success: true, posts: data || [] }
}

// ─── getBlogPostById ──────────────────────────────────────────────────────────

export async function getBlogPostById(postId: string): Promise<{
  success: boolean
  post?: {
    id: string
    brokerage_id: string
    title: string
    slug: string
    excerpt: string
    content: string
    featured_image_url: string | null
    publish_status: string
    seo_score: number | null
    wordpress_post_id: string | null
    created_at: string
    published_at: string | null
    keywords: Array<{
      id: string
      keyword: string
      is_primary: boolean
    }>
    latestSeoLog: {
      score: number
      issues: string[]
      recommendations: string[]
    } | null
  }
  error?: string
}> {
  const supabase = await createClient()

  // Fetch post
  const { data: post, error: postError } = await supabase
    .from("blog_posts")
    .select(
      "id, brokerage_id, title, slug, excerpt, content, featured_image_url, publish_status, seo_score, wordpress_post_id, created_at, published_at"
    )
    .eq("id", postId)
    .maybeSingle()

  if (postError || !post) {
    return { success: false, error: "Blog post not found" }
  }

  // Fetch linked keywords
  const { data: keywordLinks } = await supabase
    .from("blog_post_keywords")
    .select("is_primary, seo_keyword_id")
    .eq("blog_post_id", postId)

  const keywords: Array<{ id: string; keyword: string; is_primary: boolean }> = []
  if (keywordLinks?.length) {
    const keywordIds = keywordLinks.map((kl) => kl.seo_keyword_id)
    const { data: keywordData } = await supabase.from("seo_keywords").select("id, keyword").in("id", keywordIds)

    if (keywordData) {
      for (const kd of keywordData) {
        const link = keywordLinks.find((kl) => kl.seo_keyword_id === kd.id)
        keywords.push({
          id: kd.id,
          keyword: kd.keyword,
          is_primary: link?.is_primary || false,
        })
      }
    }
  }

  // Fetch latest SEO log
  const { data: seoLog } = await supabase
    .from("seo_optimization_log")
    .select("score, issues, recommendations")
    .eq("blog_post_id", postId)
    .order("optimized_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  return {
    success: true,
    post: {
      ...post,
      keywords,
      latestSeoLog: seoLog
        ? {
            score: seoLog.score,
            issues: (seoLog.issues as { items?: string[] })?.items || [],
            recommendations: (seoLog.recommendations as { items?: string[] })?.items || [],
          }
        : null,
    },
  }
}

// ─── addSeoKeyword ────────────────────────────────────────────────────────────

export async function addSeoKeyword(
  userId: string,
  params: {
    brokerageId: string
    keyword: string
    keywordType: "primary" | "secondary" | "long_tail"
    searchIntent: "informational" | "transactional" | "navigational" | "commercial"
    targetLocation?: string
    searchVolume?: number
    competition?: number
    difficultyScore?: number
    priorityScore?: number
  }
): Promise<{ success: boolean; keywordId?: string; error?: string }> {
  const supabase = await createClient()

  // Check if keyword already exists
  const { data: existing } = await supabase
    .from("seo_keywords")
    .select("id")
    .eq("brokerage_id", params.brokerageId)
    .eq("keyword", params.keyword)
    .maybeSingle()

  if (existing) {
    return { success: false, error: "Keyword already exists" }
  }

  const { data: keyword, error } = await supabase
    .from("seo_keywords")
    .insert({
      brokerage_id: params.brokerageId,
      keyword: params.keyword,
      keyword_type: params.keywordType,
      search_intent: params.searchIntent,
      target_location: params.targetLocation || null,
      search_volume: params.searchVolume || null,
      competition: params.competition || null,
      difficulty_score: params.difficultyScore || null,
      priority_score: params.priorityScore || null,
      visibility_scope: "brokerage",
      created_by: userId,
      is_active: true,
    })
    .select("id")
    .maybeSingle()

  if (error || !keyword) {
    console.error("[addSeoKeyword] Insert failed:", error)
    return { success: false, error: "Failed to add keyword" }
  }

  return { success: true, keywordId: keyword.id }
}

// ─── getSeoKeywords ───────────────────────────────────────────────────────────

export async function getSeoKeywords(brokerageId: string): Promise<{
  success: boolean
  keywords?: Array<{
    id: string
    keyword: string
    keyword_type: string
    search_intent: string
    target_location: string | null
    search_volume: number | null
    competition: number | null
    difficulty_score: number | null
    priority_score: number | null
    is_active: boolean
  }>
  error?: string
}> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("seo_keywords")
    .select(
      "id, keyword, keyword_type, search_intent, target_location, search_volume, competition, difficulty_score, priority_score, is_active"
    )
    .eq("brokerage_id", brokerageId)
    .order("priority_score", { ascending: false, nullsFirst: false })

  if (error) {
    console.error("[getSeoKeywords] Query failed:", error)
    return { success: false, error: "Failed to fetch keywords" }
  }

  return { success: true, keywords: data || [] }
}

// ─── discoverKeywordsAI ───────────────────────────────────────────────────────
//
// Asks AI to surface the most popular SEO keywords for the brokerage's territory
// and their top competitor brokerages. Returns keywords with a relative search
// popularity percentage (0-100) so the agent can pick which ones to use for
// content generation.
//
// DB write: zero — this is a discovery/preview action only. The caller saves
// selected keywords via addSeoKeyword.

export interface DiscoveredKeyword {
  keyword:       string
  keyword_type:  "primary" | "secondary" | "long_tail"
  search_intent: "informational" | "transactional" | "navigational" | "commercial"
  popularity_pct: number   // 0-100 relative popularity score from AI analysis
  competitor_usage: boolean // true if a local competitor is ranking for this keyword
  rationale:     string    // one-sentence explanation
}

export async function discoverKeywordsAI(
  userId: string,
  params: {
    brokerageId: string
    territory?: string   // e.g. "Austin, TX" — falls back to brokerage city/state
    competitorNames?: string[] // optional list of known competitor brand names
    focusArea?: string   // e.g. "luxury listings", "first-time buyers", "rentals"
  }
): Promise<{
  success: boolean
  keywords?: DiscoveredKeyword[]
  error?: string
}> {
  const supabase = await createClient()

  // ── 1. Feature gate ──────────────────────────────────────────────────────────
  const accessCheck = await canAccessFeature(userId, "seo_blog_engine")
  if (!accessCheck.allowed) {
    return { success: false, error: accessCheck.reason || "Feature access denied" }
  }

  // ── 2. Resolve territory from brokerage record if not supplied ──────────────
  let territory = params.territory
  if (!territory) {
    const { data: brokerage } = await supabase
      .from("brokerages")
      .select("city, state, name")
      .eq("id", params.brokerageId)
      .maybeSingle()
    if (brokerage?.city && brokerage?.state) {
      territory = `${brokerage.city}, ${brokerage.state}`
    }
  }

  // ── 3. Fetch existing keywords so AI knows what agent already has ────────────
  const { data: existingKeywords } = await supabase
    .from("seo_keywords")
    .select("keyword")
    .eq("brokerage_id", params.brokerageId)
    .eq("is_active", true)
    .limit(30)

  const existingList = existingKeywords?.map(k => k.keyword) ?? []

  // ── 4. Build AI prompt ───────────────────────────────────────────────────────
  const competitorClause = params.competitorNames?.length
    ? `Known local competitors: ${params.competitorNames.join(", ")}.`
    : "Identify what keywords dominant local real estate brokerages in this market typically rank for."

  const focusClause = params.focusArea
    ? `Focus the keyword discovery on: ${params.focusArea}.`
    : "Cover a balanced mix of buyer-intent, seller-intent, and informational keywords."

  const existingClause = existingList.length
    ? `The agent already has these keywords: ${existingList.join(", ")}. Avoid exact duplicates but related variants are fine.`
    : ""

  const systemPrompt = `You are an SEO strategist specializing in real estate digital marketing. 
Your job is to surface the highest-impact keywords for a real estate brokerage based on their territory, 
local competitor landscape, and market demand. You return structured JSON only.`

  const userPrompt = `Discover the 12-15 most valuable SEO keywords for a real estate brokerage in ${territory || "a local real estate market"}.

${competitorClause}
${focusClause}
${existingClause}

For each keyword, estimate its relative popularity (0-100 where 100 = highest demand in this market) 
and whether local competitors are actively targeting it.

Return ONLY valid JSON (no markdown, no code blocks):
{
  "keywords": [
    {
      "keyword": "homes for sale in ${territory || "the area"}",
      "keyword_type": "primary",
      "search_intent": "transactional",
      "popularity_pct": 92,
      "competitor_usage": true,
      "rationale": "Highest-volume buyer search term in this market"
    }
  ]
}`

  let discovered: DiscoveredKeyword[]
  try {
    const { text } = await generateText({
      feature:      "blog_generation",
      system:       systemPrompt,
      prompt:       userPrompt,
      temperature:  0.4,
      brokerageId:  params.brokerageId,
      userId,
    })

    const cleaned = text.replace(/```json\n?|\n?```/g, "").trim()
    const parsed  = JSON.parse(cleaned) as { keywords: DiscoveredKeyword[] }
    discovered     = parsed.keywords ?? []
  } catch (err) {
    console.error("[discoverKeywordsAI] AI generation failed:", err)
    return { success: false, error: "Failed to generate keyword suggestions" }
  }

  // ── 5. Sort by popularity descending ─────────────────────────────────────────
  discovered.sort((a, b) => b.popularity_pct - a.popularity_pct)

  return { success: true, keywords: discovered }
}

// ─── toggleKeywordActive ──────────────────────────────────────────────────────

export async function toggleKeywordActive(
  keywordId: string,
  isActive: boolean
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient()

  const { error } = await supabase.from("seo_keywords").update({ is_active: isActive }).eq("id", keywordId)

  if (error) {
    console.error("[toggleKeywordActive] Update failed:", error)
    return { success: false, error: "Failed to update keyword" }
  }

  return { success: true }
}
