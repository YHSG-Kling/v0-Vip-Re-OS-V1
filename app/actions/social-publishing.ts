"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { revalidatePath } from "next/cache"
import { generateText } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"
import { runComplianceGate } from "@/lib/kernel/marketing/real-estate-compliance-gate"

// =====================================================
// AUTH HELPER
// =====================================================
// All social-publishing actions are exposed as Next.js server actions, which
// makes them callable from any authenticated browser session. Previous version
// trusted caller-supplied userId/userRole params and fell back to literal
// "system" when missing — both wrong. Now we resolve identity from the
// session and ignore any caller-supplied identity values.

async function resolveCaller(): Promise<
  | { ok: true; userId: string; brokerageId: string; userType: string }
  | { ok: false }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false }
  const { data: userData } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (!userData?.brokerage_id) return { ok: false }
  return {
    ok: true,
    userId: user.id,
    brokerageId: userData.brokerage_id,
    userType: userData.user_type ?? "agent",
  }
}

// =====================================================
// EVENT HANDLERS - Called by orchestrator
// =====================================================

export async function handleScheduledPost(payload: any) {
  const caller = await resolveCaller()
  if (!caller.ok) return { success: false, error: "Unauthorized" }

  const supabase = createServiceClient()
  const { post_id, scheduled_for } = payload

  // Verify post belongs to caller's brokerage before mutating
  const { data: post } = await supabase
    .from("social_posts")
    .select("brokerage_id, user_id")
    .eq("id", post_id)
    .maybeSingle()
  if (!post) return { success: false, error: "Post not found" }
  if (post.brokerage_id !== caller.brokerageId) return { success: false, error: "Forbidden" }

  const now = new Date()
  const scheduledTime = new Date(scheduled_for)

  if (scheduledTime <= now) {
    await supabase
      .from("social_posts")
      .update({ status: "publishing" })
      .eq("id", post_id)
      .eq("brokerage_id", caller.brokerageId)

    await supabase.from("tasks").insert({
      assigned_to: post.user_id,
      title: "Verify social post published",
      due_date: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      priority: "medium",
      auto_generated: true,
    })
  }

  return { success: true }
}

export async function handlePostPublished(payload: any) {
  const caller = await resolveCaller()
  if (!caller.ok) return { success: false, error: "Unauthorized" }

  const supabase = createServiceClient()
  const { post_id, platform, external_id } = payload

  // Verify post belongs to caller's brokerage before mutating
  const { data: post } = await supabase
    .from("social_posts")
    .select("brokerage_id, user_id")
    .eq("id", post_id)
    .maybeSingle()
  if (!post) return { success: false, error: "Post not found" }
  if (post.brokerage_id !== caller.brokerageId) return { success: false, error: "Forbidden" }

  await supabase
    .from("social_posts")
    .update({
      status: "published",
      published_at: new Date().toISOString(),
      external_post_id: external_id,
    })
    .eq("id", post_id)
    .eq("brokerage_id", caller.brokerageId)

  await supabase.from("tasks").insert({
    assigned_to: post.user_id,
    title: `Check engagement on ${platform} post`,
    due_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    priority: "low",
    auto_generated: true,
  })

  return { success: true }
}

