// lib/lead-pipeline/site-visitor-sourcer.ts
//
// SITE VISITOR INTENT — wave 70 behavioral-acquisition lane; made ANONYMOUS-BY-CONSTRUCTION in wave 156 (lane 156F).
//
// Owner ruling (verbatim, 2026-09-17): "make sure we have covered every area of lead
// acquisition and enrichment scraping and behavioral scraping opportunities… If we aren't
// doing this another competitor will."
// Owner ruling (wave 156): "the anonymous visitor sometimes can be identified using a provider, and if you can't do
// it, we don't need to include it." — docs/operations/WAVE156-VISITOR-IDENTITY-DECISION.md: no provider qualifies,
// so the product does not identify anonymous visitors.
//
// THE SIGNAL. The tenant's OWN first-party website traffic — the pixel (app/api/track/pixel) and dwell beacon
// (app/api/track/dwell) write `website_visitors`. A visitor who reads a listing page for two minutes is real
// interest in that PAGE. It is not a person: the session id is a random value the snippet keeps in the visitor's
// browser storage, and it names nobody.
//
// WHAT THIS LANE DID UNTIL WAVE 156, AND WHY IT STOPPED. It normalized each qualifying session into a
// NormalizedScrapedRecord with `username = session_id` for lib/kernel/scraping.ts::ingestRawSourceBatch. The
// producer read that "username" as an identity signal: the row became a raw_scraped_leads row with subject_kind
// `person`, lead_type `buyer` and a source score — a Raw Lead for a browser cookie. It could never become a real
// person except by a guess (an IP / device match), and the product does not guess. The lane now reports an
// ANONYMOUS AGGREGATE (sessions, listing-page sessions, return sessions, campaign-referred sessions, the pages that
// held readers) and hands the RawData producer nothing — `records` is always empty, the same family contract
// lib/lead-pipeline/email-engagement-sourcer.ts keeps since wave 72A.
//
// WHERE A VISITOR DOES BECOME KNOWN: only on a first-party act — a form submit that carries an email / phone the
// tenant already holds (app/api/track/identify/route.ts), a consented capture (lib/lead-intelligence/
// visitor-email-capture.ts), a login, a chat or help request, a lead-magnet form (captureContact). Those sessions
// are read by lib/enrichment/first-party-intent-watcher.ts (fp_site_sessions in lib/intent/movement-source-registry.ts).
//
// TERRITORY: bounded to the calling market's own brokerage — see the cron call site
// (app/api/cron/lead-scraping/route.ts), which runs this ONCE per brokerage.
// Cost: $0 — a read of a table this repo already writes; no vendor call, ever.

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

/** One anonymous page-interest observation: the page and what the visit looked like — never who. */
interface AnonymousPageInterest {
  pageUrl: string
  propertyPage: boolean
  intentSignals: string[]
}

/** PURE — turns one qualifying website_visitors row into an ANONYMOUS page-interest observation: the page (query
 *  string and fragment dropped — a URL can carry what a visitor typed) and the intent signals. It carries no session
 *  id, no referrer and no agent id, and it is never a NormalizedScrapedRecord (wave 156 — see the file header).
 *  Returns null when the row lacks a session or a page (not a qualifying visit).
 *  @proofSeam scripts/scraper-simulator.ts and scripts/wave156-f-visitor-truth-guard.ts exercise the classification
 *  without a DB — called in-file by sourceSiteVisitorIntent, the live entry point the lead-scraping cron calls. */
export function normalizeSiteVisitorRow(v: SiteVisitorIntentRow): AnonymousPageInterest | null {
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

  return { pageUrl: pageWithoutQuery(url), propertyPage, intentSignals }
}

/** The page a reader was on, without its query string or fragment. */
function pageWithoutQuery(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch {
    return url.split(/[?#]/)[0]
  }
}

/** Counts only — no session is listed, so nothing in the result can be followed back to one browser. */
function aggregateSiteVisitorIntent(interests: AnonymousPageInterest[]) {
  const pages = new Map<string, number>()
  let listingPageSessions = 0, returnSessions = 0, campaignReferredSessions = 0
  for (const i of interests) {
    pages.set(i.pageUrl, (pages.get(i.pageUrl) ?? 0) + 1)
    if (i.propertyPage) listingPageSessions++
    if (i.intentSignals.includes('return_visit')) returnSessions++
    if (i.intentSignals.includes('campaign_referred')) campaignReferredSessions++
  }
  return {
    sessions: interests.length,
    listingPageSessions,
    returnSessions,
    campaignReferredSessions,
    topPages: [...pages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([pageUrl, sessions]) => ({ pageUrl, sessions })),
  }
}

interface SiteVisitorSourceResult {
  /** ALWAYS EMPTY (wave 156) — an anonymous session is never handed to the RawData producer. Kept so the cron's
   *  call shape (the family contract email_engagement_intent also keeps) is unchanged. */
  records: NormalizedScrapedRecord[]
  /** Always 0 — first-party data already collected, no vendor call. */
  cost: number
  rowsExamined: number
  /** The anonymous aggregate: counts and the pages that held readers — never a session, never a person. */
  aggregate: ReturnType<typeof aggregateSiteVisitorIntent>
}

/** LIVE: reads website_visitors for ONE brokerage's still-unidentified, high-dwell sessions in the lookback window
 *  and reports them as an ANONYMOUS AGGREGATE. Never writes, never yields a raw record. Fails closed (empty result)
 *  on a refused read — the caller sees rowsExamined stay 0. */
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

  if (error || !data) return { records: [], cost: 0, rowsExamined: 0, aggregate: aggregateSiteVisitorIntent([]) }

  const interests: AnonymousPageInterest[] = []
  for (const row of data as SiteVisitorIntentRow[]) {
    const interest = normalizeSiteVisitorRow(row)
    if (interest) interests.push(interest)
  }

  return { records: [], cost: 0, rowsExamined: data.length, aggregate: aggregateSiteVisitorIntent(interests) }
}
