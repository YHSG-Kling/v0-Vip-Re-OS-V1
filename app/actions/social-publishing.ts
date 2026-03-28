"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { generateText } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"
import { runComplianceGate } from "@/lib/kernel/marketing/real-estate-compliance-gate"

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
    user_id,
    type: "content_approved",
    title: "Content Approved",
    body: "Your social media content has been approved and is ready to publish.",
    entity_type: "social_post",
    entity_id: content_id,
    created_at: new Date().toISOString(),
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

  let query = supabase.from("social_media_accounts").select("*").eq("is_active", true).order("platform")

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
  scope?: string
  userId?: string
}) {
  const supabase = createServiceClient()
  const effectiveUserId = params.userId || "system"

  const { data, error } = await supabase
    .from("social_media_accounts")
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
        is_active: true,
        updated_at: new Date().toISOString(),
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
    .from("social_media_accounts")
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
  const { data: userData } = await supabase.from("users").select("brokerage_id, user_type").eq("id", effectiveUserId).maybeSingle()

  // Compliance gate — hard stop if content violates real-estate rules
  const gate = await runComplianceGate({
    content: params.content,
    brokerageId: userData?.brokerage_id ?? null,
    authorUserId: effectiveUserId,
    contentType: (params.contentType as any) ?? "social_post",
    platforms: params.platforms,
  })

  if (!gate.passed) {
    // Record the violation on the draft post for review
    const { data: draftPost } = await supabase
      .from("social_posts")
      .insert({
        user_id: effectiveUserId,
        brokerage_id: userData?.brokerage_id,
        content: params.content,
        media_urls: params.mediaUrls ?? [],
        hashtags: params.hashtags ?? [],
        scheduled_for: params.scheduledFor,
        platform: params.platforms?.[0] ?? "facebook",
        post_type: params.contentType ?? "custom",
        listing_id: params.linkedListingId ?? null,
        ai_generated: params.generatedByAi ?? false,
        post_brief: params.aiPrompt ?? null,
        status: "compliance_review",
        brand_compliance_passed: false,
        approval_status: "pending",
      })
      .select("id")
      .single()

    revalidatePath("/content-studio")
    return {
      success: false,
      complianceBlocked: true,
      violations: gate.violations,
      draftPostId: draftPost?.id ?? null,
      message: `Content held for compliance review: ${gate.violations.map((v) => v.rule).join(", ")}`,
    }
  }

  const { data, error } = await supabase
    .from("social_posts")
    .insert({
      user_id: effectiveUserId,
      brokerage_id: userData?.brokerage_id,
      content: params.content,
      media_urls: params.mediaUrls ?? [],
      hashtags: params.hashtags ?? [],
      scheduled_for: params.scheduledFor,
      platform: params.platforms?.[0] ?? "facebook",
      post_type: params.contentType ?? "custom",
      listing_id: params.linkedListingId ?? null,
      ai_generated: params.generatedByAi ?? false,
      post_brief: params.aiPrompt ?? null,
      status: "scheduled",
      brand_compliance_passed: true,
      approval_status: gate.requiresHumanReview ? "pending" : "approved",
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
      .select("address, list_price, bedrooms, bathrooms, sqft")
      .eq("id", params.listingId)
      .maybeSingle()

    if (listing) {
      listingContext = `Listing Details: ${listing.address}, $${listing.list_price?.toLocaleString()}, ${listing.bedrooms}BR/${listing.bathrooms}BA, ${listing.sqft}sqft.`
    }
  }

  // Use AI to generate content
  const prompt =
    params.customPrompt ||
    `Generate a social media post for ${params.contentType}. ${listingContext} Target persona: ${params.personaTarget || "general"}. Use the "Them First" approach: 40% feelings/empathy, 25% trust-building, 25% value, 10% solution. Include relevant hashtags.`

  const { text } = await generateText({
    model: resolveModel("openai/gpt-4o-mini"),
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
