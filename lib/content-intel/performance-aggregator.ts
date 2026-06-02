/**
 * lib/content-intel/performance-aggregator.ts
 *
 * Closes the loop on the content intelligence layer.
 *
 * Every time a topic seeds a generated asset (podcast script, newsletter
 * video, marketing plan item), the producer calls logTopicUses(). The daily
 * aggregator cron walks recent uses, looks up downstream engagement signals
 * for each asset (newsletter open/click rates, social_posts engagement,
 * podcast_episodes plays), and computes a rolling performance_score for
 * each topic — capped at 0..30 so the bonus is meaningful but never
 * dominates the base engagement_score (which is 0..100).
 *
 * The picker (pickTopics) adds performance_score to the adjusted_score so
 * winning topics compound (next pick scores them higher) and flops decay
 * (their performance_score drops back to 0 over time).
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export type AssetType =
  | "podcast_episode"
  | "newsletter_video"
  | "newsletter_campaign"
  | "social_post"
  | "blog_post"
  | "marketing_plan_item"

/**
 * Log that a topic was used to seed an asset. The producer calls this
 * AFTER the asset is created so asset_id is available.
 */
export async function logTopicUses(args: {
  topicIds:     string[]
  brokerageId:  string
  assetType:    AssetType
  assetId?:     string | null
}): Promise<void> {
  if (args.topicIds.length === 0) return
  const svc = createServiceClient()
  const rows = args.topicIds.map((topic_id) => ({
    topic_id,
    brokerage_id: args.brokerageId,
    asset_type:   args.assetType,
    asset_id:     args.assetId ?? null,
  }))
  try {
    await svc.from("content_topic_uses").insert(rows)
  } catch (e) {
    // Logged-then-swallowed: the producer doesn't fail because audit
    // hiccuped, but the team sees the degradation in logs.
    console.error("[performance-aggregator] logTopicUses insert failed:", (e as Error).message)
  }
}

/**
 * Aggregator — called by the daily cron. For each topic that's been used
 * in the last 30 days, computes a 0..30 score based on the engagement
 * signals from the assets it seeded. Writes back to
 * content_topic_bank.performance_score.
 *
 * Scoring heuristic (per topic):
 *   newsletter open rate  → up to 8 points
 *   newsletter click rate → up to 8 points
 *   social_posts likes+comments+shares (log-compressed) → up to 8 points
 *   podcast play_count (when wired) → up to 6 points
 * Total capped at 30.
 *
 * Pre-fetches all signal data in ~5 batch queries instead of running
 * nested per-asset round-trips inside the per-topic loop (fix from the
 * code-review N+1 finding).
 */
