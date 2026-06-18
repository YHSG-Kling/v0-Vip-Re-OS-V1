/**
 * app/api/cron/competitor-ads-exa/route.ts
 *
 * Wave 36 — daily Exa-powered competitor ad ingest. Was originally
 * built on the Meta Ad Library API + planned to add Apify for Google
 * Ads Transparency; user correction: Exa neural search covers both
 * public ad library surfaces in one adapter, no per-platform auth
 * setup, no scraping infrastructure.
 *
 * Walks competitor_brokerages watchlist; per row, runs ONE Exa search
 * per platform (facebook.com/ads/library + adstransparency.google.com)
 * with the competitor name + an optional geographic hint, upserts each
 * result into competitor_ads (the EXTENDED table from m151 — same
 * canonical idempotency key (source_platform, provider_ad_id) where
 * provider_ad_id is the Exa-returned URL), then runs the topic-bank
 * promoter for each brokerage.
 *
 * Why Exa's ranking IS the "top performing" filter you asked for:
 * Exa scores by "would a researcher cite this URL" — the cited ads
 * are the long-running, talked-about, indexed ones. We don't need an
 * arbitrary impression threshold; the top N from Exa already biases
 * to durable creative.
 *
 * Schedule: 0 11 * * * — daily 11:00 UTC. Runs after the existing
 * content-intel-* crons so the topic bank has every source before
 * the marketing-agent weekly read on Monday.
 *
 * Auth: CRON_SECRET dual scheme. No-op when EXA_API_KEY is missing.
 */
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { fetchExaCompetitorAds } from "@/lib/competitive-intel/exa-competitor-ads"
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

  if (!process.env.EXA_API_KEY) {
    return NextResponse.json({
      ran_at: new Date().toISOString(),
      skipped: "EXA_API_KEY not configured",
    })
  }

  const svc = createServiceClient()

  const { data: watchRows } = await svc
    .from("competitor_brokerages")
    .select("id, brokerage_id, competitor_name, watch_zip_codes")
    .eq("is_active", true)
    .limit(500)

  const watchlist = (watchRows ?? []) as Array<{
    id: string
    brokerage_id: string
    competitor_name: string
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
        // Geographic hint: use the first watch_zip_code if set; Exa
        // will resolve zips to locale names automatically.
        const geoHint = competitor.watch_zip_codes && competitor.watch_zip_codes.length > 0
          ? competitor.watch_zip_codes[0]
          : undefined

        const ads = await fetchExaCompetitorAds({
          competitorName: competitor.competitor_name,
          geographicHint: geoHint,
          withinDays:     60,
        })

        for (const ad of ads) {
          // Geo zips on the AD: when the competitor's watch_zip_codes
          // are set, tag the geo_relevance with them (Exa's ranking
          // already weighted toward locale-matching results).
          const geo = competitor.watch_zip_codes && competitor.watch_zip_codes.length > 0
            ? { zip_codes: competitor.watch_zip_codes }
            : null

          const { error } = await svc.from("competitor_ads").upsert({
            brokerage_id:        brokerageId,
            competitor_id:       competitor.id,
            source_platform:     ad.source_platform,
            provider_ad_id:      ad.provider_ad_id,
            competitor_name:     competitor.competitor_name,
            // competitor_ads has no ad_creative_title/ad_creative_body/ad_landing_url/
            // page_name columns: title→ad_headline, body→ad_copy (already set above),
            // landing url→landing_page_url, page_name→raw_payload.
            ad_headline:         ad.ad_creative_title ?? "",
            ad_copy:             ad.ad_creative_body ?? "",
            landing_page_url:    ad.ad_landing_url,
            ad_delivery_start:   ad.ad_delivery_start,
            ad_delivery_stop:    ad.ad_delivery_stop,
            geo_relevance:       geo,
            engagement_score:    ad.engagement_score,
            categories:          ad.categories,
            raw_payload:         { ...(ad.raw_payload ?? {}), page_name: ad.page_name },
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

    // Promote the top-scoring fresh ads into the topic bank.
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
