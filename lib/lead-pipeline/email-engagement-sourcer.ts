// lib/lead-pipeline/email-engagement-sourcer.ts
//
// EMAIL ENGAGEMENT INTENT — lane 71C, carried from wave 70's coverage audit
// (docs/lead-acquisition-coverage-2026-09.md remaining-lanes matrix).
//
// THE GAP. The coverage matrix named six behavioral-acquisition lanes still
// missing: new-construction/builder lists, EMAIL ENGAGEMENT INTENT,
// review-as-acquisition, permit/pre-listing, rental-to-buyer graduation
// (tenant side) — this lane is the cheapest of the five that remained after
// site_visitor_intent shipped (wave 70). Structurally the same shape as that
// lane: a signal this repo ALREADY WRITES (email_tracking — opens/clicks on
// our own outbound mail, landed by app/api/webhooks/sendgrid-events/route.ts)
// and NOTHING reads for acquisition. The webhook already fans engagement out
// to messages.status, the per-send ledgers and the behavioral-event scorer
// (lib/lead-scoring/record-behavioral-event.ts) — but a CONTACT who keeps
// opening and clicking the brokerage's own emails, repeatedly, over a run of
// days, is a renewed-intent signal on that person's FULL lead-intelligence
// history (CLAUDE.md §5: "the person's full history from first touch...
// through conversion and after"), and nothing fed that pattern back into the
// scraping/raw-record pipeline the way a fresh site visit or a fresh scrape
// hit does. A single open is noise; a REPEATED pattern (this lane's bar,
// EMAIL_ENGAGEMENT_MIN_EVENTS) is not.
//
// $0 MARGINAL COST — same reason site_visitor_intent was the wave-70 build:
// no vendor call, no API key, no rate limit, the data already sits in
// email_tracking (written by the SendGrid webhook this repo already runs).
//
// CONTRACT (revised wave 72A — see the ruling further down this header): the
// PURE classifier (normalizeEmailEngagementSignal) still decides whether a
// contact's repeated engagement qualifies, but the LIVE sourcer no longer
// feeds it to lib/kernel/scraping.ts::ingestRawSourceBatch. email_tracking is
// ALWAYS contact-scoped (only a matched send against `contacts` produces a
// row at all — app/api/webhooks/sendgrid-events/route.ts resolves the
// contact BEFORE writing), so there is no non-contact case to source into
// raw_scraped_leads. The qualifying signal is instead routed directly onto
// the contact via a manager signal (campaign_orchestrator → ai_isa) — the
// "gathering information... so we can better serve them" posture wave 65
// ruled for intelligence lanes generally, delivered on the CONTACT side per
// the wave-72 correction, never by minting a raw lead for an existing contact.
// TERRITORY: bounded to the calling market's own brokerage, same shape as
// site_visitor_intent — the cron call site (app/api/cron/lead-scraping/
// route.ts) runs this ONCE per brokerage, not once per market row, since
// email engagement is a brokerage-wide signal, not a per-territory one.
// DEDUP: isViableRecord + buildLeadIdentityKey (record.email is the identity
// anchor — the strongest key that function recognizes) let
// ingestRawSourceBatch's own identity-key uniqueness carry the load; this
// lane's own sourceRecordId is built from the LATEST qualifying event
// timestamp, so re-running the cron against an unchanged engagement burst
// produces the same id and dedupes at the DB unique-violation layer (23505),
// the same mechanic normalizeSiteVisitorRow relies on via last_seen_at.
//
// WAVE 72A RULING (owner verbatim: "contacts coming in from the tenants
// website or email come in as contacts not raw leads."). The paragraph above
// was WRONG about what this lane's dedup actually did. `email_tracking` is
// written by ONLY ONE path (app/api/webhooks/sendgrid-events/route.ts), and
// that path resolves the event against `contacts` before it ever writes a
// row — `email_tracking.contact_id` is nullable in the schema but this repo
// never produces a row with it null. So EVERY signal this sourcer ever saw
// was already an existing CONTACT, and feeding it through
// ingestRawSourceBatch → raw_scraped_leads → (pre-enrichment dedup) meant the
// raw row was created, matched the contact, and then just SAT there marked
// 'duplicate_pre_enrich' — a dead end. The contact's own record was never
// touched and the AI ISA was never told. `sourceEmailEngagementIntent` no
// longer returns these as NormalizedScrapedRecord[] (that field is now
// ALWAYS empty — there is no non-contact case for this table to source).
// Instead each qualifying pattern is routed directly onto the contact via a
// manager signal (campaign_orchestrator, who owns the brokerage's outbound
// email, → ai_isa, who nurtures contacts) so the AI ISA can act on the
// renewed-intent pattern — never a raw lead for someone already a contact.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { NormalizedScrapedRecord } from './raw-record-types'
import { publishManagerSignal } from '@/lib/kernel/manager-signals'

