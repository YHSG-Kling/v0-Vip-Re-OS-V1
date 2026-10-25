// lib/content-intel/local-intel.ts
// ─────────────────────────────────────────────────────────────────────────────
// LOCAL INTELLIGENCE — verified local events, civic notices, business openings, development and
// market news for a tenant's ACTIVE territories (wave 144, lane 144G; owner ruling 14: "find a
// scraper/resource for local news and events from providers we ALREADY use … no new paid scraper
// when an existing provider works; respect publisher rights/robots/attribution; store facts with
// date, location, freshness, source, confidence; feed topic suggestions → original community
// content → video/lead magnet → campaigns → education → permitted follow-up; expired vs upcoming
// distinguished; never copy whole articles").
//
// SURVIVORS (audited at 967a4866, reused — nothing here is a second system):
//   · DISCOVERY  lib/ai/web-search.ts webSearch — the registered web_search capability (Tavily
//                primary in "research" mode, Exa fallback; both through their SDK / connector
//                gateway), booked through its own `spend` (vendor_usage_tracking, platform-covered,
//                tenant-attributed — never a tenant meter).
//                lib/content-intel/newsapi-ai.ts — the owner-selected NEWS provider (Event Registry),
//                its key cascade unchanged (tenant integration_credentials first, then the
//                SaaS-licensed platform NEWSAPI_AI_KEY; no key → the leg is a published blind spot).
//                lib/content-intel/rss-scraper.ts parseRssXml — the existing RSS/Atom parser, for a
//                tenant's own community-calendar / city-news feed (content_topic_sources 'rss' rows
//                the tenant already creates in /dashboard/marketing/content-intel, carrying a
//                `local_intel` config). iCalendar (.ics) feeds are parsed here (no parser existed).
//   · WHERE      lib/lead-pipeline/scrape-territories.ts resolveActivePullGate — the ONE pre-pull
//                gate (live tenant + active territory). No territory → no pull, stated by reason.
//   · ROBOTS     lib/assets/screenshot-capture.ts isRobotsAllowed — the existing robots.txt rule.
//   · STORE      content_topic_bank — the ONE topic pool every content generator already reads
//                through pickTopics (newsletter, blog, podcast, topic video, contact reels, social /
//                newsletter cadence, farm mail, lead-magnet suggestions). A fact is a topic row:
//                topic_posted_at (date), geo_relevance (location), scraped_at + expires_at
//                (freshness; an event EXPIRES the day after it ends, so the picker can never
//                promote a past event), source_url + source_id + raw_data.local_fact.publisher
//                (source + attribution), raw_data.local_fact.confidence (confidence). No new table.
//   · PROVENANCE lib/content-intel/system-topic-source.ts — content_topic_bank.source_id is NOT NULL
//                live; web / news facts file under the tenant's own system source row.
//   · EVIDENCE   lib/kernel/action-ledger.ts withActionLedger — one ledgered pass per tenant per day.
//   · GATE       lib/billing/billing-access.ts mayUseAndAfford('lead.scrape') — platform spend never
//                runs on a lapsed tenant (the rule brand listening and scraping run under).
//
// RIGHTS: nothing here fetches a publisher's article page. Search / news results arrive as title +
// snippet + URL from the provider; a configured feed is a syndication document the publisher
// offers, fetched only after its robots.txt allows our user agent. What is STORED is a title
// (≤200), an excerpt (≤280), the URL, the publisher and the extracted date — never a body. Every
// angle handed to a writer says: original words, credit the source by name, link to it.
//
// FAIR HOUSING: community content is public marketing. A fact whose subject is crime / safety,
// school ratings, a religious congregation or demographic composition is NOT a marketing topic
// (steering — .claude/skills/real-estate-real-estate-marketing "Prohibited language and concepts")
// and is dropped at capture with its reason counted; a HIGH-severity fair-housing phrase
// (detectFairHousingViolations) drops the fact, a medium one lowers its confidence and travels with
// it. The writers' own compliance gates still run on every draft.
//
// AI EXPLAINS, CODE DECIDES: kind, date, place, confidence and expiry are deterministic. No model
// call is made here.
//
// Not server-only: scripts/local-intel-guard.ts drives the pass in memory; every provider / feed /
// ledger / gate edge is an injectable dep and the real survivor is loaded lazily.

import { detectFairHousingViolations } from "@/lib/compliance-rules/fair-housing-patterns"
import { isRobotsAllowed } from "@/lib/assets/screenshot-capture"
import { normalizeMentionUrl } from "@/lib/competitive-intel/brand-listening"
import { resolveSystemTopicSource } from "@/lib/content-intel/system-topic-source"

type Db = { from: (table: string) => any }

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** The kinds of local fact. Their newsletter spelling is the canonical section taxonomy
 *  (lib/kernel/newsletter/section-types.ts: local_event / local_news / market_update). */
export const LOCAL_FACT_KINDS = ["local_event", "civic_notice", "business_opening", "development", "local_news", "market_update"] as const
export type LocalFactKind = (typeof LOCAL_FACT_KINDS)[number]

/** Kind → the topic-bank categories the EXISTING readers already filter on (pickTopics callers:
 *  "neighborhood", "market_education") + the `local_intel` marker this module reads back. No new
 *  reader spelling (§6). */
const LOCAL_FACT_CATEGORIES: Readonly<Record<LocalFactKind, readonly string[]>> = {
  local_event: ["neighborhood", "local_intel"],
  civic_notice: ["neighborhood", "local_intel"],
  business_opening: ["neighborhood", "local_intel"],
  development: ["neighborhood", "market_education", "local_intel"],
  local_news: ["neighborhood", "local_intel"],
  market_update: ["market_education", "local_intel"],
}
const KIND_LABEL: Readonly<Record<LocalFactKind, string>> = {
  local_event: "local event", civic_notice: "civic notice", business_opening: "business opening",
  development: "development news", local_news: "community news", market_update: "local market update",
}

interface KindSpec {
  /** What the web_search capability is asked, for one place. */
  query: (place: string) => string
  /** Recency window handed to the search (null = calendar pages are evergreen; the date decides). */
  withinDays: number | null
  /** NewsAPI.ai keyword (null = not a news kind). */
  newsKeyword: string | null
  /** How long an undated (news-like) fact stays fresh after its publish date. */
  freshDays: number
  /** An event-like fact must carry a date; a civic notice / opening may. */
  date: "required" | "optional" | "none"
}
const KIND_SPECS: Readonly<Record<LocalFactKind, KindSpec>> = {
  local_event:      { query: (p) => `upcoming community events festival farmers market in ${p}`, withinDays: null, newsKeyword: null, freshDays: 0, date: "required" },
  civic_notice:     { query: (p) => `${p} city council public hearing notice`, withinDays: 30, newsKeyword: "city council", freshDays: 14, date: "optional" },
  business_opening: { query: (p) => `new business grand opening ribbon cutting ${p}`, withinDays: 45, newsKeyword: "grand opening", freshDays: 21, date: "optional" },
  development:      { query: (p) => `${p} new development construction project approved`, withinDays: 45, newsKeyword: "development project", freshDays: 30, date: "none" },
  local_news:       { query: (p) => `${p} local community news`, withinDays: 10, newsKeyword: "community", freshDays: 10, date: "none" },
  market_update:    { query: (p) => `${p} housing market report home prices inventory`, withinDays: 30, newsKeyword: "housing market", freshDays: 21, date: "none" },
}

export type LocalSourceClass = "official" | "configured_feed" | "news" | "web"
type DateBasis = "ics" | "text_explicit_year" | "text_inferred_year" | "published" | "observed"
export type LocalTemporal = "upcoming" | "ongoing" | "current" | "expired"

