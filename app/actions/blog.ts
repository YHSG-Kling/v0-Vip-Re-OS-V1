"use server"

// app/actions/blog.ts
// Layer 9.6 — SEO & Blog Engine Actions
// Kernel gates: canAccessFeature('seo_blog_engine'), applyBrandVoice, evaluateOutbound, checkBrandCompliance

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { applyBrandVoice } from "@/lib/kernel/brand-voice"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { checkBrandCompliance } from "@/lib/kernel/brand-compliance"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { pickTopics, renderTopicsForPrompt, type TopicCandidate } from "@/lib/content-intel/topic-bank"
import { logTopicUses } from "@/lib/content-intel/performance-aggregator"
import { resolveWordPressCredential, wordPressUnavailableReason } from "@/lib/blog/wordpress-connection"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface GenerateBlogPostParams {
  brokerageId: string
  agentUserId?: string
  title?: string
  keywords: string[]
  campaignId?: string
  tone?: string
  /** Source material to repurpose (e.g. a video transcript) — the article is
   * written FROM this when provided, instead of from keywords alone. */
  sourceContent?: string
  /** When true, generate a branded cover image and set featured_image_url. */
  generateCoverImage?: boolean
  /** Wave 29 — when set, the generator picks topics from content_topic_bank
   *  for this persona (per-persona perf score weighted via m136). The blog
   *  author then writes from those topics' value_angle rather than from
   *  keyword input alone. Same Wave 20.1 cohesion pattern newsletter has. */
  recipientPersona?: string
  /** Wave 29 — when true (cadence-cron path), the generator pulls topics
   *  from the topic bank automatically. When false (manual path), it
   *  honors the keywords array as-is. */
  pullFromTopicBank?: boolean
}