type Svc = SupabaseClient<any, any, any>

/** A contact must have at least this many open/click events inside
 *  EMAIL_ENGAGEMENT_WINDOW_DAYS to read as REPEATED engagement, not a single
 *  glance. Mirrors the "repeated, not a bounce" posture SITE_VISITOR_MIN_DWELL
 *  _SECONDS applies to a single page load — here the equivalent bar is count,
 *  not dwell, because email has no dwell timer.
 *  @proofSeam exported so scripts/email-engagement-sourcer-simulator.ts can
 *  assert the bar directly rather than re-deriving it — used in-file as
 *  sourceEmailEngagementIntent's default. */
export const EMAIL_ENGAGEMENT_MIN_EVENTS = 3

/** The rolling window the repeat count is measured over. 14 days — long
 *  enough to catch a slow-burn re-engagement pattern (one open a week for
 *  three weeks) without pretending a single old email cascades into intent. */
export const EMAIL_ENGAGEMENT_WINDOW_DAYS = 14

/** Lookback window for "this burst is FRESH this tick" — matches the
 *  lead-scraping cron's own cadence (every 6 hours), same reasoning as
 *  SITE_VISITOR_LOOKBACK_HOURS: a contact whose most recent qualifying event
 *  falls inside this window is sourced on the very next tick, not re-walked
 *  from stale history every run.
 *  @proofSeam exported so scripts/email-engagement-sourcer-simulator.ts can
 *  assert the cadence directly — used in-file as sourceEmailEngagementIntent's
 *  default. */
export const EMAIL_ENGAGEMENT_LOOKBACK_HOURS = 6

// Module-private (no external reader needs the shape by name — callers
// destructure sourceEmailEngagementIntent's return value directly).
interface EmailEngagementSignal {
  contactId:      string
  email:          string | null
  firstName:      string | null
  lastName:       string | null
  city:           string | null
  state:          string | null
  contactType:    string | null
  eventCount:     number
  clickCount:     number
  earliestEventAt: string | null
  latestEventAt:   string | null
}

/** PURE: turns one qualifying contact's aggregated engagement signal into a
 *  NormalizedScrapedRecord. Returns null when the row lacks the minimum a
 *  scrape record needs (no email — the identity anchor for this lane, same
 *  role session_id plays for site_visitor_intent) or has not crossed the
 *  repeat bar.
 *  @proofSeam exported so scripts/email-engagement-sourcer-simulator.ts can
 *  exercise the pure classification (repeat-bar gating, click-through
 *  detection, intent-type carry-through) without a DB — called in-file by
 *  sourceEmailEngagementIntent, the live entry point
 *  app/api/cron/lead-scraping/route.ts calls. */