export async function handleContentApproved(payload: any) {
  const caller = await resolveCaller()
  if (!caller.ok) return { success: false, error: "Unauthorized" }

  const supabase = createServiceClient()
  const { content_id } = payload

  // Verify post belongs to caller's brokerage before mutating
  const { data: post } = await supabase
    .from("social_posts")
    .select("brokerage_id, user_id")
    .eq("id", content_id)
    .maybeSingle()
  if (!post) return { success: false, error: "Post not found" }
  if (post.brokerage_id !== caller.brokerageId) return { success: false, error: "Forbidden" }

  await supabase
    .from("social_posts")
    .update({
      approval_status: "approved",
      approved_by: caller.userId,
      approved_at: new Date().toISOString(),
    })
    .eq("id", content_id)
    .eq("brokerage_id", caller.brokerageId)

  await supabase.from("notifications").insert({
    user_id: post.user_id,
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
  // Admin, Broker, and Compliance Officer see all posts in brokerage
  const adminRoles = ["ADMIN", "BROKER", "COMPLIANCE_OFFICER", "admin", "broker", "broker_owner", "compliance_officer", "superadmin"]
  return !adminRoles.includes(role)
}

export async function getSocialAccounts(_userId?: string, _userRole?: string) {
  const caller = await resolveCaller()
  if (!caller.ok) return []

  const supabase = createServiceClient()

  let query = supabase
    .from("social_media_accounts")
    .select("*")
    .eq("is_active", true)
    .order("platform")

  // Filter by user when caller doesn't have brokerage-wide visibility.
  // Note: social_media_accounts has no brokerage_id column, so we scope via user_id.
  if (shouldFilterByUser(caller.userType)) {
    query = query.eq("user_id", caller.userId)
  } else {
    // For broker/admin, restrict to users in the same brokerage
    const { data: brokerageUsers } = await supabase
      .from("users")
      .select("id")
      .eq("brokerage_id", caller.brokerageId)
    const ids = (brokerageUsers ?? []).map((u: any) => u.id)
    if (ids.length === 0) return []
    query = query.in("user_id", ids)
  }

  const { data, error } = await query

  if (error) {
    console.log("[social-publishing] Get social accounts error:", error)
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
  userId?: string  // ignored — kept for backward compat
}) {
  const caller = await resolveCaller()
  if (!caller.ok) throw new Error("Unauthorized")

  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("social_media_accounts")
    .upsert(
      {
        user_id: caller.userId,
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
    .maybeSingle()

  if (error) throw error

  revalidatePath("/settings/social-accounts")
  return data
}

export async function disconnectSocialAccount(accountId: string, _userId?: string) {
  const caller = await resolveCaller()
  if (!caller.ok) throw new Error("Unauthorized")

  const supabase = createServiceClient()

  const { error } = await supabase
    .from("social_media_accounts")
    .update({ is_active: false })
    .eq("id", accountId)
    .eq("user_id", caller.userId)

  if (error) throw error

  revalidatePath("/settings/social-accounts")
}

export async function getSocialPosts(filters?: {
  status?: string
  startDate?: string
  endDate?: string
  userId?: string  // ignored — kept for backward compat
  userRole?: string  // ignored
}) {
  const caller = await resolveCaller()
  if (!caller.ok) return []

  const supabase = createServiceClient()

  let query = supabase
    .from("social_posts")
    .select(`
      *,
      social_post_analytics(*)
    `)
    .eq("brokerage_id", caller.brokerageId)

  if (shouldFilterByUser(caller.userType)) {
    query = query.eq("user_id", caller.userId)
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
    console.log("[social-publishing] Get social posts error:", error)
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
  userId?: string  // ignored — kept for backward compat
}) {
  const caller = await resolveCaller()
  if (!caller.ok) throw new Error("Unauthorized")

  const supabase = createServiceClient()

  // Compliance gate — hard stop if content violates real-estate rules
  const gate = await runComplianceGate({
    content: params.content,
    brokerageId: caller.brokerageId,
    authorUserId: caller.userId,
    contentType: (params.contentType as any) ?? "social_post",
    platforms: params.platforms,
  })

  if (!gate.passed) {
    const { data: draftPost } = await supabase
      .from("social_posts")
      .insert({
        user_id: caller.userId,
        brokerage_id: caller.brokerageId,
        content: params.content,
        media_urls: params.mediaUrls ?? [],
        hashtags: params.hashtags ?? [],
        scheduled_for: params.scheduledFor,
        platform: params.platforms?.[0] ?? "facebook",
        post_type: params.contentType ?? "custom",
        listing_id: params.linkedListingId ?? null,
        ai_generated: params.generatedByAi ?? false,
        post_brief: params.aiPrompt ?? null,
        status: "draft",
        brand_compliance_passed: false,
        approval_status: "pending",
      })
      .select("id")
      .maybeSingle()

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
      user_id: caller.userId,
      brokerage_id: caller.brokerageId,
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
    .maybeSingle()

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
    userId?: string  // ignored — kept for backward compat
  },
) {
  const caller = await resolveCaller()
  if (!caller.ok) throw new Error("Unauthorized")

  const supabase = createServiceClient()

  // Verify post belongs to caller's brokerage before mutating
  const { data: existing } = await supabase
    .from("social_posts")
    .select("brokerage_id, user_id")
    .eq("id", postId)
    .maybeSingle()
  if (!existing) throw new Error("Post not found")
  if (existing.brokerage_id !== caller.brokerageId) throw new Error("Forbidden")
  // Non-admins can only edit their own posts
  if (shouldFilterByUser(caller.userType) && existing.user_id !== caller.userId) {
    throw new Error("Forbidden")
  }

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
    .eq("brokerage_id", caller.brokerageId)
    .select()
    .maybeSingle()

  if (error) throw error

  revalidatePath("/content-studio")
  revalidatePath("/social-planner")
  return data
}

export async function deleteSocialPost(postId: string, _userId?: string) {
  const caller = await resolveCaller()
  if (!caller.ok) throw new Error("Unauthorized")

  const supabase = createServiceClient()

  // Verify post belongs to caller's brokerage before deleting
  const { data: existing } = await supabase
    .from("social_posts")
    .select("brokerage_id, user_id")
    .eq("id", postId)
    .maybeSingle()
  if (!existing) throw new Error("Post not found")
  if (existing.brokerage_id !== caller.brokerageId) throw new Error("Forbidden")
  // Non-admins can only delete their own posts
  if (shouldFilterByUser(caller.userType) && existing.user_id !== caller.userId) {
    throw new Error("Forbidden")
  }

  const { error } = await supabase
    .from("social_posts")
    .delete()
    .eq("id", postId)
    .eq("brokerage_id", caller.brokerageId)

  if (error) throw error

  revalidatePath("/content-studio")
  revalidatePath("/social-planner")
}

export async function getSocialAnalytics(dateRange?: {
  start: string
  end: string
  userId?: string  // ignored — kept for backward compat
  userRole?: string  // ignored
}) {
  const caller = await resolveCaller()
  if (!caller.ok) return []

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
    .eq("brokerage_id", caller.brokerageId)

  if (shouldFilterByUser(caller.userType)) {
    query = query.eq("user_id", caller.userId)
  }

  if (dateRange) {
    query = query.gte("published_at", dateRange.start).lte("published_at", dateRange.end)
  }

  const { data, error } = await query.order("published_at", { ascending: false })

  if (error) {
    console.log("[social-publishing] Get social analytics error:", error)
    return []
  }
  return data || []
}

export async function generateSocialContent(params: {
  contentType: string
  personaTarget?: string
  listingId?: string
  customPrompt?: string
  userId?: string  // ignored — kept for backward compat
}) {
  const caller = await resolveCaller()
  if (!caller.ok) {
    return {
      content: "",
      hashtags: [],
      aiPrompt: "",
      error: "Unauthorized",
    }
  }

  const supabase = createServiceClient()

  // Get listing details if provided — scoped to caller's brokerage
  let listingContext = ""
  if (params.listingId) {
    const { data: listing } = await supabase
      .from("listings")
      .select("address, list_price, bedrooms, bathrooms, sqft, brokerage_id")
      .eq("id", params.listingId)
      .maybeSingle()

    if (listing && listing.brokerage_id === caller.brokerageId) {
      listingContext = `Listing Details: ${listing.address}, $${listing.list_price?.toLocaleString()}, ${listing.bedrooms}BR/${listing.bathrooms}BA, ${listing.sqft}sqft.`
    }
  }

  const prompt =
    params.customPrompt ||
    `Generate a social media post for ${params.contentType}. ${listingContext} Target persona: ${params.personaTarget || "general"}. Use the "Them First" approach: 40% feelings/empathy, 25% trust-building, 25% value, 10% solution. Include relevant hashtags.`

  try {
    const { text } = await generateText({
      model: resolveModel("openai/gpt-4o-mini"),
      prompt,
    })

    const hashtagRegex = /#\w+/g
    const hashtags = text.match(hashtagRegex) || []

    return {
      content: text,
      hashtags,
      aiPrompt: prompt,
    }
  } catch (error: any) {
    console.error("[social-publishing] AI generation error:", error)
    return {
      content: "AI generation is currently unavailable. Please configure your AI API keys in Settings or use the full Marketing Studio to create content.",
      hashtags: [],
      aiPrompt: prompt,
      error: error.message,
    }
  }
}
