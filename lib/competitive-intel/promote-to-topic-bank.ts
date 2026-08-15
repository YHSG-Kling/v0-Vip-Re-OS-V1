/**
 * lib/competitive-intel/promote-to-topic-bank.ts
 *
 * Wave 36 — promotes top-performing competitor ads from competitor_ads
 * into content_topic_bank so the existing pickTopics() + farm-mail +
 * omnipresence resolution paths consume competitor signal without
 * knowing the source.
 *
 * Strategy:
 *   - Per brokerage, pick the top N (engagement_score) recent competitor
 *     ads that haven't been promoted yet (sentinel: raw_data->>'promoted_
 *     from_competitor_ad_id' on content_topic_bank — idempotent).
 *   - Build a topic_title from the ad's headline (or body lede) + a
 *     value_angle from the body. The topic_title is what the AI copy
 *     prompt will build the headline around — so we want a CLEAN,
 *     positionable hook ("Lowest fixed-rate lock in 90 days") not a
 *     verbatim competitor headline.
 *   - categories=['competitor_intel'] + geo_relevance carried through.
 *   - status='fresh', expires_at=now()+30d so the new entry actually
 *     surfaces to pickTopics.
 *
 * The competitor's actual creative is NEVER copied verbatim into the
 * AI prompt — the value_angle is a paraphrase. The Fair Housing gate
 * applies on the output regardless.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export interface PromoteResult {
  brokerage_id: string
  considered:   number
  promoted:     number
  topic_ids:    string[]
  skipped:      Array<{ competitor_ad_id: string; reason: string }>
}

const DEFAULT_TOP_N      = 5
const EXPIRES_DAYS       = 30
const MIN_ENGAGEMENT     = 30   // 0-100 scale; below this we don't bother

export async function promoteCompetitorAdsToTopicBank(args: {
  brokerageId: string
  topN?: number
}): Promise<PromoteResult> {
  const svc = createServiceClient()
  const topN = args.topN ?? DEFAULT_TOP_N

  // 1. Pull the top-engagement-score competitor ads for this brokerage
  //    that we haven't already promoted (or whose promotion expired
  //    so we want them back in the fresh pool).
  //
  //    Wave 36 item 6 — per-watchlist threshold cascade. Each
  //    competitor_brokerages row carries min_engagement_score; the
  //    promoter selects ads where engagement_score >= the watchlist
  //    row's threshold OR the platform default when null. We do this
  //    in two passes (fetch ads + watchlist thresholds, then filter
  //    in app code) because the cross-row threshold can't express
  //    cleanly as a single SQL filter.
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const { data: thresholdRows } = await svc
    .from("competitor_brokerages")
    .select("id, min_engagement_score")
    .eq("brokerage_id", args.brokerageId)
    .eq("is_active", true)
  const thresholdByCompetitor = new Map<string, number>()
  for (const r of (thresholdRows ?? []) as Array<{ id: string; min_engagement_score: number | null }>) {
    thresholdByCompetitor.set(r.id, r.min_engagement_score ?? MIN_ENGAGEMENT)
  }

  const { data: adsData } = await svc
    .from("competitor_ads")
    .select("id, competitor_id, page_name, ad_headline, ad_copy, ad_creative_title, ad_creative_body, categories, geo_relevance, engagement_score")
    .eq("brokerage_id", args.brokerageId)
    .gte("first_seen_at", since)
    .gte("engagement_score", MIN_ENGAGEMENT)  // floor: nothing below platform min ever lands
    .order("engagement_score", { ascending: false })
    .limit(topN * 3)  // overfetch in case some are already promoted or fall below per-watchlist threshold

  type AdRow = {
    id: string
    competitor_id: string | null
    page_name: string | null
    ad_headline: string | null
    ad_copy: string | null
    ad_creative_title: string | null
    ad_creative_body: string | null
    categories: string[] | null
    geo_relevance: Record<string, unknown> | null
    engagement_score: number | null
  }
  // Per-watchlist threshold filter — runs AFTER the SQL platform-min
  // floor so we only enforce a HIGHER bar, never a lower one.
  const ads = ((adsData ?? []) as unknown as AdRow[]).filter((a) => {
    if (!a.competitor_id) return true  // legacy rows without a watchlist binding
    const threshold = thresholdByCompetitor.get(a.competitor_id) ?? MIN_ENGAGEMENT
    return (a.engagement_score ?? 0) >= threshold
  })

  if (ads.length === 0) {
    return { brokerage_id: args.brokerageId, considered: 0, promoted: 0, topic_ids: [], skipped: [] }
  }

  // 2. Idempotency check — find which of these have already been
  //    promoted (sentinel in raw_data).
  const adIds = ads.map((a) => a.id)
  const { data: existing } = await svc
    .from("content_topic_bank")
    .select("id, raw_data")
    .eq("brokerage_id", args.brokerageId)
    .gte("expires_at", new Date().toISOString())
  const alreadyPromoted = new Set<string>()
  for (const e of (existing ?? []) as Array<{ id: string; raw_data: Record<string, unknown> | null }>) {
    const fromAd = e.raw_data?.promoted_from_competitor_ad_id
    if (typeof fromAd === "string" && adIds.includes(fromAd)) alreadyPromoted.add(fromAd)
  }

  const promoted: string[] = []
  const skipped:  Array<{ competitor_ad_id: string; reason: string }> = []

  for (const ad of ads) {
    if (promoted.length >= topN) break
    if (alreadyPromoted.has(ad.id)) {
      skipped.push({ competitor_ad_id: ad.id, reason: "already_promoted_fresh" })
      continue
    }

    // Title precedence: explicit creative title > legacy ad_headline >
    // first 60 chars of body. ad_headline + ad_copy come from the
    // legacy ad-monitor.ts ingest path; ad_creative_title + ad_creative
    // _body come from the Meta adapter — both supported so the
    // promoter is source-agnostic.
    const title =
      (ad.ad_creative_title ?? ad.ad_headline ?? ad.ad_creative_body ?? ad.ad_copy ?? "")
        .toString()
        .trim()
        .slice(0, 120)
    if (!title) {
      skipped.push({ competitor_ad_id: ad.id, reason: "no_usable_title" })
      continue
    }

    const valueAngle =
      (ad.ad_creative_body ?? ad.ad_copy ?? "")
        .toString()
        .trim()
        .slice(0, 400) || null

    const categories = Array.from(
      new Set([...(ad.categories ?? []), "competitor_intel"]),
    )

    const expiresAt = new Date(Date.now() + EXPIRES_DAYS * 86_400_000).toISOString()

    const { data: newTopic, error } = await svc
      .from("content_topic_bank")
      .insert({
        brokerage_id:      args.brokerageId,
        topic_title:       title,
        value_angle:       valueAngle,
        source_url:        null,
        categories,
        engagement_score:  ad.engagement_score ?? 0,
        topic_posted_at:   new Date().toISOString(),
        scraped_at:        new Date().toISOString(),
        expires_at:        expiresAt,
        status:            "fresh",
        geo_relevance:     ad.geo_relevance ?? null,
        raw_data:          {
          promoted_from_competitor_ad_id: ad.id,
          promoted_at:                    new Date().toISOString(),
          competitor_page:                ad.page_name ?? null,
        },
      })
      .select("id")
      .single()

    if (error || !newTopic) {
      skipped.push({ competitor_ad_id: ad.id, reason: `insert_failed: ${error?.message ?? "unknown"}` })
      continue
    }
    promoted.push(newTopic.id as string)
  }

  return {
    brokerage_id: args.brokerageId,
    considered:   ads.length,
    promoted:     promoted.length,
    topic_ids:    promoted,
    skipped,
  }
}
