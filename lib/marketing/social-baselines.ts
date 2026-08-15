/**
 * lib/marketing/social-baselines.ts
 *
 * Wave 38 — typed read helper over the `social_post_baselines_28d`
 * view (m167). Built specifically to feed the future Wave 40 ad
 * creator: before launching a paid campaign for (platform, post_type),
 * the creator queries this helper for the brokerage's organic
 * baseline so the paid campaign can be A/B'd against a real floor
 * instead of an imagined one.
 *
 * The view is rebuilt on every query (it's a regular view, not a
 * materialized one), so the data is always fresh — no cron needed.
 * Per-query latency is dominated by the 28d window scan on
 * social_media_analytics; existing indexes on (post_id, measured_at)
 * keep it well under 100ms even at 10K+ rows.
 *
 * Compliance note: returns brokerage-scoped data only — the caller
 * MUST provide brokerage_id. There's no global / multi-tenant read
 * path on purpose.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export interface SocialBaseline {
  brokerageId:        string
  platform:           string
  postType:           string
  /** Number of distinct social_posts rows that contributed to this
   *  aggregate over the 28d window. */
  postsMeasured:      number
  totalImpressions:   number
  totalEngagements:   number
  totalClicks:        number
  /** engagements / impressions. null when impressions=0. */
  engagementRate:     number | null
  /** clicks / impressions. null when impressions=0. */
  clickThroughRate:   number | null
  /** Most recent measured_at timestamp in the window. */
  lastMeasuredAt:     string | null
  windowStart:        string | null
}

interface RawBaselineRow {
  brokerage_id:       string
  platform:           string
  post_type:          string
  posts_measured:     number
  total_impressions:  number
  total_engagements:  number
  total_clicks:       number
  engagement_rate:    string | number | null
  click_through_rate: string | number | null
  last_measured_at:   string | null
  window_start:       string | null
}

function rowToBaseline(r: RawBaselineRow): SocialBaseline {
  // Postgres NUMERIC comes back as a string via the postgrest driver.
  const num = (v: string | number | null): number | null => {
    if (v === null) return null
    return typeof v === "string" ? Number(v) : v
  }
  return {
    brokerageId:      r.brokerage_id,
    platform:         r.platform,
    postType:         r.post_type,
    postsMeasured:    r.posts_measured,
    totalImpressions: r.total_impressions,
    totalEngagements: r.total_engagements,
    totalClicks:      r.total_clicks,
    engagementRate:   num(r.engagement_rate),
    clickThroughRate: num(r.click_through_rate),
    lastMeasuredAt:   r.last_measured_at,
    windowStart:      r.window_start,
  }
}

/**
 * Fetch every organic baseline cell for a brokerage. Returns one row
 * per (platform, post_type) combo with non-zero activity in the 28d
 * window. Empty array means the brokerage has no measurable social
 * activity — the W40 ad creator should treat that as "no baseline yet,
 * launch the paid campaign with a conservative budget cap."
 */
export async function listSocialBaselines(brokerageId: string): Promise<SocialBaseline[]> {
  const svc = createServiceClient()
  const { data, error } = await svc
    .from("social_post_baselines_28d")
    .select("brokerage_id, platform, post_type, posts_measured, total_impressions, total_engagements, total_clicks, engagement_rate, click_through_rate, last_measured_at, window_start")
    .eq("brokerage_id", brokerageId)
    .order("total_impressions", { ascending: false })
  if (error) {
    console.error("[social-baselines] view query failed:", error.message)
    return []
  }
  return ((data ?? []) as RawBaselineRow[]).map(rowToBaseline)
}

/**
 * Targeted lookup for a specific (platform, post_type) — the canonical
 * shape W40 will use right before staging an ad. Returns null when no
 * baseline exists (caller treats as "no floor — use default targets").
 */
export async function getSocialBaseline(args: {
  brokerageId: string
  platform:    string
  postType:    string
}): Promise<SocialBaseline | null> {
  const svc = createServiceClient()
  const { data } = await svc
    .from("social_post_baselines_28d")
    .select("brokerage_id, platform, post_type, posts_measured, total_impressions, total_engagements, total_clicks, engagement_rate, click_through_rate, last_measured_at, window_start")
    .eq("brokerage_id", args.brokerageId)
    .eq("platform", args.platform)
    .eq("post_type", args.postType)
    .maybeSingle()
  return data ? rowToBaseline(data as RawBaselineRow) : null
}

/**
 * Convenience: given a candidate paid CTR / engagement rate for a new
 * ad, compute by how much it beats (or trails) the organic floor.
 *
 *   liftRatio = paidRate / organicRate
 *
 * Returned shape lets the W40 launch policy say: "we beat organic by
 * 1.5x → ship at full budget", or "we're only at 0.8x → throttle to
 * 25% budget and re-evaluate".
 */
export function computeOrganicLift(args: {
  baseline:  SocialBaseline | null
  paidRate:  number
  metric:    "engagement_rate" | "click_through_rate"
}): { hasBaseline: boolean; organicRate: number | null; paidRate: number; liftRatio: number | null } {
  if (!args.baseline) {
    return { hasBaseline: false, organicRate: null, paidRate: args.paidRate, liftRatio: null }
  }
  const organicRate = args.metric === "engagement_rate"
    ? args.baseline.engagementRate
    : args.baseline.clickThroughRate
  if (organicRate === null || organicRate === 0) {
    return { hasBaseline: true, organicRate, paidRate: args.paidRate, liftRatio: null }
  }
  return {
    hasBaseline: true,
    organicRate,
    paidRate:    args.paidRate,
    liftRatio:   args.paidRate / organicRate,
  }
}