export interface UpdateBlogPostParams {
  title?: string
  slug?: string
  content?: string
  excerpt?: string
  featuredImageUrl?: string
  publishStatus?: "draft" | "pending_review" | "approved" | "published" | "rejected"
  category?: string
  callToAction?: string
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
    actorUserId: params.agentUserId,
    actorRole: "agent",
    journeyType: "buyer",
    persona: "first_time",
    messageType: "email",
    content: params.keywords.join(", "),
  }) as any

  const toneDescription = params.tone || brandVoice.tone || "professional and helpful"

  // Wave 29 — topic-bank consumption. When pullFromTopicBank=true (cadence
  // cron path), the picker returns the strongest threads for this brokerage
  // (and for the supplied persona when provided). The value_angle of each
  // picked topic becomes the article's substance. The keywords[] input is
  // still honored — it widens the picker's category filter.
  let topicSeeds: TopicCandidate[] = []
  if (params.pullFromTopicBank) {
    try {
      topicSeeds = await pickTopics({
        brokerageId:       params.brokerageId,
        categoriesAny:     params.keywords.length > 0 ? params.keywords : undefined,
        limit:             3,
        markUsed:          false,
        recipientPersona:  params.recipientPersona ?? null,
        assetType:         "blog_post",
      })
    } catch (e) {
      console.warn("[generateBlogPost] topic-bank pick failed; falling back to keywords-only:", (e as Error).message)
    }
  }
  const topicKeywords = params.keywords.join(", ")
  const topicSeedBlock = topicSeeds.length > 0
    ? `\n\nWave 29 — TOPIC INTELLIGENCE THREADS (build the article around these):
The platform's content-intelligence bank surfaced these as the highest-engagement
threads for this brokerage's audience right now. Lead with the strongest
single thread; weave the others as supporting structure.

${renderTopicsForPrompt(topicSeeds)}`
    : ""

  // ── 4. Generate blog post via Claude API ────────────────────────────────────
  // Wave 29 — reframed from "SEO-keyword optimization" to ONLINE VISIBILITY.
  // The user's explicit preference: not keyword stuffing, but rather
  // shareability + AI-citability + cross-channel repurposability. The
  // structural choices below (FAQ-style sections, named entity emphasis,
  // 3-sentence summary at top, attributed-claim format) make the article
  // EXTRACTABLE by Google AI Overviews / ChatGPT browsing / Perplexity /
  // Gemini citations — that's the modern discoverability signal.
  const systemPrompt = `You are a real estate content writer for a professional brokerage. Write in a ${toneDescription} style.
${brandVoice.customInstructions ? `Brand voice instructions: ${brandVoice.customInstructions}` : ""}
${brandVoice.keyBrandMessages?.length ? `Key messages to incorporate: ${brandVoice.keyBrandMessages.join(", ")}` : ""}
${brandVoice.prohibitedWords?.length ? `Avoid these words: ${brandVoice.prohibitedWords.join(", ")}` : ""}

ONLINE VISIBILITY (this brokerage's chosen positioning — NOT SEO keyword stuffing):
  · Be CITABLE by AI search (Google AI Overviews, ChatGPT, Claude, Perplexity, Gemini). Use clear facts with named entities + named sources where applicable.
  · Open with a 2-3 sentence summary that an AI engine can pull as a citation snippet.
  · Use FAQ-style H2/H3 headings written as the QUESTIONS a real-estate buyer/seller actually types.
  · Attribute non-obvious claims to a source (e.g. "According to the National Association of Realtors 2025 Q1 report,…"). Never invent a source — when uncertain, soften with "in many markets" rather than fabricate a citation.
  · Make the article shareable: end with a single specific takeaway readers can quote on social.`

  const userPrompt = `Write a 700-900 word blog post about real estate topics related to: ${topicKeywords}.
${params.sourceContent ? `Base the article on this source material (repurpose its key points; do not invent specific properties, prices, or guarantees):\n"""${params.sourceContent.slice(0, 6000)}"""\n` : ""}${params.title ? `Use this title: ${params.title}` : "Create an engaging title — written as a question or a specific claim the reader is searching for."}
${topicSeedBlock}

Structure (online-visibility format):
1. 2-3 sentence opening summary (the citation snippet).
2. 3-5 H2 sections written as questions the reader would search for.
3. Each section: a direct answer in the first sentence, then supporting context.
4. Closing takeaway — one specific actionable sentence (not "contact us").

Compliance fence (non-negotiable):
  · Never reference protected characteristics (race, color, religion, national origin, sex, disability, familial status).
  · No "perfect for families", "great for empty-nesters", or similar demographic proxies.
  · No guaranteed appreciation / valuation / rate claims.
  · No predictive market direction claims without an attributed source.

Return ONLY valid JSON with this exact structure (no markdown, no code blocks):
{
  "title": "The blog post title",
  "slug": "the-blog-post-slug",
  "excerpt": "A compelling 150-160 character meta description (also the OG card description)",
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
    const detail = err instanceof Error ? err.message : String(err)
    return { success: false, error: `Failed to generate blog content: ${detail}` }
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

  // ── 5b. Optional branded cover image ────────────────────────────────────────
  let featuredImageUrl: string | null = null
  if (params.generateCoverImage && blogResult.featuredImagePrompt) {
    try {
      const { generateImage } = await import("@/lib/ai/image-generation")
      // Wave 30 — thread brand hints into the call so the image inherits
      // brokerage logo + primary color + agent attribution. Without these
      // the generator falls back to a generic real-estate stock-looking
      // image; with them every post lands branded and consistent with
      // the brokerage's other marketing.
      const { data: brokerage } = await supabase
        .from("brokerages")
        .select("name, dba_name:dba, license_number, license_state, logo_url, brand_primary_color:primary_color")
        .eq("id", params.brokerageId)
        .maybeSingle()
      const b = brokerage as { name: string | null; dba_name: string | null; license_number: string | null; license_state: string | null; logo_url: string | null; brand_primary_color: string | null } | null
      const img = await generateImage({
        prompt:   blogResult.featuredImagePrompt,
        purpose:  "blog_hero",
        size:     "1792x1024",  // 16:9 Open Graph card ratio — works for inline blog hero AND for OG/Twitter card meta tags
        quality:  "standard",
        brand: {
          brokerageName:         b?.name ?? null,
          brokerageDba:          b?.dba_name ?? null,
          brokerageLicense:      b?.license_number ?? null,
          brokerageLicenseState: b?.license_state ?? null,
          logoUrl:               b?.logo_url ?? null,
          primaryColor:          b?.brand_primary_color ?? null,
        },
      })
      if (img.success && img.imageUrl) featuredImageUrl = img.imageUrl
    } catch (imgErr) {
      console.error("[generateBlogPost] Cover image generation failed (non-blocking):", imgErr)
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
      featured_image_url: featuredImageUrl,
      publish_status: "draft",
      visibility_scope: params.agentUserId ? "private" : "brokerage",
      created_by: userId,
      is_ai_generated: true,
    })
    .select("id")
    .maybeSingle()

  if (postError || !post) {
    console.error("[generateBlogPost] Insert failed:", postError)
    return { success: false, error: "Failed to save blog post" }
  }

  // Wave 29 — close the content intelligence loop for the blog channel.
  // Log every topic that seeded this post into content_topic_uses with
  // asset_type='blog_post' so the daily aggregator can compute per-(topic,
  // blog_post, persona) performance scores from blog_post_views downstream.
  // Same Wave 19 pattern the newsletter video and podcast use.
  if (topicSeeds.length > 0) {
    void logTopicUses({
      topicIds:    topicSeeds.map((t) => t.id),
      brokerageId: params.brokerageId,
      assetType:   "blog_post",
      assetId:     post.id,
    })
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
          visibility_scope: params.agentUserId ? "private" : "brokerage",
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
        contentId: postId,
      })

      if (!complianceResult.passed) {
        return {
          success: false,
          error: `Brand compliance failed: ${complianceResult.violations?.join(", ")}`,
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
  if (updates.category !== undefined) updateData.category = updates.category || null
  if (updates.callToAction !== undefined) updateData.call_to_action = updates.callToAction || null

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
// Wave 31 — kept as the WordPress-specific implementation. New callers use
// publishBlogPost() below which routes to the right backend based on
// blog_posts.publish_target. publishToWordPress is still exported for the
// 'both' target's WP leg and for backward-compat.

/**
 * Wave 31 — top-level publish entrypoint. Routes to the right backend
 * based on blog_posts.publish_target:
 *
 *   'hosted'    — flip publish_status='published' + published_at; the
 *                 /blog/[slug] route serves the post directly. No external
 *                 API call. Brokerages without WordPress use this.
 *   'wordpress' — call publishToWordPress (existing path); also flips
 *                 publish_status. Requires platform_credentials row.
 *   'both'      — fire the hosted publish AND the WordPress publish; the
 *                 WP content gets a rel="canonical" tag pointing to the
 *                 hosted URL so search engines don't see duplicate content.
 */
export async function publishBlogPost(
  userId: string,
  postId: string,
): Promise<{ success: boolean; hostedUrl?: string; wordpressPostId?: string; error?: string }> {
  const supabase = await createClient()
  const { data: post } = await supabase
    .from("blog_posts")
    .select("id, brokerage_id, slug, publish_status, publish_target")
    .eq("id", postId)
    .maybeSingle()
  const p = post as { id: string; brokerage_id: string; slug: string; publish_status: string; publish_target: string } | null
  if (!p) return { success: false, error: "Blog post not found" }
  if (p.publish_status !== "approved" && p.publish_status !== "published") {
    return { success: false, error: "Post must be approved before publishing" }
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? ""
  const hostedUrl = `${baseUrl}/blog/${p.slug}`

  if (p.publish_target === "hosted") {
    await supabase.from("blog_posts").update({
      publish_status: "published",
      published_at:   new Date().toISOString(),
    }).eq("id", postId)
    return { success: true, hostedUrl }
  }

  if (p.publish_target === "embed") {
    // Wave 32 — embed target is hosted-shape (no external API call), but
    // the URL the brokerage embeds is the chrome-stripped /embed route.
    // Both /blog/[slug] and /embed/blog/[slug] return the post on hit so
    // a brokerage can A/B test landing vs embed without re-publishing.
    await supabase.from("blog_posts").update({
      publish_status: "published",
      published_at:   new Date().toISOString(),
    }).eq("id", postId)
    return { success: true, hostedUrl: `${baseUrl}/embed/blog/${p.slug}` }
  }

  if (p.publish_target === "wordpress") {
    return await publishToWordPress(userId, postId)
  }

  // 'both' — fire hosted first (it never fails), then WordPress.
  await supabase.from("blog_posts").update({
    publish_status: "published",
    published_at:   new Date().toISOString(),
  }).eq("id", postId)
  const wpResult = await publishToWordPress(userId, postId)
  return {
    success:         true,
    hostedUrl,
    wordpressPostId: wpResult.wordpressPostId,
    error:           wpResult.success ? undefined : wpResult.error,
  }
}

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

  // ── 2. Get WordPress credentials ────────────────────────────────────────────
  // Resolution is gated on the Connection OS — see lib/blog/wordpress-connection.ts
  // for why this used to be an unanswerable query and what decision unblocks it.
  const credentials = await resolveWordPressCredential(supabase, post.brokerage_id)

  if (!credentials || !credentials.api_url) {
    return { success: false, error: wordPressUnavailableReason() }
  }

  // ── 3. Call WordPress REST API ──────────────────────────────────────────────
  // Wave 30 — augment the content with online-visibility instrumentation:
  //   · Inline view-tracker script that fires POST /api/blog/track-view on
  //     page load (parses ?p= / ?c= / ?utm_source= URL params)
  //   · Share-button block with per-channel onclick handlers that fire
  //     POST /api/blog/track-share BEFORE opening the share dialog
  // Both endpoints accept anonymous requests; the brokerage_id is
  // derived from the blog_post_id on the server. The platform's public
  // URL is read from env (NEXT_PUBLIC_APP_URL or VERCEL_URL) so the
  // injected script always points at the canonical tracker.
  const trackerBase = process.env.NEXT_PUBLIC_APP_URL
    ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "")
  const augmentedContent = buildInstrumentedBlogContent(post.content, postId, trackerBase)
  try {
    const authHeader = credentials.access_token
      ? `Bearer ${credentials.access_token}`
      : `Basic ${Buffer.from(`admin:${credentials.api_key}`).toString("base64")}`

    const response = await callConnector<{ id?: string | number }>({
      connector: "wordpress", baseUrl: credentials.api_url, path: "/wp-json/wp/v2/posts", method: "POST",
      auth: { style: "header", name: "Authorization", value: authHeader },
      body: { title: post.title, content: augmentedContent, excerpt: post.excerpt, status: "publish" },
    })

    if (!response.ok) {
      console.error("[publishToWordPress] WordPress API error:", response.error)
      return { success: false, error: "WordPress API error" }
    }

    const wpPost = response.data ?? {}

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
    category: string | null
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
    .select("id, title, slug, excerpt, publish_status, category, seo_score, created_at, published_at, agent_user_id")
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

// ─── saveBlogPost (manual create) ────────────────────────────────────────────
//
// Creates a blank/manual blog post — no AI generation.
// Uses getAgentContext() per architecture rules.

export interface SaveBlogPostParams {
  title: string
  slug?: string
  excerpt?: string
  content?: string
  featuredImageUrl?: string
  category?: string
  callToAction?: string
  publishStatus?: "draft" | "pending_review"
  keywords?: string[]
}

export async function saveBlogPost(
  params: SaveBlogPostParams
): Promise<{ success: boolean; postId?: string; error?: string }> {
  // ── 1. Auth via getAgentContext ──────────────────────────────────────────────
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.userId || !ctx.brokerageId) {
    return { success: false, error: "Not authenticated" }
  }

  const accessCheck = await canAccessFeature(ctx.userId, "seo_blog_engine")
  if (!accessCheck.allowed) {
    return { success: false, error: accessCheck.reason || "Feature access denied" }
  }

  const supabase = await createClient()

  // ── 2. Build slug from title if not supplied ────────────────────────────────
  const slug =
    (
      params.slug ||
      params.title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80)
    ) || `post-${Date.now()}`

  // ── 3. Insert blog_posts ────────────────────────────────────────────────────
  const insertData: Record<string, unknown> = {
    brokerage_id: ctx.brokerageId,
    agent_user_id: ctx.userId,
    created_by: ctx.userId,
    title: params.title,
    slug,
    excerpt: params.excerpt || null,
    content: params.content || null,
    featured_image_url: params.featuredImageUrl || null,
    publish_status: params.publishStatus ?? "draft",
    visibility_scope: "agent",
    // pass 14: compliance_approved is a phantom key — the live gate column is
    // approval_status (starts pending until compliance review).
    approval_status: "pending",
  }

  // Store category and call_to_action in content_metadata JSON column if it exists,
  // otherwise fall back to storing in excerpt/content fields.
  if (params.category) {
    insertData.category = params.category
  }

  if (params.callToAction) {
    insertData.call_to_action = params.callToAction
  }

  const { data: post, error: insertError } = await supabase
    .from("blog_posts")
    .insert(insertData)
    .select("id")
    .maybeSingle()

  if (insertError || !post) {
    console.error("[saveBlogPost] Insert failed:", insertError)
    return { success: false, error: "Failed to save blog post" }
  }

  // ── 4. Link keywords if provided ────────────────────────────────────────────
  if (params.keywords?.length) {
    for (let i = 0; i < params.keywords.length; i++) {
      const keyword = params.keywords[i]
      const isPrimary = i === 0

      const { data: existingKw } = await supabase
        .from("seo_keywords")
        .select("id")
        .eq("brokerage_id", ctx.brokerageId)
        .eq("keyword", keyword)
        .maybeSingle()

      let seoKeywordId: string

      if (existingKw) {
        seoKeywordId = existingKw.id
      } else {
        const { data: newKw, error: kwErr } = await supabase
          .from("seo_keywords")
          .insert({
            brokerage_id: ctx.brokerageId,
            keyword,
            keyword_type: isPrimary ? "primary" : "secondary",
            search_intent: "informational",
            visibility_scope: "agent",
            created_by: ctx.userId,
            is_active: true,
          })
          .select("id")
          .maybeSingle()

        if (kwErr || !newKw) {
          console.error("[saveBlogPost] Keyword insert failed:", kwErr)
          return { success: false, error: "Post saved but failed to create keywords" }
        }
        seoKeywordId = newKw.id
      }

      const { error: linkError } = await supabase.from("blog_post_keywords").insert({
        brokerage_id: ctx.brokerageId,
        blog_post_id: post.id,
        seo_keyword_id: seoKeywordId,
        is_primary: isPrimary,
      })
      if (linkError) {
        console.error("[saveBlogPost] keyword link insert failed:", linkError.message)
        return { success: false, error: "Post saved but failed to link keywords" }
      }
    }
  }

  // Increment usage only after all writes succeed
  await incrementFeatureUsage(ctx.userId, "seo_blog_engine")

  return { success: true, postId: post.id }
}

// ─── generateTopicIdeas ───────────────────────────────────────────────────────
//
// Returns 5 real estate blog topic suggestions based on the agent's market.
// Uses getAgentContext() — no userId param needed.

export interface TopicIdea {
  title: string
  category: string
  keywords: string[]
  rationale: string
}

export async function generateTopicIdeas(): Promise<{
  success: boolean
  ideas?: TopicIdea[]
  error?: string
}> {
  // ── 1. Auth ──────────────────────────────────────────────────────────────────
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.userId || !ctx.brokerageId) {
    return { success: false, error: "Not authenticated" }
  }

  // ── 2. Feature gate ──────────────────────────────────────────────────────────
  const accessCheck = await canAccessFeature(ctx.userId, "seo_blog_engine")
  if (!accessCheck.allowed) {
    return { success: false, error: accessCheck.reason || "Feature access denied" }
  }

  const supabase = await createClient()

  // ── 3. Fetch brokerage context ───────────────────────────────────────────────
  const { data: brokerage } = await supabase
    .from("brokerages")
    .select("name, city, state")
    .eq("id", ctx.brokerageId)
    .maybeSingle()

  const territory = brokerage?.city && brokerage?.state
    ? `${brokerage.city}, ${brokerage.state}`
    : "a local real estate market"

  // ── 4. Fetch recent existing posts to avoid duplicates ───────────────────────
  const { data: recentPosts } = await supabase
    .from("blog_posts")
    .select("title")
    .eq("brokerage_id", ctx.brokerageId)
    .order("created_at", { ascending: false })
    .limit(10)

  const recentTitles = recentPosts?.map((p) => p.title).join("; ") || ""

  // ── 5. Generate via AI ───────────────────────────────────────────────────────
  const systemPrompt = `You are a real estate content strategist. Generate timely, SEO-rich blog topic ideas for a real estate brokerage. Return structured JSON only.`

  const userPrompt = `Generate 5 blog topic ideas for a real estate brokerage in ${territory}.