export async function aggregatePerformance(): Promise<{ topics_updated: number }> {
  const svc = createServiceClient()
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()

  const { data: uses } = await svc
    .from("content_topic_uses")
    .select("topic_id, asset_type, asset_id")
    .gte("used_at", since)
    .limit(5000)

  if (!uses || uses.length === 0) return { topics_updated: 0 }

  // Group by topic for the scorer; also collect the union of asset IDs per
  // type so we can pre-fetch all signal data in ~5 batch queries (instead
  // of per-asset queries inside the per-topic loop).
  const topicToAssets = new Map<string, Array<{ asset_type: AssetType; asset_id: string | null }>>()
  const newsletterCampaignAssetIds = new Set<string>()
  const newsletterVideoAssetIds    = new Set<string>()
  const socialPostAssetIds         = new Set<string>()
  const podcastEpisodeAssetIds     = new Set<string>()

  for (const u of uses as Array<{ topic_id: string; asset_type: AssetType; asset_id: string | null }>) {
    const list = topicToAssets.get(u.topic_id) ?? []
    list.push({ asset_type: u.asset_type, asset_id: u.asset_id })
    topicToAssets.set(u.topic_id, list)
    if (!u.asset_id) continue
    if (u.asset_type === "newsletter_campaign") newsletterCampaignAssetIds.add(u.asset_id)
    if (u.asset_type === "newsletter_video")    newsletterVideoAssetIds.add(u.asset_id)
    if (u.asset_type === "social_post")         socialPostAssetIds.add(u.asset_id)
    if (u.asset_type === "podcast_episode")     podcastEpisodeAssetIds.add(u.asset_id)
  }

  // Batch-resolve newsletter_video ledger rows → their campaign IDs in
  // ONE query, then merge with the direct newsletter_campaign asset IDs.
  let videoLedgerToCampaign = new Map<string, string>()
  if (newsletterVideoAssetIds.size > 0) {
    try {
      const { data: ledgers } = await svc.from("newsletter_video_renders")
        .select("id, newsletter_campaign_id")
        .in("id", Array.from(newsletterVideoAssetIds))
      for (const r of (ledgers ?? []) as Array<{ id: string; newsletter_campaign_id: string | null }>) {
        if (r.newsletter_campaign_id) videoLedgerToCampaign.set(r.id, r.newsletter_campaign_id)
      }
    } catch (e) {
      console.error("[performance-aggregator] newsletter_video_renders batch lookup failed:", (e as Error).message)
    }
  }

  // Pre-fetch newsletter_campaigns open/click rates for every campaign
  // we'll need (both direct asset references AND those resolved through
  // the video ledger).
  const allCampaignIds = new Set<string>([
    ...newsletterCampaignAssetIds,
    ...videoLedgerToCampaign.values(),
  ])
  const campaignRates = new Map<string, { open_rate: number; click_rate: number }>()
  if (allCampaignIds.size > 0) {
    try {
      const { data } = await svc.from("newsletter_campaigns")
        .select("id, open_rate, click_rate")
        .in("id", Array.from(allCampaignIds))
      for (const r of (data ?? []) as Array<{ id: string; open_rate: number | null; click_rate: number | null }>) {
        campaignRates.set(r.id, { open_rate: r.open_rate ?? 0, click_rate: r.click_rate ?? 0 })
      }
    } catch (e) {
      console.error("[performance-aggregator] newsletter_campaigns batch lookup failed:", (e as Error).message)
    }
  }

  // Pre-fetch social_posts engagement.
  const socialEngagement = new Map<string, number>()
  if (socialPostAssetIds.size > 0) {
    try {
      const { data } = await svc.from("social_posts")
        .select("id, likes_count, comments_count, shares_count")
        .in("id", Array.from(socialPostAssetIds))
      for (const r of (data ?? []) as Array<{ id: string; likes_count?: number | null; comments_count?: number | null; shares_count?: number | null }>) {
        socialEngagement.set(r.id, (r.likes_count ?? 0) + (r.comments_count ?? 0) + (r.shares_count ?? 0))
      }
    } catch (e) {
      console.error("[performance-aggregator] social_posts batch lookup failed:", (e as Error).message)
    }
  }

  // Pre-fetch podcast plays.
  const podcastPlays = new Map<string, number>()
  if (podcastEpisodeAssetIds.size > 0) {
    try {
      const { data } = await svc.from("podcast_episodes")
        .select("id, play_count")
        .in("id", Array.from(podcastEpisodeAssetIds))
      for (const r of (data ?? []) as Array<{ id: string; play_count?: number | null }>) {
        podcastPlays.set(r.id, r.play_count ?? 0)
      }
    } catch (e) {
      console.error("[performance-aggregator] podcast_episodes batch lookup failed:", (e as Error).message)
    }
  }

  // Now score every topic — pure-data lookups against the pre-fetched maps.
  let updated = 0
  for (const [topicId, assets] of topicToAssets) {
    const score = scoreTopicFromMaps(assets, {
      campaignRates,
      videoLedgerToCampaign,
      socialEngagement,
      podcastPlays,
    })
    try {
      await svc.from("content_topic_bank")
        .update({ performance_score: Math.max(0, Math.min(30, Math.round(score))) })
        .eq("id", topicId)
      updated++
    } catch (e) {
      console.error(`[performance-aggregator] update score failed for topic ${topicId}:`, (e as Error).message)
    }
  }
  return { topics_updated: updated }
}

function scoreTopicFromMaps(
  assets: Array<{ asset_type: AssetType; asset_id: string | null }>,
  maps: {
    campaignRates:          Map<string, { open_rate: number; click_rate: number }>
    videoLedgerToCampaign:  Map<string, string>
    socialEngagement:       Map<string, number>
    podcastPlays:           Map<string, number>
  },
): number {
  let score = 0

  // Newsletter signals — both direct campaign asset refs AND newsletter_video
  // ledger refs that resolve to a campaign.
  const campaignRatesForTopic: Array<{ open_rate: number; click_rate: number }> = []
  for (const a of assets) {
    if (!a.asset_id) continue
    if (a.asset_type === "newsletter_campaign") {
      const r = maps.campaignRates.get(a.asset_id)
      if (r) campaignRatesForTopic.push(r)
    } else if (a.asset_type === "newsletter_video") {
      const campaignId = maps.videoLedgerToCampaign.get(a.asset_id)
      if (campaignId) {
        const r = maps.campaignRates.get(campaignId)
        if (r) campaignRatesForTopic.push(r)
      }
    }
  }
  if (campaignRatesForTopic.length > 0) {
    const avgOpen  = avg(campaignRatesForTopic.map((r) => r.open_rate))
    const avgClick = avg(campaignRatesForTopic.map((r) => r.click_rate))
    score += Math.min(8, (avgOpen  / 0.35) * 8)
    score += Math.min(8, (avgClick / 0.06) * 8)
  }

  // Social signals — sum across all this topic's social_post asset IDs.
  const socialIds = assets.filter((a) => a.asset_type === "social_post" && a.asset_id).map((a) => a.asset_id as string)
  if (socialIds.length > 0) {
    const total = socialIds.reduce((s, id) => s + (maps.socialEngagement.get(id) ?? 0), 0)
    score += Math.min(8, 8 * Math.log10(total + 1) / 3)
  }

  // Podcast signals.
  const podcastIds = assets.filter((a) => a.asset_type === "podcast_episode" && a.asset_id).map((a) => a.asset_id as string)
  if (podcastIds.length > 0) {
    const total = podcastIds.reduce((s, id) => s + (maps.podcastPlays.get(id) ?? 0), 0)
    score += Math.min(6, 6 * Math.log10(total + 1) / 3)
  }

  return score
}

function avg(nums: number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length
}
