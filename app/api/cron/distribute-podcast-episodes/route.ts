import {
NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "@/lib/kernel/events"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

/**
 * CRON — Distribute Podcast Episodes
 * 
 * Runs periodically to distribute completed podcast episodes to their target channels.
 * 
 * Query:
 *   SELECT podcast_episodes WHERE status='completed' AND published_at IS NULL
 *     AND publish_channels IS NOT EMPTY ORDER BY created_at ASC LIMIT 10
 * 
 * For each episode:
 *   1. Get enabled distribution channels for the brokerage
 *   2. For each channel in episode.publish_channels that matches an enabled channel:
 *      - INSERT podcast_distribution_log with distribution_status='queued'
 *      - Attempt distribution (call external provider API)
 *      - On success: UPDATE log SET distribution_status='published', external_episode_id
 *      - On failure: UPDATE log SET distribution_status='failed', error_message
 *   3. If ALL channels are published: UPDATE episode SET published_at=now()
 *   4. processKernelEvent(PODCAST_EPISODE_DISTRIBUTED or PODCAST_EPISODE_FAILED)
 * 
 * Idempotent: Skip episodes that have all channels in 'published' state already.
 */

export const runtime = "nodejs"
export const maxDuration = 300 // 5 minutes max

export async function GET(request: NextRequest) {
  // Verify CRON_SECRET
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "distribute-podcast-episodes",
    cron_path: "/app/api/cron/distribute-podcast-episodes/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[DistributePodcastEpisodes] Failed to record cron start:", startRecordResult.error)
  }

  const supabase = createServiceClient()
  const results: {
    processed: number
    distributed: number
    failed: number
    skipped: number
    errors: string[]
  } = {
    processed: 0,
    distributed: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  }

  try {
    // ══════════════════════════════════════════════════════════════════════════
    // STEP 1: Fetch episodes ready for distribution
    // ══════════════════════════════════════════════════════════════════════════
    // approval_status filter: the auto-producer stages pending_review and
    // PROMISES the distributor only ships approved episodes — without this
    // predicate, un-reviewed AI episodes with channels set would go public
    // (an approval BYPASS, caught by the 2026-07 autonomy audit).
    const { data: episodes, error: fetchError } = await supabase
      .from("podcast_episodes")
      .select("*")
      .eq("status", "completed")
      .eq("approval_status", "approved")
      .is("published_at", null)
      .not("publish_channels", "eq", "{}")
      .order("created_at", { ascending: true })
      .limit(10)

    if (fetchError) {
      throw new Error(`Failed to fetch episodes: ${fetchError.message}`)
    }

    if (!episodes || episodes.length === 0) {
      await recordCronSuccessAction({ context_id: contextId, records_processed: 0, metadata: { message: "No episodes to distribute" } })
      return NextResponse.json({
        success: true,
        message: "No episodes to distribute",
        results,
      })
    }

    // ══════════════════════════════════════════════════════════════════════════
    // STEP 2: Process each episode
    // ══════════════════════════════════════════════════════════════════════════
    for (const episode of episodes) {
      results.processed++

      try {
        const brokerageId = episode.brokerage_id
        const publishChannels: string[] = episode.publish_channels || []

        if (publishChannels.length === 0) {
          results.skipped++
          continue
        }

        // Check if already fully distributed (idempotent check)
        const { data: existingLogs } = await supabase
          .from("podcast_distribution_log")
          .select("channel_name, distribution_status")
          .eq("podcast_episode_id", episode.id)

        const publishedChannels = existingLogs
          ?.filter(log => log.distribution_status === "published")
          .map(log => log.channel_name) || []

        const remainingChannels = publishChannels.filter(
          ch => !publishedChannels.includes(ch)
        )

        if (remainingChannels.length === 0) {
          // All channels already distributed — mark episode as published
          await supabase
            .from("podcast_episodes")
            .update({ published_at: new Date().toISOString() })
            .eq("id", episode.id)
          
          results.skipped++
          continue
        }

        // ══════════════════════════════════════════════════════════════════════
        // STEP 3: Get enabled distribution channels for brokerage
        // ══════════════════════════════════════════════════════════════════════
        const { data: brokerageChannels } = await supabase
          .from("podcast_distribution_channels")
          .select("*")
          .eq("brokerage_id", brokerageId)
          .eq("is_enabled", true)

        const enabledChannelMap = new Map(
          (brokerageChannels || []).map(ch => [ch.channel_name, ch])
        )

        // ══════════════════════════════════════════════════════════════════════
        // STEP 4: Distribute to each channel
        // ══════════════════════════════════════════════════════════════════════
        let allSucceeded = true
        let anySucceeded = false

        for (const channelName of remainingChannels) {
          const channelConfig = enabledChannelMap.get(channelName)

          // Skip if channel is not enabled for this brokerage
          if (!channelConfig) {
            continue
          }

          // Check if already has a log entry for this channel
          const existingLog = existingLogs?.find(
            log => log.channel_name === channelName
          )

          // Skip if already processed (success or permanent failure)
          if (existingLog && existingLog.distribution_status !== "queued") {
            continue
          }

          // Create or update log entry
          let logId: string

          if (existingLog) {
            // Use existing log ID
            const { data: logRow } = await supabase
              .from("podcast_distribution_log")
              .select("id")
              .eq("podcast_episode_id", episode.id)
              .eq("channel_name", channelName)
              .single()
            logId = logRow?.id
          } else {
            // Insert new log entry
            const { data: newLog } = await supabase
              .from("podcast_distribution_log")
              .insert({
                brokerage_id: brokerageId,
                podcast_episode_id: episode.id,
                channel_name: channelName,
                distribution_status: "queued",
              })
              .select("id")
              .single()
            logId = newLog?.id
          }

          // ════════════════════════════════════════════════════════════════════
          // STEP 5: Attempt distribution
          // ════════════════════════════════════════════════════════════════════
          try {
            const distributionResult = await distributeToChannel(
              episode,
              channelName,
              channelConfig
            )

            // Update log as published
            await supabase
              .from("podcast_distribution_log")
              .update({
                distribution_status: "published",
                published_at: new Date().toISOString(),
                external_episode_id: distributionResult.externalEpisodeId,
                provider_response: distributionResult.providerResponse,
              })
              .eq("id", logId)

            anySucceeded = true
            results.distributed++

            // KERNEL: Process Distribution Success Event
            await processKernelEvent({
              event: KernelEvent.PODCAST_EPISODE_DISTRIBUTED,
              brokerageId,
              entityType: "podcast_episode",
              entityId: episode.id,
            }).catch(() => {})

          } catch (distError: any) {
            // Update log as failed
            await supabase
              .from("podcast_distribution_log")
              .update({
                distribution_status: "failed",
                error_message: distError.message,
                provider_response: { error: distError.message },
              })
              .eq("id", logId)

            allSucceeded = false
            results.failed++
            results.errors.push(
              `Episode ${episode.id} → ${channelName}: ${distError.message}`
            )

            // KERNEL: Process Distribution Failure Event
            await processKernelEvent({
              event: KernelEvent.PODCAST_EPISODE_FAILED,
              brokerageId,
              entityType: "podcast_episode",
              entityId: episode.id,
            }).catch(() => {})
          }
        }

        // ══════════════════════════════════════════════════════════════════════
        // STEP 6: Update episode status if all channels published
        // ══════════════════════════════════════════════════════════════════════
        if (anySucceeded && allSucceeded) {
          await supabase
            .from("podcast_episodes")
            .update({
              status: "published",
              published_at: new Date().toISOString(),
            })
            .eq("id", episode.id)
        }

      } catch (episodeError: any) {
        results.errors.push(`Episode ${episode.id}: ${episodeError.message}`)
      }
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: results.processed,
      output_count: results.distributed,
      metadata: results,
    })

    return NextResponse.json({
      success: true,
      message: `Processed ${results.processed} episodes`,
      results,
    })

  } catch (error: any) {
    console.error("[Cron] distribute-podcast-episodes error:", error)
    await recordCronFailureAction({ context_id: contextId, error, stage: "main-processing" })
    return NextResponse.json(
      { success: false, error: error.message, results, context_id: contextId },
      { status: 500 }
    )
  }
}