Categories to choose from: Market Update, Buyer Tips, Seller Tips, Neighborhood Guide, Investment Tips, Company News

${recentTitles ? `Avoid these already-written topics: ${recentTitles}` : ""}

Return ONLY valid JSON (no markdown, no code blocks):
{
  "ideas": [
    {
      "title": "5 Things Every First-Time Buyer Should Know About ${territory}",
      "category": "Buyer Tips",
      "keywords": ["first-time buyer", "home buying guide", "${territory} real estate"],
      "rationale": "High search volume for first-time buyer content in this market"
    }
  ]
}`

  try {
    const { text } = await generateText({
      feature: "blog_generation",
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0.8,
      brokerageId: ctx.brokerageId,
      userId: ctx.userId,
    })

    const cleaned = text.replace(/```json\n?|\n?```/g, "").trim()
    const parsed = JSON.parse(cleaned) as { ideas: TopicIdea[] }
    return { success: true, ideas: parsed.ideas || [] }
  } catch (err) {
    console.error("[generateTopicIdeas] AI failed:", err)
    return { success: false, error: "Failed to generate topic ideas" }
  }
}

// ─── suggestSEOKeywords ───────────────────────────────────────────────────────
//
// Given a blog title and partial content, suggests relevant SEO keywords.
// Uses getAgentContext() — no userId param needed.

export async function suggestSEOKeywords(params: {
  title: string
  content?: string
}): Promise<{
  success: boolean
  keywords?: Array<{ keyword: string; type: "primary" | "secondary" | "long_tail" }>
  error?: string
}> {
  // ── 1. Auth ──────────────────────────────────────────────────────────────────
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.userId || !ctx.brokerageId) {
    return { success: false, error: "Not authenticated" }
  }

  // ── 2. Feature gate ──────────────────────────────────────────────────────────
  const accessCheck = await canAccessFeature(ctx.userId, "seo_blog_engine")
  if (!accessCheck.allowed) {
    return { success: false, error: accessCheck.reason || "Feature access denied" }
  }

  const supabase = await createClient()

  // ── 3. Fetch territory context ───────────────────────────────────────────────
  const { data: brokerage } = await supabase
    .from("brokerages")
    .select("city, state")
    .eq("id", ctx.brokerageId)
    .maybeSingle()

  const territory = brokerage?.city && brokerage?.state
    ? `${brokerage.city}, ${brokerage.state}`
    : "local area"

  // ── 4. Generate keyword suggestions via AI ───────────────────────────────────
  const systemPrompt = `You are an SEO specialist for real estate content. Suggest relevant, high-value SEO keywords. Return structured JSON only.`

  const contentSnippet = params.content
    ? params.content.slice(0, 500)
    : ""

  const userPrompt = `Suggest 8-10 SEO keywords for this real estate blog post in ${territory}.

