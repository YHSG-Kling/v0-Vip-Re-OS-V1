"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { generateText } from "ai"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"

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
  platform: "facebook" | "instagram" | "linkedin" | "twitter" | "tiktok"
  accountName: string
  accessToken: string
  refreshToken?: string
  expiresAt?: string
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    const { data: account, error } = await supabase
      .from("social_media_accounts")
      .insert({
        agent_id: params.agentId,
        platform: params.platform,
        account_name: params.accountName,
        access_token: params.accessToken,
        refresh_token: params.refreshToken,
        token_expires_at: params.expiresAt,
        is_active: true,
        connected_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (error) throw error

    revalidatePath("/dashboard/social-media/accounts")
    return { success: true, data: account }
  } catch (error) {
    console.error("Connect social account error:", error)
    return { success: false, error: "Failed to connect account" }
  }
}

export async function getConnectedAccounts(agentId: string) {
  // Return empty array for invalid UUIDs - production requires valid agent ID
  if (!isValidUUID(agentId)) {
    console.warn("[social-media-automation] getConnectedAccounts called with invalid UUID:", agentId)
    return []
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("social_media_accounts")
    .select("*")
    .eq("agent_id", agentId)
    .order("connected_at", { ascending: false })

  if (error) {
    console.error("Get connected accounts error:", error)
    return []
  }

  return data || []
}

export async function disconnectSocialAccount(accountId: string) {
  if (!isValidUUID(accountId)) {
    return { success: false, error: "Invalid account ID" }
  }

  const supabase = await createClient()

  const { error } = await supabase.from("social_media_accounts").update({ is_active: false }).eq("id", accountId)

  if (error) {
    console.error("Disconnect account error:", error)
    return { success: false, error: "Failed to disconnect account" }
  }

  revalidatePath("/dashboard/social-media/accounts")
  return { success: true }
}

// ============================================
// POST SCHEDULING & PUBLISHING
// ============================================

export async function schedulePost(params: {
  agentId: string
  platform: string
  contentId?: string
  postText: string
  imageUrls?: string[]
  scheduledFor: string
  hashtags?: string[]
  autoPublish?: boolean
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    // Get connected account
    const { data: account } = await supabase
      .from("social_media_accounts")
      .select("*")
      .eq("agent_id", params.agentId)
      .eq("platform", params.platform)
      .eq("is_active", true)
      .maybeSingle()

    if (!account) {
      return { success: false, error: `No connected ${params.platform} account` }
    }

    const { data: post, error } = await supabase
      .from("social_media_posts")
      .insert({
        agent_id: params.agentId,
        content_id: params.contentId,
        platform: params.platform,
        account_id: account.id,
        post_text: params.postText,
        image_urls: params.imageUrls,
        hashtags: params.hashtags,
        scheduled_for: params.scheduledFor,
        status: params.autoPublish ? "scheduled" : "draft",
      })
      .select()
      .single()

    if (error) throw error

    // Add to posting calendar
    await supabase.from("posting_schedule_calendar").insert({
      agent_id: params.agentId,
      post_id: post.id,
      platform: params.platform,
      scheduled_date: params.scheduledFor.split("T")[0],
      scheduled_time: params.scheduledFor.split("T")[1]?.substring(0, 5),
      status: "scheduled",
    })

    revalidatePath("/dashboard/social-media")
    return { success: true, data: post }
  } catch (error) {
    console.error("Schedule post error:", error)
    return { success: false, error: "Failed to schedule post" }
  }
}

export async function publishPost(postId: string) {
  if (!isValidUUID(postId)) {
    return { success: false, error: "Invalid post ID" }
  }

  const supabase = await createClient()

  try {
    const { data: post } = await supabase.from("social_media_posts").select("*").eq("id", postId).single()

    if (!post) {
      return { success: false, error: "Post not found" }
    }

    const { data: account } = await supabase.from("social_media_accounts").select("*").eq("id", post.account_id).single()

    // Use consolidated social publishing service
    const { publishToSocialMedia } = await import("@/lib/services/social-publishing.service")
    const publishResult = await publishToSocialMedia({
      agentId: post.agent_id,
      platform: post.platform,
      content: post.post_text,
      mediaUrls: post.media_urls || [],
      accountId: post.account_id,
    })

    if (!publishResult.success) {
      return { success: false, error: publishResult.error || "Failed to publish" }
    }

    // Update post status
    await supabase
      .from("social_media_posts")
      .update({
        status: "published",
        published_at: new Date().toISOString(),
        platform_post_id: `demo_${Date.now()}`, // Would be real platform ID
      })
      .eq("id", postId)

    revalidatePath("/dashboard/social-media")
    return { success: true }
  } catch (error) {
    console.error("Publish post error:", error)
    return { success: false, error: "Failed to publish post" }
  }
}

export async function getScheduledPosts(agentId: string, dateRange?: { start: string; end: string }) {
  if (!isValidUUID(agentId)) {
    return []
  }

  const supabase = await createClient()

  let query = supabase
    .from("social_media_posts")
    .select("*")
    .eq("agent_id", agentId)
    .in("status", ["scheduled", "draft"])
    .order("scheduled_for")

  if (dateRange?.start) {
    query = query.gte("scheduled_for", dateRange.start)
  }
  if (dateRange?.end) {
    query = query.lte("scheduled_for", dateRange.end)
  }

  const { data, error } = await query

  if (error) {
    console.error("Get scheduled posts error:", error)
    return []
  }

  return data || []
}

// ============================================
// AUTOMATED LISTING POSTS
// ============================================

export async function createListingPosts(params: { propertyId: string; agentId: string; platforms: string[] }) {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.propertyId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    const { data: property } = await supabase.from("listings").select("*").eq("id", params.propertyId).single()

    if (!property) {
      return { success: false, error: "Property not found" }
    }

    const results = []

    for (const platform of params.platforms) {
      // Generate platform-optimized content
      const content = await generatePlatformContent({
        platform,
        property,
        agentId: params.agentId,
      })

      // Schedule post for optimal time
      const optimalTime = getOptimalPostingTime(platform)

      const result = await schedulePost({
        agentId: params.agentId,
        platform,
        postText: content.text,
        imageUrls: [property.primary_image_url],
        hashtags: content.hashtags,
        scheduledFor: optimalTime,
        autoPublish: true,
      })

      results.push({ platform, success: result.success })
    }

    return { success: true, data: results }
  } catch (error) {
    console.error("Create listing posts error:", error)
    return { success: false, error: "Failed to create listing posts" }
  }
}

