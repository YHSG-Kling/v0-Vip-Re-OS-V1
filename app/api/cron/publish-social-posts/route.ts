// app/api/cron/publish-social-posts/route.ts
// Layer 9.2 Social Media Automation — Cron Publisher
// Tables: social_posts, social_media_accounts, social_publish_log, social_post_analytics

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { createServiceClient } from "@/lib/supabase/service"
import { NextResponse } from "next/server"
import { KernelEvent } from "@/lib/kernel/events"
import { publishToSocialPlatform } from "@/lib/social/publisher"
import { checkBrandCompliance } from "@/lib/kernel/brand-compliance"
import { assembleSocialDisclosures, appendDisclosures } from "@/lib/social/assemble-disclosures"
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
        const { error: publishingFlagErr } = await supabase
          .from("social_posts")
          .update({ status: "publishing", updated_at: new Date().toISOString() })
          .eq("id", post.id)
        if (publishingFlagErr) console.error(`[publish-social-posts] post NOT marked publishing: ${publishingFlagErr.message}`)

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
              await sentinelWrite(supabase, supabase
                .from("social_posts")
                .update({
                  status: "failed",
                  brand_compliance_passed: false,
                  compliance_checked_at: new Date().toISOString(),
                  error_message: `Brand compliance failed: ${complianceResult.violations?.join(", ") || "Unknown violation"}`,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", post.id), { table: "social_posts", flow: "social_posts_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })

              // Log to social_publish_log
              await sentinelWrite(supabase, supabase.from("social_publish_log").insert({
                social_post_id: post.id,
                brokerage_id: post.brokerage_id,
                platform: post.platform,
                publish_status: "failed",
                error_message: "Brand compliance check failed",
                created_at: new Date().toISOString(),
              }), { table: "social_publish_log", flow: "social_publish_log_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })

              results.push({
                postId: post.id,
                status: "failed",
                platform: post.platform,
                error: "Brand compliance failed",
              })
              continue
            }

            // Update compliance passed
            await sentinelWrite(supabase, supabase
              .from("social_posts")
              .update({
                brand_compliance_passed: true,
                compliance_checked_at: new Date().toISOString(),
              })
              .eq("id", post.id), { table: "social_posts", flow: "social_posts_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })
          } catch (complianceError: any) {
            console.error("[cron/publish-social-posts] Compliance check error:", complianceError)
            // Fail CLOSED — never push content we could not verify for Fair Housing /
            // brand compliance to a public platform. Hold the post for review and skip.
            await sentinelWrite(supabase, supabase
              .from("social_posts")
              .update({
                status: "failed",
                compliance_checked_at: new Date().toISOString(),
                error_message: `Brand compliance check errored — held for review: ${complianceError?.message ?? "unknown error"}`,
                updated_at: new Date().toISOString(),
              })
              .eq("id", post.id), { table: "social_posts", flow: "social_posts_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })

            await sentinelWrite(supabase, supabase.from("social_publish_log").insert({
              social_post_id: post.id,
              brokerage_id: post.brokerage_id,
              platform: post.platform,
              publish_status: "failed",
              error_message: "Brand compliance check errored — held for review",
              created_at: new Date().toISOString(),
            }), { table: "social_publish_log", flow: "social_publish_log_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })

            results.push({
              postId: post.id,
              status: "failed",
              platform: post.platform,
              error: "Compliance check errored",
            })
            continue
          }
        }

        // platform='all' → fan out to EVERY active connected account for the
        // brokerage (the "post to every platform" selection). One source row,
        // N platform publishes, per-platform logging. Content is already
        // compliance-checked above.
        if (post.platform === "all") {
          const { data: accounts } = await supabase
            .from("social_media_accounts")
            .select("platform, access_token, account_id")
            .eq("brokerage_id", post.brokerage_id)
            .eq("is_active", true)
          const targets = (accounts ?? []) as Array<{ platform: string; access_token: string; account_id: string }>
          if (targets.length === 0) {
            await sentinelWrite(supabase, supabase.from("social_posts").update({
              status: "failed", error_message: "platform=all but no connected social accounts", updated_at: new Date().toISOString(),
            }).eq("id", post.id), { table: "social_posts", flow: "social_posts_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })
            results.push({ postId: post.id, status: "failed", platform: "all", error: "no connected accounts" })
            continue
          }
          const fanDisclosures = await assembleSocialDisclosures(supabase, { brokerageId: post.brokerage_id, userId: post.user_id })
          const fanContent = appendDisclosures(post.content, fanDisclosures)
          let anyOk = false
          for (const acct of targets) {
            try {
              const pr = await publishToSocialPlatform(acct.platform, {
                content: fanContent, mediaUrls: post.media_urls || [],
                accessToken: acct.access_token, accountId: acct.account_id, hashtags: post.hashtags || [],
              }, { brokerageId: post.brokerage_id, postId: post.id, cycle: `${post.id}:${acct.platform}:${acct.account_id}`, actorUserId: post.user_id ?? null })
              await sentinelWrite(supabase, supabase.from("social_publish_log").insert({
                social_post_id: post.id, brokerage_id: post.brokerage_id, platform: acct.platform,
                publish_status: pr.success ? "published" : "failed",
                external_post_id: pr.success ? (pr.externalPostId ?? null) : null,
                error_message: pr.success ? null : (pr.error ?? "publish failed"),
                published_at: pr.success ? new Date().toISOString() : null,
                created_at: new Date().toISOString(),
              }), { table: "social_publish_log", flow: "social_publish_log_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })
              if (pr.success) anyOk = true
            } catch (fanErr) {
              await sentinelWrite(supabase, supabase.from("social_publish_log").insert({
                social_post_id: post.id, brokerage_id: post.brokerage_id, platform: acct.platform,
                publish_status: "failed", error_message: (fanErr as Error).message, created_at: new Date().toISOString(),
              }), { table: "social_publish_log", flow: "social_publish_log_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })
            }
          }
          const { error: fanoutStatusErr } = await supabase.from("social_posts").update({
            status: anyOk ? "published" : "failed",
            published_at: anyOk ? new Date().toISOString() : null,
            error_message: anyOk ? null : "platform=all fan-out failed on every connected platform",
            updated_at: new Date().toISOString(),
          }).eq("id", post.id)
          if (fanoutStatusErr) console.error(`[publish-social-posts] fan-out outcome NOT saved on the post: ${fanoutStatusErr.message}`)
          results.push({ postId: post.id, status: anyOk ? "published" : "failed", platform: "all" })
          continue
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

        // Step 4: Append required real-estate disclosures (brokerage name +
        // license # + Equal Housing) resolved from the agent→brokerage settings
        // cascade, then publish. Final chokepoint, so every published post is
        // compliant by construction regardless of how it was created.
        const disclosures = await assembleSocialDisclosures(supabase, {
          brokerageId: post.brokerage_id,
          userId: post.user_id,
        })
        const compliantContent = appendDisclosures(post.content, disclosures)

        const publishResult = await publishToSocialPlatform(post.platform, {
          content: compliantContent,
          mediaUrls: post.media_urls || [],
          accessToken: account.access_token,
          accountId: account.account_id,
          hashtags: post.hashtags || [],
        }, {
          // ACTION LEDGER (wave 98): one publish per (post, platform, account) — a post whose
          // 'published' flip failed is replayed on the next run, never re-posted.
          brokerageId: post.brokerage_id, postId: post.id,
          cycle: `${post.id}:${post.platform}:${account.account_id}`, actorUserId: post.user_id ?? null,
        })

        if (publishResult.success) {
          // Step 5a: On success
          // UPDATE social_posts SET status='published', published_at, external_post_id
          const { error: publishedStatusErr } = await supabase
            .from("social_posts")
            .update({
              status: "published",
              published_at: new Date().toISOString(),
              external_post_id: publishResult.externalPostId || null,
              error_message: null,
              updated_at: new Date().toISOString(),
            })
            .eq("id", post.id)
          if (publishedStatusErr) console.error(`[publish-social-posts] post published but NOT marked published (may be re-published): ${publishedStatusErr.message}`)

          // INSERT social_publish_log with publish_status='published'
          await sentinelWrite(supabase, supabase.from("social_publish_log").insert({
            social_post_id: post.id,
            brokerage_id: post.brokerage_id,
            platform: post.platform,
            account_id: post.social_account_id,
            publish_status: "published",
            external_post_id: publishResult.externalPostId,
            published_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          }), { table: "social_publish_log", flow: "social_publish_log_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })

          // Seed a zeroed engagement-tracking row so the published post surfaces
          // in the social dashboard, which reads social_engagement_tracking.
          // (Previously wrote social_post_analytics, a table nothing reads.)
          await sentinelWrite(supabase, supabase.from("social_engagement_tracking").insert({
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
          }), { table: "social_engagement_tracking", flow: "social_engagement_tracking_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })

          // processKernelEvent(KernelEvent.SOCIAL_POST_PUBLISHED)
          // ONE EMIT (wave 101C): this row and its fan-out were two calls (an auditOnly emit, then a bare
          // processKernelEvent). One emitKernelEvent now — the reactor gets the lifecycleEventId. Equivalent:
          // same event/tenant/entity, and the reactor's reader for this event uses no metadata.
          await sentinelWrite(supabase, import("@/lib/kernel/emit").then((k) => k.emitKernelEvent({
            entityType: "social_post",
            entityId: post.id,
            brokerageId: post.brokerage_id,
            event: KernelEvent.SOCIAL_POST_PUBLISHED,
            metadata: {
              platform: post.platform,
              external_post_id: publishResult.externalPostId,
              listing_id: post.listing_id,
              post_type: post.post_type,
            },
          }).then(k.asWriteResult)), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped" })


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
        const retryCount = (post.error_count || 0) + 1

        // UPDATE social_posts SET status='failed', error_message, retry_count+1
        const { error: failedStatusErr } = await supabase
          .from("social_posts")
          .update({
            status: "failed",
            error_message: postError.message,
            error_count: retryCount,
            updated_at: new Date().toISOString(),
          })
          .eq("id", post.id)
        if (failedStatusErr) console.error(`[publish-social-posts] failure NOT recorded on the post: ${failedStatusErr.message}`)

        // INSERT social_publish_log with publish_status='failed', error_message
        await sentinelWrite(supabase, supabase.from("social_publish_log").insert({
          social_post_id: post.id,
          brokerage_id: post.brokerage_id,
          platform: post.platform,
          publish_status: "failed",
          error_message: postError.message,
          created_at: new Date().toISOString(),
        }), { table: "social_publish_log", flow: "social_publish_log_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })

        // Wave 102C: ONE emit (row + fan-out) — the reactor forwards this metadata as the
        // social_post_failed signal payload (was {}), read by named keys.
        await sentinelWrite(supabase, import("@/lib/kernel/emit").then((k) => k.emitKernelEvent({
          entityType: "social_post",
          entityId: post.id,
          brokerageId: post.brokerage_id,
          event: KernelEvent.SOCIAL_POST_FAILED,
          metadata: {
            platform: post.platform,
            error: postError.message,
            retry_count: retryCount,
            listing_id: post.listing_id,
          },
          agentUserId: null,
        }).then(k.asWriteResult)), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped" })

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