Title: ${params.title}
${contentSnippet ? `Content preview: ${contentSnippet}` : ""}

Return ONLY valid JSON (no markdown, no code blocks):
{
  "keywords": [
    { "keyword": "homes for sale in ${territory}", "type": "primary" },
    { "keyword": "real estate tips", "type": "secondary" },
    { "keyword": "how to buy a home in ${territory} 2025", "type": "long_tail" }
  ]
}`

  try {
    const { text } = await generateText({
      feature: "blog_generation",
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0.3,
      brokerageId: ctx.brokerageId,
      userId: ctx.userId,
    })

    const cleaned = text.replace(/```json\n?|\n?```/g, "").trim()
    const parsed = JSON.parse(cleaned) as {
      keywords: Array<{ keyword: string; type: "primary" | "secondary" | "long_tail" }>
    }
    return { success: true, keywords: parsed.keywords || [] }
  } catch (err) {
    console.error("[suggestSEOKeywords] AI failed:", err)
    return { success: false, error: "Failed to suggest keywords" }
  }
}

/**
 * Wave 30 — wrap blog HTML with view-tracking script + share-button block.
 * Called from publishToWordPress before the WP REST insert. The script is
 * self-contained: reads its own data-blog-post-id attribute, parses URL
 * params (?p= persona, ?c= contact_id, ?utm_source= source), and fires a
 * fire-and-forget POST to the tracker endpoint. Share buttons render as
 * inline HTML with onclick handlers that fire the share-tracker before
 * opening the platform-specific share dialog.
 *
 * Why injected into content (not the WP theme): zero theme modification,
 * works on every WP install including managed hosts where theme edits are
 * locked. Some heavily-sanitized themes may strip the inline <script>;
 * those installs can add the script to their theme footer instead — but
 * the share buttons (pure HTML+onclick) survive every sanitizer.
 */
function buildInstrumentedBlogContent(originalContent: string, blogPostId: string, trackerBase: string): string {
  const safeBase = trackerBase.replace(/['"<>]/g, "")
  const safeId   = blogPostId.replace(/[^a-z0-9-]/gi, "")
  // Share buttons — emoji + label + onclick handler. The handler fires the
  // tracker THEN opens the share window (so a blocked window doesn't lose
  // the signal). Each channel is a simple anchor with javascript:void(0).
  const shareBlock = `