// ── Bounds (cost is platform money: every pass is capped) ────────────────────
const MAX_TERRITORIES_PER_PASS = 3
const KINDS_PER_TERRITORY = 2
const MAX_WEB_SEARCHES = 6
const RESULTS_PER_SEARCH = 8
const MAX_FEEDS_PER_PASS = 5
const FEED_ITEMS_PER_FEED = 30
const TITLE_CHARS = 200
const EXCERPT_CHARS = 280
const DATE_SCAN_CHARS = 1500
const MIN_CONFIDENCE = 0.5
const HORIZON_DAYS_EXPLICIT = 120
const HORIZON_DAYS_INFERRED = 45
const DAY_MS = 86_400_000
/** Identified, honest UA — a feed's robots.txt rules for this token are honoured. */
export const LOCAL_INTEL_USER_AGENT = "VipReOS-LocalIntel/1.0 (community calendar & local news facts; honours robots.txt)"

const BASE_CONFIDENCE: Readonly<Record<LocalSourceClass, number>> = { official: 0.85, configured_feed: 0.75, news: 0.65, web: 0.55 }
const DATE_ADJUST: Readonly<Record<DateBasis, number>> = { ics: 0, text_explicit_year: -0.05, text_inferred_year: -0.15, published: 0, observed: -0.1 }

/** Topics that are NOT community marketing material (steering). Matched on text with the place's
 *  own name removed, so a city called Temple is not a religious topic. */
const EXCLUDED_TOPIC_RULES: ReadonlyArray<{ reason: string; pattern: RegExp }> = [
  { reason: "crime_safety", pattern: /\b(crimes?|criminal|shootings?|stabbings?|homicides?|murders?|robber(y|ies)|burglar(y|ies)|assault(ed|s)?|arrest(ed|s)?|suspects?|gangs?|carjack\w*|police (say|said|report\w*)|safest|most dangerous|unsafe)\b/i },
  { reason: "school_rating", pattern: /\b(school (ratings?|rankings?|scores?|grades?)|(top|best|highest)[- ](rated|ranked) schools?|best schools?|greatschools)\b/i },
  { reason: "religious_congregation", pattern: /\b(church(es)?|mosques?|synagogues?|temples?|parish(es)?|congregations?|worship|ministry|bible|sermons?)\b/i },
  { reason: "demographic_composition", pattern: /\b(demographics?|racial(ly)?|ethnic(ity|ally)?|immigrants?|minorit(y|ies))\b/i },
]

// ── PURE helpers ─────────────────────────────────────────────────────────────

function clean(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim()
}
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, "") } catch { return "" }
}
const iso = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`
function validYmd(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m && t.getUTCDate() === d
}
const dayStartMs = (ymd: string) => Date.parse(`${ymd}T00:00:00.000Z`)
const todayYmd = (now: Date) => now.toISOString().slice(0, 10)

/** A government host: *.gov, or a US locality domain (ci.<city>.<st>.us, co.<county>.<st>.us …). */
function isOfficialHost(host: string): boolean {
  return /\.gov$/.test(host) || /(^|\.)(ci|co|city|town|twp|county|vil|village)\.[a-z0-9-]+\.[a-z]{2}\.us$/.test(host)
}

const MONTHS: Readonly<Record<string, number>> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
const monthIdx = (s: string) => MONTHS[s.toLowerCase().slice(0, 3)]

interface DateCandidate { start: string; end: string | null; basis: "text_explicit_year" | "text_inferred_year"; at: number }

/**
 * PURE — every calendar date written in `text` ("Saturday, November 8, 2026", "Nov. 8–9",
 * "2026-11-08", "11/08/2026"). A date without a year takes the reference year, rolling to the next
 * year only when it would sit more than 30 days before the reference (a January date read in
 * October) — and is marked INFERRED so it carries less confidence and a shorter horizon.
 */
function dateCandidates(text: string, reference: Date): DateCandidate[] {
  const out: DateCandidate[] = []
  const refMs = reference.getTime()
  const named = new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*(?:-|–|—|to|through|thru)\\s*(?:${MONTH_RE}\\.?\\s+)?(\\d{1,2})(?:st|nd|rd|th)?)?(?:,?\\s+(20\\d{2}))?(?![\\d:])`, "gi")
  for (const m of text.matchAll(named)) {
    const m1 = monthIdx(m[1]), d1 = Number(m[2]), m2 = m[3] ? monthIdx(m[3]) : m1, d2 = m[4] ? Number(m[4]) : null
    let y = m[5] ? Number(m[5]) : reference.getUTCFullYear()
    const explicit = !!m[5]
    if (!validYmd(y, m1, d1)) continue
    if (!explicit && Date.UTC(y, m1, d1) < refMs - 30 * DAY_MS) y += 1
    if (!validYmd(y, m1, d1)) continue
    let end: string | null = null
    if (d2 !== null) {
      let y2 = y
      if (Date.UTC(y2, m2, d2) < Date.UTC(y, m1, d1)) y2 += 1
      if (validYmd(y2, m2, d2)) end = iso(y2, m2, d2)
    }
    out.push({ start: iso(y, m1, d1), end, basis: explicit ? "text_explicit_year" : "text_inferred_year", at: m.index ?? 0 })
  }
  for (const m of text.matchAll(/\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/g)) {
    const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3])
    if (validYmd(y, mo, d)) out.push({ start: iso(y, mo, d), end: null, basis: "text_explicit_year", at: m.index ?? 0 })
  }
  for (const m of text.matchAll(/\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(20\d{2})\b/g)) {
    const y = Number(m[3]), mo = Number(m[1]) - 1, d = Number(m[2])
    if (validYmd(y, mo, d)) out.push({ start: iso(y, mo, d), end: null, basis: "text_explicit_year", at: m.index ?? 0 })
  }
  return out
}

/**
 * PURE — THE event date of a page. A date on the publish day itself is the dateline, not the
 * event (dropped when another date exists). Of the rest, the earliest on/after the reference wins;
 * when every date is in the past, the latest one (so the fact reads as EXPIRED, never upcoming).
 * @proofSeam scripts/local-intel-guard.ts D7/D8 pin the dateline / all-past / range / inferred-year rules directly; production caller factFromHit below.
 */
export function extractEventDate(text: string, opts: { publishedAt?: string | null; now: Date }): { start: string; end: string | null; basis: "text_explicit_year" | "text_inferred_year" } | null {
  const reference = opts.publishedAt && !Number.isNaN(Date.parse(opts.publishedAt)) ? new Date(opts.publishedAt) : opts.now
  let cands = dateCandidates(text, reference)
  if (!cands.length) return null
  if (opts.publishedAt && cands.length > 1) {
    const pubDay = reference.toISOString().slice(0, 10)
    const notDateline = cands.filter((c) => c.start !== pubDay)
    if (notDateline.length) cands = notDateline
  }
  const refDay = reference.toISOString().slice(0, 10)
  const ahead = cands.filter((c) => c.start >= refDay).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.at - b.at))
  const pick = ahead[0] ?? [...cands].sort((a, b) => (a.start < b.start ? 1 : -1))[0]
  return { start: pick.start, end: pick.end, basis: pick.basis }
}

export interface IcsEvent { uid: string | null; summary: string; start: string; end: string | null; location: string | null; url: string | null; description: string | null }

/** PURE — VEVENTs of an iCalendar document (RFC 5545 line unfolding, text unescaping; all-day
 *  DTEND is exclusive so it steps back a day; CANCELLED events are skipped). Dates only — a
 *  time-of-day is never invented or converted.
 *  @proofSeam scripts/local-intel-guard.ts E1 pins unfolding / unescaping / exclusive DTEND / CANCELLED directly; production caller: the feed leg of runLocalIntelPass. */
