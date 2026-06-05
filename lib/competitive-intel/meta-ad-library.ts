/**
 * lib/competitive-intel/meta-ad-library.ts
 *
 * Wave 36 — Meta Ad Library API adapter. Pulls active + recently-
 * delivered ads for a specific Facebook page id (the competitor's
 * Page). Free + public; requires an app access token of the form
 * `APP_ID|APP_SECRET` in META_APP_ID / META_APP_SECRET env vars.
 *
 * Docs:
 *   https://www.facebook.com/ads/library/api
 *   Endpoint: GET https://graph.facebook.com/v18.0/ads_archive
 *
 * Routes through callConnector (single egress) so every external call
 * is captured in the connector audit log, same as every other adapter.
 *
 * The adapter returns a NORMALIZED shape; the caller upserts into
 * competitor_ads through lib/ads/ad-monitor.ts (so the existing kernel
 * feature gate + COMPETITOR_CONTENT_ALERTED event semantics still
 * fire).
 */
import "server-only"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

export interface MetaAdRecord {
  provider_ad_id:      string
  page_name:           string | null
  ad_creative_title:   string | null
  ad_creative_body:    string | null
  ad_landing_url:      string | null
  ad_delivery_start:   string | null
  ad_delivery_stop:    string | null
  impressions_lower:   number | null
  impressions_upper:   number | null
  spend_lower_cents:   number | null
  spend_upper_cents:   number | null
  /** ISO-3166 region codes (state abbreviations for US). */
  delivery_regions:    string[]
  raw_payload:         Record<string, unknown>
  /** Normalized 0-100. */
  engagement_score:    number
}

interface MetaAdsArchiveItem {
  id:                                    string
  page_id?:                              string
  page_name?:                            string
  ad_creative_link_title?:               string
  ad_creative_link_caption?:             string
  ad_creative_link_description?:         string
  ad_creative_body?:                     string
  ad_creative_bodies?:                   string[]
  ad_snapshot_url?:                      string
  ad_delivery_start_time?:               string
  ad_delivery_stop_time?:                string
  impressions?:                          { lower_bound?: string; upper_bound?: string }
  spend?:                                { lower_bound?: string; upper_bound?: string }
  delivery_by_region?:                   Array<{ region: string; percentage?: string }>
  publisher_platforms?:                  string[]
}

interface MetaAdsArchiveResponse {
  data?:    MetaAdsArchiveItem[]
  paging?:  { next?: string }
  error?:   { message: string }
}

function scoreAd(item: MetaAdsArchiveItem): number {
  // Heuristic 0-100: long-running ads with high impression lower-bound
  // are higher-confidence ROI signals than week-old ads with low reach.
  let score = 0
  const impLower = Number(item.impressions?.lower_bound ?? 0)
  if (impLower > 0) {
    // Cap log(impressions) so a single mega-spend ad doesn't dominate
    // every other signal. log10(1M) = 6 → multiplied by 8 = 48.
    score += Math.min(60, Math.round(8 * Math.log10(impLower + 1)))
  }
  if (item.ad_delivery_start_time) {
    const days = Math.max(
      1,
      Math.floor((Date.now() - new Date(item.ad_delivery_start_time).getTime()) / 86_400_000),
    )
    // Capped: a 30-day-old ad is the sweet spot (long enough to prove
    // ROI, recent enough to still be relevant).
    score += Math.min(40, Math.floor(days / 0.75))
  }
  return Math.min(100, score)
}

/**
 * Fetch ads from Meta's public Ad Library for one or more page ids.
 *
 * Without META_APP_ID + META_APP_SECRET this returns an empty array
 * — the adapter is a no-op rather than a hard error so the cron
 * continues cleanly when the env isn't configured (the brokerage's
 * watchlist row stays valid for the day META credentials land).
 */
export async function fetchAdsForCompetitor(args: {
  facebookPageId: string
  /** Window in days the API looks back. Meta default is 7; we widen
   *  to 30 to capture longer-running ads which are higher ROI signal. */
  windowDays?:    number
  /** Page size. Meta caps around 100. */
  limit?:         number
}): Promise<MetaAdRecord[]> {
  const appId     = process.env.META_APP_ID
  const appSecret = process.env.META_APP_SECRET
  if (!appId || !appSecret) return []  // adapter is no-op without creds

  const accessToken = `${appId}|${appSecret}`
  const windowDays  = args.windowDays ?? 30
  const limit       = Math.min(args.limit ?? 50, 100)

  const res = await callConnector<MetaAdsArchiveResponse>({
    connector: "meta_ad_library",
    baseUrl:   "https://graph.facebook.com",
    path:      "v18.0/ads_archive",
    method:    "GET",
    auth:      { style: "none" },
    query: {
      access_token:           accessToken,
      search_page_ids:        args.facebookPageId,
      ad_reached_countries:   "['US']",
      ad_active_status:       "ALL",
      ad_delivery_date_min:   new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10),
      // Fields Meta supports for ads_archive — request the ones we
      // store + score. Full field list at the docs URL above.
      fields: [
        "id", "page_id", "page_name",
        "ad_creative_link_title", "ad_creative_link_caption", "ad_creative_link_description",
        "ad_creative_body", "ad_creative_bodies",
        "ad_snapshot_url",
        "ad_delivery_start_time", "ad_delivery_stop_time",
        "impressions", "spend",
        "delivery_by_region", "publisher_platforms",
      ].join(","),
      limit: String(limit),
    },
    responseType: "json",
    timeoutMs:    30_000,
  })

  if (!res.ok || !res.data || res.data.error) return []
  const items = res.data.data ?? []
  const out: MetaAdRecord[] = []
  for (const item of items) {
    const body = item.ad_creative_body
      ?? (item.ad_creative_bodies && item.ad_creative_bodies.length > 0 ? item.ad_creative_bodies[0] : null)
      ?? item.ad_creative_link_description
      ?? null
    const impLower = item.impressions?.lower_bound ? Number(item.impressions.lower_bound) : null
    const impUpper = item.impressions?.upper_bound ? Number(item.impressions.upper_bound) : null
    // Meta returns spend in WHOLE DOLLARS via the lower/upper bound
    // strings — convert to cents for canonical storage.
    const spendLowerCents = item.spend?.lower_bound ? Math.round(Number(item.spend.lower_bound) * 100) : null
    const spendUpperCents = item.spend?.upper_bound ? Math.round(Number(item.spend.upper_bound) * 100) : null

    out.push({
      provider_ad_id:    item.id,
      page_name:         item.page_name ?? null,
      ad_creative_title: item.ad_creative_link_title ?? null,
      ad_creative_body:  body,
      ad_landing_url:    item.ad_snapshot_url ?? null,
      ad_delivery_start: item.ad_delivery_start_time ?? null,
      ad_delivery_stop:  item.ad_delivery_stop_time ?? null,
      impressions_lower: impLower,
      impressions_upper: impUpper,
      spend_lower_cents: spendLowerCents,
      spend_upper_cents: spendUpperCents,
      delivery_regions:  (item.delivery_by_region ?? []).map((d) => d.region),
      raw_payload:       item as unknown as Record<string, unknown>,
      engagement_score:  scoreAd(item),
    })
  }
  return out
}