<div class="blog-share-block" style="margin:32px 0 16px 0;padding:16px;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;text-align:center;font-family:system-ui,-apple-system,sans-serif">
  <div style="font-size:14px;font-weight:600;color:#374151;margin-bottom:12px">Found this useful? Share it</div>
  <div style="display:flex;justify-content:center;gap:10px;flex-wrap:wrap">
    <a href="javascript:void(0)" onclick="window.__bptShare('facebook')"   style="padding:8px 14px;background:#1877f2;color:#fff;border-radius:6px;text-decoration:none;font-size:13px">Facebook</a>
    <a href="javascript:void(0)" onclick="window.__bptShare('twitter')"    style="padding:8px 14px;background:#000;color:#fff;border-radius:6px;text-decoration:none;font-size:13px">X / Twitter</a>
    <a href="javascript:void(0)" onclick="window.__bptShare('linkedin')"   style="padding:8px 14px;background:#0a66c2;color:#fff;border-radius:6px;text-decoration:none;font-size:13px">LinkedIn</a>
    <a href="javascript:void(0)" onclick="window.__bptShare('whatsapp')"   style="padding:8px 14px;background:#25d366;color:#fff;border-radius:6px;text-decoration:none;font-size:13px">WhatsApp</a>
    <a href="javascript:void(0)" onclick="window.__bptShare('email_share')" style="padding:8px 14px;background:#374151;color:#fff;border-radius:6px;text-decoration:none;font-size:13px">Email</a>
    <a href="javascript:void(0)" onclick="window.__bptShare('copy_link')"   style="padding:8px 14px;background:#6b7280;color:#fff;border-radius:6px;text-decoration:none;font-size:13px">Copy Link</a>
  </div>