export function parseIcsEvents(ics: string): IcsEvent[] {
  const lines = ics.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)
  const out: IcsEvent[] = []
  let cur: Record<string, { params: string; value: string }> | null = null
  const unescape = (v: string) => v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim()
  const ymd = (v: string): string | null => {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(v.trim())
    if (!m) return null
    const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3])
    return validYmd(y, mo, d) ? iso(y, mo, d) : null
  }
  for (const line of lines) {
    if (/^BEGIN:VEVENT/i.test(line)) { cur = {}; continue }
    if (/^END:VEVENT/i.test(line)) {
      if (cur) {
        const start = cur.DTSTART ? ymd(cur.DTSTART.value) : null
        const summary = cur.SUMMARY ? unescape(cur.SUMMARY.value) : ""
        const cancelled = (cur.STATUS?.value ?? "").trim().toUpperCase() === "CANCELLED"
        if (start && summary && !cancelled) {
          let end = cur.DTEND ? ymd(cur.DTEND.value) : null
          const allDay = /VALUE=DATE(?!-)/i.test(cur.DTSTART.params) || /^\d{8}$/.test(cur.DTSTART.value.trim())
          if (end && allDay && /^\d{8}$/.test((cur.DTEND?.value ?? "").trim())) {
            const e = new Date(dayStartMs(end) - DAY_MS).toISOString().slice(0, 10)
            end = e > start ? e : null
          }
          if (end === start) end = null
          out.push({
            uid: cur.UID ? cur.UID.value.trim() : null, summary, start, end,
            location: cur.LOCATION ? unescape(cur.LOCATION.value) || null : null,
            url: cur.URL ? cur.URL.value.trim() || null : null,
            description: cur.DESCRIPTION ? unescape(cur.DESCRIPTION.value) || null : null,
          })
        }
      }
      cur = null
      if (out.length >= 200) break
      continue
    }
    if (!cur) continue
    const m = /^([A-Z-]+)((?:;[^:]*)?):(.*)$/i.exec(line)
    if (m && !cur[m[1].toUpperCase()]) cur[m[1].toUpperCase()] = { params: m[2] ?? "", value: m[3] ?? "" }
  }
  return out
}

/** Where a fact must be: one of the tenant's active territories (lead_scraping_markets rows). */
export interface LocalTerritory { city: string | null; state: string | null; zipCodes: string[]; counties: string[] }

function placeLabel(t: LocalTerritory): string {
  const st = clean(t.state).toUpperCase()
  if (clean(t.city)) return [clean(t.city), st].filter(Boolean).join(", ")
  if (t.counties[0]) return [`${clean(t.counties[0])} County`, st].filter(Boolean).join(", ")
  return t.zipCodes[0] ?? ""
}
function placeNames(t: LocalTerritory): string[] {
  return [clean(t.city), ...t.counties.map(clean)].filter((n) => n.length >= 3)
}
/** Does the text literally NAME the place (city, "<county> County", or a territory ZIP)? Never a semantic guess. */
function namesPlace(t: LocalTerritory, text: string): boolean {
  if (clean(t.city).length >= 3 && new RegExp(`\\b${escapeRe(clean(t.city))}\\b`, "i").test(text)) return true
  if (t.counties.some((c) => clean(c).length >= 3 && new RegExp(`\\b${escapeRe(clean(c))}\\s+county\\b`, "i").test(text))) return true
  return t.zipCodes.some((z) => /^\d{5}$/.test(z) && new RegExp(`\\b${z}\\b`).test(text))
}
function excludedTopic(t: LocalTerritory, text: string): string | null {
  let scrubbed = text
  for (const n of placeNames(t)) scrubbed = scrubbed.replace(new RegExp(`\\b${escapeRe(n)}\\b`, "gi"), " ")
  return EXCLUDED_TOPIC_RULES.find((r) => r.pattern.test(scrubbed))?.reason ?? null
}

/** The expiry of a dated fact: the day after it ends, 12:00 UTC (the event day is over in every US zone). */
function eventExpiry(start: string, end: string | null): string {
  return new Date(dayStartMs(end ?? start) + DAY_MS + 12 * 3_600_000).toISOString()
}

/** PURE — upcoming / ongoing (a dated fact before / during its day), current (an undated fact still
 *  fresh), expired (past its expiry). The ONE reading of "expired vs upcoming".
 *  @proofSeam scripts/local-intel-guard.ts D2 pins the four states at their boundaries; production caller loadLocalFacts below. */
export function classifyLocalTemporal(f: { eventStart: string | null; expiresAt: string }, now: Date): LocalTemporal {
  if (now.getTime() >= Date.parse(f.expiresAt)) return "expired"
  if (!f.eventStart) return "current"
  return todayYmd(now) < f.eventStart ? "upcoming" : "ongoing"
}

// ── The fact ─────────────────────────────────────────────────────────────────

export interface LocalFact {
  key: string
  kind: LocalFactKind
  title: string
  excerpt: string | null
  url: string
  host: string
  publisher: string
  provider: string
  sourceClass: LocalSourceClass
  sourceId: string
  publishedAt: string | null
  eventStart: string | null
  eventEnd: string | null
  dateBasis: DateBasis
  venue: string | null
  territory: { city: string | null; state: string | null; zipCodes: string[] }
  confidence: number
  confidenceBasis: string[]
  corroboratingUrls: string[]
  complianceNote: string | null
  expiresAt: string
  observedAt: string
}

interface HitLike { title: string | null; url: string | null; snippet: string | null; author?: string | null; publishedAt?: string | null }

