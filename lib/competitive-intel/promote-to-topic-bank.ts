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
 *
 * WAVE 145 (lane 145G, owner ruling 22 — "extract themes, never copy creative"): the header above said
 * paraphrase, but the code filed the rival's headline as topic_title and their ad copy as value_angle,
 * VERBATIM. The row now carries the THEME only — competitorAdTheme (lib/content-intel/topic-themes.ts),
 * the same theme vocabulary every other intelligence source files under — and an ad whose theme is an
 * excluded topic (crime, school rank, demographics) or matches no theme is skipped, said, never guessed.
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { competitorAdTheme } from "@/lib/content-intel/topic-themes"
import { intakeTopicIdeas, classifyTopicExclusion, type TopicIdea } from "@/lib/content-intel/topic-intake"
// WAVE 154 (lane 154C): the direct content_topic_bank insert that lived below is TOMBSTONED — the survivor is THE ONE intake,
// lib/content-intel/topic-intake.ts intakeTopicIdeas (tenant-pinned, exclusion-gated, provenance-merged, counted writes).

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
    .select("id, competitor_id, ad_headline, ad_copy, categories, geo_relevance, engagement_score, raw_payload")
    .eq("brokerage_id", args.brokerageId)
    .gte("first_seen_at", since)
    .gte("engagement_score", MIN_ENGAGEMENT)  // floor: nothing below platform min ever lands
    .order("engagement_score", { ascending: false })
    .limit(topN * 3)  // overfetch in case some are already promoted or fall below per-watchlist threshold

  type AdRow = {
    id: string
    competitor_id: string | null
    ad_headline: string | null
    ad_copy: string | null
    categories: string[] | null
    geo_relevance: Record<string, unknown> | null
    engagement_score: number | null
    raw_payload: Record<string, unknown> | null
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

  // content_topic_bank.source_id is NOT NULL live (m128). This insert carried none, so every
  // promotion was refused by the database and reported as `insert_failed`. It now files under the
  // tenant's own system source row (lib/content-intel/system-topic-source.ts) — provenance kept,
  // and a tenant that switched that row off is not fed.
  const { resolveSystemTopicSource } = await import("@/lib/content-intel/system-topic-source")
  const topicSource = await resolveSystemTopicSource(svc, args.brokerageId, "competitor_promotion")
  if (!topicSource.ok || !topicSource.active) {
    const reason = !topicSource.ok ? `topic_source_unavailable: ${topicSource.error}` : "topic_source_disabled_by_tenant"
    return { brokerage_id: args.brokerageId, considered: ads.length, promoted: 0, topic_ids: [], skipped: ads.map((a) => ({ competitor_ad_id: a.id, reason })) }
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
  const ideas:    Array<{ adId: string; idea: TopicIdea }> = []

  for (const ad of ads) {
    if (promoted.length >= topN) break
    if (alreadyPromoted.has(ad.id)) {
      skipped.push({ competitor_ad_id: ad.id, reason: "already_promoted_fresh" })
      continue
    }

    // THE THEME, NEVER THE CREATIVE (wave 145): the Exa/Meta adapter writes the creative title into
    // ad_headline and the body into ad_copy (the live competitor_ads columns); both are READ to find the
    // theme and neither is written. No theme (or an excluded one) → skipped with the reason.
    if (!(ad.ad_headline ?? ad.ad_copy ?? "").toString().trim()) {
      skipped.push({ competitor_ad_id: ad.id, reason: "no_usable_title" })
      continue
    }
    const theme = competitorAdTheme(ad.ad_headline, ad.ad_copy)
    if (!theme) {
      skipped.push({ competitor_ad_id: ad.id, reason: "no_theme_or_excluded_topic" })
      continue
    }
    const title = theme.title
    const valueAngle = theme.valueAngle

    // THE EXCLUSION GATE (wave 154, R9) on the rival's creative BEFORE promotion: a new-hire / joining announcement, a
    // recruiting pitch, brand self-promotion, a listing brag or an unverified performance claim never enters the pool —
    // whatever its engagement. (The intake runs the gate again on the theme it stores.)
    const gate = classifyTopicExclusion({ title: ad.ad_headline ?? "", text: ad.ad_copy ?? null, sourceKind: "competitor_ad" })
    if (gate.excluded) {
      skipped.push({ competitor_ad_id: ad.id, reason: `excluded:${gate.reason}` })
      continue
    }

    const categories = Array.from(
      new Set([...(ad.categories ?? []), "competitor_intel"]),
    )

    const nowIso = new Date().toISOString()
    // THE ONE INTAKE (wave 154, lane 154C): the theme, never the creative. The ad's own campaign is ONE observation (a re-run
    // is merged, never a second topic); competitor_ads.engagement_score is the SEARCH provider's relevance × recency proxy
    // (lib/competitive-intel/exa-competitor-ads.ts) — kept as proxy evidence in its own unit, never written into the topic's
    // engagement column; conversion / CPA / CTR / impressions / spend stay unknown, and a long-running ad proves nothing.
    ideas.push({ adId: ad.id, idea: {
      sourceKind: "competitor_ad", sourceId: topicSource.id, title, angle: valueAngle, categories,
      geo: (ad.geo_relevance as TopicIdea["geo"]) ?? null, sourceUrl: null, publishedAt: null, observedAt: nowIso,
      expiresAt: new Date(Date.now() + EXPIRES_DAYS * 86_400_000).toISOString(),
      evidence: { kind: typeof ad.engagement_score === "number" ? "proxy" : "unknown", metric: typeof ad.engagement_score === "number" ? "search_relevance_recency" : null, value: ad.engagement_score ?? null, unit: typeof ad.engagement_score === "number" ? "search_relevance_0_100" : null, note: "a search-ranking proxy, not engagement; ad longevity is not evidence of performance" },
      rights: "public_read_reworded",
      dedupKey: `competitor_theme:${theme.themeKeys.slice(0, 2).join("+")}`,
      brief: {
        observation_key: `competitor_ad:${(ad.raw_payload?.collation_id as string | undefined) ?? ad.id}`, transport: "competitor_ads",
        promoted_from_competitor_ad_id: ad.id, promoted_at: nowIso, theme_keys: theme.themeKeys, theme_only: true,
        competitor_page: (ad.raw_payload?.page_name as string | undefined) ?? null,
        topic_concept: title, proof_needed: "independent, sourced facts — a competitor ad proves nothing",
        ad_metrics: { conversion: "unknown", cpa: "unknown", ctr: "unknown", impressions: "unknown", spend: "unknown", longevity_is_not_performance: true },
      },
    } })
    promoted.push(ad.id)
  }

  if (ideas.length) {
    const r = await intakeTopicIdeas(svc, { brokerageId: args.brokerageId, ideas: ideas.map((i) => i.idea) })
    for (const e of r.excluded) skipped.push({ competitor_ad_id: ideas.find((i) => i.idea.title.slice(0, 120) === e.title)?.adId ?? "unknown", reason: `intake_excluded:${e.reason}` })
    if (!r.ok) for (const i of ideas) skipped.push({ competitor_ad_id: i.adId, reason: `intake_refused: ${r.refused ?? r.errors.slice(0, 2).join("; ")}` })
    const ids = [...new Set(r.rows.map((x) => x.id))]
    return { brokerage_id: args.brokerageId, considered: ads.length, promoted: r.ok ? r.inserted + r.merged : r.rows.length, topic_ids: ids, skipped }
  }

  return {
    brokerage_id: args.brokerageId,
    considered:   ads.length,
    promoted:     0,
    topic_ids:    [],
    skipped,
  }
}