/**
 * Distribute episode to a specific channel
 * In production, this would call the actual provider APIs (Spotify, Apple, etc.)
 */
async function distributeToChannel(
  episode: any,
  channelName: string,
  channelConfig: any
): Promise<{
  externalEpisodeId: string
  providerResponse: Record<string, any>
}> {
  // Provider-specific distribution logic
  switch (channelName.toLowerCase()) {
    case "spotify":
      return distributeToSpotify(episode, channelConfig)
    case "apple":
      return distributeToApple(episode, channelConfig)
    case "youtube":
      return distributeToYouTube(episode, channelConfig)
    case "rss":
      return distributeToRSS(episode, channelConfig)
    default:
      return distributeGeneric(episode, channelName, channelConfig)
  }
}

// Spotify distribution (stub — integrate with Spotify for Podcasters API)
async function distributeToSpotify(
  episode: any,
  channelConfig: any
): Promise<{ externalEpisodeId: string; providerResponse: Record<string, any> }> {
  // In production: POST to Spotify for Podcasters API
  const externalShowId = channelConfig.external_show_id

  if (!externalShowId) {
    throw new Error("Spotify show ID not configured")
  }

  // Simulate API call
  await new Promise(resolve => setTimeout(resolve, 100))

  return {
    externalEpisodeId: `spotify_${episode.id}_${Date.now()}`,
    providerResponse: {
      status: "success",
      platform: "spotify",
      show_id: externalShowId,
      timestamp: new Date().toISOString(),
    },
  }
}