interface FactContext {
  kind: LocalFactKind
  territory: LocalTerritory
  provider: string
  sourceClass: Exclude<LocalSourceClass, "official">
  sourceId: string
  publisher?: string | null
  /** A configured feed IS the place's own channel — its items need not repeat the place name. */
  placeImplicit?: boolean
  /** A structured (ICS) date — beats any date read from text. */
  structured?: { start: string; end: string | null; venue: string | null }
  /** Distinguishes several items that share one document URL (ICS events without their own URL:
   *  the URL key drops fragments, so the event UID rides here). */
  keySuffix?: string
  now: Date
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** PURE — one search / news / feed item → a fact, or the counted reason it is not one.
 *  @proofSeam scripts/local-intel-guard.ts B11/B12/H4 drive single items (a city named Temple, school ratings, utm twins); production caller runLocalIntelPass below. */
export function factFromHit(hit: HitLike, ctx: FactContext): { fact: LocalFact } | { drop: string } {
  const url = clean(hit.url)
  const baseKey = normalizeMentionUrl(url)
  if (!baseKey) return { drop: "no_url" }
  const key = ctx.keySuffix ? `${baseKey}#${ctx.keySuffix}` : baseKey
  const title = clean(hit.title).slice(0, TITLE_CHARS)
  if (!title) return { drop: "no_title" }
  const snippet = clean(hit.snippet)
  const text = clean(`${title} ${snippet.slice(0, DATE_SCAN_CHARS)}`)
  if (!ctx.placeImplicit && !namesPlace(ctx.territory, text)) return { drop: "not_local" }
  const excluded = excludedTopic(ctx.territory, text)
  if (excluded) return { drop: `excluded_topic:${excluded}` }
  const fh = detectFairHousingViolations(text)
  if (fh.some((p) => p.severity === "high")) return { drop: "fair_housing_phrase" }
  const medium = fh.find((p) => p.severity === "medium")

  const now = ctx.now
  const publishedAt = hit.publishedAt && !Number.isNaN(Date.parse(hit.publishedAt)) ? new Date(hit.publishedAt).toISOString() : null
  const spec = KIND_SPECS[ctx.kind]
  let eventStart: string | null = null, eventEnd: string | null = null, venue: string | null = null
  let basis: DateBasis
  let expiresAt: string
  const dated = ctx.structured
    ? { start: ctx.structured.start, end: ctx.structured.end, basis: "ics" as const }
    : spec.date !== "none" ? extractEventDate(text, { publishedAt, now }) : null
  if (spec.date === "required" && !dated) return { drop: "event_undated" }
  if (dated) {
    eventStart = dated.start; eventEnd = dated.end; basis = dated.basis
    venue = ctx.structured?.venue ?? null
    const horizon = basis === "text_inferred_year" ? HORIZON_DAYS_INFERRED : HORIZON_DAYS_EXPLICIT
    if (dayStartMs(eventStart) > now.getTime() + horizon * DAY_MS) return { drop: "beyond_horizon" }
    expiresAt = eventExpiry(eventStart, eventEnd)
    if (now.getTime() >= Date.parse(expiresAt)) return { drop: "expired_at_capture" }
  } else {
    basis = publishedAt ? "published" : "observed"
    const baseMs = publishedAt ? Date.parse(publishedAt) : now.getTime()
    if (publishedAt && spec.withinDays && baseMs < now.getTime() - spec.withinDays * 2 * DAY_MS) return { drop: "stale_news" }
    expiresAt = new Date(baseMs + Math.max(1, spec.freshDays) * DAY_MS).toISOString()
    if (now.getTime() >= Date.parse(expiresAt)) return { drop: "stale_news" }
  }

  const host = hostOf(url)
  const sourceClass: LocalSourceClass = isOfficialHost(host) ? "official" : ctx.sourceClass
  const basisNotes = [`source:${sourceClass}`, `date:${basis}`]
  let confidence = BASE_CONFIDENCE[sourceClass] + DATE_ADJUST[basis]
  if (medium) { confidence -= 0.1; basisNotes.push(`fair_housing_medium:${medium.phrase}`) }
  return {
    fact: {
      key, kind: ctx.kind, title,
      excerpt: snippet ? snippet.slice(0, EXCERPT_CHARS) : null,
      url, host,
      publisher: clean(ctx.publisher) || clean(hit.author) || host,
      provider: ctx.provider, sourceClass, sourceId: ctx.sourceId,
      publishedAt, eventStart, eventEnd, dateBasis: basis, venue,
      territory: { city: ctx.territory.city, state: ctx.territory.state, zipCodes: ctx.territory.zipCodes.slice(0, 20) },
      confidence: round2(Math.max(0.05, Math.min(0.95, confidence))),
      confidenceBasis: basisNotes,
      corroboratingUrls: [],
      complianceNote: medium ? `fair-housing phrase "${medium.phrase}" (${medium.reference}) — write around it` : null,
      expiresAt, observedAt: now.toISOString(),
    },
  }
}

const STOP = new Set(["the", "a", "an", "and", "of", "in", "at", "on", "for", "to", "with", "is", "are", "this", "its", "new", "annual"])
function titleKey(f: LocalFact): string {
  const place = new Set(placeNames({ city: f.territory.city, state: null, zipCodes: [], counties: [] }).flatMap((n) => n.toLowerCase().split(" ")))
  const toks = f.title.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(" ").filter((t) => t.length > 1 && !STOP.has(t) && !place.has(t) && !/^\d+$/.test(t) && !(t.slice(0, 3) in MONTHS))
  return `${f.kind}|${f.eventStart ?? ""}|${toks.slice(0, 6).join(" ")}`
}
const CLASS_RANK: Readonly<Record<LocalSourceClass, number>> = { official: 3, configured_feed: 2, news: 1, web: 0 }

/** PURE — one fact per URL, then one per (kind, date, title) across hosts: the best-sourced report
 *  is kept, the others corroborate it (+0.1 confidence per extra independent host, up to +0.2).
 *  @proofSeam scripts/local-intel-guard.ts H4 pins "one host is not corroboration" directly; production caller runLocalIntelPass below. */
export function mergeLocalFacts(facts: LocalFact[]): LocalFact[] {
  const byUrl = new Map<string, LocalFact>()
  for (const f of facts) {
    const have = byUrl.get(f.key)
    if (!have || CLASS_RANK[f.sourceClass] > CLASS_RANK[have.sourceClass] || (CLASS_RANK[f.sourceClass] === CLASS_RANK[have.sourceClass] && f.confidence > have.confidence)) byUrl.set(f.key, f)
  }
  const groups = new Map<string, LocalFact[]>()
  for (const f of byUrl.values()) {
    const k = titleKey(f)
    groups.set(k, [...(groups.get(k) ?? []), f])
  }
  const out: LocalFact[] = []
  for (const g of groups.values()) {
    const sorted = [...g].sort((a, b) => CLASS_RANK[b.sourceClass] - CLASS_RANK[a.sourceClass] || b.confidence - a.confidence)
    const primary = { ...sorted[0] }
    const hosts = new Set(g.map((f) => f.host))
    if (hosts.size > 1) {
      primary.confidence = round2(Math.min(0.95, primary.confidence + Math.min(0.2, 0.1 * (hosts.size - 1))))
      primary.confidenceBasis = [...primary.confidenceBasis, `corroborated_by:${hosts.size - 1}`]
      primary.corroboratingUrls = sorted.slice(1).map((f) => f.url).slice(0, 3)
    }
    out.push(primary)
  }
  return out
}

function fmtDay(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00.000Z`)
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
}

/** PURE — the writer's brief for one fact: what it is, when, who reported it, and the rights rule. */
function valueAngleFor(f: LocalFact): string {
  const credit = `credit ${f.publisher} by name and link to the source; never copy its text`
  if (f.eventStart) {
    const when = f.eventEnd ? `${fmtDay(f.eventStart)} to ${fmtDay(f.eventEnd)}` : fmtDay(f.eventStart)
    const lead = f.kind === "local_event" ? "Upcoming local event" : KIND_LABEL[f.kind][0].toUpperCase() + KIND_LABEL[f.kind].slice(1)
    return `${lead} — ${when}${f.venue ? ` · ${f.venue}` : ""} (per ${f.publisher}). Write an ORIGINAL community piece in the agent's own voice; ${credit}.`.slice(0, 400)
  }
  const when = f.publishedAt ? `reported ${fmtDay(f.publishedAt.slice(0, 10))}` : "reported recently"
  return `Local ${KIND_LABEL[f.kind]} ${when} by ${f.publisher}. Explain what it means for local homeowners and buyers in ORIGINAL words; ${credit}.`.slice(0, 400)
}

/** PURE — the content_topic_bank row a fact is stored as (insert shape). */
function topicRowForFact(f: LocalFact, brokerageId: string, now: Date): Record<string, unknown> {
  return {
    source_id: f.sourceId,
    brokerage_id: brokerageId,
    topic_title: f.title,
    value_angle: valueAngleFor(f),
    source_url: f.url,
    categories: [...LOCAL_FACT_CATEGORIES[f.kind]],
    engagement_score: Math.max(0, Math.min(100, Math.round(f.confidence * 90))),
    topic_posted_at: f.publishedAt ?? (f.eventStart ? null : f.observedAt),
    scraped_at: now.toISOString(),
    expires_at: f.expiresAt,
    status: "fresh",
    geo_relevance: { cities: f.territory.city ? [f.territory.city] : [], states: f.territory.state ? [f.territory.state.toUpperCase()] : [], zip_codes: f.territory.zipCodes },
    raw_data: { local_fact_key: f.key, local_fact: localFactRecord(f, null, now) },
  }
}