export function normalizeEmailEngagementSignal(
  s: EmailEngagementSignal,
  opts: { minEvents?: number } = {},
): NormalizedScrapedRecord | null {
  const minEvents = opts.minEvents ?? EMAIL_ENGAGEMENT_MIN_EVENTS
  const email = (s.email ?? '').trim().toLowerCase()
  if (!email) return null
  if (s.eventCount < minEvents) return null

  const intentSignals = ['repeated_email_engagement']
  if (s.clickCount > 0) intentSignals.push('click_through')
  if (s.eventCount >= minEvents * 2) intentSignals.push('high_frequency_engagement')

  // Fair-Housing safe (same posture as buildBuyerMatchReelProps and
  // normalizeSiteVisitorRow): only the contact's OWN stated buyer/seller
  // stance carries the intentType, never demographics. 'unknown' when the
  // contact record has not classified them yet — enrichment resolves it, the
  // same identityPolicy 'enrichment_first' site_visitor_intent uses.
  const intentType: NormalizedScrapedRecord['intentType'] =
    s.contactType === 'buyer' || s.contactType === 'seller' ? s.contactType : 'unknown'

  return {
    sourceRecordId: `email_engagement-${s.contactId}-${s.latestEventAt ?? s.earliestEventAt ?? 'na'}`,
    source: 'email_engagement_intent',
    behaviorType: 'email_engagement_intent',
    intentType,
    intentSignals,
    firstName: s.firstName,
    lastName:  s.lastName,
    email,
    city:  s.city,
    state: s.state,
    propertyAddress: null,
    motivationScore: null,
    rawPayload: {
      signal: s,
      window_days: EMAIL_ENGAGEMENT_WINDOW_DAYS,
      min_events: minEvents,
      lookback_hours: EMAIL_ENGAGEMENT_LOOKBACK_HOURS,
    },
  }
}

interface EmailEngagementSourceResult {
  /** WAVE 72A: ALWAYS empty. This table has no non-contact case (see the
   *  header note) — kept in the shape only so callers written against the
   *  site_visitor_intent-family contract (records/cost/rowsExamined) do not
   *  need a special case; `insertRawBatch` no-ops on an empty array. */
  records: NormalizedScrapedRecord[]
  /** Always 0 — first-party data already collected (our own send + the
   *  provider's engagement webhook), no vendor call. */
  cost: number
  rowsExamined: number
  /** Contacts whose repeated-engagement pattern was routed to the AI ISA
   *  (campaign_orchestrator → ai_isa manager signal) this run. */
  contactsNotified: number
}

/** LIVE: reads email_tracking for ONE brokerage's open/click activity in the
 *  trailing EMAIL_ENGAGEMENT_WINDOW_DAYS, aggregates per contact, keeps only
 *  contacts crossing the repeat bar whose MOST RECENT qualifying event falls
 *  inside the lookback window (a fresh burst this tick — the same "only
 *  what's new since the last look" shape sourceSiteVisitorIntent applies via
 *  last_seen_at), then resolves each survivor's contact record. WAVE 72A:
 *  `records` is deliberately never filled (see the header note — this table
 *  has no non-contact case). Instead, for every qualifying, non-opted-out
 *  contact this WRITES a manager signal (campaign_orchestrator → ai_isa,
 *  lib/kernel/manager-signals.ts::publishManagerSignal, idempotent per open
 *  signal) carrying the pattern, so the AI ISA can decide whether to
 *  re-engage — never a raw lead for someone who is already a contact. Fails
 *  closed (empty result) on a refused read — never treats "couldn't read" as
 *  "nothing to source" silently: the caller sees rowsExamined stay 0 and can
 *  log it. Excludes opted-out contacts (email_opt_out) — an engagement
 *  pattern from before an opt-out is not grounds to resurface someone who
 *  told the brokerage to stop. */
