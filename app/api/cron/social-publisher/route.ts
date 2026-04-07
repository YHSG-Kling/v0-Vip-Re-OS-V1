import { createClient } from "@/lib/supabase/server"
import { NextResponse } from "next/server"
import { publishToSocialPlatform } from "@/lib/social/publisher"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(request: Request) {
  // Verify cron secret
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const contextResult = await createCronRunContextAction({
    cron_name: "social-publisher",
    cron_path: "/app/api/cron/social-publisher/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[SocialPublisher] Failed to record cron start:", startRecordResult.error)
  }

  try {
    const supabase = await createClient()
    const now = new Date()

    // Fetch posts scheduled for now or earlier that are approved (or don't require approval)
    // JOIN to the single linked social_media_account via social_account_id FK
    const { data: posts, error } = await supabase
      .from("social_posts")
      .select(`
        *,
        social_media_accounts!social_posts_social_account_id_fkey(
          id, platform, access_token, refresh_token, account_id, is_active
        )
      `)
      .eq("status", "scheduled")
      .in("approval_status", ["approved", "pending"]) // pending = no broker approval required
      .lte("scheduled_for", now.toISOString())
      .order("scheduled_for", { ascending: true })
      .limit(20)

    if (error) throw error

    const results = []

    for (const post of posts ?? []) {
      const account = post.social_media_accounts as any

      if (!account || !account.is_active) {
        // Mark as failed — no active account
        await supabase
          .from("social_posts")
          .update({
            status: "failed",
            error_message: "No active social account linked to this post",
            updated_at: new Date().toISOString(),
          })
          .eq("id", post.id)

        results.push({ postId: post.id, status: "failed", error: "No active account" })
        continue
      }

      // Mark as publishing
      await supabase
        .from("social_posts")
        .update({ status: "publishing", updated_at: new Date().toISOString() })
        .eq("id", post.id)

      try {
        const publishResult = await publishToSocialPlatform(post.platform, {
          content: post.content,
          mediaUrls: post.media_urls ?? [],
          hashtags: post.hashtags ?? [],
          accessToken: account.access_token,
          accountId: account.account_id ?? account.id,
        })

        if (!publishResult.success) {
          throw new Error(publishResult.error ?? `Failed to publish to ${post.platform}`)
        }

        const externalPostId = publishResult.externalPostId ?? null

        // Mark as published
        await supabase
          .from("social_posts")
          .update({
            status: "published",
            external_post_id: externalPostId,
            published_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq("id", post.id)

        // Write publish log (success)
        await supabase.from("social_publish_log").insert({
          social_post_id: post.id,
          brokerage_id: post.brokerage_id,
          platform: post.platform,
          account_id: account.id,
          external_post_id: externalPostId,
          publish_status: "published",
          published_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        })

        // Seed analytics row so engagement tracking can start
        await supabase.from("social_engagement_tracking").insert({
          social_post_id: post.id,
          brokerage_id: post.brokerage_id,
          platform: post.platform,
          impressions_count: 0,
          likes_count: 0,
          comments_count: 0,
          shares_count: 0,
          saves_count: 0,
          clicks_count: 0,
          leads_generated: 0,
          captured_at: new Date().toISOString(),
        })

        results.push({ postId: post.id, status: "published", platform: post.platform, externalPostId })
      } catch (publishError: any) {
        console.error(`[social-publisher] Failed to publish post ${post.id}:`, publishError.message)

        // Increment error_count (existing column) for circuit-breaker tracking
        const { data: current } = await supabase
          .from("social_posts")
          .select("error_count")
          .eq("id", post.id)
          .maybeSingle()

        const newErrorCount = (current?.error_count ?? 0) + 1

        await supabase
          .from("social_posts")
          .update({
            status: "failed",
            error_message: publishError.message,
            error_count: newErrorCount,
            updated_at: new Date().toISOString(),
          })
          .eq("id", post.id)

        // Write publish log (failure)
        await supabase.from("social_publish_log").insert({
          social_post_id: post.id,
          brokerage_id: post.brokerage_id,
          platform: post.platform,
          account_id: account.id,
          publish_status: "failed",
          error_message: publishError.message,
          created_at: new Date().toISOString(),
        })

        results.push({ postId: post.id, status: "failed", error: publishError.message })
      }
    }

    const published = results.filter((r) => r.status === "published").length
    const failed = results.filter((r) => r.status === "failed").length

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: results.length,
      output_count: published,
      metadata: { processed: results.length, published, failed },
    })

    return NextResponse.json({
      success: true,
      processed: results.length,
      results,
    })
  } catch (error: any) {
    console.error("[social-publisher] Cron error:", error)
    await recordCronFailureAction({ context_id: contextId, error, stage: "main-processing" })
    return NextResponse.json({ error: "Social publishing failed", message: error.message, context_id: contextId }, { status: 500 })
  }
}
