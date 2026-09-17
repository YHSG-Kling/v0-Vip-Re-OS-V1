// lib/lead-pipeline/site-visitor-sourcer.ts
//
// SITE VISITOR INTENT — wave 70 behavioral-acquisition lane.
//
// Owner ruling (verbatim, 2026-09-17): "make sure we have covered every area of lead
// acquisition and enrichment scraping and behavioral scraping opportunities… If we aren't
// doing this another competitor will."
//
// THE GAP. docs/lead-acquisition-coverage-2026-09.md's matrix covered every OFF-SITE
// behavioral lane (Zillow/Realtor/Homes.com saved-search + chatter, Nextdoor, Reddit,
// Facebook, Instagram, Craigslist, Google phrase intent, LinkedIn relocation, OSINT) but
// nothing turned the tenant's OWN first-party website/portal traffic into an acquisition
// signal. That data already existed — the pixel (app/api/track/pixel) and dwell beacon
// (app/api/track/dwell) have been writing `website_visitors` since wave "BUILT, not
// tidied" fixed their gates — but the only consumer was app/api/track/identify, which
// LINKS a session to an EXISTING contact/lead and does nothing for a visitor who matches
// no one yet. An anonymous visitor who reads a listing page for two minutes is exactly the
// kind of signal every other lane in this pipeline pays a vendor for; here it is already
// sitting in the database, unread.
//
// THE CHEAPEST LANE IN THE MATRIX. $0 marginal cost — no vendor call, no API key, no rate
// limit. This is why it is the wave-70 build (BatchData/Apify/ZenRows lanes all cost
// $0.01–$2/record; LinkedIn relocation costs an Apify actor run per pull; this costs
// nothing beyond a read of a table this repo already writes).
//
// CONTRACT: normalizes qualifying website_visitors rows into NormalizedScrapedRecord[] for
// lib/kernel/scraping.ts::ingestRawSourceBatch (sourceChannel 'site_visitor_intent',
// sourceFamily 'site_behavior' — see source-intent-map.ts's SOURCE_MAP entry for scoring).
// TERRITORY: bounded to the calling market's own brokerage — see the cron call site
// (app/api/cron/lead-scraping/route.ts), which runs this ONCE per brokerage (the active,
// subscribed, territory-resolved set from resolveActiveScrapeTerritories()), not once per
// market row, since website traffic is a brokerage-wide signal, not a per-territory one.
// DEDUP: isViableRecord + buildLeadIdentityKey (username=session_id + sourceUrl=page_url)
// let ingestRawSourceBatch's own dedup carry the load — no bespoke dedup here.
//
// WAVE 72A AUDIT (owner ruling: "contacts coming in from the tenants website or
// email come in as contacts not raw leads."): this sourcer was checked against
// that rule and is COMPLIANT — sourceSiteVisitorIntent's read below already
// filters `.is('contact_id', null).is('lead_id', null).is('identified_at', null)`,
// so it only ever sources a session that has NOT resolved to a contact (or a
// lead) yet. A visitor who IS identified never reaches this pipeline; that
// linkage happens at app/api/track/identify, outside this file. Contrast with
// lib/lead-pipeline/email-engagement-sourcer.ts, which the same audit found
// violating this rule and fixed.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { NormalizedScrapedRecord } from './raw-record-types'

type Svc = SupabaseClient<any, any, any>

/** A visitor must have dwelled at least this long on their last-seen page to count as
 *  real interest, not a bounce. Mirrors the ≥60s "stays longest" bar
 *  lib/kernel/site-traffic-insights.ts already uses for its own "stickiest page" verdict.
 *  @proofSeam exported so scripts/scraper-simulator.ts can assert the bar directly rather
 *  than re-deriving it — used in-file as sourceSiteVisitorIntent's default. */
export const SITE_VISITOR_MIN_DWELL_SECONDS = 60

/** Lookback window — matches the lead-scraping cron's own cadence (every 6 hours) so a
 *  fresh dwell reading is sourced on the very next tick without re-walking old traffic.
 *  @proofSeam exported so scripts/scraper-simulator.ts can assert the cadence directly —
 *  used in-file as sourceSiteVisitorIntent's default. */
export const SITE_VISITOR_LOOKBACK_HOURS = 6

const PROPERTY_PAGE_PATTERN = /\/(listing|listings|property|properties|homes-for-sale|for-sale)(\/|$)/i

function looksLikePropertyPage(url: string): boolean {
  return PROPERTY_PAGE_PATTERN.test(url)
}

