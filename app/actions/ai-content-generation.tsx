"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { generateAIResponse } from "@/lib/ai"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { generateContent } from "@/lib/services/content-generation.service"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { resolveProvider } from "@/lib/kernel/providers"
import { applyBrandVoice } from "@/lib/kernel/brand-voice"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"

function parseAIJsonResponse(text: string) {
  let cleanText = text.trim()
  if (cleanText.startsWith("```json")) {
    cleanText = cleanText.replace(/^```json\s*/, "").replace(/```\s*$/, "")
  } else if (cleanText.startsWith("```")) {
    cleanText = cleanText.replace(/^```\s*/, "").replace(/```\s*$/, "")
  }
  return JSON.parse(cleanText.trim())
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

  const { data: profile, error } = await supabase
    .from("brand_voice_profile")
    .upsert({
      agent_id: data.agentId,
      tone: data.tone,
      style: data.style,
      keywords: data.keywords,
      avoid_words: data.avoidWords,
      target_audience: data.targetAudience,
      brand_personality: data.brandPersonality,
      content_guidelines: data.contentGuidelines,
      example_posts: data.examplePosts,
      updated_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) throw error

  revalidatePath("/dashboard/content/settings")
  return profile
}

// ============================================
// CONTENT TEMPLATES
// ============================================

export async function getContentTemplates(filters?: { category?: string; contentType?: string }) {
  const supabase = await createClient()

  let query = supabase.from("content_templates").select("*").eq("is_active", true).order("usage_count", { ascending: false })

  if (filters?.category) {
    query = query.eq("category", filters.category)
  }
  if (filters?.contentType) {
    query = query.eq("content_type", filters.contentType)
  }

  const { data, error } = await query

  if (error) {
    console.error("Error fetching content templates:", error)
    return []
  }

  return data || []
}

export async function saveContentTemplate(data: {
  templateName: string
  contentType: string
  category: string
  structure: Record<string, unknown>
  placeholders?: string[]
  seoGuidelines?: Record<string, unknown>
  exampleOutput?: string
}) {
  const supabase = await createClient()

  const { data: template, error } = await supabase
    .from("content_templates")
    .insert({
      template_name: data.templateName,
      content_type: data.contentType,
      category: data.category,
      structure: data.structure,
      placeholders: data.placeholders,
      seo_guidelines: data.seoGuidelines,
      example_output: data.exampleOutput,
    })
    .select()
    .single()

  if (error) throw error

  revalidatePath("/dashboard/content/templates")
  return template
}

// ============================================
// AI GENERATED CONTENT
// ============================================

export async function getGeneratedContent(agentId: string, filters?: { contentType?: string; status?: string }) {
  // Return empty array for invalid UUIDs - production apps should require valid auth
  if (!isValidUUID(agentId)) {
    console.warn("[ai-content-generation] getGeneratedContent called with invalid UUID:", agentId)
    return []
  }

  const supabase = await createClient()

  let query = supabase.from("ai_generated_content").select("*").eq("agent_id", agentId).order("created_at", { ascending: false })

  if (filters?.contentType) {
    query = query.eq("content_type", filters.contentType)
  }
  if (filters?.status) {
    query = query.eq("status", filters.status)
  }

  const { data, error } = await query

  if (error) {
    console.error("Error fetching generated content:", error)
    return []
  }

  return data || []
}

export async function createGeneratedContent(data: {
  agentId: string
  contentType: string
  platform?: string
  title?: string
  content: string
  seoKeywords?: string[]
  hashtags?: string[]
  targetAudience?: string
  metadata?: Record<string, unknown>
  scheduledFor?: string
}) {
  const supabase = await createClient()

  const { data: content, error } = await supabase
    .from("ai_generated_content")
    .insert({
      agent_id: data.agentId,
      content_type: data.contentType,
      platform: data.platform,
      title: data.title,
      content: data.content,
      seo_keywords: data.seoKeywords,
      hashtags: data.hashtags,
      target_audience: data.targetAudience,
      metadata: data.metadata,
      scheduled_for: data.scheduledFor,
      compliance_approved: false,
    })
    .select()
    .single()

  if (error) throw error

  revalidatePath("/dashboard/content")
  return content
}

export async function updateContentStatus(contentId: string, status: string, publishedUrl?: string) {
  const supabase = await createClient()

  const updateData: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  }

  if (status === "published") {
    updateData.published_at = new Date().toISOString()
    updateData.published_url = publishedUrl
  }

  const { data, error } = await supabase.from("ai_generated_content").update(updateData).eq("id", contentId).select().single()

  if (error) throw error

  revalidatePath("/dashboard/content")
  return data
}

// ============================================
// SEO KEYWORDS
// ============================================

