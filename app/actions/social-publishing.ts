"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"

// =====================================================
// EVENT HANDLERS - Called by orchestrator
// =====================================================

export async function handleScheduledPost(payload: any) {
  const supabase = createServiceClient()
  const { post_id, user_id, scheduled_for } = payload

  // Check if it's time to publish
  const now = new Date()
  const scheduledTime = new Date(scheduled_for)

  if (scheduledTime <= now) {
    // Update post status to publishing
    await supabase
      .from("social_posts")
      .update({ status: "publishing" })
      .eq("id", post_id)

    // Create task to verify publication
    await supabase.from("tasks").insert({
      assigned_to: user_id,
      title: "Verify social post published",
      due_date: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      priority: "medium",
      auto_generated: true,
    })
  }

  return { success: true }
}

export async function handlePostPublished(payload: any) {
  const supabase = createServiceClient()
  const { post_id, platform, user_id, external_id } = payload

  // Update post with external ID and status
  await supabase
    .from("social_posts")
    .update({
      status: "published",
      published_at: new Date().toISOString(),
      external_post_id: external_id,
    })
    .eq("id", post_id)

  // Create engagement tracking task
  await supabase.from("tasks").insert({
    assigned_to: user_id,
    title: `Check engagement on ${platform} post`,
    due_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    priority: "low",
    auto_generated: true,
  })

  return { success: true }
}

export async function handleContentApproved(payload: any) {
  const supabase = createServiceClient()
  const { content_id, approved_by, user_id } = payload

  // Update content status
  await supabase
    .from("social_posts")
    .update({
      approval_status: "approved",
      approved_by,
      approved_at: new Date().toISOString(),
    })
    .eq("id", content_id)

  // Notify creator
  await supabase.from("notifications").insert({
    recipient_id: user_id,
    notification_type: "content_approved",
    title: "Content Approved",
    message: "Your social media content has been approved and is ready to publish.",
    related_entity_type: "social_post",
    related_entity_id: content_id,
  })

  return { success: true }
}

function shouldFilterByUser(role: string): boolean {
  // Admin, Broker, and Compliance Officer see all posts
  const adminRoles = ["ADMIN", "BROKER", "COMPLIANCE_OFFICER"]
  return !adminRoles.includes(role)
}

export async function getSocialAccounts(userId?: string, userRole?: string) {
  const supabase = createServiceClient()

  let query = supabase.from("social_accounts").select("*").eq("is_active", true).order("platform")

  if (userId && shouldFilterByUser(userRole || "")) {
    query = query.eq("user_id", userId)
  }

  const { data, error } = await query

  if (error) {
    console.log("[v0] Get social accounts error:", error)
    return []
  }
  return data || []
}

export async function connectSocialAccount(params: {
  platform: string
  accountId: string
  accountName: string
  accessToken: string
  refreshToken?: string
  tokenExpiresAt?: string
  scope?: string[]
  profilePictureUrl?: string
  followerCount?: number
  userId?: string
}) {
  const supabase = createServiceClient()
  const effectiveUserId = params.userId || "system"

  const { data, error } = await supabase
    .from("social_accounts")
    .upsert(
      {
        user_id: effectiveUserId,
        platform: params.platform,
        account_id: params.accountId,
        account_name: params.accountName,
        access_token: params.accessToken,
        refresh_token: params.refreshToken,
        token_expires_at: params.tokenExpiresAt,
        scope: params.scope,
        profile_picture_url: params.profilePictureUrl,
        follower_count: params.followerCount,
        is_active: true,
        last_synced_at: new Date().toISOString(),
      },
      {
        onConflict: "user_id,platform,account_id",
      },
    )
    .select()
    .single()

  if (error) throw error

  revalidatePath("/settings/social-accounts")
  return data
}

export async function disconnectSocialAccount(accountId: string, userId?: string) {
  const supabase = createServiceClient()
  const effectiveUserId = userId || "system"

  const { error } = await supabase
    .from("social_accounts")
    .update({ is_active: false })
    .eq("id", accountId)
    .eq("user_id", effectiveUserId)

  if (error) throw error

  revalidatePath("/settings/social-accounts")
}

export async function getSocialPosts(filters?: {
  status?: string
  startDate?: string
  endDate?: string
  userId?: string
  userRole?: string
}) {
  const supabase = createServiceClient()

  let query = supabase.from("social_posts").select(`
      *,
      social_post_analytics(*)
    `)

  if (filters?.userId && shouldFilterByUser(filters?.userRole || "")) {
    query = query.eq("user_id", filters.userId)
  }

  if (filters?.status) {
    query = query.eq("status", filters.status)
  }

  if (filters?.startDate) {
    query = query.gte("scheduled_for", filters.startDate)
  }

  if (filters?.endDate) {
    query = query.lte("scheduled_for", filters.endDate)
  }

  const { data, error } = await query.order("scheduled_for", { ascending: true })

  if (error) {
    console.log("[v0] Get social posts error:", error)
    return []
  }
  return data || []
}

