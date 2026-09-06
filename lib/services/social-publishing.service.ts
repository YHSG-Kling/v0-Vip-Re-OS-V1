

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"
import { handleError, ValidationError, NotFoundError } from "@/lib/errors"
import { SOCIAL_PLATFORMS, type SocialPlatform } from "@/lib/constants"

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

    // THE PLATFORM VOCABULARY IS CHECKED, not assumed. `params.platforms` is a
    // bare `string[]` that arrives from a caller, and every unrecognised entry
    // used to become its own PublishResult row and its own attempted publish.
    // SOCIAL_PLATFORMS (lib/constants/index.ts:248) is the one list of platforms
    // this product publishes to; it was imported into this file under its
    // deprecated alias and never consulted.
    const unknown = platforms.filter((p) => !(SOCIAL_PLATFORMS as readonly string[]).includes(p))
    if (unknown.length > 0) {
      throw new ValidationError(`Unsupported social platform(s): ${unknown.join(", ")}`)
    }
    // Past the vocabulary gate, every entry IS a SocialPlatform — the derived
    // type of the list just consulted. Narrowed here (§1.2, 2026-08-31, lane
    // M4: the type existed with no consumer; this gate is its reader) so the
    // per-platform loop carries the proof instead of a bare string.
    const validPlatforms = platforms as SocialPlatform[]

    for (const platform of validPlatforms) {
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

    // TENANT ANCHOR. params.postId is caller-supplied, so the post is READ FIRST
    // through the session client: social_posts' SELECT policy is tenant-scoped,
    // so a post this session may not see does not come back and the schedule is
    // refused instead of silently no-op'ing. The row it returns is also where
    // the orchestrator task's brokerage_id comes from — resolved before anything
    // is mutated, so a post with no tenant is refused rather than half-scheduled.
    const { data: post, error: postError } = await supabase
      .from("social_posts")
      .select("id, brokerage_id")
      .eq("id", params.postId)
      .maybeSingle()

    if (postError) throw postError
    if (!post) throw new NotFoundError("Post not found")

    const brokerageId = (post as { brokerage_id: string | null }).brokerage_id
    if (!brokerageId) {
      // Not a "could not find the tenant" shrug — the post itself carries no
      // brokerage, so there is no tenant to file the queued task under and
      // stamping it from anywhere else would be a guess.
      return { success: false, error: "Post has no brokerage — cannot schedule it" }
    }

    // Update post with schedule. .select("id") because supabase-js RESOLVES a
    // query RLS refused: an update that matched zero rows returns error null,
    // so `if (error) throw` alone reported success for a post that never moved.
    const { data: updated, error } = await supabase
      .from("social_posts")
      .update({
        status: "scheduled",
        scheduled_for: params.scheduledFor
      })
      .eq("id", params.postId)
      .select("id")

    if (error) throw error
    if (!updated || updated.length === 0) {
      return { success: false, error: "Post could not be scheduled — the update was refused" }
    }

    // Create orchestrator task for scheduled publishing.
    //
    // STAMPED, and the insert is CHECKED. This row is the queue entry the
    // queue-drain cron reconciles; it belongs to the post's brokerage, not to
    // the platform. Unstamped it satisfied the `brokerage_id IS NULL` branch of
    // ot_select and was readable — payload post ids and all — by every signed-in
    // user of every other brokerage. Worse, ot_update is
    // `is_platform_admin() OR has_brokerage_access(brokerage_id)` with NO NULL
    // branch and has_brokerage_access(NULL) is false, so an untenanted task
    // could never be updated by its own tenant: cancelScheduledPost below could
    // not actually cancel it.
    //
    // The bare `await …insert(…)` inside this try/catch checked nothing —
    // supabase-js resolves a refused insert, so the catch caught nothing and a
    // post could report "scheduled" with no queue entry behind it.
    const { error: taskError } = await supabase.from("orchestrator_tasks").insert({
      brokerage_id: brokerageId,
      task_type: "publish_scheduled_post",
      scheduled_for: params.scheduledFor,
      payload: {
        post_id: params.postId,
        platforms: params.platforms
      },
      status: "pending"
    })

    if (taskError) {
      // Say the truth: the post reads as scheduled but nothing will pick it up
      // from this queue. (The canonical publish-social-posts cron reads
      // social_posts directly, so this is a degraded state, not a silent one.)
      return {
        success: false,
        error: `Post marked scheduled but the publish task could not be queued: ${taskError.message}`,
      }
    }

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