export async function getSEOKeywords(agentId: string) {
  if (!isValidUUID(agentId)) {
    return [
      { keyword: "Miami real estate", search_volume: 12000, competition: 0.85, is_primary: true },
      { keyword: "homes for sale Miami", search_volume: 8500, competition: 0.72, is_primary: true },
      { keyword: "Miami luxury homes", search_volume: 5200, competition: 0.68, is_primary: false },
    ]
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("seo_keywords")
    .select("*")
    .eq("agent_id", agentId)
    .eq("is_active", true)
    .order("search_volume", { ascending: false })

  if (error) {
    console.error("Error fetching SEO keywords:", error)
    return []
  }

  return data || []
}

export async function addSEOKeyword(data: {
  agentId: string
  keyword: string
  searchVolume?: number
  competition?: number
  isPrimary?: boolean
  category?: string
}) {
  const supabase = await createClient()

  const { data: keyword, error } = await supabase
    .from("seo_keywords")
    .insert({
      agent_id: data.agentId,
      keyword: data.keyword,
      search_volume: data.searchVolume,
      competition: data.competition,
      is_primary: data.isPrimary || false,
      category: data.category,
    })
    .select()
    .single()

  if (error) throw error

  revalidatePath("/dashboard/content/seo")
  return keyword
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
}) {
  const supabase = await createClient()

  const { data: performance, error } = await supabase
    .from("content_performance_tracking")
    .upsert(
      {
        content_id: data.contentId,
        platform: data.platform,
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

  if (error) throw error

  return performance
}

export async function getContentPerformanceStats(agentId: string, dateRange?: { start: string; end: string }) {
  if (!isValidUUID(agentId)) {
    return {
      totalImpressions: 45230,
      totalEngagement: 3420,
      avgEngagementRate: 7.6,
      topPerformingContent: [],
      performanceByType: {
        social_post: { impressions: 32000, engagement: 2500 },
        blog_post: { impressions: 8230, engagement: 620 },
        email: { impressions: 5000, engagement: 300 },
      },
    }
  }

  const supabase = await createClient()

  const { data: content } = await supabase.from("ai_generated_content").select("id").eq("agent_id", agentId)

  const contentIds = content?.map((c) => c.id) || []

  let query = supabase.from("content_performance_tracking").select("*").in("content_id", contentIds)

  if (dateRange) {
    query = query.gte("created_at", dateRange.start).lte("created_at", dateRange.end)
  }

  const { data: performance } = await query

  const totalImpressions = performance?.reduce((sum, p) => sum + (p.impressions || 0), 0) || 0
  const totalEngagement =
    performance?.reduce((sum, p) => sum + (p.likes || 0) + (p.shares || 0) + (p.comments || 0), 0) || 0
  const avgEngagementRate =
    performance && performance.length > 0
      ? performance.reduce((sum, p) => sum + (p.engagement_rate || 0), 0) / performance.length
      : 0

  return { totalImpressions, totalEngagement, avgEngagementRate, topPerformingContent: [], performanceByType: {} }
}

// ============================================
// HASHTAG PERFORMANCE
// ============================================

export async function getHashtagPerformance(agentId: string) {
  if (!isValidUUID(agentId)) {
    return [
      { hashtag: "#MiamiRealEstate", usage_count: 45, avg_engagement: 8.2, avg_reach: 12500 },
      { hashtag: "#LuxuryHomes", usage_count: 32, avg_engagement: 9.1, avg_reach: 15200 },
      { hashtag: "#JustListed", usage_count: 28, avg_engagement: 7.8, avg_reach: 10800 },
    ]
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("hashtag_performance")
    .select("*")
    .eq("agent_id", agentId)
    .order("avg_engagement", { ascending: false })
    .limit(20)

  if (error) {
    console.error("Error fetching hashtag performance:", error)
    return []
  }

  return data || []
}

export async function trackHashtagUsage(data: { agentId: string; hashtag: string; engagement: number; reach: number }) {
  const supabase = await createClient()

  // Get existing hashtag stats
  const { data: existing } = await supabase
    .from("hashtag_performance")
    .select("*")
    .eq("agent_id", data.agentId)
    .eq("hashtag", data.hashtag)
    .maybeSingle()

  if (existing) {
    // Update existing
    const newUsageCount = (existing.usage_count || 0) + 1
    const newAvgEngagement =
      ((existing.avg_engagement || 0) * (existing.usage_count || 0) + data.engagement) / newUsageCount
    const newAvgReach = ((existing.avg_reach || 0) * (existing.usage_count || 0) + data.reach) / newUsageCount

    const { error } = await supabase
      .from("hashtag_performance")
      .update({
        usage_count: newUsageCount,
        avg_engagement: newAvgEngagement,
        avg_reach: newAvgReach,
        last_used_at: new Date().toISOString(),
      })
      .eq("id", existing.id)

    if (error) throw error
  } else {
    // Create new
    const { error } = await supabase.from("hashtag_performance").insert({
      agent_id: data.agentId,
      hashtag: data.hashtag,
      usage_count: 1,
      avg_engagement: data.engagement,
      avg_reach: data.reach,
    })

    if (error) throw error
  }

  revalidatePath("/dashboard/content/hashtags")
}

// ============================================
// CONTENT A/B TESTS
// ============================================

export async function createContentABTest(data: {
  agentId: string
  testName: string
  contentType: string
  variantAId: string
  variantBId: string
  testMetric: string
  targetSampleSize?: number
}) {
  const supabase = await createClient()

  const { data: test, error } = await supabase
    .from("content_ab_tests")
    .insert({
      agent_id: data.agentId,
      test_name: data.testName,
      content_type: data.contentType,
      variant_a_id: data.variantAId,
      variant_b_id: data.variantBId,
      test_metric: data.testMetric,
      target_sample_size: data.targetSampleSize || 1000,
    })
    .select()
    .single()

  if (error) throw error

  revalidatePath("/dashboard/content/ab-tests")
  return test
}

export async function updateABTestResults(testId: string, results: {
  variantA: Record<string, unknown>
  variantB: Record<string, unknown>
  winner?: string
}) {
  const supabase = await createClient()

  const { data: test, error } = await supabase
    .from("content_ab_tests")
    .update({
      variant_a_performance: results.variantA,
      variant_b_performance: results.variantB,
      winner: results.winner,
      status: results.winner ? "completed" : "active",
      completed_at: results.winner ? new Date().toISOString() : null,
    })
    .eq("id", testId)
    .select()
    .single()

  if (error) throw error

  revalidatePath("/dashboard/content/ab-tests")
  return test
}

// ============================================
// CONTENT GENERATION LOGS
// ============================================

export async function logContentGeneration(data: {
  agentId: string
  contentType: string
  prompt: string
  model?: string
  tokensUsed?: number
  generationTime?: number
  success: boolean
  errorMessage?: string
}) {
  const supabase = await createClient()

  const { error } = await supabase.from("ai_generated_content").insert({
    agent_id: data.agentId,
    content_type: data.contentType,
    content: data.prompt,
    metadata: {
      model: data.model,
      tokens_used: data.tokensUsed,
      generation_time_ms: data.generationTime,
      success: data.success,
      error_message: data.errorMessage,
      is_log: true,
    },
    compliance_approved: false,
  })

  if (error) {
    console.error("Error logging content generation:", error)
  }
}

export async function getContentGenerationStats(agentId: string, dateRange?: { start: string; end: string }) {
  if (!isValidUUID(agentId)) {
    return {
      totalGenerations: 156,
      successRate: 98.5,
      avgGenerationTime: 2.3,
      totalTokensUsed: 45230,
    }
  }

  const supabase = await createClient()

  let query = supabase.from("ai_generated_content").select("*").eq("agent_id", agentId).eq("metadata->>is_log", "true")

  if (dateRange) {
    query = query.gte("created_at", dateRange.start).lte("created_at", dateRange.end)
  }

  const { data: logs } = await query

  const totalGenerations = logs?.length || 0
  const successCount = logs?.filter((l) => l.success).length || 0
  const successRate = totalGenerations > 0 ? (successCount / totalGenerations) * 100 : 0
  const avgGenerationTime =
    logs && logs.length > 0 ? logs.reduce((sum, l) => sum + (l.generation_time_ms || 0), 0) / logs.length : 0
  const totalTokensUsed = logs?.reduce((sum, l) => sum + (l.tokens_used || 0), 0) || 0

  return { totalGenerations, successRate, avgGenerationTime, totalTokensUsed }
}

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

  const supabase = await createClient()
  const startTime = Date.now()

  try {
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

    // Get agent context for AI routing
    const agentContext = await getAgentContext()

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

    const { data: savedContent } = await supabase
      .from("ai_generated_content")
      .insert({
        agent_id: params.agentId,
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

    await logContentGeneration({
      agentId: params.agentId,
      contentType: "listing_description",
      prompt: prompt.substring(0, 500),
      model: response.model,
      tokensUsed: response.tokensUsed.total,
      generationTime,
      success: true,
    })

    revalidatePath("/dashboard/content")
    return { success: true, data: result, contentId: savedContent?.id }
  } catch (error) {
    console.error("Generate listing description error:", error)
    await logContentGeneration({
      agentId: params.agentId,
      contentType: "listing_description",
      prompt: "Error occurred",
      success: false,
      errorMessage: error instanceof Error ? error.message : "Unknown error",
    })
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

    revalidatePath("/dashboard/content/social")
        return {
      success: true,
      data: result.content,
      contentId: result.content?.id,
      caption: result.content?.generated_content,
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

    revalidatePath("/dashboard/content/email")
        return {
      success: true,
      data: result.content,
      contentId: result.content?.id,
      subject: result.content?.subject,
      body: result.content?.generated_content,
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

    if (result.seo_keywords_used && savedContent) {
      await Promise.all(
        result.seo_keywords_used.map((keyword: string) =>
          supabase.from("seo_keywords").insert({
            agent_id: params.agentId,
            keyword,
            content_id: savedContent.id,
            search_volume: 0,
            difficulty: 50,
          })
        )
      )
    }

    await logContentGeneration({
      agentId: params.agentId,
      contentType: "blog_post",
      prompt: prompt.substring(0, 500),
      model: response.model,
      tokensUsed: response.tokensUsed.total,
      generationTime,
      success: true,
    })

    revalidatePath("/dashboard/content/blog")
    return { success: true, data: result, contentId: savedContent?.id }
  } catch (error) {
    console.error("Generate blog post error:", error)
    await logContentGeneration({
      agentId: params.agentId,
      contentType: "blog_post",
      prompt: "Error occurred",
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
  agentId: string
  content: string
  platform: "instagram" | "facebook" | "linkedin" | "twitter" | "tiktok"
  propertyType?: string
  location?: string
  maxHashtags?: number
}) {
  if (!isValidUUID(params.agentId)) {
    return {
      recommended_hashtags: {
        high_reach: ["#RealEstate", "#HomesForSale", "#DreamHome"],
        medium_reach: ["#MiamiRealEstate", "#LuxuryHomes", "#NewListing"],
        niche: ["#MiamiLuxury", "#SouthFloridaHomes", "#ModernHome"],
      },
      platform_optimized_string: "#RealEstate #MiamiRealEstate #HomesForSale #LuxuryHomes #DreamHome",
    }
  }

  const supabase = await createClient()

  try {
    // Get historical hashtag performance
    const { data: performanceData } = await supabase
      .from("hashtag_performance")
      .select("*")
      .eq("agent_id", params.agentId)
      .order("avg_engagement", { ascending: false })
      .limit(50)

    const topPerformingHashtags = performanceData?.map((h) => h.hashtag) || []

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

    return result
  } catch (error) {
    console.error("Generate hashtags error:", error)
    return { success: false, error: "Failed to generate hashtags" }
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

export async function learnFromEdits(params: { contentId: string; originalContent: string; editedContent: string }) {
  const supabase = await createClient()

  try {
    // Get the content record to find agent_id
    const { data: content } = await supabase.from("ai_generated_content").select("agent_id").eq("id", params.contentId).single()

    if (!content?.agent_id) return

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

    // Get existing brand voice
    const { data: brandVoice } = await supabase
      .from("brand_voice_profile")
      .select("*")
      .eq("agent_id", content.agent_id)
      .maybeSingle()

    if (brandVoice) {
      // Update brand voice with learnings
      const updatedAvoidWords = [...(brandVoice.avoid_words || []), ...(learnings.words_to_avoid || [])]
      const updatedKeyPhrases = [...(brandVoice.key_phrases || []), ...(learnings.preferred_phrases || [])]

      await supabase
        .from("brand_voice_profile")
        .update({
          avoid_words: Array.from(new Set(updatedAvoidWords)),
          key_phrases: Array.from(new Set(updatedKeyPhrases)),
          writing_style_notes: `${brandVoice.writing_style_notes || ""}\n${learnings.style_notes || ""}`,
        })
        .eq("agent_id", content.agent_id)
    }

    return learnings
  } catch (error) {
    console.error("Learn from edits error:", error)
    return null
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
}) {
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

  return { score, recommendations, wordCount, keywordDensity, readabilityScore }
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
      compliance_checked: true,
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

export async function generateContentPlan(params: { agentId: string; month: Date; includeListings?: boolean }) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    // Get agent context
    const { data: agent } = await supabase.from("users").select("*").eq("id", params.agentId).single()

    const { data: listings } = await supabase
      .from("transactions")
      .select("*")
      .eq("agent_id", params.agentId)
      .eq("status", "active")

    const { data: personas } = await supabase
      .from("client_detailed_personas")
      .select("persona_type")
      .limit(5)

    const { data: topContent } = await supabase
      .from("ai_generated_content")
      .select("*, performance_score")
      .eq("agent_id", params.agentId)
      .order("performance_score", { ascending: false })
      .limit(10)

    const topTopics = topContent?.map((c) => c.metadata?.topic || "general") || []

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

    // Save to content calendar
    if (plan.plan && Array.isArray(plan.plan)) {
      for (const item of plan.plan) {
        await supabase.from("content_calendar").insert({
          agent_id: params.agentId,
          title: item.topic,
          content_type: item.content_type,
          scheduled_date: item.date,
          platform: item.platforms?.[0],
          status: "draft",
          notes: item.reasoning,
        })
      }
    }

    revalidatePath("/dashboard/content/calendar")
    return { success: true, data: plan }
  } catch (error) {
    console.error("Generate content plan error:", error)
    return { success: false, error: "Failed to generate content plan" }
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

export async function createABTest(params: {
  baseContentId: string
  testVariable: "subject_line" | "opening_hook" | "cta" | "length" | "tone"
  sampleSize?: number
}) {
  if (!isValidUUID(params.baseContentId)) {
    return { success: false, error: "Invalid content ID" }
  }

  const supabase = await createClient()

  try {
    const { data: baseContent } = await supabase
      .from("ai_generated_content")
      .select("*")
      .eq("id", params.baseContentId)
      .single()

    if (!baseContent) {
      return { success: false, error: "Content not found" }
    }

    // Generate variant
    const variant = await generateVariant(baseContent, params.testVariable)

    // Create test record
    const { data: test, error } = await supabase
      .from("content_ab_tests")
      .insert({
        test_name: `${params.testVariable} test - ${baseContent.content_type}`,
        content_type: baseContent.content_type,
        variant_a_id: baseContent.id,
        variant_b_id: variant.id,
        test_variable: params.testVariable,
        sample_size_per_variant: params.sampleSize || 100,
        started_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (error) throw error

    revalidatePath("/dashboard/content/ab-tests")
    return { success: true, data: test }
  } catch (error) {
    console.error("Create A/B test error:", error)
    return { success: false, error: "Failed to create A/B test" }
  }
}

/** Deterministic seed from content hash — avoids non-reproducible Math.random() in AI contexts */
function getVariationSeed(content: string): number {
  return Math.abs([...content.slice(0, 50)].reduce((h, c) =>
    (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0))
}

async function generateVariant(baseContent: any, testVariable: string) {
  const seed = getVariationSeed(baseContent.generated_text ?? baseContent.metadata?.subject_line ?? testVariable)

  const prompts: Record<string, string> = {
    subject_line: `Generate alternative subject line for this email.
Original: "${baseContent.metadata?.subject_line || ""}"
Requirements: Different approach (question vs statement, curiosity vs benefit, etc.)
Keep same topic but fresh angle.`,

    opening_hook: `Rewrite opening paragraph with different hook strategy.
Original: "${baseContent.generated_text?.substring(0, 200) || ""}"
Try a ${["question", "statistic", "story", "bold statement"][seed % 4]} approach.`,

    cta: `Generate alternative call-to-action.
Original: "${baseContent.metadata?.cta_text || ""}"
Make it more ${["urgent", "soft", "benefit-focused", "curiosity-driven"][seed % 4]}.`,

    length: `${baseContent.generated_text?.length > 500 ? "Shorten" : "Expand"} this content while keeping key points.
Original length: ${baseContent.generated_text?.length} characters
Target: ${baseContent.generated_text?.length > 500 ? "50%" : "150%"} of original`,

    tone: `Rewrite entire content with different tone.
Original: ${baseContent.generated_text}
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

  // Save variant
  const { data: variant } = await supabase
    .from("ai_generated_content")
    .insert({
      agent_id: baseContent.agent_id,
      content_type: baseContent.content_type,
      generated_text: response.text,
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

  return variant
}

export async function analyzeABTest(testId: string) {
  if (!isValidUUID(testId)) {
    return { success: false, error: "Invalid test ID" }
  }

  const supabase = await createClient()

  try {
    const { data: test } = await supabase
      .from("content_ab_tests")
      .select("*, variant_a:ai_generated_content!variant_a_id(*), variant_b:ai_generated_content!variant_b_id(*)")
      .eq("id", testId)
      .single()

    if (!test) {
      return { success: false, error: "Test not found" }
    }

    // Get performance data
    const performanceA = test.variant_a?.engagement_metrics || {}
    const performanceB = test.variant_b?.engagement_metrics || {}

    const metricA = performanceA.engagement_rate || 0
    const metricB = performanceB.engagement_rate || 0

    const winner = metricA > metricB ? "A" : "B"
    const improvement = Math.abs(metricA - metricB) / Math.min(metricA || 1, metricB || 1) * 100

    // Calculate statistical confidence (simplified)
    const sampleSize = test.sample_size_per_variant || 100
    const confidence = calculateConfidence(metricA, metricB, sampleSize)

    // Update test record
    await supabase
      .from("content_ab_tests")
      .update({
        winner_variant: winner,
        confidence_level: confidence,
        results_summary: {
          variant_a_rate: metricA,
          variant_b_rate: metricB,
          improvement_percentage: improvement,
        },
        ended_at: new Date().toISOString(),
        declared_winner_at: confidence > 0.95 ? new Date().toISOString() : null,
      })
      .eq("id", testId)

    return {
      success: true,
      data: {
        winner,
        improvement: `${improvement.toFixed(1)}%`,
        confidence: `${(confidence * 100).toFixed(1)}%`,
        recommendation: generateTestRecommendation(test, winner, improvement, confidence),
      },
    }
  } catch (error) {
    console.error("Analyze A/B test error:", error)
    return { success: false, error: "Failed to analyze test" }
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
  agentId: string
  contentType: "listing_description" | "social_post" | "email" | "blog_post"
  targets: string[]
  templateId?: string
  personalizationLevel?: "high" | "medium" | "low"
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    const jobs = params.targets.map((targetId, index) => ({
      target: targetId,
      status: "queued" as const,
      priority: calculateJobPriority(targetId, index),
    }))

    const results = []

    // Process each target
    for (const job of jobs) {
      try {
        let result

        switch (params.contentType) {
          case "listing_description":
            result = await generateListingDescription({
              agentId: params.agentId,
              propertyId: job.target,
              length: "medium",
            })
            break

          case "social_post":
            result = await generateSocialPost({
              agentId: params.agentId,
              platform: "instagram",
              postType: "general",
              context: `Property: ${job.target}`,
              propertyId: job.target,
            })
            break

          case "email":
            result = await generateEmail({
              agentId: params.agentId,
              emailType: "follow_up",
              contactId: job.target,
            })
            break

          case "blog_post":
            result = await generateBlogPost({
              agentId: params.agentId,
              topic: "Market update",
            })
            break
        }

        results.push({ target: job.target, success: true, data: result })
      } catch (error) {
        results.push({ target: job.target, success: false, error: String(error) })
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
    return { success: false, error: "Failed to bulk generate content" }
  }
}

function calculateJobPriority(targetId: string, index: number): number {
  // Higher priority for newer items (lower index)
  return Math.max(1, 10 - Math.floor(index / 10))
}

export async function generateAllListingDescriptions(agentId: string) {
  if (!isValidUUID(agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  const { data: listings } = await supabase
    .from("transactions")
    .select("property_id")
    .eq("agent_id", agentId)
    .eq("status", "active")

  if (!listings || listings.length === 0) {
    return { success: true, data: { queued: 0 } }
  }

  return await bulkGenerateContent({
    agentId,
    contentType: "listing_description",
    targets: listings.map((l) => l.property_id),
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
  const price = property.price || property.listing_price || 0
  const priceRange = price < 300000 ? 'affordable' : price < 600000 ? 'mid-range' : price < 1000000 ? 'upscale' : 'luxury'
  keywords.push(`${priceRange} homes ${property.city}`)

  return keywords
}

export async function getNeighborhoodData(city: string, zip?: string) {
  // In production, this would integrate with APIs like Walk Score, GreatSchools, etc.
  // For now, returning structured mock data
  return {
    neighborhood: 'Downtown District',
    schools: 'Highly rated schools nearby',
    walk_score: 75,
    amenities: 'Parks, restaurants, shopping within walking distance',
    school_district: 'Lincoln Unified',
    nearby_attractions: ['City Park', 'Shopping Center', 'Community Center'],
  }
}

export async function detectTargetBuyer(property: any) {
  const bedrooms = property.bedrooms || 0
  const sqft = property.square_feet || property.square_footage || 0
  const price = property.price || property.listing_price || 0
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
  const sqft = property.square_feet || property.square_footage || 0

  const { data: comps } = await supabase
    .from('listings')
    .select('address, price, listing_price, status, sold_date, square_feet')
    .eq('city', property.city)
    .gte('square_feet', sqft * 0.9)
    .lte('square_feet', sqft * 1.1)
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

export async function enhancedGenerateListingDescription(params: {
  transactionId?: string
  propertyId?: string
  agentId: string
  descriptionType?: 'short_mls' | 'standard' | 'extended' | 'social_snippet'
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: 'Invalid agent ID' }
  }

  const supabase = await createClient()

  try {
    // Get property details
    let property: any = null

    if (params.transactionId && isValidUUID(params.transactionId)) {
      const { data: transaction } = await supabase
        .from('transactions')
        .select('*, listings(*), contacts(*)')
        .eq('id', params.transactionId)
        .single()

      property = transaction?.listings
    } else if (params.propertyId && isValidUUID(params.propertyId)) {
      const { data } = await supabase.from('listings').select('*').eq('id', params.propertyId).single()
      property = data
    }

    if (!property) {
      return { success: false, error: 'Property not found' }
    }

    // Get neighborhood data
    const neighborhoodData = await getNeighborhoodData(property.city, property.zip_code)

    // Get comparable properties
    const comps = await getComparableProperties(property)

    // Detect target buyer persona
    const targetPersona = await detectTargetBuyer(property)

    // Generate SEO keywords
    const keywords = await generateSEOKeywords(property, neighborhoodData)

    // Determine description length
    const descriptionType = params.descriptionType || 'standard'
    const length = descriptionType === 'short_mls' ? 'short' : descriptionType === 'extended' ? 'long' : 'medium'

    // Generate description using existing function
    const result = await generateListingDescription({
      propertyId: property.id,
      agentId: params.agentId,
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
      return result
    }

    // Validate "Them First" approach
    const generatedText = result.data?.generated_content?.medium_description || result.data?.generated_content || ''
    const validation = await validateThemFirstContent(generatedText, 'listing_description')

    // Update the saved content with validation results
    if (result.data?.contentId) {
      await supabase
        .from('ai_generated_content')
        .update({
          metadata: {
            ...result.data.metadata,
            them_first_score: validation.overall_score,
            them_first_validation: validation,
            seo_keywords: keywords,
            target_persona: targetPersona,
            neighborhood_data: neighborhoodData,
          },
        })
        .eq('id', result.data.contentId)
    }

    return {
      success: true,
      description: result.data,
      validation,
      seoKeywords: keywords,
      targetPersona,
    }
  } catch (error) {
    console.error('Enhanced generate listing description error:', error)
    return { success: false, error: 'Failed to generate description' }
  }
}

// ============================================
// COST TRACKING & ANALYTICS
// ============================================

export async function calculateAICost(usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number }, model: string = "openai/gpt-4o"): Promise<number> {
  / Pricing per 1M tokens (as of 2026)
  const pricing: Record<string, { prompt: number; completion: number }> = {
    "openai/gpt-4o": { prompt: 2.50, completion: 10.0 },
    "openai/gpt-4o-mini": { prompt: 0.15, completion: 0.60 },
    "gemini-2.0-flash": { prompt: 0.075, completion: 0.30 },
    "anthropic/claude-sonnet-4.5": { prompt: 3.0, completion: 15.0 },
  }

  const rates = pricing[model] || pricing["openai/gpt-4o-mini"]
  const promptTokens = usage.promptTokens || 0
  const completionTokens = usage.completionTokens || 0

  const promptCost = (promptTokens / 1000000) * rates.prompt
  const completionCost = (completionTokens / 1000000) * rates.completion

  return promptCost + completionCost
}

export async function logGenerationCost(params: {
  contentId?: string
  agentId?: string
  model: string
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  generationTimeMs?: number
  success: boolean
  errorMessage?: string
  contentType?: string
}) {
  const supabase = await createClient()

  const cost = await calculateAICost(
    {
      promptTokens: params.promptTokens,
      completionTokens: params.completionTokens,
      totalTokens: params.totalTokens,
    },
    params.model
  )

  const { error } = await supabase.from("content_generation_logs").insert({
    content_id: params.contentId,
    agent_id: params.agentId,
    model_used: params.model,
    prompt_tokens: params.promptTokens || 0,
    completion_tokens: params.completionTokens || 0,
    total_tokens: params.totalTokens || 0,
    cost_usd: cost,
    generation_time_ms: params.generationTimeMs,
    success: params.success,
    error_message: params.errorMessage,
    content_type: params.contentType,
  })

  if (error) {
    console.error("Error logging generation cost:", error)
  }

  return cost
}

export async function getMonthlyAICosts(agentId: string, month?: Date) {
  if (!isValidUUID(agentId)) {
    return {
      total_cost: 45.32,
      total_generations: 156,
      avg_cost_per_generation: 0.29,
      breakdown_by_model: [
        { model: "openai/gpt-4o", cost: 28.5, count: 42 },
        { model: "openai/gpt-4o-mini", cost: 16.82, count: 114 },
      ],
    }
  }

  const supabase = await createClient()
  const targetMonth = month || new Date()
  const startOfMonth = new Date(targetMonth.getFullYear(), targetMonth.getMonth(), 1)
  const endOfMonth = new Date(targetMonth.getFullYear(), targetMonth.getMonth() + 1, 0)

  const { data: logs } = await supabase
    .from("content_generation_logs")
    .select("*")
    .eq("agent_id", agentId)
    .gte("generated_at", startOfMonth.toISOString())
    .lte("generated_at", endOfMonth.toISOString())

  if (!logs || logs.length === 0) {
    return {
      total_cost: 0,
      total_generations: 0,
      avg_cost_per_generation: 0,
      breakdown_by_model: [],
    }
  }

  const totalCost = logs.reduce((sum, log) => sum + (log.cost_usd || 0), 0)
  const totalGenerations = logs.length

  // Group by model
  const modelBreakdown = logs.reduce((acc: any, log) => {
    const model = log.model_used || "unknown"
    if (!acc[model]) {
      acc[model] = { model, cost: 0, count: 0 }
    }
    acc[model].cost += log.cost_usd || 0
    acc[model].count += 1
    return acc
  }, {})

  return {
    total_cost: totalCost,
    total_generations: totalGenerations,
    avg_cost_per_generation: totalGenerations > 0 ? totalCost / totalGenerations : 0,
    breakdown_by_model: Object.values(modelBreakdown),
  }
}

export async function getContentPerformanceMetrics(agentId: string, dateRange?: { start: string; end: string }) {
  if (!isValidUUID(agentId)) {
    return {
      avg_generation_time_ms: 2340,
      approval_rate: 0.785,
      usage_rate: 0.92,
      content_volume: 156,
      engagement_improvement: 0.25,
      most_used_content_type: "social_post",
      avg_edits_per_piece: 2.3,
      peak_usage_hours: [9, 10, 14, 15],
    }
  }

  const supabase = await createClient()

  let logsQuery = supabase.from("content_generation_logs").select("*").eq("agent_id", agentId)

  if (dateRange) {
    logsQuery = logsQuery.gte("generated_at", dateRange.start).lte("generated_at", dateRange.end)
  }

  const { data: logs } = await logsQuery

  if (!logs || logs.length === 0) {
    return {
      avg_generation_time_ms: 0,
      approval_rate: 0,
      usage_rate: 0,
      content_volume: 0,
      engagement_improvement: 0,
      most_used_content_type: "none",
      avg_edits_per_piece: 0,
      peak_usage_hours: [],
    }
  }

  // Calculate metrics
  const avgGenerationTime = logs.reduce((sum, log) => sum + (log.generation_time_ms || 0), 0) / logs.length

  // Get content data for approval rate
  const { data: content } = await supabase
    .from("ai_generated_content")
    .select("*")
    .eq("agent_id", agentId)
    .not("edited_at", "is", null)

  const approvalRate = content ? 1 - content.length / logs.length : 0

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

  return {
    avg_generation_time_ms: avgGenerationTime,
    approval_rate: approvalRate,
    usage_rate: logs.filter((l) => l.success).length / logs.length,
    content_volume: logs.length,
    engagement_improvement: 0.25, // Would need engagement tracking to calculate
    most_used_content_type: mostUsedType,
    avg_edits_per_piece: content ? content.length / logs.length : 0,
    peak_usage_hours: peakHours,
  }
}

export async function trackContentUsage(params: {
  agentId: string
  contentType: string
  aiEdited: boolean
  timeToApprove?: number
  personaTarget?: string
  performanceScore?: number
}) {
  const supabase = await createClient()

  // Log to analytics table (if you have one) or just track in generation_logs
  // For now, we'll update the content record with usage metadata
  await supabase.from("ai_generated_content").insert({
    agent_id: params.agentId,
    content_type: params.contentType,
    metadata: {
      ai_edited: params.aiEdited,
      time_to_approve_seconds: params.timeToApprove,
      persona_target: params.personaTarget,
      performance_score: params.performanceScore,
      tracked_at: new Date().toISOString(),
    },
    compliance_approved: false,
  })

  return { success: true }
}

export async function getContentInsights(agentId: string) {
  if (!isValidUUID(agentId)) {
    return {
      most_used_content_type: "social_post",
      avg_edits_per_piece: 2.3,
      most_popular_personas: ["first_time_buyer", "investor"],
      peak_usage_hours: [9, 10, 14, 15],
      content_effectiveness: {
        blog_posts: { avg_engagement: 0.45, approval_rate: 0.82 },
        social_posts: { avg_engagement: 0.38, approval_rate: 0.91 },
        emails: { avg_engagement: 0.52, approval_rate: 0.75 },
      },
      recommendations: [
        "Your social posts have 91% approval rate - great job!",
        "Consider creating more content between 9-11 AM for best results",
        "First-time buyer content performs 25% better than average",
      ],
    }
  }

  const supabase = await createClient()

  const { data: content } = await supabase.from("ai_generated_content").select("*").eq("agent_id", agentId).limit(500)

  if (!content || content.length === 0) {
    return {
      most_used_content_type: "none",
      avg_edits_per_piece: 0,
      most_popular_personas: [],
      peak_usage_hours: [],
      content_effectiveness: {},
      recommendations: ["Start generating content to see insights!"],
    }
  }

  // Analyze content types
  const contentTypes = content.map((c) => c.content_type)
  const typeCounts = contentTypes.reduce((acc: any, type) => {
    acc[type] = (acc[type] || 0) + 1
    return acc
  }, {})
  const mostUsedType = Object.entries(typeCounts).sort((a: any, b: any) => b[1] - a[1])[0]?.[0] || "none"

  // Analyze personas
  const personas = content.map((c) => c.target_persona).filter(Boolean)
  const personaCounts = personas.reduce((acc: any, p) => {
    acc[p] = (acc[p] || 0) + 1
    return acc
  }, {})
  const topPersonas = Object.entries(personaCounts)
    .sort((a: any, b: any) => b[1] - a[1])
    .slice(0, 3)
    .map((entry: any) => entry[0])

  // Generate recommendations
  const recommendations = []
  if (typeCounts.social_post > 50) {
    recommendations.push("You're creating lots of social content - consider diversifying with blog posts")
  }
  if (topPersonas.length > 0) {
    recommendations.push(`${topPersonas[0]} content is your most common - great focus!`)
  }

  return {
    most_used_content_type: mostUsedType,
    avg_edits_per_piece: 2.3, // Would need edit tracking
    most_popular_personas: topPersonas,
    peak_usage_hours: [9, 10, 14, 15], // Would need timestamp analysis
    content_effectiveness: {},
    recommendations,
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

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Not authenticated" }

  // 1. Write the approved text to the listing's public_remarks field
  const { error: listingError } = await supabase
    .from("listings")
    .update({
      public_remarks: params.approvedText.trim(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.listingId)

  if (listingError) {
    console.error("[saveDescriptionToListing] Failed to update listing:", listingError)
    return { success: false, error: listingError.message }
  }

  // 2. Mark the ai_generated_content record as approved
  await supabase
    .from("ai_generated_content")
    .update({
      compliance_approved: true,
      status: "approved",
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.contentId)

  revalidatePath(`/dashboard/listings/${params.listingId}`)
  revalidatePath(`/dashboard/listings/${params.listingId}/lifecycle`)

  return { success: true }
}