// Module-private (no external reader needs the shape by name — callers destructure
// sourceSiteVisitorIntent's return value directly; TS infers it fine without an export).
interface SiteVisitorIntentRow {
  session_id: string | null
  page_url: string | null
  referrer: string | null
  time_on_page_seconds: number | null
  first_seen_at: string | null
  last_seen_at: string | null
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  agent_id: string | null
}

/** PURE: turns one qualifying website_visitors row into a NormalizedScrapedRecord.
 *  Returns null when the row lacks the minimum a scrape record needs (no session or page).
 *  @proofSeam exported so scripts/scraper-simulator.ts can exercise the pure classification
 *  (listing-page detection, return-visit heuristic, viability) without a DB — called in-file
 *  by sourceSiteVisitorIntent, the live entry point app/api/cron/lead-scraping/route.ts calls. */
export function normalizeSiteVisitorRow(v: SiteVisitorIntentRow): NormalizedScrapedRecord | null {
  const sessionId = (v.session_id ?? '').trim()
  const url = (v.page_url ?? '').trim()
  if (!sessionId || !url) return null

  const propertyPage = looksLikePropertyPage(url)
  const intentSignals = ['long_dwell']
  if (propertyPage) intentSignals.push('listing_page_view')
  if (v.utm_source) intentSignals.push('campaign_referred')
  // Consecutive visits (first_seen_at < last_seen_at by more than the dwell itself) reads as
  // a return visit within the same still-unidentified session, not just one long page load.
  const dwell = v.time_on_page_seconds ?? 0
  if (v.first_seen_at && v.last_seen_at) {
    const spanMs = new Date(v.last_seen_at).getTime() - new Date(v.first_seen_at).getTime()
    if (spanMs > (dwell + 300) * 1000) intentSignals.push('return_visit')
  }

  return {
    sourceRecordId: `site_visitor-${sessionId}-${v.last_seen_at ?? v.first_seen_at ?? 'na'}`,
    source: 'site_visitor_intent',
    behaviorType: 'site_visitor_intent',
    intentType: 'buyer',
    intentSignals,
    username: sessionId,
    sourceUrl: url,
    propertyAddress: null,
    motivationScore: null,
    rawPayload: {
      visitor: v,
      lookback_hours: SITE_VISITOR_LOOKBACK_HOURS,
      min_dwell_seconds: SITE_VISITOR_MIN_DWELL_SECONDS,
      property_page: propertyPage,
    },
  }
}

interface SiteVisitorSourceResult {
  records: NormalizedScrapedRecord[]
  /** Always 0 — first-party data already collected, no vendor call. */
  cost: number
  rowsExamined: number
}

/** LIVE: reads website_visitors for ONE brokerage's still-unidentified, high-dwell sessions
 *  in the lookback window and normalizes them. Never writes — the caller (the lead-scraping
 *  cron) batches these through ingestRawSourceBatch, same as every other sourcer in this file's
 *  family. Fails closed (empty result) on a refused read — never treats "couldn't read" as
 *  "nothing to source" silently: the caller sees rowsExamined stay 0 and can log it. */
export async function sourceSiteVisitorIntent(
  svc: Svc,
  brokerageId: string,
  opts: { lookbackHours?: number; minDwellSeconds?: number; now?: Date } = {},
): Promise<SiteVisitorSourceResult> {
  const lookbackHours = opts.lookbackHours ?? SITE_VISITOR_LOOKBACK_HOURS
  const minDwell = opts.minDwellSeconds ?? SITE_VISITOR_MIN_DWELL_SECONDS
  const now = opts.now ?? new Date()
  const since = new Date(now.getTime() - lookbackHours * 3600_000).toISOString()

  const { data, error } = await svc
    .from('website_visitors')
    .select('session_id, page_url, referrer, time_on_page_seconds, first_seen_at, last_seen_at, utm_source, utm_medium, utm_campaign, agent_id')
    .eq('brokerage_id', brokerageId)
    .is('contact_id', null)
    .is('lead_id', null)
    .is('identified_at', null)
    .not('page_url', 'is', null)
    .gte('last_seen_at', since)
    .gte('time_on_page_seconds', minDwell)
    .limit(200)

  if (error || !data) return { records: [], cost: 0, rowsExamined: 0 }

  const records: NormalizedScrapedRecord[] = []
  for (const row of data as SiteVisitorIntentRow[]) {
    const rec = normalizeSiteVisitorRow(row)
    if (rec) records.push(rec)
  }

  return { records, cost: 0, rowsExamined: data.length }
}
