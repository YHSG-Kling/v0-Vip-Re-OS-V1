// app/api/cron/publish-social-posts/route.ts
// Layer 9.2 Social Media Automation — Cron Publisher
// Tables: social_posts, social_media_accounts, social_publish_log, social_post_analytics

import { createServiceClient } from "@/lib/supabase/service"
import { NextResponse } from "next/server"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { publishToSocialPlatform } from "@/lib/social/publisher"
import { checkBrandCompliance } from "@/lib/kernel/brand-compliance"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(request: Request) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "publish-social-posts",
    cron_path: "/app/api/cron/publish-social-posts/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[PublishSocialPosts] Failed to record cron start:", startRecordResult.error)
  }

  try {
    const supabase = createServiceClient()
    const now = new Date()

    // SELECT social_posts WHERE status='scheduled' AND approval_status='approved'
    // AND scheduled_for <= now() ORDER BY scheduled_for ASC LIMIT 20
    const { data: posts, error } = await supabase
      .from("social_posts")
      .select("*")
      .eq("status", "scheduled")
      .eq("approval_status", "approved")
      .lte("scheduled_for", now.toISOString())
      .order("scheduled_for", { ascending: true })
      .limit(20)

    if (error) {
      console.error("[cron/publish-social-posts] Query error:", error)
      throw error
    }

    const results: {
      postId: string
      status: "published" | "failed" | "skipped"
      platform?: string
      externalPostId?: string
      error?: string
    }[] = []

    for (const post of posts || []) {
      // Idempotent check — skip if already published
      if (post.status === "published") {
        results.push({ postId: post.id, status: "skipped" })
        continue
      }

      try {
        // Step 1: UPDATE social_posts SET status='publishing'
        await supabase
          .from("social_posts")
          .update({ status: "publishing", updated_at: new Date().toISOString() })
          .eq("id", post.id)

        // Step 2: Run brand compliance check before publish
        if (post.brokerage_id) {
          try {
            const complianceResult = await checkBrandCompliance({
              contentType: "social_post",
              contentId: post.id,
              brokerageId: post.brokerage_id,
            })

            if (!complianceResult.passed) {
              // Mark as failed due to compliance
              await supabase
                .from("social_posts")
                .update({
                  status: "failed",
                  brand_compliance_passed: false,
                  compliance_checked_at: new Date().toISOString(),
                  error_message: `Brand compliance failed: ${complianceResult.violations?.join(", ") || "Unknown violation"}`,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", post.id)

              // Log to social_publish_log
              await supabase.from("social_publish_log").insert({
                social_post_id: post.id,
                brokerage_id: post.brokerage_id,
                platform: post.platform,
                publish_status: "failed",
                error_message: "Brand compliance check failed",
                created_at: new Date().toISOString(),
              })

              results.push({
                postId: post.id,
                status: "failed",
                platform: post.platform,
                error: "Brand compliance failed",
              })
              continue
            }

            // Update compliance passed
            await supabase
              .from("social_posts")
              .update({
                brand_compliance_passed: true,
                compliance_checked_at: new Date().toISOString(),
              })
              .eq("id", post.id)
          } catch (complianceError: any) {
            console.error("[cron/publish-social-posts] Compliance check error:", complianceError)
            // Fail CLOSED — never push content we could not verify for Fair Housing /
            // brand compliance to a public platform. Hold the post for review and skip.
            await supabase
              .from("social_posts")
              .update({
                status: "failed",
                compliance_checked_at: new Date().toISOString(),
                error_message: `Brand compliance check errored — held for review: ${complianceError?.message ?? "unknown error"}`,
                updated_at: new Date().toISOString(),
              })
              .eq("id", post.id)

            await supabase.from("social_publish_log").insert({
              social_post_id: post.id,
              brokerage_id: post.brokerage_id,
              platform: post.platform,
              publish_status: "failed",
              error_message: "Brand compliance check errored — held for review",
              created_at: new Date().toISOString(),
            })

            results.push({
              postId: post.id,
              status: "failed",
              platform: post.platform,
              error: "Compliance check errored",
            })
            continue
          }
        }

        // Step 3: SELECT social_media_accounts WHERE id = post.social_account_id
        const { data: account, error: accountError } = await supabase
          .from("social_media_accounts")
          .select("platform, access_token, refresh_token, account_id")
          .eq("id", post.social_account_id)
          .eq("is_active", true)
          .maybeSingle()

        if (accountError || !account) {
          throw new Error(`No active account found for social_account_id: ${post.social_account_id}`)
        }

        // Step 4: Call lib/social/publisher.ts publishToSocialPlatform
        const publishResult = await publishToSocialPlatform(post.platform, {
          content: post.content,
          mediaUrls: post.media_urls || [],
          accessToken: account.access_token,
          accountId: account.account_id,
          hashtags: post.hashtags || [],
        })

        if (publishResult.success) {
          // Step 5a: On success
          // UPDATE social_posts SET status='published', published_at, external_post_id
          await supabase
            .from("social_posts")
            .update({
              status: "published",
              published_at: new Date().toISOString(),
              external_post_id: publishResult.externalPostId || null,
              error_message: null,
              updated_at: new Date().toISOString(),
            })
            .eq("id", post.id)

          // INSERT social_publish_log with publish_status='published'
          await supabase.from("social_publish_log").insert({
            social_post_id: post.id,
            brokerage_id: post.brokerage_id,
            platform: post.platform,
            account_id: post.social_account_id,
            publish_status: "published",
            external_post_id: publishResult.externalPostId,
            published_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          })

          // Seed a zeroed engagement-tracking row so the published post surfaces
          // in the social dashboard, which reads social_engagement_tracking.
          // (Previously wrote social_post_analytics, a table nothing reads.)
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

          // processKernelEvent(KernelEvent.SOCIAL_POST_PUBLISHED)
          await supabase.from("lifecycle_events").insert({
            entity_type: "social_post",
            entity_id: post.id,
            brokerage_id: post.brokerage_id,
            event_type: KernelEvent.SOCIAL_POST_PUBLISHED,
            metadata: {
              platform: post.platform,
              external_post_id: publishResult.externalPostId,
              listing_id: post.listing_id,
              post_type: post.post_type,
            },
          })

          await processKernelEvent({
            event: KernelEvent.SOCIAL_POST_PUBLISHED,
            brokerageId: post.brokerage_id,
            entityType: "social_post",
            entityId: post.id,
          }).catch((err) =>
            console.error("[cron/publish-social-posts] Kernel event failed:", err)
          )

          results.push({
            postId: post.id,
            status: "published",
            platform: post.platform,
            externalPostId: publishResult.externalPostId,
          })
        } else {
          // Step 5b: On failure
          throw new Error(publishResult.error || "Unknown publish error")
        }
      } catch (postError: any) {
        console.error(`[cron/publish-social-posts] Failed to publish post ${post.id}:`, postError.message)

        // Get current retry count
        const retryCount = (post.retry_count || 0) + 1

        // UPDATE social_posts SET status='failed', error_message, retry_count+1
        await supabase
          .from("social_posts")
          .update({
            status: "failed",
            error_message: postError.message,
            retry_count: retryCount,
            updated_at: new Date().toISOString(),
          })
          .eq("id", post.id)

        // INSERT social_publish_log with publish_status='failed', error_message
        await supabase.from("social_publish_log").insert({
          social_post_id: post.id,
          brokerage_id: post.brokerage_id,
          platform: post.platform,
          publish_status: "failed",
          error_message: postError.message,
          created_at: new Date().toISOString(),
        })

        // processKernelEvent(KernelEvent.SOCIAL_POST_FAILED)
        await supabase.from("lifecycle_events").insert({
          entity_type: "social_post",
          entity_id: post.id,
          brokerage_id: post.brokerage_id,
          event_type: KernelEvent.SOCIAL_POST_FAILED,
          metadata: {
            platform: post.platform,
            error: postError.message,
            retry_count: retryCount,
            listing_id: post.listing_id,
          },
        })

        await processKernelEvent({
          event: KernelEvent.SOCIAL_POST_FAILED,
          brokerageId: post.brokerage_id,
          entityType: "social_post",
          entityId: post.id,
        }).catch((err) =>
          console.error("[cron/publish-social-posts] Kernel event failed:", err)
        )

        results.push({
          postId: post.id,
          status: "failed",
          platform: post.platform,
          error: postError.message,
        })
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
      timestamp: now.toISOString(),
    })
  } catch (error: any) {
    console.error("[cron/publish-social-posts] Cron error:", error)
    await recordCronFailureAction({ context_id: contextId, error, stage: "main-processing" })
    return NextResponse.json(
      { error: "Social publishing failed", message: error.message, context_id: contextId },
      { status: 500 }
    )
  }
}
