/**
 * lib/content-intel/topic-bank.ts
 *
 * Query interface the autonomous content generators (podcast, newsletter,
 * blog) use to pull value-first topics from content_topic_bank. Returns
 * the freshest, highest-engagement topics for a brokerage, mixing
 * brokerage-specific topics with the platform-wide bank. The generators
 * pass the result into the AI Gateway prompt as the LEAD content; the
 * agent's listings/closings fold in as supporting 20%.
 *
 * Picking strategy:
 *   1. Brokerage-specific topics get a +15 score boost (they have local
 *      relevance the platform-wide bank can't match).
 *   2. Fresh (within 7 days) topics get a +10 boost.
 *   3. Topics in 'used' status are filtered out — we don't repeat last
 *      week's lead. The cron flips 'fresh' → 'used' when the topic seeds
 *      a generated podcast or newsletter video.
 *   4. Category filter is honored when supplied (so a podcast can ask for
 *      'finance,buyer_advice' topics while skipping 'home_improvement').
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export interface TopicCandidate {
  id:               string
  topic_title:      string
  value_angle:      string | null
  source_url:       string | null
  categories:       string[]
  engagement_score: number
  topic_posted_at:  string | null
  is_brokerage_local: boolean
}

export async function pickTopics(args: {
  brokerageId:   string
  /** Filter by at least one of these categories. */
  categoriesAny?: string[]
  /** How many topics to return. The podcast wants 4-6, newsletter 2-3. */
  limit?:        number
  /** When true, automatically flip the returned topics to status='used'
   *  so a concurrent generator picks different topics. */
  markUsed?:     boolean
}): Promise<TopicCandidate[]> {
  const svc   = createServiceClient()
  const limit = Math.min(args.limit ?? 6, 25)

  let q = svc.from("content_topic_bank")
    .select("id, brokerage_id, topic_title, value_angle, source_url, categories, engagement_score, topic_posted_at")
    .eq("status", "fresh")
    .gt("expires_at", new Date().toISOString())
    .or(`brokerage_id.is.null,brokerage_id.eq.${args.brokerageId}`)
    .order("engagement_score", { ascending: false })
    .limit(limit * 4) // overfetch so we can re-score in JS

  if (args.categoriesAny && args.categoriesAny.length > 0) {
    q = q.overlaps("categories", args.categoriesAny)
  }

  const { data } = await q
  const rows = (data ?? []) as Array<{
    id:               string
    brokerage_id:     string | null
    topic_title:      string
    value_angle:      string | null
    source_url:       string | null
    categories:       string[]
    engagement_score: number
    topic_posted_at:  string | null
  }>

  const now = Date.now()
  const scored = rows.map((r) => {
    const isLocal = r.brokerage_id !== null
    const ageDays = r.topic_posted_at ? Math.max(0, (now - Date.parse(r.topic_posted_at)) / 86_400_000) : 14
    const localBoost = isLocal ? 15 : 0
    const freshBoost = ageDays <= 7 ? 10 : 0
    return {
      ...r,
      adjusted_score: r.engagement_score + localBoost + freshBoost,
      is_brokerage_local: isLocal,
    }
  })
  .sort((a, b) => b.adjusted_score - a.adjusted_score)
  .slice(0, limit)

  if (args.markUsed && scored.length > 0) {
    await svc.from("content_topic_bank")
      .update({ status: "used" })
      .in("id", scored.map((s) => s.id))
  }

  return scored.map((s) => ({
    id:                 s.id,
    topic_title:        s.topic_title,
    value_angle:        s.value_angle,
    source_url:         s.source_url,
    categories:         s.categories,
    engagement_score:   s.engagement_score,
    topic_posted_at:    s.topic_posted_at,
    is_brokerage_local: s.is_brokerage_local,
  }))
}

/**
 * Render a topic list for inclusion in an AI Gateway prompt. Each topic is
 * the LEAD value the generator should build around; the agent's listings
 * fold in as supporting context only.
 */
export function renderTopicsForPrompt(topics: TopicCandidate[]): string {
  if (topics.length === 0) {
    return "(no topics in bank — fall back to evergreen real-estate education: closing-cost basics, home-inspection tips, mortgage-rate context)"
  }
  return topics.map((t, i) =>
    `${i + 1}. ${t.topic_title}` +
    (t.value_angle ? `\n   Angle: ${t.value_angle}` : "") +
    (t.categories.length > 0 ? `\n   Tags: ${t.categories.join(", ")}` : "") +
    (t.is_brokerage_local ? `\n   (LOCAL TO THIS BROKERAGE)` : "")
  ).join("\n\n")
}
