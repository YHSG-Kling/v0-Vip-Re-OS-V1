/**
 * app/api/cron/competitor-ads-meta/route.ts
 *
 * Wave 36 — daily Meta Ad Library ingest. Walks every brokerage's
 * competitor_brokerages watchlist; per row, calls Meta's ads_archive
 * for the configured facebook_page_id, upserts each ad into competitor
 * _ads (the EXISTING table from lib/ads/ad-monitor.ts, extended in
 * m151 with provider_ad_id + engagement_score + impressions/spend
 * ranges + geo_relevance), and triggers the topic-bank promoter for
 * each brokerage.
 *
 * Schedule: 0 11 * * * — daily 11:00 UTC. Runs AFTER the existing
 * Reddit/RSS/Exa/Apify content-intel crons (which fire 06-08 UTC) so
 * the topic bank gets all sources before the marketing-agent weekly
 * cron reads it on Monday morning.
 *
 * Auth: CRON_SECRET dual scheme.
 * No-op when META_APP_ID + META_APP_SECRET aren't configured (the
 * adapter returns an empty array, the cron records "no_credentials"
 * in the per-brokerage outcome, and exits cleanly).
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { fetchAdsForCompetitor } from "@/lib/competitive-intel/meta-ad-library"
import { promoteCompetitorAdsToTopicBank } from "@/lib/competitive-intel/promote-to-topic-bank"

export const dynamic = "force-dynamic"
export const maxDuration = 300

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

export async function GET(req: NextRequest) {
  const auth     = req.headers.get("authorization")?.replace("Bearer ", "")
  const url      = new URL(req.url)
  const qs       = url.searchParams.get("secret")
  const expected = process.env.CRON_SECRET
  if (!expected) return NextResponse.json({ skipped: "CRON_SECRET not configured" })
  if (auth !== expected && qs !== expected) return unauthorized()

  if (!process.env.META_APP_ID || !process.env.META_APP_SECRET) {
    return NextResponse.json({
      ran_at: new Date().toISOString(),
      skipped: "META_APP_ID + META_APP_SECRET not configured",
    })
  }

  const svc = createServiceClient()

  const { data: watchRows } = await svc
    .from("competitor_brokerages")
    .select("id, brokerage_id, competitor_name, facebook_page_id, watch_zip_codes")
    .eq("is_active", true)
    .not("facebook_page_id", "is", null)
    .limit(500)

  const watchlist = (watchRows ?? []) as Array<{
    id: string
    brokerage_id: string
    competitor_name: string
    facebook_page_id: string
    watch_zip_codes: string[] | null
  }>

  const perBrokerage = new Map<string, Array<typeof watchlist[number]>>()
  for (const w of watchlist) {
    const arr = perBrokerage.get(w.brokerage_id) ?? []
    arr.push(w)
    perBrokerage.set(w.brokerage_id, arr)
  }

  const results: Array<{
    brokerage_id:    string
    watchlist_size:  number
    ingested:        number
    upserted_ad_ids: string[]
    promoted:        number
    promoted_topic_ids: string[]
    errors:          string[]
  }> = []

  for (const [brokerageId, competitors] of perBrokerage.entries()) {
    let ingested = 0
    const upsertedAdIds: string[] = []
    const errors: string[] = []

    for (const competitor of competitors) {
      try {
        const ads = await fetchAdsForCompetitor({
          facebookPageId: competitor.facebook_page_id,
          windowDays:     30,
          limit:          50,
        })
        for (const ad of ads) {
          // Geo zips on the AD: when the competitor's watch_zip_codes
          // are set, we tag the ad's geo_relevance with the watch zips
          // (Meta's delivery_by_region is at state level, not zip — the
          // brokerage's watchlist gives us the missing zip granularity).
          const geo = competitor.watch_zip_codes && competitor.watch_zip_codes.length > 0
            ? { zip_codes: competitor.watch_zip_codes, states: ad.delivery_regions }
            : { states: ad.delivery_regions }

          // Upsert by (source_platform, provider_ad_id) — partial unique
          // index from m151. The conflict target uses the unique
          // constraint name.
          const { error } = await svc.from("competitor_ads").upsert({
            brokerage_id:        brokerageId,
            competitor_id:       competitor.id,
            source_platform:     "facebook",
            provider_ad_id:      ad.provider_ad_id,
            competitor_name:     competitor.competitor_name,
            page_name:           ad.page_name,
            ad_headline:         ad.ad_creative_title ?? "",
            ad_copy:             ad.ad_creative_body ?? "",
            ad_creative_title:   ad.ad_creative_title,
            ad_creative_body:    ad.ad_creative_body,
            ad_landing_url:      ad.ad_landing_url,
            ad_delivery_start:   ad.ad_delivery_start,
            ad_delivery_stop:    ad.ad_delivery_stop,
            impressions_lower:   ad.impressions_lower,
            impressions_upper:   ad.impressions_upper,
            spend_lower_cents:   ad.spend_lower_cents,
            spend_upper_cents:   ad.spend_upper_cents,
            geo_relevance:       geo,
            engagement_score:    ad.engagement_score,
            raw_payload:         ad.raw_payload,
            // The existing system sets first_seen_at/last_seen_at on
            // ingest — we set both on initial insert; downstream updates
            // bump last_seen_at via the upsert path.
            last_seen_at:        new Date().toISOString(),
          }, {
            onConflict: "source_platform,provider_ad_id",
          })
          if (error) {
            errors.push(`upsert ${ad.provider_ad_id}: ${error.message}`)
          } else {
            upsertedAdIds.push(ad.provider_ad_id)
            ingested++
          }
        }
      } catch (e) {
        errors.push(`fetch ${competitor.competitor_name}: ${(e as Error).message}`)
      }
    }

    // Promote the top-scoring fresh ads into the topic bank so the
    // existing marketing-agent + farm-mail paths consume the signal.
    const promote = await promoteCompetitorAdsToTopicBank({ brokerageId })

    results.push({
      brokerage_id:       brokerageId,
      watchlist_size:     competitors.length,
      ingested,
      upserted_ad_ids:    upsertedAdIds,
      promoted:           promote.promoted,
      promoted_topic_ids: promote.topic_ids,
      errors,
    })
  }

  return NextResponse.json({
    ran_at:               new Date().toISOString(),
    brokerages_processed: results.length,
    results,
  })
}