</div>`
  // The tracker script — view fires on load, share fires on button click.
  // Uses mode:'no-cors' so cross-origin posts succeed without preflight
  // (the tracker endpoint accepts the body as-is from any origin since
  // it's public by design).
  const trackerScript = `
<script data-blog-post-id="${safeId}">
(function(){
  var BASE   = "${safeBase}";
  var POSTID = "${safeId}";
  if (!BASE || !POSTID) return;
  function paramOf(name){
    try { return new URLSearchParams(window.location.search).get(name); } catch(e) { return null; }
  }
  var persona = paramOf("p");
  var contactId = paramOf("c");
  var source = paramOf("utm_source") || (document.referrer ? guessSource(document.referrer) : "direct");
  function guessSource(ref){
    if (!ref) return "direct";
    var h = (function(){ try { return new URL(ref).hostname; } catch(e){ return ""; } })();
    if (h.indexOf("newsletter") >= 0 || ref.indexOf("utm_source=newsletter") >= 0) return "newsletter";
    if (h.indexOf("facebook") >= 0 || h.indexOf("twitter") >= 0 || h.indexOf("linkedin") >= 0 || h.indexOf("x.com") >= 0) return "social_post";
    if (h.indexOf("google") >= 0 || h.indexOf("bing") >= 0) return "organic";
    if (h.indexOf("openai") >= 0 || h.indexOf("perplexity") >= 0 || h.indexOf("chat.") >= 0 || h.indexOf("gemini") >= 0) return "ai_overview";
    return "unknown";
  }
  function post(path, body){
    try {
      fetch(BASE + path, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        keepalive: true
      });
    } catch(e){}
  }
  // View tracker — fire once on load
  post("/api/blog/track-view", {
    blog_post_id: POSTID,
    source: source,
    referrer: document.referrer || null,
    contact_id: contactId,
    persona_snapshot: persona
  });
  // Share handler — fire tracker, then open the share dialog
  window.__bptShare = function(channel){
    post("/api/blog/track-share", {
      blog_post_id: POSTID,
      share_channel: channel,
      contact_id: contactId,
      persona_snapshot: persona
    });
    var url = window.location.href;
    var title = document.title || "";
    if (channel === "copy_link") {
      try { navigator.clipboard.writeText(url); } catch(e){}
      return;
    }
    var target = "";
    if (channel === "facebook") target = "https://www.facebook.com/sharer/sharer.php?u=" + encodeURIComponent(url);
    else if (channel === "twitter") target = "https://twitter.com/intent/tweet?url=" + encodeURIComponent(url) + "&text=" + encodeURIComponent(title);
    else if (channel === "linkedin") target = "https://www.linkedin.com/sharing/share-offsite/?url=" + encodeURIComponent(url);
    else if (channel === "whatsapp") target = "https://api.whatsapp.com/send?text=" + encodeURIComponent(title + " " + url);
    else if (channel === "email_share") target = "mailto:?subject=" + encodeURIComponent(title) + "&body=" + encodeURIComponent(url);
    if (target) window.open(target, "_blank", "noopener,noreferrer");
  };
})();
</script>`
  return originalContent + shareBlock + trackerScript
}
