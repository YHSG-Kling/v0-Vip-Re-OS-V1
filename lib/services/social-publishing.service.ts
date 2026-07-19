

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"
import { handleError, ValidationError, NotFoundError } from "@/lib/errors"
import { SOCIAL_MEDIA_PLATFORMS } from "@/lib/constants"

/**
 * Consolidated Social Media Publishing Service
 * Handles multi-platform publishing with proper error handling
 */

export interface PublishPostParams {
  postId: string
  platforms?: string[]
  scheduleFor?: string
}

export interface PublishResult {
  success: boolean
  platform?: string
  externalId?: string
  error?: string
}

/**
 * Publish post to social media platforms
 */
export async function publishToSocialMedia(params: PublishPostParams): Promise<{
  success: boolean
  results: PublishResult[]
  error?: string
}> {
  try {
    if (!isValidUUID(params.postId)) {
      throw new ValidationError("Invalid post ID")
    }

    const supabase = await createClient()

    // Get post details
    const { data: post, error: fetchError } = await supabase
      .from("social_posts")
      .select("*")
      .eq("id", params.postId)
      .single()

    if (fetchError || !post) {
      throw new NotFoundError("Post not found")
    }

    const platforms = params.platforms || [post.platform]
    const results: PublishResult[] = []

    for (const platform of platforms) {
      const result = await publishToPlatform({
        post,
        platform,
        scheduleFor: params.scheduleFor
      })
      results.push(result)
    }

    // Update post status
    const allSucceeded = results.every(r => r.success)
    await supabase
      .from("social_posts")
      .update({
        status: allSucceeded ? "published" : "failed",
        published_at: allSucceeded ? new Date().toISOString() : null
      })
      .eq("id", params.postId)

    return {
      success: allSucceeded,
      results
    }
  } catch (error) {
    const err = handleError(error, "publishToSocialMedia") as { success: false; error: string }
    return { ...err, results: [] }
  }
}

/**
 * Publish to specific platform
 */
async function publishToPlatform(params: {
  post: any
  platform: string
  scheduleFor?: string
}): Promise<PublishResult> {
  const { post, platform } = params

  // HONEST FAILURE, never fake success. This legacy service is NOT wired to the
  // real publishing rail — the canonical path is the publish-social-posts cron
  // (app/api/cron/publish-social-posts) → lib/social/publisher.ts, which posts
  // through real platform APIs with real credentials. This function used to
  // SIMULATE success (fabricated external ids + zeroed analytics rows), which
  // would mark a post 'published' that never left the building. It now refuses,
  // so any future caller gets the truth instead of a silent no-op. Use
  // schedulePost() here (which the canonical cron picks up) or the real rail.
  console.error(
    `[social-publishing.service] refusing simulated publish of post ${post?.id} to ${platform} — ` +
    "use the canonical publish-social-posts cron / lib/social/publisher.ts rail",
  )
  return {
    success: false,
    platform,
    error:
      "publishToSocialMedia is not connected to a real publisher — schedule the post instead " +
      "(the publish-social-posts cron sends scheduled+approved posts through the real rail)",
  }
}

/**
 * Schedule post for future publishing
 */
export async function schedulePost(params: {
  postId: string
  scheduledFor: string
  platforms?: string[]
}): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isValidUUID(params.postId)) {
      throw new ValidationError("Invalid post ID")
    }

    const supabase = await createClient()

    // Update post with schedule
    const { error } = await supabase
      .from("social_posts")
      .update({
        status: "scheduled",
        scheduled_for: params.scheduledFor
      })
      .eq("id", params.postId)

    if (error) throw error

    // Create orchestrator task for scheduled publishing
    await supabase.from("orchestrator_tasks").insert({
      task_type: "publish_scheduled_post",
      scheduled_for: params.scheduledFor,
      payload: {
        post_id: params.postId,
        platforms: params.platforms
      },
      status: "pending"
    })

    return { success: true }
  } catch (error) {
    return handleError(error, "schedulePost")
  }
}

/**
 * Get post analytics across all platforms
 */
export async function getPostAnalytics(postId: string): Promise<{
  totalImpressions: number
  totalEngagements: number
  totalClicks: number
  byPlatform: Record<string, any>
}> {
  try {
    if (!isValidUUID(postId)) {
      return { totalImpressions: 0, totalEngagements: 0, totalClicks: 0, byPlatform: {} }
    }

    const supabase = await createClient()

    const { data: analytics } = await supabase
      .from("social_media_analytics")
      .select("*")
      .eq("post_id", postId)

    if (!analytics || analytics.length === 0) {
      return { totalImpressions: 0, totalEngagements: 0, totalClicks: 0, byPlatform: {} }
    }

    const byPlatform: Record<string, any> = {}
    let totalImpressions = 0
    let totalEngagements = 0
    let totalClicks = 0

    for (const record of analytics) {
      totalImpressions += record.impressions || 0
      totalEngagements += record.engagements || 0
      totalClicks += record.clicks || 0

      byPlatform[record.platform] = {
        impressions: record.impressions || 0,
        engagements: record.engagements || 0,
        clicks: record.clicks || 0,
        engagement_rate: record.impressions > 0 
          ? ((record.engagements || 0) / record.impressions * 100).toFixed(2)
          : 0
      }
    }

    return {
      totalImpressions,
      totalEngagements,
      totalClicks,
      byPlatform
    }
  } catch (error) {
    console.error("[v0] Get post analytics error:", error)
    return { totalImpressions: 0, totalEngagements: 0, totalClicks: 0, byPlatform: {} }
  }
}

/**
 * Bulk publish multiple posts
 */
export async function bulkPublishPosts(params: {
  postIds: string[]
  platforms?: string[]
}): Promise<{ 
  success: boolean
  published: number
  failed: number
  results: PublishResult[]
}> {
  const results: PublishResult[] = []
  let published = 0
  let failed = 0

  for (const postId of params.postIds) {
    const result = await publishToSocialMedia({
      postId,
      platforms: params.platforms
    })

    if (result.success) {
      published++
    } else {
      failed++
    }

    results.push(...result.results)

    // Rate limiting
    await new Promise(resolve => setTimeout(resolve, 500))
  }

  return {
    success: published > 0,
    published,
    failed,
    results
  }
}

/**
 * Delete scheduled post
 */
export async function cancelScheduledPost(postId: string): Promise<{ success: boolean }> {
  try {
    if (!isValidUUID(postId)) {
      throw new ValidationError("Invalid post ID")
    }

    const supabase = await createClient()

    // Update post status
    await supabase
      .from("social_posts")
      .update({ status: "draft", scheduled_for: null })
      .eq("id", postId)

    // Cancel orchestrator task
    await supabase
      .from("orchestrator_tasks")
      .update({ status: "cancelled" })
      .eq("task_type", "publish_scheduled_post")
      .eq("payload->post_id", postId)

    return { success: true }
  } catch (error) {
    return handleError(error, "cancelScheduledPost")
  }
}
