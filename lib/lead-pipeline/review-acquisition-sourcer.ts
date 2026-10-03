// lib/lead-pipeline/review-acquisition-sourcer.ts
//
// REVIEW-AS-ACQUISITION — lane 74D, closing docs/lead-acquisition-coverage-2026-09.md item #31
// ("review/reputation chatter (as an ACQUISITION signal, not just reputation response)").
//
// Owner ruling (task brief, 2026-09-18): "review-as-acquisition = people who leave reviews / ask
// questions on the tenant's Google Business / Zillow / Facebook pages (reuse lib/reputation/*
// readers; identified reviewers with real-estate questions → raw lead → pipeline; existing
// contacts → signal)."
//
// ── WHAT THIS IS, AND WHAT IT IS NOT ─────────────────────────────────────────────────────────
// lib/reputation/review-landed.ts::onReviewLanded and lib/kernel/reputation.ts exist for the
// tenant's OWN review COLLECTION — a client leaves a review through this repo's own request flow,
// or the tenant records one manually. That is response/relationship-management, not acquisition.
// This lane reads the tenant's PUBLIC review/comment pages (a Google Business Profile, a Zillow
// agent-profile review feed, a Facebook Page) for text a STRANGER left — praise, a question, or
// both — and asks a narrower question than "was this review recorded": does this reviewer's own
// words carry a real-estate QUESTION ("do you have any listings in…", "what's my home worth")?
// Not every review qualifies — a five-star "great agent, helped us close fast" with no NEW ask in
// it is not a fresh acquisition signal, it is exactly what lib/reputation/* already handles. Reuse
// is at the VOCABULARY layer: REVIEW_PLATFORMS (lib/kernel/reputation.ts, re-exported by
// lib/external/review-extract.ts) is the platform spelling this lane's records carry, so a hit
// found here and a review recorded through the normal flow never disagree on how to spell
// "google"/"zillow"/"facebook" (CLAUDE.md §6).
//
// IDENTITY SPLIT (the actual point of this lane, same shape as permit-sourcer.ts's attach-vs-mint
// split, but matched on NAME rather than address — a public review carries a display name, never
// an address): a qualifying reviewer whose name matches an EXISTING contact this brokerage already
// owns is not a new person — route their renewed intent as a manager signal, never mint a
// duplicate. A qualifying reviewer with no match is a genuinely new person — mint a raw lead
// through the normal pipeline, exactly like every other SourceKey.
//
// CONFIGURATION, HONESTLY. This repo has no live column anywhere that names a tenant's public
// Google Business Profile / Zillow / Facebook Page URL (confirmed before writing this file —
// lib/social/oauth-config.ts's `google_business` provider is an OAuth connection for POSTING to
// GBP, not a stored profile URL for READING it). Rather than guess a URL pattern (the way
// facebook_group falls back to a guessed `/groups/<city>realestate` when unconfigured — a guess
// that is at least plausible for a generic city group, but there is no plausible guess for WHICH
// Google Business Profile belongs to a given brokerage), this lane requires the tenant to
// configure real page URLs: `lead_scraping_motivated_params.review_source_urls` (migration m652,
// same table/shape as the existing `facebook_group_urls` column). No configured URLs ⇒ no scrape,
// same territory-honesty contract every sourcer since wave 65 states.
//
// SCRAPE + EXTRACT: `scrapeSiteWithBestProvider` (lib/external/zenrows-client.ts, ZenRows primary
// / Zyte fallback by configured key, wave 65) + `extractFromHtml`
// (lib/external/llm-html-extractor.ts) against `lib/external/review-extract.ts`'s schema — the
// SAME schema-bound-extraction shape `zenrows-client.ts::scrapeNextdoor` established for a page
// type with no structured actor. Fails CLOSED with neither key configured (scrapeSiteWithBestProvider's own contract).

import { scrapeSiteWithBestProvider } from '@/lib/external/zenrows-client'
import {
  REVIEW_PAGE_SCHEMA, REVIEW_EXTRACT_INSTRUCTIONS,
  normalizeExtractedReviews, regexFallbackReviews,
  type ReviewEntry,
} from '@/lib/external/review-extract'
import { isViableRecord, type NormalizedScrapedRecord } from './raw-record-types'
import { publishManagerSignal } from '@/lib/kernel/manager-signals'

export interface ReviewAcquisitionMarket {
  city: string | null
  state: string | null
}

/** At most this many configured review-source URLs are scraped per run — the same per-run spend
 *  bound permit-sourcer.ts / social-sourcer.ts's phrase lanes apply to their own query sets. */
const MAX_URLS_PER_RUN = 5