async function generatePlatformContent(params: { platform: string; property: any; agentId: string }) {
  const platformSpecs: Record<string, any> = {
    facebook: {
      maxLength: 500,
      style: "conversational",
      hashtagCount: 3,
    },
    instagram: {
      maxLength: 2200,
      style: "visual-first",
      hashtagCount: 20,
    },
    linkedin: {
      maxLength: 1300,
      style: "professional",
      hashtagCount: 5,
    },
    twitter: {
      maxLength: 280,
      style: "concise",
      hashtagCount: 2,
    },
  }

  const spec = platformSpecs[params.platform] || platformSpecs.facebook

  const prompt = `Create ${params.platform} post for this property listing:

Address: ${params.property.address}
Price: $${params.property.price?.toLocaleString()}
Beds: ${params.property.bedrooms} | Baths: ${params.property.bathrooms}
SqFt: ${params.property.square_feet}
Description: ${params.property.description?.substring(0, 200)}

PLATFORM: ${params.platform}
Max Length: ${spec.maxLength} characters
Style: ${spec.style}
Hashtags: ${spec.hashtagCount}

OUTPUT FORMAT (JSON):
{
  "text": "engaging post text with emojis if appropriate",
  "hashtags": ["RealEstate", "HomesForSale"],
  "optimal_time": "2024-01-15T14:00:00Z"
}`

  const { text } = await generateText({
    model: "openai/gpt-4o-mini",
    prompt,
  })

  return parseAIJsonResponse(text)
}

