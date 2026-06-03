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

  // Wave 23 — per-persona attribution. The global score above averages
  // engagement across all subscriber personas; this pass recomputes per
  // (topic, persona) from raw newsletter_sends ⨝ contacts so the picker
  // can rank topics differently when authoring persona-targeted sections.
  // Runs SECOND so the global update has already landed for cron observability.
  await aggregatePersonaPerformance(svc, since)

  return { topics_updated: updated }
}

/**
 * Wave 23 — recompute (topic × persona) performance scores from raw
 * per-recipient newsletter_sends. Joins:
 *   content_topic_uses (topic_id, asset_id=campaign_id)
 *     ⨝ newsletter_sends (campaign_id → contact_id, opened_at, clicked_at)
 *     ⨝ contacts (id → contact_persona)
 * groups by (topic_id, persona), computes open + click rates from the
 * per-recipient outcomes, and upserts content_topic_persona_performance.
 *
 * Score shape mirrors the global score (cap 0..30) so the picker can use
 * either value uniformly. The persona-specific bonus comes from the
 * sample_count gate: persona scores with fewer than MIN_SAMPLES backing
 * are NOT written (returns 'noisy' bucket) — the picker falls back to
 * the global topic score for sparse personas.
 *
 * Only newsletter signals are folded in here. Podcast + social don't
 * attribute per-persona today (no recipient lifecycle), so those stay
 * in the global score only.
 */
async function aggregatePersonaPerformance(
  svc: ReturnType<typeof createServiceClient>,
  since: string,
): Promise<void> {
  // Pull all topic uses against newsletter_campaign assets in the window —
  // the only asset type we can persona-attribute through newsletter_sends.
  const { data: uses } = await svc
    .from("content_topic_uses")
    .select("topic_id, asset_id")
    .eq("asset_type", "newsletter_campaign")
    .gte("used_at", since)
    .not("asset_id", "is", null)
    .limit(5000)
  if (!uses || uses.length === 0) return

  // Map topic → set of campaign IDs that seeded it.
  const topicToCampaigns = new Map<string, Set<string>>()
  const allCampaignIds = new Set<string>()
  for (const u of uses as Array<{ topic_id: string; asset_id: string }>) {
    if (!u.asset_id) continue
    const set = topicToCampaigns.get(u.topic_id) ?? new Set()
    set.add(u.asset_id)
    topicToCampaigns.set(u.topic_id, set)
    allCampaignIds.add(u.asset_id)
  }
  if (allCampaignIds.size === 0) return

  // Pull all per-recipient sends for these campaigns in ONE query, joined
  // to contacts for the persona. The aggregator runs daily — one batch
  // join is fine; the WHERE clause keys on the indexed campaign_id.
  const { data: sends } = await svc
    .from("newsletter_sends")
    .select("campaign_id, contact_id, opened_at, clicked_at, contact:contacts!newsletter_sends_contact_id_fkey(contact_persona)")
    .in("campaign_id", Array.from(allCampaignIds))
    .limit(50000)
  if (!sends || sends.length === 0) return

  // Build (campaign_id × persona) → { sent, opened, clicked } buckets.
  type Bucket = { sent: number; opened: number; clicked: number }
  const campaignPersonaStats = new Map<string, Bucket>()  // key: `${campaign_id}|${persona}`
  for (const row of sends as Array<{
    campaign_id: string
    contact_id: string | null
    opened_at: string | null
    clicked_at: string | null
    contact?: { contact_persona?: string | null } | Array<{ contact_persona?: string | null }> | null
  }>) {
    const cobj = Array.isArray(row.contact) ? row.contact[0] : row.contact
    const persona = (cobj?.contact_persona ?? "").trim()
    if (!persona) continue  // unattributable; falls into the global score only
    const key = `${row.campaign_id}|${persona}`
    const cur = campaignPersonaStats.get(key) ?? { sent: 0, opened: 0, clicked: 0 }
    cur.sent++
    if (row.opened_at)  cur.opened++
    if (row.clicked_at) cur.clicked++
    campaignPersonaStats.set(key, cur)
  }

  // Compose (topic × persona) → aggregated rates by walking each topic's
  // campaign set and summing per persona across those campaigns.
  type TopicPersonaAgg = {
    sent: number
    opened: number
    clicked: number
  }
  const topicPersonaAgg = new Map<string, TopicPersonaAgg>()  // key: `${topic_id}|${persona}`
  const personasPerTopic = new Map<string, Set<string>>()
  for (const [topicId, campaignIds] of topicToCampaigns.entries()) {
    const personasSeen = new Set<string>()
    for (const cid of campaignIds) {
      // Walk every (campaign × persona) bucket whose campaign is in this set
      for (const [key, stats] of campaignPersonaStats.entries()) {
        const [bucketCampaignId, persona] = key.split("|")
        if (bucketCampaignId !== cid) continue
        personasSeen.add(persona)
        const aggKey = `${topicId}|${persona}`
        const cur = topicPersonaAgg.get(aggKey) ?? { sent: 0, opened: 0, clicked: 0 }
        cur.sent    += stats.sent
        cur.opened  += stats.opened
        cur.clicked += stats.clicked
        topicPersonaAgg.set(aggKey, cur)
      }
    }
    personasPerTopic.set(topicId, personasSeen)
  }

  // Score each (topic, persona). Same shape as the global scorer for
  // newsletter signals: open_rate × 8 / 100 + click_rate × 8 / 100, capped
  // at 16 (the newsletter signal headroom). Persona-only — no podcast/social.
  const MIN_SAMPLES = 5  // below this we treat the persona score as noise and skip the write
  const upserts: Array<{
    topic_id: string
    persona: string
    persona_open_rate: number
    persona_click_rate: number
    persona_samples_count: number
    performance_score: number
  }> = []
  for (const [aggKey, agg] of topicPersonaAgg.entries()) {
    if (agg.sent < MIN_SAMPLES) continue
    const [topicId, persona] = aggKey.split("|")
    const openRate  = agg.sent > 0 ? Math.min(100, (agg.opened  / agg.sent) * 100) : 0
    const clickRate = agg.sent > 0 ? Math.min(100, (agg.clicked / agg.sent) * 100) : 0
    const score = Math.round(
      Math.min(16, (openRate / 100) * 8 + (clickRate / 100) * 8)
    )
    upserts.push({
      topic_id: topicId,
      persona,
      persona_open_rate:     Math.round(openRate * 100) / 100,
      persona_click_rate:    Math.round(clickRate * 100) / 100,
      persona_samples_count: agg.sent,
      performance_score:     Math.max(0, Math.min(30, score)),
    })
  }

  if (upserts.length === 0) return

  try {
    // Supabase doesn't batch upsert + onConflict by ARRAY param in one call;
    // chunk in groups of 200 to stay under URL-length + payload limits.
    for (let i = 0; i < upserts.length; i += 200) {
      const chunk = upserts.slice(i, i + 200).map((u) => ({ ...u, computed_at: new Date().toISOString() }))
      await svc.from("content_topic_persona_performance")
        .upsert(chunk, { onConflict: "topic_id,persona" })
    }
  } catch (e) {
    console.error("[performance-aggregator] persona perf upsert failed:", (e as Error).message)
  }
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
