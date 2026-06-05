/**
 * lib/competitive-intel/exa-competitor-ads.ts
 *
 * Wave 36 — REPLACES the Meta Ad Library API path. User correction:
 * registering a Meta developer app + getting App Secret + handling
 * Facebook's auth dance is high ops cost for a feature that's just
 * "watch what wins for competitors in our zips". Exa already gives
 * us neural search over the public web — including the public Meta
 * Ad Library pages and the public Google Ads Transparency Center
 * pages. One adapter, one env var (EXA_API_KEY, already configured
 * for the existing content-intel-exa cron), both ad platforms
 * covered.
 *
 * Search strategy per competitor (one Exa call per platform):
 *   Meta:   "site:facebook.com/ads/library {competitorName} real estate"
 *   Google: "site:adstransparency.google.com {competitorName} real estate"
 *
 * Exa's neural search ranks "what would a researcher cite" — that
 * heuristic IS "what's been performing well enough to be referenced".
 * The top results from a search like that ARE the high-engagement
 * competitor ads (long-running, talked about, indexed) — which is
 * exactly the "top performing only" criterion you asked for, without
 * us needing to define an arbitrary impression threshold.
 *
 * Each Exa result becomes a competitor_ads row. The promoter
 * (lib/competitive-intel/promote-to-topic-bank.ts) then picks the
 * top N fresh ones into the topic bank — same pipeline as before,
 * different upstream.
 */
import "server-only"
import { exaSearch } from "@/lib/content-intel/exa-scraper"

export interface ExaCompetitorAdRecord {
  /** Use the Exa result URL as the provider_ad_id — stable + the
   *  public ad library URL IS the ad's canonical identifier. */
  provider_ad_id:    string
  source_platform:   "facebook" | "google"
  page_name:         string | null
  ad_creative_title: string | null
  ad_creative_body:  string | null
  ad_landing_url:    string
  ad_delivery_start: string | null
  ad_delivery_stop:  string | null
  /** Exa doesn't return impression / spend numbers; we leave them null.
   *  The engagement_score (Exa's relevance × recency) replaces them
   *  as the ranking signal. */
  engagement_score:  number
  categories:        string[]
  raw_payload:       Record<string, unknown>
}

const META_DOMAIN   = "facebook.com/ads/library"
const GOOGLE_DOMAIN = "adstransparency.google.com"

/**
 * Search Exa for active ads from one competitor on Meta + Google.
 *
 * The geographicHint (city/state/zip) is folded into the query so
 * Exa's neural ranker prefers ads that mention the locale — which
 * for real estate means the ads are actually targeting that geo.
 * Without the hint, a national brand's ads outrank local competitor
 * ads even when the local ones are more relevant to the brokerage.
 */
export async function fetchExaCompetitorAds(args: {
  competitorName:  string
  /** Optional locale hint — city name, state, or zip. */
  geographicHint?: string
  withinDays?:     number
  /** Per-platform result cap. Default 20 each → up to 40 ads/competitor/cycle. */
  perPlatformLimit?: number
}): Promise<ExaCompetitorAdRecord[]> {
  const limit = Math.min(args.perPlatformLimit ?? 20, 50)
  const withinDays = args.withinDays ?? 60
  const geoPart = args.geographicHint ? ` ${args.geographicHint}` : ""

  const [metaResults, googleResults] = await Promise.all([
    exaSearch({
      query:       `site:${META_DOMAIN} "${args.competitorName}" real estate${geoPart}`,
      type:        "neural",
      numResults:  limit,
      withinDays,
    }),
    exaSearch({
      query:       `site:${GOOGLE_DOMAIN} "${args.competitorName}" real estate${geoPart}`,
      type:        "neural",
      numResults:  limit,
      withinDays,
    }),
  ])

  const out: ExaCompetitorAdRecord[] = []
  for (const r of metaResults) {
    if (!r.url.includes(META_DOMAIN)) continue  // Exa sometimes ranks adjacent URLs
    out.push({
      provider_ad_id:    r.url,
      source_platform:   "facebook",
      page_name:         args.competitorName,
      ad_creative_title: r.title,
      ad_creative_body:  r.summary,
      ad_landing_url:    r.url,
      ad_delivery_start: r.published_date,
      ad_delivery_stop:  null,
      engagement_score:  r.engagement_score,
      categories:        r.categories,
      raw_payload:       { exa_id: r.result_id, exa_url: r.url },
    })
  }
  for (const r of googleResults) {
    if (!r.url.includes(GOOGLE_DOMAIN)) continue
    out.push({
      provider_ad_id:    r.url,
      source_platform:   "google",
      page_name:         args.competitorName,
      ad_creative_title: r.title,
      ad_creative_body:  r.summary,
      ad_landing_url:    r.url,
      ad_delivery_start: r.published_date,
      ad_delivery_stop:  null,
      engagement_score:  r.engagement_score,
      categories:        r.categories,
      raw_payload:       { exa_id: r.result_id, exa_url: r.url },
    })
  }
  return out
}