/** PURE: splits a display name into first/last — same shape social-sourcer.ts's nameFromHandle
 *  and permit-sourcer.ts's splitDisplayName produce; kept local (a two-field split, not a full
 *  name normalizer) rather than importing a module-private helper. */
function splitDisplayName(name: string | null): { firstName: string | null; lastName: string | null } {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return { firstName: parts[0], lastName: parts.slice(1).join(' ') }
  return { firstName: null, lastName: null }
}

/** PURE: lowercase + collapsed-whitespace full name, for exact-name contact matching. Exported so
 *  routeReviewAcquisitionHits and its simulator use the SAME normalizer (CLAUDE.md §6) rather than
 *  two independently-typed comparisons that could silently drift apart. */
export function normalizeFullName(first: string | null | undefined, last: string | null | undefined): string | null {
  // BOTH halves required — a first-name-only match is far too loose for the "signal the wrong
  // person's record" harm this function exists to bound (see routeReviewAcquisitionHits's header).
  const f = (first ?? '').trim()
  const l = (last ?? '').trim()
  if (!f || !l) return null
  return `${f} ${l}`.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * PURE. One extracted review/comment → a raw-record candidate, IF it carries a real-estate
 * question (classifyReviewIntent's non-"none" buckets) — ordinary praise/complaint text with no
 * NEW ask in it never becomes a candidate (that is lib/reputation/*'s territory, not this lane's).
 * Returns null for a non-qualifying review or one with no reviewer name (an anonymous "Google
 * user" comment has nothing this pipeline's identity gate can anchor on).
 */
export function normalizeReviewAcquisitionEntry(
  entry: ReviewEntry,
  market: ReviewAcquisitionMarket,
  platform: string,
): NormalizedScrapedRecord | null {
  if (entry.intentType === 'none') return null
  const { firstName, lastName } = splitDisplayName(entry.reviewer_name)
  if (!firstName || !lastName) return null

  const intentType: NormalizedScrapedRecord['intentType'] =
    entry.intentType === 'buyer' ? 'buyer' : entry.intentType === 'seller' ? 'seller' : 'unknown'

  const intentSignals = ['review_question_intent', ...entry.matched_signals]
  if (entry.intentType === 'agent_seeking') intentSignals.push('agent_referral_request')

  return {
    sourceRecordId: `review_acquisition-${platform}-${Buffer.from(`${entry.reviewer_name}|${entry.review_text}`).toString('base64').slice(0, 48)}`,
    source: 'review_acquisition_intent',
    behaviorType: 'review_question_intent',
    intentType,
    intentSignals,
    firstName,
    lastName,
    city: market.city,
    state: market.state,
    propertyAddress: null,
    sourceUrl: entry.url,
    motivationScore: null,
    rawPayload: { platform, rating: entry.rating, posted_at: entry.posted_at, review_text: entry.review_text, extraction: entry.extraction },
  }
}

/** Best-effort platform guess from the configured URL's host — used only to tag the record; never
 *  gates anything. Falls back to 'internal' (a REVIEW_PLATFORMS-adjacent honest "unknown" rather
 *  than guessing one of the five real platforms wrong). */
function platformFromUrl(url: string): string {
  const u = url.toLowerCase()
  if (u.includes('google.com') || u.includes('g.page')) return 'google'
  if (u.includes('zillow.com')) return 'zillow'
  if (u.includes('facebook.com')) return 'facebook'
  if (u.includes('realtor.com')) return 'realtor_com'
  if (u.includes('yelp.com')) return 'yelp'
  return 'internal'
}

export interface ReviewAcquisitionSourceResult {
  records: NormalizedScrapedRecord[]
  cost: number
  provider: 'zenrows' | 'zyte' | null
  urlsScanned: number
}

/**
 * LIVE (network): scrapes each configured review-source URL (ZenRows→Zyte, fail-closed with
 * neither key) and extracts qualifying real-estate-question reviewers into raw-record candidates.
 * Territory-honest: no configured URLs ⇒ no scrape (`[]` immediately, before any provider call).
 */
export async function sourceReviewAcquisitionIntent(
  market: ReviewAcquisitionMarket,
  reviewUrls: string[],
): Promise<ReviewAcquisitionSourceResult> {
  const urls = (reviewUrls ?? []).filter(Boolean).slice(0, MAX_URLS_PER_RUN)
  if (urls.length === 0) return { records: [], cost: 0, provider: null, urlsScanned: 0 }

  const all: NormalizedScrapedRecord[] = []
  let cost = 0
  let provider: 'zenrows' | 'zyte' | null = null

  for (const url of urls) {
    const res = await scrapeSiteWithBestProvider(url, { jsRender: true, premiumProxy: true }).catch(
      () => ({ ok: false, html: '', provider: null as 'zenrows' | 'zyte' | null, cost: 0, error: 'scrape threw' }),
    )
    cost += res.cost ?? 0
    if (res.provider) provider = res.provider
    if (!res.ok || !res.html) continue

    const platform = platformFromUrl(url)
    const extracted = await extractFromHtml_({ html: res.html, schema: REVIEW_PAGE_SCHEMA, instructions: REVIEW_EXTRACT_INSTRUCTIONS })
    const entries = extracted.error
      ? regexFallbackReviews(res.html, { sourceUrl: url, limit: 30 })
      : normalizeExtractedReviews(extracted.records, { sourceUrl: url, limit: 30 })

    for (const entry of entries) {
      const rec = normalizeReviewAcquisitionEntry(entry, market, platform)
      if (rec && isViableRecord(rec)) all.push(rec)
    }
  }

  return { records: all, cost, provider, urlsScanned: urls.length }
}

// Lazy-imported so a pure-layer test (no AI Gateway credentials) never pays the module's own
// import cost — same pattern zenrows-client.ts::scrapeNextdoor uses for the same extractor.
async function extractFromHtml_(params: { html: string; schema: string; instructions: string }) {
  const { extractFromHtml } = await import('@/lib/external/llm-html-extractor')
  return extractFromHtml(params)
}

// ── Attach-vs-signal routing (existing contact → signal, never a raw lead) ───────────────────

type SupabaseLike = { from: (table: string) => any }

const MAX_MATCHABLE_CONTACTS = 5000

export interface ReviewAcquisitionRouteResult {
  /** Hits with NO name match to an owned contact — the caller mints these as raw_scraped_leads
   *  through the normal pipeline (insertSocial/ingestRawSourceBatch), exactly like every other
   *  SourceKey. */
  toMint: NormalizedScrapedRecord[]
  signaled: number
  errors: string[]
}

/**
 * Splits qualifying review hits into MINT (no owned-contact name match — proceed as a normal raw
 * lead) vs SIGNAL (the reviewer's name matches a contact this brokerage ALREADY owns — publish a
 * manager signal, campaign_orchestrator [owns reputation & brand] → ai_isa, never a duplicate
 * person — the exact shape lib/lead-pipeline/email-engagement-sourcer.ts uses for
 * contact_email_reengage). Matching is EXACT normalized full name only (never a fuzzy/partial
 * match) — a false-positive name collision routed as a "renewed intent" signal on the wrong
 * contact is a much smaller harm than one routed as a duplicate mint, but it is still a real
 * person's record, so this stays conservative by design.
 */
export async function routeReviewAcquisitionHits(params: {
  supabase: SupabaseLike
  brokerageId: string
}, records: NormalizedScrapedRecord[]): Promise<ReviewAcquisitionRouteResult> {
  const { supabase, brokerageId } = params
  const result: ReviewAcquisitionRouteResult = { toMint: records, signaled: 0, errors: [] }
  if (records.length === 0) return result

  const { data: contactRows, error } = await supabase
    .from('contacts')
    .select('id, first_name, last_name, contact_type')
    .eq('brokerage_id', brokerageId)
    .is('deleted_at', null)
    .not('first_name', 'is', null)
    .not('last_name', 'is', null)
    .limit(MAX_MATCHABLE_CONTACTS)
  if (error) {
    result.errors.push(`contacts read refused: ${error.message}`)
    return result
  }

  const byName = new Map<string, { id: string }>()
  for (const c of (contactRows ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>) {
    const key = normalizeFullName(c.first_name, c.last_name)
    if (key && !byName.has(key)) byName.set(key, { id: c.id })
  }
  if (byName.size === 0) return result

  const matchedIds = new Set<string>()
  for (const rec of records) {
    const key = normalizeFullName(rec.firstName, rec.lastName)
    const match = key ? byName.get(key) : undefined
    if (!match) continue
    matchedIds.add(rec.sourceRecordId)

    const name = [rec.firstName, rec.lastName].filter(Boolean).join(' ').trim() || 'A contact'
    const res = await publishManagerSignal({
      brokerageId,
      fromManager: 'campaign_orchestrator',
      toManager: 'ai_isa',
      signalType: 'contact_review_intent_reengage',
      message: `${name} asked a real-estate question in a public review/comment — renewed intent, consider a follow-up.`,
      entityType: 'contact',
      entityId: match.id,
      contactId: match.id,
      payload: {
        intentSignals: rec.intentSignals,
        intentType: rec.intentType,
        sourceUrl: rec.sourceUrl,
        platform: (rec.rawPayload as any)?.platform ?? null,
      },
    }, supabase as any)
    if (res.ok) result.signaled++
  }

  result.toMint = records.filter((r) => !matchedIds.has(r.sourceRecordId))
  return result
}