// Apple Podcasts distribution (stub — integrate with Apple Podcasts Connect API)
async function distributeToApple(
  episode: any,
  channelConfig: any
): Promise<{ externalEpisodeId: string; providerResponse: Record<string, any> }> {
  const externalShowId = channelConfig.external_show_id

  if (!externalShowId) {
    throw new Error("Apple Podcasts show ID not configured")
  }

  // Simulate API call
  await new Promise(resolve => setTimeout(resolve, 100))

  return {
    externalEpisodeId: `apple_${episode.id}_${Date.now()}`,
    providerResponse: {
      status: "success",
      platform: "apple",
      show_id: externalShowId,
      timestamp: new Date().toISOString(),
    },
  }
}

// YouTube distribution (stub — integrate with YouTube Data API)
async function distributeToYouTube(
  episode: any,
  channelConfig: any
): Promise<{ externalEpisodeId: string; providerResponse: Record<string, any> }> {
  const channelId = channelConfig.external_show_id

  if (!channelId) {
    throw new Error("YouTube channel ID not configured")
  }

  // Simulate API call
  await new Promise(resolve => setTimeout(resolve, 100))

  return {
    externalEpisodeId: `youtube_${episode.id}_${Date.now()}`,
    providerResponse: {
      status: "success",
      platform: "youtube",
      channel_id: channelId,
      timestamp: new Date().toISOString(),
    },
  }
}

// RSS feed distribution (updates the RSS feed file)
async function distributeToRSS(
  episode: any,
  channelConfig: any
): Promise<{ externalEpisodeId: string; providerResponse: Record<string, any> }> {
  // In production: Update RSS feed XML stored in Vercel Blob or S3
  await new Promise(resolve => setTimeout(resolve, 50))

  return {
    externalEpisodeId: `rss_${episode.id}_${Date.now()}`,
    providerResponse: {
      status: "success",
      platform: "rss",
      feed_updated: true,
      timestamp: new Date().toISOString(),
    },
  }
}

// Generic distribution handler for custom channels
async function distributeGeneric(
  episode: any,
  channelName: string,
  channelConfig: any
): Promise<{ externalEpisodeId: string; providerResponse: Record<string, any> }> {
  // Generic webhook distribution
  const webhookUrl = channelConfig.distribution_config?.webhook_url

  if (webhookUrl) {
    // POST to webhook
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        episode_id: episode.id,
        title: episode.title,
        description: episode.description,
        audio_url: episode.audio_url,
        duration_seconds: episode.duration_seconds,
      }),
    })

    if (!response.ok) {
      throw new Error(`Webhook failed: ${response.status}`)
    }
  }

  return {
    externalEpisodeId: `${channelName}_${episode.id}_${Date.now()}`,
    providerResponse: {
      status: "success",
      platform: channelName,
      timestamp: new Date().toISOString(),
    },
  }
}