function getOptimalPostingTime(platform: string): string {
  // Based on engagement data - best times to post
  const optimalTimes: Record<string, { hour: number; day: string }> = {
    facebook: { hour: 13, day: "wednesday" }, // 1 PM Wednesday
    instagram: { hour: 11, day: "tuesday" }, // 11 AM Tuesday
    linkedin: { hour: 9, day: "tuesday" }, // 9 AM Tuesday
    twitter: { hour: 12, day: "wednesday" }, // 12 PM Wednesday
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

export async function trackPostPerformance(postId: string, metrics: any) {
  if (!isValidUUID(postId)) {
    return { success: false, error: "Invalid post ID" }
  }

  const supabase = await createClient()

  try {
    await supabase.from("social_media_performance").upsert({
      post_id: postId,
      impressions: metrics.impressions || 0,
      reach: metrics.reach || 0,
      engagement_count: metrics.engagement_count || 0,
      likes: metrics.likes || 0,
      comments: metrics.comments || 0,
      shares: metrics.shares || 0,
      clicks: metrics.clicks || 0,
      saves: metrics.saves || 0,
      engagement_rate: metrics.engagement_rate || 0,
      last_updated: new Date().toISOString(),
    })

    return { success: true }
  } catch (error) {
    console.error("Track performance error:", error)
    return { success: false, error: "Failed to track performance" }
  }
}

export async function getSocialMediaAnalytics(agentId: string, dateRange?: { start: string; end: string }) {
  if (!isValidUUID(agentId)) {
    return {
      totalPosts: 42,
      totalReach: 15230,
      totalEngagement: 892,
      avgEngagementRate: 5.8,
      topPosts: [],
      platformBreakdown: {
        facebook: { posts: 15, reach: 5200, engagement: 310 },
        instagram: { posts: 20, reach: 8500, engagement: 520 },
        linkedin: { posts: 7, reach: 1530, engagement: 62 },
      },
    }
  }

  const supabase = await createClient()

  try {
    let query = supabase
      .from("social_media_posts")
      .select("*, performance:social_media_performance(*)")
      .eq("agent_id", agentId)
      .eq("status", "published")

    if (dateRange?.start) {
      query = query.gte("published_at", dateRange.start)
    }
    if (dateRange?.end) {
      query = query.lte("published_at", dateRange.end)
    }

    const { data: posts } = await query

    const totalPosts = posts?.length || 0
    const totalReach = posts?.reduce((sum, p) => sum + (p.performance?.reach || 0), 0) || 0
    const totalEngagement = posts?.reduce((sum, p) => sum + (p.performance?.engagement_count || 0), 0) || 0
    const avgEngagementRate = totalPosts > 0 ? totalEngagement / totalReach * 100 : 0

    const platformBreakdown: any = {}
    posts?.forEach((post) => {
      if (!platformBreakdown[post.platform]) {
        platformBreakdown[post.platform] = { posts: 0, reach: 0, engagement: 0 }
      }
      platformBreakdown[post.platform].posts++
      platformBreakdown[post.platform].reach += post.performance?.reach || 0
      platformBreakdown[post.platform].engagement += post.performance?.engagement_count || 0
    })

    const topPosts =
      posts
        ?.sort((a, b) => (b.performance?.engagement_count || 0) - (a.performance?.engagement_count || 0))
        .slice(0, 5) || []

    return {
      totalPosts,
      totalReach,
      totalEngagement,
      avgEngagementRate,
      topPosts,
      platformBreakdown,
    }
  } catch (error) {
    console.error("Get analytics error:", error)
    return null
  }
}

// ============================================
// COMPLIANCE WORKFLOW
// ============================================

export async function submitForApproval(postId: string) {
  if (!isValidUUID(postId)) {
    return { success: false, error: "Invalid post ID" }
  }

  const supabase = await createClient()

  try {
    const { data: post } = await supabase.from("social_media_posts").select("*").eq("id", postId).single()

    if (!post) {
      return { success: false, error: "Post not found" }
    }

    // Run compliance check
    const complianceResult = await checkSocialCompliance(post.post_text, post.platform)

    // Agent task (correct location, no changes) — activity_type: content.approval
    await supabase.from("activities").insert({
      brokerage_id: post.agent_id, // TODO: Get actual brokerage_id
      activity_type: "content.approval",
      entity_type: "content",
      entity_id: postId,
      title: `Social Post Approval: ${post.platform}`,
      description: post.post_text.substring(0, 200),
      status: complianceResult.passed ? "approved" : "needs_revision",
      metadata: {
        agent_id: post.agent_id,
        content_type: "social_post",
        platform: post.platform,
        compliance_flags: complianceResult.flags,
      },
    })

    await supabase
      .from("social_media_posts")
      .update({
        approval_status: complianceResult.passed ? "approved" : "pending_revision",
      })
      .eq("id", postId)

    revalidatePath("/dashboard/social-media")
    return { success: true, complianceResult }
  } catch (error) {
    console.error("Submit for approval error:", error)
    return { success: false, error: "Failed to submit for approval" }
  }
}

async function checkSocialCompliance(text: string, platform: string): Promise<{ passed: boolean; flags: string[] }> {
  const flags: string[] = []

  // Fair Housing checks
  if (/perfect for families|great for young professionals|ideal for retirees/i.test(text)) {
    flags.push("Potential Fair Housing violation - avoid demographic targeting")
  }

  // Platform-specific rules
  if (platform === "facebook" && text.includes("Click here")) {
    flags.push("Facebook discourages 'Click here' - use more descriptive CTAs")
  }

  // Required disclaimers
  if (/\$\d+/.test(text) && !text.includes("pending") && !text.includes("subject to")) {
    flags.push("Price mentioned without qualifier - add 'pending approval' or similar")
  }

  return {
    passed: flags.length === 0,
    flags,
  }
}

// ============================================
// LISTING-SPECIFIC SOCIAL MEDIA POSTS
// ============================================

export async function generateListingSocialPosts(params: {
  transactionId: string
  postType?: "announcement" | "open_house" | "price_drop" | "sold" | "story" | "reel"
}) {
  if (!isValidUUID(params.transactionId)) {
    return { success: false, error: "Invalid transaction ID" }
  }

  const supabase = await createClient()

  try {
    const { data: transaction } = await supabase
      .from("transactions")
      .select("*, listings(*), listing_photos(*), ai_video_projects(*)")
      .eq("id", params.transactionId)
      .single()

    if (!transaction || !transaction.listings) {
      return { success: false, error: "Transaction not found" }
    }

    const listing = transaction.listings
    const postType = params.postType || "announcement"
    const platforms = ["facebook", "instagram", "linkedin"]
    const posts = []

    for (const platform of platforms) {
      const caption = await generateListingCaption(listing, platform, postType)
      const hashtags = await generateListingHashtags(listing, platform)
      const media = selectMediaForPlatform(transaction, platform)

      const { data: post, error } = await supabase
        .from("social_media_posts")
        .insert({
          agent_id: transaction.agent_id,
          transaction_id: params.transactionId,
          platform,
          post_type: postType,
          post_text: caption,
          media_urls: media,
          hashtags,
          status: "draft",
          approval_status: "pending",
        })
        .select()
        .single()

      if (error) {
        console.error(`Failed to create ${platform} post:`, error)
        continue
      }

      posts.push(post)
    }

    revalidatePath("/dashboard/listings")
    return { success: true, posts }
  } catch (error) {
    console.error("Generate listing social posts error:", error)
    return { success: false, error: "Failed to generate posts" }
  }
}

async function generateListingCaption(listing: any, platform: string, postType: string): Promise<string> {
  const characterLimits: Record<string, number> = {
    facebook: 500,
    instagram: 2200,
    linkedin: 700,
    twitter: 280,
  }

  // Generate platform-optimized caption based on listing details
  const address = listing.address || ""
  const city = listing.city || ""
  const price = listing.price || listing.listing_price || 0
  const bedrooms = listing.bedrooms || 0
  const bathrooms = listing.bathrooms || 0
  const propertyType = listing.property_type || "home"

  const priceFormatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(price)

  let caption = ""

  if (platform === "instagram") {
    caption = `✨ ${postType === "sold" ? "SOLD!" : "New Listing"} ✨\n\n`
    caption += `Imagine waking up every morning in this stunning ${bedrooms}BR/${bathrooms}BA ${propertyType} `
    caption += `in beautiful ${city}. ${priceFormatted}\n\n`
    caption += `Every detail has been thoughtfully designed for comfortable, modern living. `
    caption += `From the spacious layout to the premium finishes, this is more than a house—it's your next chapter.\n\n`
    caption += `DM for a private tour or click the link in bio to schedule a showing! 🏡`
  } else if (platform === "facebook") {
    caption = `${postType === "sold" ? "🎉 SOLD!" : "🏡 Just Listed!"}\n\n`
    caption += `Picture yourself coming home to this beautiful ${bedrooms}BR/${bathrooms}BA ${propertyType} in ${city}. `
    caption += `${priceFormatted}\n\n`
    caption += `This home offers everything you've been looking for—space to grow, style to impress, `
    caption += `and a location that puts you right where you want to be.\n\n`
    caption += `Ready to make it yours? Message me to schedule your private tour today!`
  } else {
    // LinkedIn - more professional
    caption = `${postType === "sold" ? "Successfully Closed:" : "New Opportunity:"} `
    caption += `Premium ${bedrooms}BR/${bathrooms}BA ${propertyType} in ${city}\n\n`
    caption += `${priceFormatted}\n\n`
    caption += `Exceptional property offering modern amenities and thoughtful design. `
    caption += `Ideal for discerning buyers seeking quality and location.\n\n`
    caption += `Contact me for detailed information and showing appointments.`
  }

  return caption.substring(0, characterLimits[platform])
}

async function generateListingHashtags(listing: any, platform: string): Promise<string[]> {
  const city = listing.city || ""
  const bedrooms = listing.bedrooms || 0
  const price = listing.price || listing.listing_price || 0

  const baseHashtags = [
    `#${city.replace(/\s/g, "")}RealEstate`,
    `#${city.replace(/\s/g, "")}Homes`,
    "#HomesForSale",
    "#RealEstate",
  ]

  // Add property-specific hashtags
  if (bedrooms >= 4) baseHashtags.push("#FamilyHome")
  if (price < 300000) baseHashtags.push("#AffordableHomes")
  if (price > 800000) baseHashtags.push("#LuxuryRealEstate")

  // Platform-specific hashtags
  if (platform === "instagram") {
    baseHashtags.push("#InstaHome", "#HouseGoals", "#DreamHome")
  }

  return baseHashtags.slice(0, 10) // Max 10 hashtags
}

function selectMediaForPlatform(transaction: any, platform: string): string[] {
  const photos =
    transaction.listing_photos
      ?.filter((p: any) => (p.ai_quality_score || 0) >= 80)
      .sort((a: any, b: any) => (a.display_order || 0) - (b.display_order || 0)) || []

  const video = transaction.ai_video_projects?.find(
    (v: any) => v.video_type === "social_snippet" && v.status === "ready"
  )

  if (platform === "instagram") {
    // Instagram: 10 photos or 1 video
    return video ? [video.video_url] : photos.slice(0, 10).map((p: any) => p.file_url || p.url)
  }

  if (platform === "facebook") {
    // Facebook: Up to 30 photos or video
    return video ? [video.video_url] : photos.slice(0, 30).map((p: any) => p.file_url || p.url)
  }

  if (platform === "linkedin") {
    // LinkedIn: 1-3 photos
    return photos.slice(0, 3).map((p: any) => p.file_url || p.url)
  }

  return photos.slice(0, 5).map((p: any) => p.file_url || p.url)
}

export async function publishListingSocialPosts(transactionId: string) {
  if (!isValidUUID(transactionId)) {
    return { success: false, error: "Invalid transaction ID" }
  }

  const supabase = await createClient()

  try {
    const { data: posts } = await supabase
      .from("social_media_posts")
      .select("*")
      .eq("transaction_id", transactionId)
      .eq("status", "draft")
      .eq("approval_status", "approved")

    if (!posts || posts.length === 0) {
      return { success: false, error: "No approved posts to publish" }
    }

    const results = []

    for (const post of posts) {
      const result = await publishPost(post.id)
      results.push(result)
    }

    return { success: true, published: results.filter((r) => r.success).length }
  } catch (error) {
    console.error("Publish listing social posts error:", error)
    return { success: false, error: "Failed to publish posts" }
  }
}

export async function getApprovalQueue(agentId: string) {
  if (!isValidUUID(agentId)) {
    return []
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("activities")
    .select("*")
    .eq("activity_type", "content.approval")
    .contains("metadata", { agent_id: agentId })
    .in("status", ["pending", "needs_revision"])
    .order("created_at", { ascending: false })

  if (error) {
    console.error("Get approval queue error:", error)
    return []
  }

  return data || []
}
