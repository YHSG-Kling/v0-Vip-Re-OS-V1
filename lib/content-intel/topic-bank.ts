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
  /** When set + matched against the recipient's location, the picker
   *  applied a +20 score boost (Wave 18 location-aware boost). */
  geo_match:        boolean
}

export interface RecipientLocation {
  city?:     string | null
  state?:    string | null
  zip_code?: string | null
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
  /** Optional recipient location — when supplied, the picker applies a +20
   *  score boost to topics whose geo_relevance jsonb matches. Wave 18
   *  per-recipient localization. */
  recipientLocation?: RecipientLocation | null
  /** Wave 23 — optional persona key. When supplied, the picker prefers the
   *  per-(topic, persona) performance_score from
   *  content_asset_persona_performance (the persona that opened/clicked
   *  this topic's prior assets) over the global performance_score. Falls
   *  back to the global score for topics with no per-persona row OR with
   *  fewer than MIN_SAMPLES backing (suppressed during aggregation).
   *  Passed by the AI section author when authoring persona-targeted
   *  newsletter sections (Wave 20's segmentable audience path). */
  recipientPersona?: string | null
  /** Wave 26 — generalized asset attribution. When `recipientPersona` is
   *  set, the picker reads per-persona scores scoped to THIS asset type
   *  (a topic that scored hard with FTB in newsletter may score
   *  differently for podcast/listing-promo). Defaults to
   *  'newsletter_campaign' so existing callers keep prior behavior. */
  assetType?: string
}): Promise<TopicCandidate[]> {
  const svc   = createServiceClient()
  const limit = Math.min(args.limit ?? 6, 25)

  let q = svc.from("content_topic_bank")
    .select("id, brokerage_id, topic_title, value_angle, source_url, categories, engagement_score, performance_score, topic_posted_at, geo_relevance")
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
    performance_score: number
    topic_posted_at:  string | null
    geo_relevance:    { cities?: string[]; states?: string[]; zip_codes?: string[] } | null
  }>

  // Wave 23 — per-persona performance score lookup. ONE query over the
  // candidate set instead of per-topic round-trips inside the scoring map.
  // Falls back to the global performance_score for topics with no row.
  //
  // Code-review pass 2 — re-check persona_samples_count >= MIN_SAMPLES at
  // READ time (aggregator already gates at WRITE time, but stale rows from
  // prior aggregator runs OR rows whose underlying sample count later
  // shrinks below the floor would otherwise outrank reliable global
  // scores). Keeps the picker's reliability contract independent of
  // aggregator history.
  const MIN_RELIABLE_SAMPLES = 5
  const personaPerfMap = new Map<string, number>()
  if (args.recipientPersona && rows.length > 0) {
    try {
      const { data: personaPerf } = await svc
        .from("content_asset_persona_performance")
        .select("topic_id, performance_score, persona_samples_count")
        .eq("persona", args.recipientPersona)
        .eq("asset_type", args.assetType ?? "newsletter_campaign")
        .gte("persona_samples_count", MIN_RELIABLE_SAMPLES)
        .in("topic_id", rows.map((r) => r.id))
      for (const r of (personaPerf ?? []) as Array<{ topic_id: string; performance_score: number; persona_samples_count: number }>) {
        personaPerfMap.set(r.topic_id, r.performance_score)
      }
    } catch (e) {
      console.error("[topic-bank] persona perf lookup failed:", (e as Error).message)
    }
  }

  const now = Date.now()
  const scored = rows.map((r) => {
    const isLocal = r.brokerage_id !== null
    const ageDays = r.topic_posted_at ? Math.max(0, (now - Date.parse(r.topic_posted_at)) / 86_400_000) : 14
    const localBoost = isLocal ? 15 : 0
    const freshBoost = ageDays <= 7 ? 10 : 0
    const geoMatch   = matchesGeo(r.geo_relevance, args.recipientLocation)
    const geoBoost   = geoMatch ? 20 : 0
    // Wave 19 — performance feedback loop. content_topic_uses → engagement
    // signals → aggregator → performance_score (0..30). Winning topics
    // compound; flops decay.
    // Wave 23 — when a recipient persona is supplied AND we have a
    // per-(topic, persona) score with enough samples (sample-count gate
    // happens at aggregator write-time — missing row = noise = use global),
    // use the persona-specific score instead of the global. Same 0..30
    // scale so the rest of the math is unchanged.
    const perfBoost = (args.recipientPersona && personaPerfMap.has(r.id))
      ? personaPerfMap.get(r.id)!
      : (r.performance_score ?? 0)
    return {
      ...r,
      adjusted_score: r.engagement_score + localBoost + freshBoost + geoBoost + perfBoost,
      is_brokerage_local: isLocal,
      geo_match: geoMatch,
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
    geo_match:          s.geo_match,
  }))
}

/** Does the topic's geo_relevance match the recipient's location?
 *  Geo-tagged topics that DON'T match still pass (returns false here just
 *  to deny the boost) — they're not excluded, just not boosted. The picker
 *  treats geo as a positive lift, not an exclusion filter (a Miami subscriber
 *  is fine receiving a "national rate news" topic; they just get a Miami-
 *  specific one first when available). */
function matchesGeo(
  geo: { cities?: string[]; states?: string[]; zip_codes?: string[] } | null,
  loc: RecipientLocation | null | undefined,
): boolean {
  if (!geo || !loc) return false
  const city  = (loc.city  ?? "").trim().toLowerCase()
  const state = (loc.state ?? "").trim().toUpperCase()
  const zip   = (loc.zip_code ?? "").trim()
  if ((geo.cities ?? []).some((c) => c.trim().toLowerCase() === city && city !== "")) return true
  if ((geo.states ?? []).some((s) => s.trim().toUpperCase() === state && state !== "")) return true
  if ((geo.zip_codes ?? []).some((z) => z.trim() === zip && zip !== "")) return true
  return false
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