function localFactRecord(f: LocalFact, prior: Record<string, unknown> | null, now: Date): Record<string, unknown> {
  const prevCount = typeof prior?.observed_count === "number" ? (prior.observed_count as number) : 0
  return {
    kind: f.kind, excerpt: f.excerpt, publisher: f.publisher, host: f.host, provider: f.provider, source_class: f.sourceClass,
    published_at: f.publishedAt, event_start: f.eventStart, event_end: f.eventEnd, date_basis: f.dateBasis, venue: f.venue,
    territory: f.territory, confidence: f.confidence, confidence_basis: f.confidenceBasis, corroborating_urls: f.corroboratingUrls,
    compliance_note: f.complianceNote,
    observed_count: prevCount + 1,
    first_observed_at: (typeof prior?.first_observed_at === "string" ? prior.first_observed_at : null) ?? now.toISOString(),
    last_observed_at: now.toISOString(),
    rights: "title, ≤280-char excerpt, link and date only — never the article body",
  }
}

// ── The reader (what the writers ground on) ─────────────────────────────────

export interface LocalFactView {
  topicId: string
  kind: LocalFactKind
  title: string
  url: string | null
  publisher: string | null
  eventStart: string | null
  eventEnd: string | null
  publishedAt: string | null
  venue: string | null
  city: string | null
  state: string | null
  confidence: number | null
  temporal: LocalTemporal
}

/**
 * THE READER of stored local facts for one tenant (tenant-pinned). `includeExpired` adds facts
 * that expired within the last 60 days — readable as RECAPS, never as upcoming. A refused read is
 * returned as `error`, never as "nothing is happening".
 */
export async function loadLocalFacts(db: Db, brokerageId: string, opts: { now?: Date; includeExpired?: boolean; limit?: number } = {}): Promise<{ facts: LocalFactView[]; error: string | null }> {
  const now = opts.now ?? new Date()
  const limit = Math.min(opts.limit ?? 12, 50)
  if (!brokerageId) return { facts: [], error: "no tenant" }
  const since = new Date(now.getTime() - (opts.includeExpired ? 60 * DAY_MS : 0)).toISOString()
  let data: unknown, error: { message?: string } | null
  try {
    ({ data, error } = await db.from("content_topic_bank")
      .select("id, topic_title, source_url, status, expires_at, topic_posted_at, raw_data")
      .eq("brokerage_id", brokerageId)
      .contains("categories", ["local_intel"])
      .gte("expires_at", since)
      .order("expires_at", { ascending: true })
      .limit(limit * 3))
  } catch (e) {
    return { facts: [], error: `content_topic_bank read threw: ${(e as Error)?.message ?? String(e)}` }
  }
  if (error) return { facts: [], error: `content_topic_bank read refused: ${error.message ?? "unknown"}` }
  const rank: Record<LocalTemporal, number> = { ongoing: 0, upcoming: 1, current: 2, expired: 3 }
  const facts = ((data ?? []) as Array<{ id: string; topic_title: string; source_url: string | null; status: string; expires_at: string; topic_posted_at: string | null; raw_data: Record<string, any> | null }>)
    .filter((r) => r.status !== "rejected" && r.raw_data?.local_fact && (LOCAL_FACT_KINDS as readonly string[]).includes(r.raw_data.local_fact.kind))
    .map((r) => {
      const lf = r.raw_data!.local_fact as Record<string, any>
      const eventStart = typeof lf.event_start === "string" ? lf.event_start : null
      return {
        topicId: r.id, kind: lf.kind as LocalFactKind, title: r.topic_title, url: r.source_url,
        publisher: typeof lf.publisher === "string" ? lf.publisher : null,
        eventStart, eventEnd: typeof lf.event_end === "string" ? lf.event_end : null,
        publishedAt: typeof lf.published_at === "string" ? lf.published_at : null,
        venue: typeof lf.venue === "string" ? lf.venue : null,
        city: lf.territory?.city ?? null, state: lf.territory?.state ?? null,
        confidence: typeof lf.confidence === "number" ? lf.confidence : null,
        temporal: classifyLocalTemporal({ eventStart, expiresAt: r.expires_at }, now),
      }
    })
    .sort((a, b) => rank[a.temporal] - rank[b.temporal] || (a.eventStart ?? "9").localeCompare(b.eventStart ?? "9") || (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))
    .slice(0, limit)
  return { facts, error: null }
}

/** PURE — the grounding block a writer receives. It is also the RULE: no named event, date, venue,
 *  business or civic decision may appear in copy unless it is on this list. */