export async function sourceEmailEngagementIntent(
  svc: Svc,
  brokerageId: string,
  opts: { windowDays?: number; lookbackHours?: number; minEvents?: number; now?: Date } = {},
): Promise<EmailEngagementSourceResult> {
  const windowDays = opts.windowDays ?? EMAIL_ENGAGEMENT_WINDOW_DAYS
  const lookbackHours = opts.lookbackHours ?? EMAIL_ENGAGEMENT_LOOKBACK_HOURS
  const minEvents = opts.minEvents ?? EMAIL_ENGAGEMENT_MIN_EVENTS
  const now = opts.now ?? new Date()
  const windowStart = new Date(now.getTime() - windowDays * 24 * 3600_000).toISOString()
  const lookbackStart = new Date(now.getTime() - lookbackHours * 3600_000).toISOString()

  const { data, error } = await svc
    .from('email_tracking')
    .select('contact_id, event_type, event_at')
    .eq('brokerage_id', brokerageId)
    .in('event_type', ['open', 'click'])
    .not('contact_id', 'is', null)
    .gte('event_at', windowStart)
    .limit(2000)

  if (error || !data) return { records: [], cost: 0, rowsExamined: 0, contactsNotified: 0 }

  // Aggregate client-side (no GROUP BY over the supabase-js query builder) —
  // same "one read, aggregate in TS" shape the rest of this pipeline family
  // uses rather than an RPC for a lane this small.
  const byContact = new Map<string, { count: number; clicks: number; earliest: string; latest: string }>()
  for (const row of data as Array<{ contact_id: string; event_type: string; event_at: string }>) {
    const id = row.contact_id
    const existing = byContact.get(id)
    if (!existing) {
      byContact.set(id, {
        count: 1,
        clicks: row.event_type === 'click' ? 1 : 0,
        earliest: row.event_at,
        latest: row.event_at,
      })
      continue
    }
    existing.count += 1
    if (row.event_type === 'click') existing.clicks += 1
    if (row.event_at < existing.earliest) existing.earliest = row.event_at
    if (row.event_at > existing.latest) existing.latest = row.event_at
  }

  const qualifyingIds: string[] = []
  const aggByContact = new Map<string, { count: number; clicks: number; earliest: string; latest: string }>()
  for (const [id, agg] of byContact) {
    if (agg.count >= minEvents && agg.latest >= lookbackStart) {
      qualifyingIds.push(id)
      aggByContact.set(id, agg)
    }
  }

  if (qualifyingIds.length === 0) return { records: [], cost: 0, rowsExamined: data.length, contactsNotified: 0 }

  const { data: contacts, error: contactsError } = await svc
    .from('contacts')
    .select('id, email, first_name, last_name, city, state, contact_type, email_opt_out')
    .eq('brokerage_id', brokerageId)
    .in('id', qualifyingIds.slice(0, 200))

  if (contactsError || !contacts) return { records: [], cost: 0, rowsExamined: data.length, contactsNotified: 0 }

  // WAVE 72A: `records` stays empty by design (see header note) — every
  // subject here is already a CONTACT, so this never feeds
  // ingestRawSourceBatch/raw_scraped_leads. `normalizeEmailEngagementSignal`
  // (the pure classifier) still decides WHETHER the pattern qualifies and
  // which intent signals it carries; the qualifying result is routed onto
  // the contact via a manager signal instead of being minted as a record.
  const records: NormalizedScrapedRecord[] = []
  let contactsNotified = 0
  for (const c of contacts as Array<{
    id: string; email: string | null; first_name: string | null; last_name: string | null
    city: string | null; state: string | null; contact_type: string | null; email_opt_out: boolean | null
  }>) {
    if (c.email_opt_out) continue
    const agg = aggByContact.get(c.id)
    if (!agg) continue
    const signal = normalizeEmailEngagementSignal({
      contactId: c.id,
      email: c.email,
      firstName: c.first_name,
      lastName: c.last_name,
      city: c.city,
      state: c.state,
      contactType: c.contact_type,
      eventCount: agg.count,
      clickCount: agg.clicks,
      earliestEventAt: agg.earliest,
      latestEventAt: agg.latest,
    }, { minEvents })
    if (!signal) continue

    const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || 'This contact'
    const res = await publishManagerSignal({
      brokerageId,
      fromManager: 'campaign_orchestrator',
      toManager: 'ai_isa',
      signalType: 'contact_renewed_email_engagement',
      message: `${name} has opened/clicked our emails ${agg.count}x in the last ${windowDays}d — renewed intent, consider a follow-up.`,
      entityType: 'contact',
      entityId: c.id,
      contactId: c.id,
      payload: {
        eventCount: agg.count,
        clickCount: agg.clicks,
        windowDays,
        intentSignals: signal.intentSignals,
        intentType: signal.intentType,
        latestEventAt: agg.latest,
      },
    }, svc)
    if (res.ok) contactsNotified++
  }

  return { records, cost: 0, rowsExamined: data.length, contactsNotified }
}
