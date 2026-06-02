/**
 * lib/content-intel/performance-aggregator.ts
 *
 * Closes the loop on the content intelligence layer.
 *
 * Every time a topic seeds a generated asset (podcast script, newsletter
 * video, marketing plan item), the producer calls logTopicUse(). The daily
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
  } catch { /* never fail the producer because audit hiccuped */ }
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

  // Group by topic for one DB roundtrip per signal type.
  const topicToAssets = new Map<string, Array<{ asset_type: AssetType; asset_id: string | null }>>()
  for (const u of uses as Array<{ topic_id: string; asset_type: AssetType; asset_id: string | null }>) {
    const list = topicToAssets.get(u.topic_id) ?? []
    list.push({ asset_type: u.asset_type, asset_id: u.asset_id })
    topicToAssets.set(u.topic_id, list)
  }

  let updated = 0
  for (const [topicId, assets] of topicToAssets) {
    const score = await scoreTopic(svc, assets)
    try {
      await svc.from("content_topic_bank")
        .update({ performance_score: Math.max(0, Math.min(30, Math.round(score))) })
        .eq("id", topicId)
      updated++
    } catch { /* per-topic write failure is not fatal */ }
  }
  return { topics_updated: updated }
}

async function scoreTopic(
  svc: ReturnType<typeof createServiceClient>,
  assets: Array<{ asset_type: AssetType; asset_id: string | null }>,
): Promise<number> {
  let score = 0

  // ── Newsletter signals (open rate + click rate from newsletter_campaigns) ──
  const newsletterCampaignIds = assets.filter((a) => a.asset_type === "newsletter_campaign" && a.asset_id).map((a) => a.asset_id as string)
  const newsletterVideoCampaignIds = (await Promise.all(
    assets.filter((a) => a.asset_type === "newsletter_video" && a.asset_id)
      .map(async (a) => {
        const { data } = await svc.from("newsletter_video_renders")
          .select("newsletter_campaign_id")
          .eq("id", a.asset_id as string)
          .maybeSingle()
        return (data as { newsletter_campaign_id?: string } | null)?.newsletter_campaign_id ?? null
      })
  )).filter((id): id is string => id !== null)

  const newsletterIds = Array.from(new Set([...newsletterCampaignIds, ...newsletterVideoCampaignIds]))
  if (newsletterIds.length > 0) {
    const { data } = await svc.from("newsletter_campaigns")
      .select("open_rate, click_rate")
      .in("id", newsletterIds)
    const rows = (data ?? []) as Array<{ open_rate: number | null; click_rate: number | null }>
    if (rows.length > 0) {
      const avgOpen  = avg(rows.map((r) => r.open_rate  ?? 0))
      const avgClick = avg(rows.map((r) => r.click_rate ?? 0))
      // Industry avg open rate for real-estate newsletters ~ 25%; click ~ 3%.
      // Linear maps that grade above-avg performance generously.
      score += Math.min(8, (avgOpen  / 0.35) * 8)
      score += Math.min(8, (avgClick / 0.06) * 8)
    }
  }

  // ── Social signals ──
  const socialIds = assets.filter((a) => a.asset_type === "social_post" && a.asset_id).map((a) => a.asset_id as string)
  if (socialIds.length > 0) {
    try {
      const { data } = await svc.from("social_posts")
        .select("likes_count, comments_count, shares_count")
        .in("id", socialIds)
      const rows = (data ?? []) as Array<{ likes_count?: number | null; comments_count?: number | null; shares_count?: number | null }>
      const totalEngagement = rows.reduce((s, r) =>
        s + (r.likes_count ?? 0) + (r.comments_count ?? 0) + (r.shares_count ?? 0), 0)
      // Log-compressed — 1000 total engagements → 8 points; 100 → 4 points.
      score += Math.min(8, 8 * Math.log10(totalEngagement + 1) / 3)
    } catch { /* optional columns; best-effort */ }
  }

  // ── Podcast signals (when plays are tracked) ──
  const podcastIds = assets.filter((a) => a.asset_type === "podcast_episode" && a.asset_id).map((a) => a.asset_id as string)
  if (podcastIds.length > 0) {
    try {
      const { data } = await svc.from("podcast_episodes")
        .select("play_count")
        .in("id", podcastIds)
      const rows = (data ?? []) as Array<{ play_count?: number | null }>
      const totalPlays = rows.reduce((s, r) => s + (r.play_count ?? 0), 0)
      score += Math.min(6, 6 * Math.log10(totalPlays + 1) / 3)
    } catch { /* play_count may not be wired yet */ }
  }

  return score
}

function avg(nums: number[]): number {
  return nums.length === 0 ? 0 : nums.reduce((a, b) => a + b, 0) / nums.length
}