export async function createSocialPost(params: {
  content: string
  mediaUrls?: string[]
  mediaTypes?: string[]
  hashtags?: string[]
  scheduledFor: string
  platforms: string[]
  contentType?: string
  linkedListingId?: string
  generatedByAi?: boolean
  aiPrompt?: string
  userId?: string
}) {
  const supabase = createServiceClient()
  const effectiveUserId = params.userId || "system"

  // Get user's brokerage
  const { data: userData } = await supabase.from("users").select("brokerage_id").eq("id", effectiveUserId).single()

  const { data, error } = await supabase
    .from("social_posts")
    .insert({
      user_id: effectiveUserId,
      brokerage_id: userData?.brokerage_id,
      content: params.content,
      media_urls: params.mediaUrls,
      media_types: params.mediaTypes,
      hashtags: params.hashtags,
      scheduled_for: params.scheduledFor,
      platforms: params.platforms,
      content_type: params.contentType,
      linked_listing_id: params.linkedListingId,
      generated_by_ai: params.generatedByAi || false,
      ai_prompt: params.aiPrompt,
      status: "scheduled",
    })
    .select()
    .single()

  if (error) throw error

  revalidatePath("/content-studio")
  revalidatePath("/social-planner")
  return data
}

export async function updateSocialPost(
  postId: string,
  params: {
    content?: string
    mediaUrls?: string[]
    scheduledFor?: string
    platforms?: string[]
    status?: string
    userId?: string
  },
) {
  const supabase = createServiceClient()
  const effectiveUserId = params.userId || "system"

  const updateData: any = {}
  if (params.content !== undefined) updateData.content = params.content
  if (params.mediaUrls !== undefined) updateData.media_urls = params.mediaUrls
  if (params.scheduledFor !== undefined) updateData.scheduled_for = params.scheduledFor
  if (params.platforms !== undefined) updateData.platforms = params.platforms
  if (params.status !== undefined) updateData.status = params.status

  const { data, error } = await supabase
    .from("social_posts")
    .update(updateData)
    .eq("id", postId)
    .eq("user_id", effectiveUserId)
    .select()
    .single()

  if (error) throw error

  revalidatePath("/content-studio")
  revalidatePath("/social-planner")
  return data
}

export async function deleteSocialPost(postId: string, userId?: string) {
  const supabase = createServiceClient()
  const effectiveUserId = userId || "system"

  const { error } = await supabase.from("social_posts").delete().eq("id", postId).eq("user_id", effectiveUserId)

  if (error) throw error

  revalidatePath("/content-studio")
  revalidatePath("/social-planner")
}

export async function getSocialAnalytics(dateRange?: {
  start: string
  end: string
  userId?: string
  userRole?: string
}) {
  const supabase = createServiceClient()

  let query = supabase
    .from("social_posts")
    .select(`
      id,
      content,
      platforms,
      scheduled_for,
      published_at,
      status,
      social_post_analytics(
        platform,
        impressions,
        reach,
        engagement,
        likes,
        comments,
        shares,
        clicks
      )
    `)
    .eq("status", "published")

  if (dateRange?.userId && shouldFilterByUser(dateRange?.userRole || "")) {
    query = query.eq("user_id", dateRange.userId)
  }

  if (dateRange) {
    query = query.gte("published_at", dateRange.start).lte("published_at", dateRange.end)
  }

  const { data, error } = await query.order("published_at", { ascending: false })

  if (error) {
    console.log("[v0] Get social analytics error:", error)
    return []
  }
  return data || []
}

export async function generateSocialContent(params: {
  contentType: string
  personaTarget?: string
  listingId?: string
  customPrompt?: string
  userId?: string
}) {
  const supabase = createServiceClient()
  const effectiveUserId = params.userId || "system"

  // Get listing details if provided
  let listingContext = ""
  if (params.listingId) {
    const { data: listing } = await supabase
      .from("listings")
      .select("address, price, bedrooms, bathrooms, square_feet, description")
      .eq("id", params.listingId)
      .single()

    if (listing) {
      listingContext = `Listing Details: ${listing.address}, $${listing.price}, ${listing.bedrooms}BR/${listing.bathrooms}BA, ${listing.square_feet}sqft. ${listing.description}`
    }
  }

  // Use AI to generate content
  const { generateText } = await import("ai")

  const prompt =
    params.customPrompt ||
    `Generate a social media post for ${params.contentType}. ${listingContext} Target persona: ${params.personaTarget || "general"}. Use the "Them First" approach: 40% feelings/empathy, 25% trust-building, 25% value, 10% solution. Include relevant hashtags.`

  const { text } = await generateText({
    model: "openai/gpt-4o-mini",
    prompt,
  })

  // Extract hashtags from generated content
  const hashtagRegex = /#\w+/g
  const hashtags = text.match(hashtagRegex) || []

  return {
    content: text,
    hashtags,
    aiPrompt: prompt,
  }
}