export function renderLocalFactsForPrompt(facts: LocalFactView[]): string {
  const upcoming = facts.filter((f) => f.temporal === "upcoming" || f.temporal === "ongoing")
  const current = facts.filter((f) => f.temporal === "current")
  const expired = facts.filter((f) => f.temporal === "expired")
  const line = (f: LocalFactView, i: number) => {
    const when = f.eventStart ? (f.eventEnd ? `${fmtDay(f.eventStart)} to ${fmtDay(f.eventEnd)}` : fmtDay(f.eventStart)) : f.publishedAt ? `reported ${fmtDay(f.publishedAt.slice(0, 10))}` : "recent"
    const where = [f.venue, [f.city, f.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ")
    return `${i + 1}. ${f.title} — ${when}${where ? ` · ${where}` : ""} · source: ${f.publisher ?? "unknown"}${f.url ? ` <${f.url}>` : ""}${f.temporal === "ongoing" ? " · HAPPENING NOW" : ""}`
  }
  const rules = "RULES: name a local event, date, venue, business or civic decision ONLY if it is listed above. Write ORIGINAL copy in the agent's voice — never reproduce a source's wording; credit the source by name and link to it. An EXPIRED item may only be mentioned as a recap, never promoted. Describe places by amenities and happenings, never by who lives there, safety, or school quality."
  if (!upcoming.length && !current.length && !expired.length) {
    return `═══ VERIFIED LOCAL FACTS ═══\n(none verified for this market right now)\nRULES: do not name any local event, date, venue, business or civic decision — none has been verified. Keep community sections general or invite readers to ask the agent what is coming up.`
  }
  return [
    "═══ VERIFIED LOCAL FACTS (local intelligence: each sourced, dated and located) ═══",
    upcoming.length ? `UPCOMING / HAPPENING NOW:\n${upcoming.map(line).join("\n")}` : "UPCOMING: (no verified upcoming events — do not name one)",
    current.length ? `LOCAL NEWS & NOTICES:\n${current.map(line).join("\n")}` : "",
    expired.length ? `EXPIRED (recap only, never promote):\n${expired.map(line).join("\n")}` : "",
    rules,
  ].filter(Boolean).join("\n")
}

// ── The pass ─────────────────────────────────────────────────────────────────

interface SearchResultLike { hits: HitLike[]; provider: string; cost: number; booked?: boolean }
type SearchFn = (p: { query: string; maxResults: number; withinDays: number | null; brokerageId: string; idempotencyKey: string }) => Promise<SearchResultLike>
interface NewsArticleLike { title: string; body: string | null; url: string; dateTimePub: string | null; source: string | null }
type NewsSearch = (p: { keyword: string; city: string; sinceDays: number }) => Promise<NewsArticleLike[]>
type FetchText = (url: string, brokerageId: string) => Promise<{ ok: boolean; status: number | null; text: string | null }>
interface RssItemLike { title: string; link: string; summary: string; published_date: string | null }
interface PullGateLike {
  resolution: { territories: Array<{ brokerage_id: string | null; city?: string | null; state?: string | null; zip_codes?: string[] | null; counties?: string[] | null }> }
  check(area: { brokerageId?: string | null; city?: string | null; state?: string | null; zip?: string | null }, opts?: { requireArea?: boolean }): { allowed: boolean; reason: string }
}

export interface LocalIntelDeps {
  db: Db
  now?: Date
  /** The ONE active-territory gate (resolved once per sweep). Default: resolveActivePullGate(db). */
  pullGate?: PullGateLike
  search?: SearchFn
  /** Resolves the NewsAPI.ai leg once per pass; null = no key (a published blind spot). */
  news?: (db: Db, brokerageId: string) => Promise<NewsSearch | null>
  fetchText?: FetchText
  parseRss?: (xml: string) => RssItemLike[] | Promise<RssItemLike[]>
  /** Platform spend never runs on a lapsed / suspended tenant (mayUseAndAfford, budget none). */
  gate?: (brokerageId: string) => Promise<{ allowed: boolean; reason: string }>
  /** LAW 5 evidence — withActionLedger; returns null when the day's pass already ran (replay). */
  ledger?: <T>(brokerageId: string, day: string, run: () => Promise<T>) => Promise<T | null>
}

export interface LocalIntelResult {
  brokerageId: string
  ran: boolean
  skipped: string | null
  territories: string[]
  kindsSearched: string[]
  searches: number
  providersNone: number
  searchCostUsd: number
  searchesBooked: number
  newsCalls: number
  feeds: { considered: number; fetched: number; robotsDenied: number; robotsUnreadable: number; outsideTerritory: number; failed: number }
  captured: number
  dropped: Record<string, number>
  merged: number
  promoted: number
  inserted: number
  updated: number
  staleMarked: number
  topicIds: string[]
  blindSpots: string[]
  errors: string[]
}

type WebSearchDeps = NonNullable<Parameters<typeof import("@/lib/ai/web-search").webSearch>[1]>

/**
 * THE production search: the registered web_search capability in "research" mode (Tavily first,
 * Exa fallback), its spend booked through webSearch's own `spend` (platform-covered, attributed to
 * the tenant, idempotent per tenant / day / place / kind). `wsDeps` is the proof's seam only (the
 * real webSearch with stubbed searchers + meter) — never set in production.
 * @proofSeam scripts/local-intel-guard.ts F1/F2 run the REAL webSearch booking through it; production caller: defaultSearch below.
 */
export function localIntelWebSearch(wsDeps?: WebSearchDeps): SearchFn {
  return async (p) => {
    const { webSearch } = await import("@/lib/ai/web-search")
    const r = await webSearch({
      query: p.query, maxResults: p.maxResults, mode: "research", ...(p.withinDays ? { withinDays: p.withinDays } : {}),
      spend: { brokerageId: p.brokerageId, systemSource: "local_intel", idempotencyKey: p.idempotencyKey },
    }, wsDeps)
    return { hits: r.hits, provider: r.provider, cost: r.cost, booked: r.booked === true }
  }
}
const defaultSearch: SearchFn = localIntelWebSearch()
const defaultNews = async (db: Db, brokerageId: string): Promise<NewsSearch | null> => {
  const { resolveNewsApiAiKey, searchNewsApiAiArticles } = await import("@/lib/content-intel/newsapi-ai")
  const apiKey = await resolveNewsApiAiKey(db, brokerageId)
  if (!apiKey) return null
  return (q) => searchNewsApiAiArticles({ apiKey, keyword: q.keyword, locationKeyword: q.city, sortBy: "date", count: 10, sinceDays: q.sinceDays })
}
const defaultFetchText: FetchText = async (url, brokerageId) => {
  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const r = await callConnector<string>({
    connector: "rss", url, method: "GET", auth: { style: "none" }, headers: { "User-Agent": LOCAL_INTEL_USER_AGENT },
    responseType: "text", timeoutMs: 15_000, brokerageId, retry: false,
  })
  return { ok: r.ok, status: r.status, text: r.ok ? (r.data ?? "") : null }
}
const defaultParseRss = async (xml: string): Promise<RssItemLike[]> => {
  const { parseRssXml } = await import("@/lib/content-intel/rss-scraper")
  return parseRssXml(xml)
}

function rotate<T>(xs: readonly T[], cap: number, offset: number): T[] {
  if (xs.length <= cap) return [...xs]
  const start = ((offset % xs.length) + xs.length) % xs.length
  return Array.from({ length: cap }, (_, i) => xs[(start + i) % xs.length])
}

/**
 * ONE tenant's local-intelligence pass. Tenant isolation: every read and write is pinned to
 * `brokerageId` (the cron iterates the pull gate's own tenants — nothing here takes a tenant from a
 * request). Spend is bounded (≤ MAX_WEB_SEARCHES searches), booked, and only for a live tenant's
 * active territories.
 * @proofSeam scripts/local-intel-guard.ts drives it in memory; production caller: runLocalIntelSweep below.
 */
export async function runLocalIntelPass(brokerageId: string, deps: LocalIntelDeps): Promise<LocalIntelResult> {
  const now = deps.now ?? new Date()
  const db = deps.db
  const day = now.toISOString().slice(0, 10)
  const dayIndex = Math.floor(now.getTime() / DAY_MS)
  const out: LocalIntelResult = {
    brokerageId, ran: false, skipped: null, territories: [], kindsSearched: [], searches: 0, providersNone: 0, searchCostUsd: 0,
    searchesBooked: 0, newsCalls: 0, feeds: { considered: 0, fetched: 0, robotsDenied: 0, robotsUnreadable: 0, outsideTerritory: 0, failed: 0 },
    captured: 0, dropped: {}, merged: 0, promoted: 0, inserted: 0, updated: 0, staleMarked: 0, topicIds: [], blindSpots: [], errors: [],
  }
  const drop = (reason: string) => { out.dropped[reason] = (out.dropped[reason] ?? 0) + 1 }

  const gate = deps.gate ?? (async (b: string) => {
    const { mayUseAndAfford } = await import("@/lib/billing/billing-access")
    const d = await mayUseAndAfford({ brokerageId: b, capability: "lead.scrape", client: db as never })
    return { allowed: d.allowed, reason: d.reason }
  })
  const verdict = await gate(brokerageId).catch((e) => ({ allowed: false, reason: `gate_threw: ${(e as Error)?.message ?? e}` }))
  if (!verdict.allowed) { out.skipped = `gate refused local intelligence: ${verdict.reason}`; return out }

  const ledger = deps.ledger ?? (async <T,>(b: string, d: string, run: () => Promise<T>): Promise<T | null> => {
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    let replayed = false
    const r = await withActionLedger(
      {
        brokerageId: b, action: "intel.local_intel.pass", actor: { type: "manager", managerKey: "campaign_orchestrator" },
        subject: { type: "brokerage", id: b }, idempotencyKey: `local_intel:${b}:${d}`, riskClass: "READ",
        systemSource: "local-intel", reasonCode: "CAMPAIGN_STEP",
        reasonDetail: "daily platform-covered local intelligence pass (territory events / civic / business / development / market news → verified facts → topic bank)",
        detail: { payer: "platform", booking: ["vendor_usage_tracking (platform_covered, systemSource local_intel)"] },
      },
      async () => ({ value: await run() as T | null }),
      { settle: () => ({ status: "executed" as const, outcome: "gathered" }), replay: () => { replayed = true; return { value: null as T | null } } },
      { client: db as never },
    )
    return replayed ? null : r.value
  })

  const body = async (): Promise<LocalIntelResult> => {
    out.ran = true
    let pullGate = deps.pullGate
    if (!pullGate) {
      const { resolveActivePullGate } = await import("@/lib/lead-pipeline/scrape-territories")
      pullGate = (await resolveActivePullGate(db)) as unknown as PullGateLike
    }
    const tenantCheck = pullGate.check({ brokerageId })
    if (!tenantCheck.allowed) { out.skipped = `no pull for this tenant: ${tenantCheck.reason}`; return out }
    const allTerritories: LocalTerritory[] = pullGate.resolution.territories
      .filter((t) => t.brokerage_id === brokerageId)
      .map((t) => ({ city: clean(t.city) || null, state: clean(t.state).toUpperCase() || null, zipCodes: (t.zip_codes ?? []).map((z) => clean(z).slice(0, 5)).filter(Boolean), counties: (t.counties ?? []).map(clean).filter(Boolean) }))
      .filter((t) => placeLabel(t))
    const seen = new Set<string>()
    const uniq = allTerritories.filter((t) => { const k = placeLabel(t).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true })
    const territories = rotate(uniq, MAX_TERRITORIES_PER_PASS, dayIndex)
    out.territories = territories.map(placeLabel)
    if (uniq.length > territories.length) out.blindSpots.push(`${uniq.length - territories.length} of ${uniq.length} territories rotate to a later day (≤${MAX_TERRITORIES_PER_PASS} per pass)`)

    const facts: LocalFact[] = []
    const take = (r: { fact: LocalFact } | { drop: string }) => { if ("drop" in r) drop(r.drop); else facts.push(r.fact) }

    // 1 — the system source the web / news legs file under (NOT NULL source_id; the tenant's off switch).
    const sys = await resolveSystemTopicSource(db, brokerageId, "local_intel")
    if (!sys.ok) out.errors.push(`system topic source unavailable — web / news legs skipped: ${sys.error}`)
    else if (!sys.active) out.blindSpots.push("web / news discovery is off: the tenant switched the local-intelligence topic source off")

    if (sys.ok && sys.active && territories.length) {
      // 2 — web discovery through the registered web_search capability (bounded, booked).
      const search = deps.search ?? defaultSearch
      let budget = MAX_WEB_SEARCHES
      territories.forEach((t, ti) => {
        for (const kind of rotate(LOCAL_FACT_KINDS, KINDS_PER_TERRITORY, dayIndex + ti)) out.kindsSearched.push(`${placeLabel(t)}:${kind}`)
      })
      for (const [ti, t] of territories.entries()) {
        for (const kind of rotate(LOCAL_FACT_KINDS, KINDS_PER_TERRITORY, dayIndex + ti)) {
          if (budget-- <= 0) break
          const spec = KIND_SPECS[kind]
          const res = await search({
            query: spec.query(placeLabel(t)), maxResults: RESULTS_PER_SEARCH, withinDays: spec.withinDays, brokerageId,
            idempotencyKey: `local_intel:${brokerageId}:${day}:${placeLabel(t).toLowerCase()}:${kind}`,
          }).catch(() => ({ hits: [], provider: "none", cost: 0 }) as SearchResultLike)
          out.searches++
          if (res.provider === "none") out.providersNone++
          out.searchCostUsd = Math.round((out.searchCostUsd + (res.cost > 0 ? res.cost : 0)) * 10000) / 10000
          if (res.booked) out.searchesBooked++
          for (const h of res.hits ?? []) {
            out.captured++
            take(factFromHit(h, { kind, territory: t, provider: res.provider, sourceClass: "web", sourceId: sys.id, now }))
          }
        }
      }
      if (out.searches > 0 && out.providersNone === out.searches) out.blindSpots.push("web search answered nothing (no Tavily / Exa key, or both empty) — web discovery produced no facts")

      // 3 — local news through the owner-selected news provider, when a licensed key resolves.
      const newsSearch = await (deps.news ?? defaultNews)(db, brokerageId).catch((e) => { out.errors.push(`news key resolution failed: ${(e as Error)?.message ?? e}`); return null })
      if (!newsSearch) out.blindSpots.push("NewsAPI.ai leg not run: no tenant key and no licensed platform NEWSAPI_AI_KEY")
      else {
        for (const [ti, t] of territories.entries()) {
          if (!clean(t.city)) continue
          const kind = rotate(LOCAL_FACT_KINDS.filter((k) => KIND_SPECS[k].newsKeyword), 1, dayIndex + ti)[0]
          const spec = KIND_SPECS[kind]
          const articles = await newsSearch({ keyword: spec.newsKeyword!, city: clean(t.city), sinceDays: spec.withinDays ?? 14 }).catch(() => [] as NewsArticleLike[])
          out.newsCalls++
          for (const a of articles) {
            out.captured++
            take(factFromHit({ title: a.title, url: a.url, snippet: a.body, publishedAt: a.dateTimePub, author: a.source }, { kind, territory: t, provider: "newsapi_ai", sourceClass: "news", sourceId: sys.id, publisher: a.source, now }))
          }
        }
      }
    } else if (!territories.length) {
      out.blindSpots.push("no active territory with a city, county or ZIP — nothing to search")
    }

    // 4 — the tenant's own community calendar / city news feeds (robots first; ICS or RSS/Atom).
    const { data: feedRows, error: feedErr } = await db.from("content_topic_sources")
      .select("id, label, source_config, is_active")
      .eq("brokerage_id", brokerageId).eq("source_type", "rss").eq("is_active", true)
    if (feedErr) out.errors.push(`content_topic_sources read refused — feeds not read: ${feedErr.message ?? "unknown"}`)
    const feeds = ((feedRows ?? []) as Array<{ id: string; label: string | null; source_config: Record<string, any> | null }>)
      .filter((r) => r.source_config?.local_intel && typeof r.source_config.feed_url === "string" && /^https?:\/\//i.test(r.source_config.feed_url))
      .slice(0, MAX_FEEDS_PER_PASS)
    const fetchText = deps.fetchText ?? defaultFetchText
    const robotsCache = new Map<string, { ok: true; txt: string | null } | { ok: false }>()
    for (const f of feeds) {
      out.feeds.considered++
      const cfg = f.source_config!.local_intel as Record<string, any>
      const feedUrl = String(f.source_config!.feed_url)
      // The feed's place is what its config says; only a config naming NO place inherits the
      // tenant's first territory (never a mix — a named city must not borrow the home ZIPs and slip
      // through the territory check on them).
      const cfgZips: string[] = Array.isArray(cfg.zip_codes) ? cfg.zip_codes.map((z: unknown) => clean(z).slice(0, 5)).filter(Boolean) : []
      const named = !!clean(cfg.city) || cfgZips.length > 0
      const home = territories[0] ?? allTerritories[0] ?? null
      const territory: LocalTerritory = named
        ? { city: clean(cfg.city) || null, state: clean(cfg.state).toUpperCase() || null, zipCodes: cfgZips, counties: [] }
        : { city: home?.city ?? null, state: home?.state ?? null, zipCodes: home?.zipCodes ?? [], counties: [] }
      const area = pullGate.check({ brokerageId, city: territory.city, state: territory.state, zip: territory.zipCodes[0] ?? null }, { requireArea: true })
      if (!area.allowed) { out.feeds.outsideTerritory++; out.blindSpots.push(`feed "${f.label ?? feedUrl}" skipped: ${area.reason}`); continue }
      let u: URL
      try { u = new URL(feedUrl) } catch { out.feeds.failed++; continue }
      if (!robotsCache.has(u.origin)) {
        const r = await fetchText(`${u.origin}/robots.txt`, brokerageId).catch(() => ({ ok: false, status: null, text: null }))
        robotsCache.set(u.origin, r.status === null ? { ok: false } : { ok: true, txt: r.ok ? r.text : null })
      }
      const robots = robotsCache.get(u.origin)!
      if (!robots.ok) { out.feeds.robotsUnreadable++; out.blindSpots.push(`feed "${f.label ?? feedUrl}" skipped: robots.txt unreachable (fail closed)`); continue }
      if (!isRobotsAllowed(robots.txt, `${u.pathname}${u.search}`, LOCAL_INTEL_USER_AGENT)) { out.feeds.robotsDenied++; continue }
      const doc = await fetchText(feedUrl, brokerageId).catch(() => ({ ok: false, status: null, text: null }))
      if (!doc.ok || !doc.text) { out.feeds.failed++; continue }
      out.feeds.fetched++
      const publisher = clean(cfg.publisher) || clean(f.label) || hostOf(feedUrl)
      const isIcs = /BEGIN:VCALENDAR/i.test(doc.text.slice(0, 2000))
      const feedKind: LocalFactKind = (LOCAL_FACT_KINDS as readonly string[]).includes(cfg.kind) ? cfg.kind : (isIcs ? "local_event" : "local_news")
      if (isIcs) {
        for (const ev of parseIcsEvents(doc.text).slice(0, FEED_ITEMS_PER_FEED * 4)) {
          out.captured++
          // An event with no URL of its own points at the feed; its UID (fragment) keeps it one row
          // of its own — (source_id, source_url) is UNIQUE on the topic bank.
          const evId = encodeURIComponent(ev.uid ?? `${ev.start}-${ev.summary}`).slice(0, 160)
          take(factFromHit({ title: ev.summary, url: ev.url ?? `${feedUrl}#${evId}`, snippet: ev.description },
            { kind: feedKind, territory, provider: "feed", sourceClass: "configured_feed", sourceId: f.id, publisher, placeImplicit: true, structured: { start: ev.start, end: ev.end, venue: ev.location }, keySuffix: ev.url ? undefined : evId, now }))
        }
      } else {
        const items = await (deps.parseRss ?? defaultParseRss)(doc.text)
        for (const it of items.slice(0, FEED_ITEMS_PER_FEED)) {
          out.captured++
          take(factFromHit({ title: it.title, url: it.link, snippet: it.summary, publishedAt: it.published_date },
            { kind: feedKind, territory, provider: "feed", sourceClass: "configured_feed", sourceId: f.id, publisher, placeImplicit: true, now }))
        }
      }
    }

    // 5 — one fact per URL / per story across hosts; the confidence floor.
    const merged = mergeLocalFacts(facts)
    out.merged = merged.length
    const kept = merged.filter((f) => { if (f.confidence < MIN_CONFIDENCE) { drop("low_confidence"); return false } return true })
    out.promoted = kept.length

    // 6 — persist into the ONE topic pool (re-observation updates; never resurrects a used / rejected row).
    if (kept.length) {
      const urls = kept.map((f) => f.url)
      const { data: existing, error: exErr } = await db.from("content_topic_bank")
        .select("id, status, categories, raw_data, source_id, source_url")
        .eq("brokerage_id", brokerageId).in("source_url", urls)
      if (exErr) out.errors.push(`content_topic_bank read refused — facts not stored: ${exErr.message ?? "unknown"}`)
      else {
        const byUrl = new Map<string, { id: string; status: string; categories: string[] | null; raw_data: Record<string, any> | null }>()
        for (const r of (existing ?? []) as Array<{ id: string; status: string; categories: string[] | null; raw_data: Record<string, any> | null; source_url: string }>) if (!byUrl.has(r.source_url)) byUrl.set(r.source_url, r)
        for (const f of kept) {
          const row = topicRowForFact(f, brokerageId, now)
          const prior = byUrl.get(f.url)
          if (prior) {
            const patch = {
              topic_title: row.topic_title, value_angle: row.value_angle, engagement_score: row.engagement_score,
              categories: [...new Set([...(prior.categories ?? []), ...(row.categories as string[])])],
              geo_relevance: row.geo_relevance, expires_at: row.expires_at, scraped_at: row.scraped_at,
              status: prior.status === "used" || prior.status === "rejected" ? prior.status : "fresh",
              raw_data: { ...(prior.raw_data ?? {}), local_fact_key: f.key, local_fact: localFactRecord(f, prior.raw_data?.local_fact ?? null, now) },
            }
            const { data: upd, error: updErr } = await db.from("content_topic_bank").update(patch).eq("id", prior.id).eq("brokerage_id", brokerageId).select("id")
            if (updErr || !(upd ?? []).length) out.errors.push(`content_topic_bank update for ${f.url} refused or matched nothing: ${updErr?.message ?? "0 rows"}`)
            else { out.updated++; out.topicIds.push(prior.id) }
          } else {
            const { data: ins, error: insErr } = await db.from("content_topic_bank").insert(row).select("id")
            if (insErr) {
              if (insErr.code === "23505") drop("duplicate_raced")
              else out.errors.push(`content_topic_bank insert refused (${f.url}): ${insErr.message ?? "unknown"}`)
            } else {
              out.inserted++
              const id = (Array.isArray(ins) ? ins[0] : ins)?.id
              if (id) out.topicIds.push(String(id))
            }
          }
        }
      }
    }

    // 7 — expired facts leave the fresh pool (status 'stale'); they stay readable as recaps.
    const { data: stale, error: staleErr } = await db.from("content_topic_bank")
      .update({ status: "stale" })
      .eq("brokerage_id", brokerageId).eq("status", "fresh").contains("categories", ["local_intel"]).lt("expires_at", now.toISOString())
      .select("id")
    if (staleErr) out.errors.push(`stale sweep refused: ${staleErr.message ?? "unknown"}`)
    else out.staleMarked = (stale ?? []).length
    return out
  }

  const r = await ledger(brokerageId, day, body)
  if (r === null) { out.skipped = `already gathered today (${day}) — ledger replay`; return out }
  return r
}

/**
 * THE CRON SWEEP (/api/cron/local-intel, owner campaign_orchestrator). ONE pull-gate resolution;
 * every live tenant WITH an active territory, bounded by tenants-per-run and a wall-clock budget. A
 * refused gate read fails CLOSED (nobody is searched) under its own reason.
 */
export async function runLocalIntelSweep(db: Db, opts: { now?: Date; maxTenants?: number; budgetMs?: number; pullGate?: PullGateLike } = {}): Promise<{ tenants: number; ran: number; skipped: number; facts: number; platformCostUsd: number; reason: string; errors: string[] }> {
  const started = Date.now()
  const out = { tenants: 0, ran: 0, skipped: 0, facts: 0, platformCostUsd: 0, reason: "ok", errors: [] as string[] }
  let pullGate = opts.pullGate
  if (!pullGate) {
    const { resolveActivePullGate } = await import("@/lib/lead-pipeline/scrape-territories")
    pullGate = (await resolveActivePullGate(db)) as unknown as PullGateLike
  }
  const res = pullGate.resolution as PullGateLike["resolution"] & { noOp?: boolean; reason?: string; error?: string }
  if (res.noOp) { out.reason = res.reason ?? "no_pull"; if (res.error) out.errors.push(res.error); return out }
  const tenants = [...new Set(res.territories.map((t) => t.brokerage_id).filter((b): b is string => !!b))]
  for (const b of tenants) {
    if (out.ran >= (opts.maxTenants ?? 25) || Date.now() - started > (opts.budgetMs ?? 240_000)) break
    out.tenants++
    try {
      const r = await runLocalIntelPass(b, { db, now: opts.now, pullGate })
      if (r.ran && !r.skipped) out.ran++
      else out.skipped++
      out.facts += r.inserted + r.updated
      out.platformCostUsd = Math.round((out.platformCostUsd + r.searchCostUsd) * 10000) / 10000
      for (const e of r.errors.slice(0, 3)) out.errors.push(`${b}: ${e}`)
    } catch (e) {
      out.errors.push(`${b}: ${(e as Error)?.message ?? String(e)}`)
    }
  }
  return out
}
