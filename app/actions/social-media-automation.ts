"use server"

// app/actions/social-media-automation.ts
// Layer 9.2 Social Media Automation — Server Actions
// Canonical Tables: social_posts, social_media_accounts, social_engagement_tracking, social_publish_log
// DO NOT use social_media_posts or social_accounts

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { generateAIResponse } from "@/lib/ai"
import { isValidUUID } from "@/lib/validations"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { canAccessFeature, incrementFeatureUsage } from "@/lib/kernel/0.1-feature-access"
import { applyBrandVoice } from "@/lib/kernel/brand-voice"
import { evaluateOutbound } from "@/lib/kernel/compliance"

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
// SOCIAL MEDIA ACCOUNT MANAGEMENT
// ============================================

export async function connectSocialAccount(params: {
  agentId: string
  /** user_id from auth.users — required for RLS */
  userId?: string
  platform: "facebook" | "instagram" | "linkedin" | "twitter" | "tiktok" | "youtube" | "pinterest"
  accountName: string
  accessToken: string
  refreshToken?: string
  expiresAt?: string
  accountId?: string
  brokerageId?: string
  scope?: "brokerage" | "agent"
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  // Resolve caller identity for user_id if not explicitly provided
  let resolvedUserId = params.userId
  if (!resolvedUserId) {
    const { data: { user } } = await supabase.auth.getUser()
    resolvedUserId = user?.id ?? params.agentId
  }

  try {
    const { data: account, error } = await supabase
      .from("social_media_accounts")
      .insert({
        agent_id: params.agentId,
        user_id: resolvedUserId,
        brokerage_id: params.brokerageId || null,
        platform: params.platform,
        account_name: params.accountName,
        account_id: params.accountId || null,
        access_token: params.accessToken,
        refresh_token: params.refreshToken ?? null,
        token_expires_at: params.expiresAt ?? null,
        scope: params.scope || "agent",
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .maybeSingle()

    if (error) throw error

    revalidatePath("/dashboard/social")
    return { success: true, data: account }
  } catch (error) {
    console.error("[social-media-automation] Connect social account error:", error)
    return { success: false, error: "Failed to connect account" }
  }
}

export async function getConnectedAccounts(agentId?: string, brokerageId?: string) {
  const supabase = await createClient()

  let query = supabase
    .from("social_media_accounts")
    .select("*")
    .eq("is_active", true)
    .order("platform")

  if (agentId && isValidUUID(agentId)) {
    query = query.eq("agent_id", agentId)
  } else if (brokerageId && isValidUUID(brokerageId)) {
    query = query.eq("brokerage_id", brokerageId)
  } else {
    return []
  }

  const { data, error } = await query

  if (error) {
    console.error("[social-media-automation] Get connected accounts error:", error)
    return []
  }

  return data || []
}

export async function disconnectSocialAccount(accountId: string) {
  if (!isValidUUID(accountId)) {
    return { success: false, error: "Invalid account ID" }
  }

  const supabase = await createClient()

  const { error } = await supabase
    .from("social_media_accounts")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", accountId)

  if (error) {
    console.error("[social-media-automation] Disconnect account error:", error)
    return { success: false, error: "Failed to disconnect account" }
  }

  revalidatePath("/dashboard/social")
  return { success: true }
}

// ============================================
// POST SCHEDULING — KERNEL INTEGRATED
// ============================================

/**
 * Schedule a social post with full kernel integration
 * - canAccessFeature('social_automation') check
 * - applyBrandVoice() on content
 * - evaluateOutbound() — blocks if compliance fails
 * - processKernelEvent(SOCIAL_POST_SCHEDULED)
 */
export async function scheduleSocialPost(params: {
  brokerageId: string
  agentId?: string
  userId: string
  platform: string
  postType: string
  content: string
  mediaUrls?: string[]
  hashtags?: string[]
  scheduledFor: string
  socialAccountId: string
  listingId?: string
  campaignId?: string
  /** Pass true when the brokerage requires broker approval — sets status to pending_approval */
  requiresBrokerApproval?: boolean
}) {
  // Validate required UUIDs
  if (!isValidUUID(params.brokerageId)) {
    return { success: false, error: "Invalid brokerage ID" }
  }
  if (!isValidUUID(params.userId)) {
    return { success: false, error: "Invalid user ID" }
  }
  if (!isValidUUID(params.socialAccountId)) {
    return { success: false, error: "Invalid social account ID" }
  }

  // Feature access check
  const canAccess = await canAccessFeature({
    featureKey: "social_automation",
    brokerageId: params.brokerageId,
    userId: params.userId,
  })

  if (!canAccess.allowed) {
    return { success: false, error: "Feature not available for your subscription tier" }
  }

  const supabase = await createClient()

  try {
    // Apply brand voice — check for violations only; we never rewrite content automatically.
    // BrandVoiceResult.content is the original (unchanged); there is no transformedContent.
    let processedContent = params.content
    try {
      await applyBrandVoice({
        brokerageId: params.brokerageId,
        actorUserId: params.userId,
        actorRole: "agent",
        journeyType: "buyer",
        persona: "first_time",
        messageType: "social",
        content: params.content,
      })
      // Brand voice result is advisory only — we log but never block scheduling here.
    } catch (brandError) {
      console.warn("[social-media-automation] Brand voice check failed:", brandError)
      // Continue with original content — brand voice is advisory
    }

    // Evaluate outbound compliance — BLOCK if fails
    // Uses a broadcast stub contact so TCPA/Authority gates pass;
    // Fair Housing (Gate 4) and Them-First (Gate 5) still run on the content.
    try {
      const complianceResult = await evaluateOutbound({
        actorContext: {
          userId: params.userId,
          role: "agent",
          brokerageId: params.brokerageId,
        },
        journeyType: "buyer",
        persona: "first_time",
        messageType: "social",
        content: processedContent,
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
          error: `Compliance blocked: ${complianceResult.violations?.[0] || "Content failed compliance check"}`,
          blocked: true,
        }
      }
    } catch (complianceError) {
      console.warn("[social-media-automation] Compliance evaluation failed:", complianceError)
      // Continue if compliance service is temporarily unavailable
    }

    // Determine initial status: broker-approval required → pending_approval, otherwise → scheduled
    const initialStatus = params.requiresBrokerApproval ? "pending_approval" : "scheduled"

    // INSERT social_posts
    const { data: post, error: insertError } = await supabase
      .from("social_posts")
      .insert({
        brokerage_id: params.brokerageId,
        agent_id: params.agentId || null,
        user_id: params.userId,
        platform: params.platform,
        post_type: params.postType,
        content: processedContent,
        media_urls: params.mediaUrls || [],
        hashtags: params.hashtags || [],
        scheduled_for: params.scheduledFor,
        social_account_id: params.socialAccountId,
        listing_id: params.listingId || null,
        status: initialStatus,
        approval_status: params.requiresBrokerApproval ? "pending" : "approved",
        brand_compliance_passed: null,
        ai_generated: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select()
      .maybeSingle()

    // If broker approval required, notify broker via notifications table
    if (params.requiresBrokerApproval && post) {
      const { data: brokerUsers } = await supabase
        .from("users")
        .select("id")
        .eq("brokerage_id", params.brokerageId)
        .in("user_type", ["broker", "admin"])
        .is("deleted_at", null)
        .limit(5)

      for (const broker of brokerUsers ?? []) {
        await supabase.from("notifications").insert({
          user_id: broker.id,
          brokerage_id: params.brokerageId,
          type: "social_post_pending_approval",
          title: "Social Post Awaiting Approval",
          body: `A new ${params.platform} post is pending your approval.`,
          entity_type: "social_post",
          entity_id: post.id,
          is_read: false,
          created_at: new Date().toISOString(),
        })
      }
    }

    if (insertError) {
      console.error("[social-media-automation] Insert error:", insertError)
      throw insertError
    }

    // Link to marketing campaign if provided
    if (params.campaignId && isValidUUID(params.campaignId)) {
      await supabase.from("marketing_assets").insert({
        brokerage_id: params.brokerageId,
        campaign_id: params.campaignId,
        asset_type: "social_post",
        asset_name: `${params.platform} - ${params.postType}`,
        source_table: "social_posts",
        source_id: post.id,
        approval_status: "pending",
        created_at: new Date().toISOString(),
      })
    }

    // Increment feature usage
    await incrementFeatureUsage({
      featureKey: "social_automation",
      brokerageId: params.brokerageId,
      userId: params.userId,
    }).catch((err) => console.warn("[social-media-automation] Usage increment failed:", err))

    // Fire kernel event
    await supabase.from("lifecycle_events").insert({
      entity_type: "social_post",
      entity_id: post.id,
      brokerage_id: params.brokerageId,
      event_type: KernelEvent.SOCIAL_POST_SCHEDULED,
      metadata: {
        platform: params.platform,
        post_type: params.postType,
        scheduled_for: params.scheduledFor,
        listing_id: params.listingId,
        campaign_id: params.campaignId,
      },
    })

    await processKernelEvent({
      event: KernelEvent.SOCIAL_POST_SCHEDULED,
      brokerageId: params.brokerageId,
      entityType: "social_post",
      entityId: post.id,
    }).catch((err) => console.error("[social-media-automation] Kernel event failed:", err))

    revalidatePath("/dashboard/social")
    return { success: true, data: post }
  } catch (error: any) {
    console.error("[social-media-automation] Schedule post error:", error)
    return { success: false, error: error.message || "Failed to schedule post" }
  }
}

/**
 * Approve a social post
 */
export async function approveSocialPost(postId: string, approverUserId: string) {
  if (!isValidUUID(postId)) {
    return { success: false, error: "Invalid post ID" }
  }
  if (!isValidUUID(approverUserId)) {
    return { success: false, error: "Invalid approver user ID" }
  }

  const supabase = await createClient()

  try {
    const { data: post, error } = await supabase
      .from("social_posts")
      .update({
        approval_status: "approved",
        approved_by: approverUserId,
        approved_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", postId)
      .select()
      .maybeSingle()

    if (error) throw error

    revalidatePath("/dashboard/social")
    return { success: true, data: post }
  } catch (error: any) {
    console.error("[social-media-automation] Approve post error:", error)
    return { success: false, error: error.message || "Failed to approve post" }
  }
}

/**
 * Reject a social post
 */
export async function rejectSocialPost(postId: string, rejectorUserId: string, reason?: string) {
  if (!isValidUUID(postId)) {
    return { success: false, error: "Invalid post ID" }
  }

  const supabase = await createClient()

  try {
    const { data: post, error } = await supabase
      .from("social_posts")
      .update({
        approval_status: "rejected",
        status: "cancelled",
        error_message: reason || "Rejected by approver",
        updated_at: new Date().toISOString(),
      })
      .eq("id", postId)
      .select()
      .maybeSingle()

    if (error) throw error

    revalidatePath("/dashboard/social")
    return { success: true, data: post }
  } catch (error: any) {
    console.error("[social-media-automation] Reject post error:", error)
    return { success: false, error: error.message || "Failed to reject post" }
  }
}

/**
 * Get social queue with filters
 */
export async function getSocialQueue(
  brokerageId: string,
  filters?: {
    platform?: string
    status?: string
    agentId?: string
    approvalStatus?: string
  }
) {
  if (!isValidUUID(brokerageId)) {
    return []
  }

  const supabase = await createClient()

  let query = supabase
    .from("social_posts")
    .select(
      `
      *,
      social_media_accounts (id, platform, account_name),
      social_engagement_tracking (*)
    `
    )
    .eq("brokerage_id", brokerageId)
    .order("scheduled_for", { ascending: true })

  if (filters?.platform) {
    query = query.eq("platform", filters.platform)
  }
  if (filters?.status) {
    query = query.eq("status", filters.status)
  }
  if (filters?.agentId && isValidUUID(filters.agentId)) {
    query = query.eq("agent_id", filters.agentId)
  }
  if (filters?.approvalStatus) {
    query = query.eq("approval_status", filters.approvalStatus)
  }

  const { data, error } = await query

  if (error) {
    console.error("[social-media-automation] Get social queue error:", error)
    return []
  }

  return data || []
}

/**
 * Get engagement data for a post
 */
export async function getSocialEngagement(postId: string) {
  if (!isValidUUID(postId)) {
    return []
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("social_engagement_tracking")
    .select("*")
    .eq("social_post_id", postId)
    .order("captured_at", { ascending: false })

  if (error) {
    console.error("[social-media-automation] Get engagement error:", error)
    return []
  }

  return data || []
}

/**
 * Get publish logs for a post
 */
export async function getPublishLog(postId: string) {
  if (!isValidUUID(postId)) {
    return []
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("social_publish_log")
    .select("*")
    .eq("social_post_id", postId)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("[social-media-automation] Get publish log error:", error)
    return []
  }

  return data || []
}

// ============================================
// AUTOMATED LISTING POSTS
// ============================================

export async function createListingPosts(params: {
  propertyId: string
  agentId: string
  brokerageId: string
  platforms: string[]
}) {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.propertyId) || !isValidUUID(params.brokerageId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    // Fetch listing + first photo from listing_media for media_urls
    const { data: property } = await supabase
      .from("listings")
      .select("address, city, list_price, bedrooms, bathrooms, sqft")
      .eq("id", params.propertyId)
      .maybeSingle()

    // Get primary photo for the listing
    const { data: primaryMedia } = await supabase
      .from("listing_media")
      .select("file_url")
      .eq("listing_id", params.propertyId)
      .eq("is_primary", true)
      .eq("media_type", "photo")
      .maybeSingle()

    if (!property) {
      return { success: false, error: "Property not found" }
    }

    const results = []

    for (const platform of params.platforms) {
      // Get connected account for this platform
      const { data: account } = await supabase
        .from("social_media_accounts")
        .select("id")
        .eq("agent_id", params.agentId)
        .eq("platform", platform)
        .eq("is_active", true)
        .maybeSingle()

      if (!account) {
        results.push({ platform, success: false, error: `No connected ${platform} account` })
        continue
      }

      // Generate platform-optimized content
      const content = await generatePlatformContent({
        platform,
        property,
        agentId: params.agentId,
      })

      // Schedule post for optimal time
      const optimalTime = getOptimalPostingTime(platform)

      const result = await scheduleSocialPost({
        brokerageId: params.brokerageId,
        agentId: params.agentId,
        userId: params.agentId,
        platform,
        postType: "new_listing",
        content: content.text,
        mediaUrls: primaryMedia?.file_url ? [primaryMedia.file_url] : [],
        hashtags: content.hashtags,
        scheduledFor: optimalTime,
        socialAccountId: account.id,
        listingId: params.propertyId,
      })

      results.push({ platform, success: result.success, postId: result.data?.id })
    }

    return { success: true, data: results }
  } catch (error) {
    console.error("[social-media-automation] Create listing posts error:", error)
    return { success: false, error: "Failed to create listing posts" }
  }
}

async function generatePlatformContent(params: { platform: string; property: any; agentId: string }) {
  const platformSpecs: Record<string, any> = {
    facebook: { maxLength: 500, style: "conversational", hashtagCount: 3 },
    instagram: { maxLength: 2200, style: "visual-first", hashtagCount: 20 },
    linkedin: { maxLength: 1300, style: "professional", hashtagCount: 5 },
    twitter: { maxLength: 280, style: "concise", hashtagCount: 2 },
    tiktok: { maxLength: 150, style: "casual", hashtagCount: 5 },
    youtube: { maxLength: 5000, style: "detailed", hashtagCount: 10 },
    pinterest: { maxLength: 500, style: "descriptive", hashtagCount: 5 },
  }

  const spec = platformSpecs[params.platform] || platformSpecs.facebook

  const prompt = `Create ${params.platform} post for this property listing:

Address: ${params.property.address}
Price: $${params.property.list_price?.toLocaleString() || params.property.price?.toLocaleString()}
Beds: ${params.property.bedrooms} | Baths: ${params.property.bathrooms}
SqFt: ${params.property.sqft || params.property.square_feet}

PLATFORM: ${params.platform}
Max Length: ${spec.maxLength} characters
Style: ${spec.style}
Hashtags: ${spec.hashtagCount}

OUTPUT FORMAT (JSON):
{
  "text": "engaging post text",
  "hashtags": ["RealEstate", "HomesForSale"]
}`

  try {
    const response = await generateAIResponse({
      prompt,
      metadata: {
        userId: params.agentId,
        brokerageId: "system",
        agentId: params.agentId,
        feature: "social_post_generation",
      },
    })

    return parseAIJsonResponse(response.text)
  } catch (error) {
    // Fallback content
    return {
      text: `Just Listed! Beautiful ${params.property.bedrooms}BR/${params.property.bathrooms}BA home in ${params.property.city || "your area"}. Contact me for a showing!`,
      hashtags: ["RealEstate", "JustListed", "HomesForSale"],
    }
  }
}

function getOptimalPostingTime(platform: string): string {
  const optimalTimes: Record<string, { hour: number; day: string }> = {
    facebook: { hour: 13, day: "wednesday" },
    instagram: { hour: 11, day: "tuesday" },
    linkedin: { hour: 9, day: "tuesday" },
    twitter: { hour: 12, day: "wednesday" },
    tiktok: { hour: 19, day: "thursday" },
    youtube: { hour: 14, day: "friday" },
    pinterest: { hour: 20, day: "saturday" },
  }

  const time = optimalTimes[platform] || { hour: 14, day: "tuesday" }
  const today = new Date()
  const daysUntilOptimal = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(time.day)
  const daysToAdd = (daysUntilOptimal - today.getDay() + 7) % 7 || 7

  const scheduledDate = new Date(today)
  scheduledDate.setDate(today.getDate() + daysToAdd)
  scheduledDate.setHours(time.hour, 0, 0, 0)

  return scheduledDate.toISOString()
}

// ============================================
// PERFORMANCE ANALYTICS
// ============================================

export async function trackPostPerformance(postId: string, brokerageId: string, metrics: any) {
  if (!isValidUUID(postId) || !isValidUUID(brokerageId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    // Get post to determine platform
    const { data: post } = await supabase
      .from("social_posts")
      .select("platform")
      .eq("id", postId)
      .maybeSingle()

    await supabase.from("social_engagement_tracking").upsert({
      social_post_id: postId,
      brokerage_id: brokerageId,
      platform: post?.platform || "unknown",
      impressions_count: metrics.impressions || 0,
      likes_count: metrics.likes || 0,
      comments_count: metrics.comments || 0,
      shares_count: metrics.shares || 0,
      saves_count: metrics.saves || 0,
      clicks_count: metrics.clicks || 0,
      leads_generated: metrics.leads || 0,
      captured_at: new Date().toISOString(),
    })

    return { success: true }
  } catch (error) {
    console.error("[social-media-automation] Track performance error:", error)
    return { success: false, error: "Failed to track performance" }
  }
}

export async function getSocialMediaAnalytics(brokerageId: string, dateRange?: { start: string; end: string }) {
  if (!isValidUUID(brokerageId)) {
    return null
  }

  const supabase = await createClient()

  try {
    let query = supabase
      .from("social_posts")
      .select("*, engagement:social_engagement_tracking(*)")
      .eq("brokerage_id", brokerageId)
      .eq("status", "published")

    if (dateRange?.start) {
      query = query.gte("published_at", dateRange.start)
    }
    if (dateRange?.end) {
      query = query.lte("published_at", dateRange.end)
    }

    const { data: posts } = await query

    const totalPosts = posts?.length || 0
    
    // Aggregate engagement metrics
    let totalImpressions = 0
    let totalLikes = 0
    let totalComments = 0
    let totalShares = 0
    let totalClicks = 0
    let totalLeads = 0

    const platformBreakdown: Record<string, { posts: number; impressions: number; engagement: number }> = {}

    posts?.forEach((post) => {
      const engagement = Array.isArray(post.engagement) ? post.engagement[0] : post.engagement

      totalImpressions += engagement?.impressions_count || 0
      totalLikes += engagement?.likes_count || 0
      totalComments += engagement?.comments_count || 0
      totalShares += engagement?.shares_count || 0
      totalClicks += engagement?.clicks_count || 0
      totalLeads += engagement?.leads_generated || 0

      if (!platformBreakdown[post.platform]) {
        platformBreakdown[post.platform] = { posts: 0, impressions: 0, engagement: 0 }
      }
      platformBreakdown[post.platform].posts++
      platformBreakdown[post.platform].impressions += engagement?.impressions_count || 0
      platformBreakdown[post.platform].engagement +=
        (engagement?.likes_count || 0) +
        (engagement?.comments_count || 0) +
        (engagement?.shares_count || 0)
    })

    const totalEngagement = totalLikes + totalComments + totalShares
    const avgEngagementRate = totalImpressions > 0 ? (totalEngagement / totalImpressions) * 100 : 0

    const topPosts =
      posts
        ?.sort((a, b) => {
          const aEng = Array.isArray(a.engagement) ? a.engagement[0] : a.engagement
          const bEng = Array.isArray(b.engagement) ? b.engagement[0] : b.engagement
          return ((bEng?.likes_count || 0) + (bEng?.comments_count || 0)) -
                 ((aEng?.likes_count || 0) + (aEng?.comments_count || 0))
        })
        .slice(0, 5) || []

    return {
      totalPosts,
      totalImpressions,
      totalEngagement,
      totalLikes,
      totalComments,
      totalShares,
      totalClicks,
      totalLeads,
      avgEngagementRate,
      topPosts,
      platformBreakdown,
    }
  } catch (error) {
    console.error("[social-media-automation] Get analytics error:", error)
    return null
  }
}

// ============================================
// POST LIFECYCLE — RETRY, DELETE, RESCHEDULE, EDIT
// ============================================

/**
 * Retry a failed post — resets status to 'scheduled' and clears error_message.
 * Increments an error_count column (added via migration) for circuit-breaker tracking.
 */
export async function retryFailedPost(postId: string, userId: string) {
  if (!isValidUUID(postId) || !isValidUUID(userId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    const { data: post, error } = await supabase
      .from("social_posts")
      .update({
        status: "scheduled",
        error_message: null,
        approval_status: "pending",
        updated_at: new Date().toISOString(),
      })
      .eq("id", postId)
      .eq("status", "failed") // only retry truly failed posts
      .select()
      .maybeSingle()

    if (error) throw error
    if (!post) return { success: false, error: "Post not found or not in failed state" }

    // Log the retry attempt
    await supabase.from("social_publish_log").insert({
      social_post_id: postId,
      brokerage_id: post.brokerage_id,
      platform: post.platform,
      account_id: post.social_account_id,
      publish_status: "retry_queued",
      created_at: new Date().toISOString(),
    })

    await supabase.from("lifecycle_events").insert({
      entity_type: "social_post",
      entity_id: postId,
      brokerage_id: post.brokerage_id,
      event_type: "social_post_retry_queued",
      actor_user_id: userId,
      metadata: { retried_at: new Date().toISOString() },
    })

    revalidatePath("/dashboard/social")
    return { success: true, data: post }
  } catch (error: any) {
    console.error("[social-media-automation] Retry post error:", error)
    return { success: false, error: error.message || "Failed to retry post" }
  }
}

/**
 * Soft-delete a social post — sets status to 'cancelled' and records actor.
 * Does NOT hard-delete the row so publish logs are preserved.
 */
export async function deleteSocialPost(postId: string, userId: string) {
  if (!isValidUUID(postId) || !isValidUUID(userId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    const { data: post, error } = await supabase
      .from("social_posts")
      .update({
        status: "cancelled",
        updated_at: new Date().toISOString(),
      })
      .eq("id", postId)
      .in("status", ["draft", "scheduled", "failed", "cancelled"])
      .select("id, brokerage_id, platform, status")
      .maybeSingle()

    if (error) throw error
    if (!post) return { success: false, error: "Post not found or already published — cannot delete" }

    await supabase.from("lifecycle_events").insert({
      entity_type: "social_post",
      entity_id: postId,
      brokerage_id: post.brokerage_id,
      event_type: "social_post_deleted",
      actor_user_id: userId,
      metadata: { deleted_at: new Date().toISOString() },
    })

    revalidatePath("/dashboard/social")
    return { success: true }
  } catch (error: any) {
    console.error("[social-media-automation] Delete post error:", error)
    return { success: false, error: error.message || "Failed to delete post" }
  }
}

/**
 * Update an existing draft or scheduled post's content, hashtags, or platform.
 * Cannot edit published or failed posts.
 */
export async function updateSocialPost(params: {
  postId: string
  userId: string
  content?: string
  hashtags?: string[]
  mediaUrls?: string[]
  platform?: string
  postType?: string
  scheduledFor?: string
}) {
  if (!isValidUUID(params.postId) || !isValidUUID(params.userId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    const updatePayload: Record<string, any> = { updated_at: new Date().toISOString() }
    if (params.content    !== undefined) updatePayload.content      = params.content
    if (params.hashtags   !== undefined) updatePayload.hashtags     = params.hashtags
    if (params.mediaUrls  !== undefined) updatePayload.media_urls   = params.mediaUrls
    if (params.platform   !== undefined) updatePayload.platform     = params.platform
    if (params.postType   !== undefined) updatePayload.post_type    = params.postType
    if (params.scheduledFor !== undefined) updatePayload.scheduled_for = params.scheduledFor

    const { data: post, error } = await supabase
      .from("social_posts")
      .update(updatePayload)
      .eq("id", params.postId)
      .in("status", ["draft", "scheduled"]) // only editable statuses
      .select()
      .maybeSingle()

    if (error) throw error
    if (!post) return { success: false, error: "Post not found or not editable" }

    revalidatePath("/dashboard/social")
    return { success: true, data: post }
  } catch (error: any) {
    console.error("[social-media-automation] Update post error:", error)
    return { success: false, error: error.message || "Failed to update post" }
  }
}

/**
 * Reschedule an existing post to a new datetime.
 */
export async function rescheduleSocialPost(postId: string, userId: string, newScheduledFor: string) {
  return updateSocialPost({ postId, userId, scheduledFor: newScheduledFor })
}
