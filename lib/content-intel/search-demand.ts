// lib/content-intel/search-demand.ts
// ─────────────────────────────────────────────────────────────────────────────
// GOOGLE SEARCH DEMAND / KEYWORD INTELLIGENCE → THE CANONICAL TOPIC POOL (wave 154, lane 154B — owner ruling R5(b):
// "the other google idea is looking for popular searched keywords … so the content idea can get stored in the topic pool";
// directive B2 / B3).
//
// THIS IS OPERATION 2 ONLY. It never produces a person: every producer below reads AGGREGATE demand (a regional trend, the
// tenant's own Search Console totals, counts of consented buyer statements, keyword rows) and emits TopicIdea records for
// THE ONE intake (lane 154C, lib/content-intel/topic-intake.ts intakeTopicIdeas — injected as `deps.intake`; this module
// never inserts into content_topic_bank). Operation 1 (people who publicly state a housing need → RawData) is
// lib/acquisition-plays/public-request.ts and is not reachable from here.
//
// PRODUCERS — each takes an injected transport and says honestly when it is not connected (zero rows, never invented):
//   · trends         Google Trends / aggregate regional topic interest. NOT CONNECTED: Google's Trends API is an
//                    access-limited alpha and no grant is on record (OWNER-HELD); trends.google.com is never scraped.
//                    A relative index stays relative — evidence.kind 'proxy', unit 'relative_index_0_100', never a count.
//   · search_console The tenant's OWN verified site: queries, impressions, clicks, CTR, position, pages, regions and the
//                    change against the previous window. NOT CONNECTED: no Search Console adapter or OAuth grant exists
//                    (lib/geo/search-visibility.ts says the same — "Google organic NOT MEASURED"); the tenant's
//                    webmasters.readonly grant is OWNER-HELD. Rows are whitelisted field by field: nothing on a row can
//                    carry an identity into an idea, and anonymized-query / row-truncation caveats ride every idea.
//   · first_party    Consented first-party search statements on the tenant's portal / site / calls
//                    (buyer_criteria_utterances — written ONLY by lib/buyer-search/criteria-turn.ts recordStatedCriteriaTurn,
//                    consent_basis stated by the door). Aggregated into buyer-demand categories × city, counted by
//                    DISTINCT contacts and shown only at FIRST_PARTY_MIN_CONTACTS or more; the literal words, the contact
//                    and the agent never leave this function — the idea carries a category label and a count.
//   · keyword_intel  The existing keyword_intelligence rows (lib/competitive-intel/content-intel-scan.ts). Their stored
//                    `keyword` is an ARTICLE TITLE (someone else's wording) — never used as a title here; the idea is
//                    reworded from the niche + an extracted keyphrase, and the number is classified by
//                    lib/content-intel/search-demand-volume.ts (relative index, or UNKNOWN — never searches).
//
// TENANT: every call takes the brokerage the CALLER resolved (session for the action, the cron's own walk for the cron);
// every read is pinned to it. Not server-only (proofs drive it with an in-memory client and fake transports).

import { displaySearchVolume } from "./search-demand-volume"

type Db = { from: (table: string) => any }

// ── THE TOPIC-POOL CONTRACT (wave 154 charter — lane 154C builds the real intake) ──────────────────────────────────

export type TopicIdea = {
  sourceKind: string
  /** The REWORDED consumer question / topic — never a source's own wording. */
  title: string
  angle?: string | null
  categories?: string[]
  geo?: { city?: string | null; state?: string | null; zip?: string | null; label?: string | null } | null
  sourceUrl?: string | null
  publishedAt?: string | null
  observedAt: string
  expiresAt?: string | null
  evidence: { kind: "measured" | "proxy" | "unknown"; metric?: string | null; value?: number | null; unit?: string | null; note?: string | null }
  rights: "licensed" | "own_content" | "public_read_reworded" | "first_party" | "unknown"
  brief?: Record<string, unknown> | null
  dedupKey?: string | null
}

export type TopicIntakeResult = { ok: boolean; inserted: number; merged: number; excluded: Array<{ title: string; reason: string }>; refused?: string }
export type TopicIntake = (db: Db, a: { brokerageId: string; ideas: TopicIdea[]; now?: Date }) => Promise<TopicIntakeResult>

/**
 * PRODUCTION DEFAULT — null until the integrator wires lane 154C's intake (Outside-lane request, ONE line):
 *   export const productionTopicIntake: TopicIntake | null = async (db, a) => (await import("@/lib/content-intel/topic-intake")).intakeTopicIdeas(db as never, a)
 * While null, every scan still reads and reports its ideas, says `intake_unwired`, and stores nothing.
 */
export const productionTopicIntake: TopicIntake | null = async (db, a) => (await import("@/lib/content-intel/topic-intake")).intakeTopicIdeas(db as never, a)

/** One vocabulary — the sourceKind every idea from this module carries. */
export const SEARCH_DEMAND_SOURCE_KINDS = {
  trends: "google_trends", // wave 154 (154G1, §6): the live content_topic_sources.source_type spelling, and RELATIVE_INDEX_SOURCES' key — was "search_demand_trends"
  search_console: "search_demand_search_console",
  first_party: "search_demand_first_party",
  keyword_intel: "search_demand_keyword_intel",
} as const
export type SearchDemandProducer = keyof typeof SEARCH_DEMAND_SOURCE_KINDS

export type ProducerStatus = "ran" | "nothing_found" | "not_connected" | "owner_held" | "refused"

export interface ProducerReport {
  producer: SearchDemandProducer
  status: ProducerStatus
  reason: string | null
  rowsRead: number
  ideas: TopicIdea[]
  caveats: string[]
}

const DAY_MS = 86_400_000
const TOPIC_TTL_DAYS = 14
const clean = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "")
const iso = (d: Date) => d.toISOString()
const geoLabelOf = (g: { city?: string | null; state?: string | null; label?: string | null } | null | undefined) =>
  clean(g?.label) || [clean(g?.city), clean(g?.state)].filter(Boolean).join(", ")

/** PURE — one vocabulary of content categories a demand phrase falls into (the topic bank's existing category words). */
function demandCategoriesOf(text: string): string[] {
  const t = text.toLowerCase()
  const out = new Set<string>()
  if (/\b(buy|buying|first[- ]time|homes? for sale|house hunting|pre-?approv|offer)\b/.test(t)) out.add("buyer_advice")
  if (/\b(sell|selling|list(ing)? my|home value|worth|by owner|fsbo)\b/.test(t)) out.add("seller_advice")
  if (/\b(mortgage|rate|rates|loan|down payment|refinanc|closing cost|afford)\b/.test(t)) out.add("finance")
  if (/\b(market|prices?|inventory|forecast|trend|median)\b/.test(t)) out.add("market_education")
  if (/\b(neighbou?rhood|school|commute|park|downtown|things to do|moving to|relocat)\b/.test(t)) out.add("neighborhood")
  if (/\b(renovat|remodel|repair|yard|pool|kitchen|roof|landscap)\b/.test(t)) out.add("home_improvement")
  return out.size ? [...out] : ["market_education"]
}

// ── PRODUCER 1: GOOGLE TRENDS / AGGREGATE REGIONAL TOPIC INTEREST ─────────────────────────────────────────────────

export interface TrendsPoint {
  term: string
  geo: { label?: string | null; city?: string | null; state?: string | null; code?: string | null }
  /** Google's relative interest, 0–100 (100 = the peak for this term, region and window). NEVER a search count. */
  relativeIndex: number
  windowStart: string
  windowEnd: string
  /** Rising-query change the provider reports, percent; null when not reported. */
  risingPct?: number | null
}

export interface TrendsTransport {
  readonly provider: string
  /** The rights basis of THIS transport (a granted API is 'licensed'). */
  readonly rights: TopicIdea["rights"]
  fetchRegional(a: { geo: { city?: string | null; state?: string | null; code?: string | null }; category: "real_estate" }): Promise<{ ok: true; points: TrendsPoint[] } | { ok: false; error: string }>
}

/** The production Trends transport: none. Google's Trends API is an access-limited alpha with no grant on record — OWNER-HELD.
 *  Scraping trends.google.com is not an option this module takes. */
export function productionTrendsTransport(): TrendsTransport | null { return null }

/** PURE — one trend point → one topic idea (or why not). */
/** @proofSeam scripts/google-intelligence-guard.ts checks one trend row's evidence labels; production caller trendsProducer in this file. */
export function trendIdea(p: TrendsPoint, now: Date): { idea: TopicIdea | null; why: string | null } {
  const term = clean(p.term)
  const where = geoLabelOf(p.geo)
  if (!term) return { idea: null, why: "no term" }
  if (!where) return { idea: null, why: "no region — an unlocated trend is not a local topic" }
  if (typeof p.relativeIndex !== "number" || !Number.isFinite(p.relativeIndex) || p.relativeIndex < 0 || p.relativeIndex > 100) return { idea: null, why: `relative index outside 0–100 (${String(p.relativeIndex)})` }
  if (p.relativeIndex === 0) return { idea: null, why: "no measurable relative interest in this window" }
  const rising = typeof p.risingPct === "number" && Number.isFinite(p.risingPct) ? Math.round(p.risingPct) : null
  return {
    idea: {
      sourceKind: SEARCH_DEMAND_SOURCE_KINDS.trends,
      title: `What ${where} residents are asking about ${term.toLowerCase()} — a local explainer`,
      angle: rising != null ? `Interest is rising (${rising > 0 ? "+" : ""}${rising}% in the provider's rising-query view)` : "Steady regional interest",
      categories: demandCategoriesOf(term),
      geo: { city: p.geo.city ?? null, state: p.geo.state ?? null, label: where },
      sourceUrl: null,
      publishedAt: p.windowEnd,
      observedAt: iso(now),
      expiresAt: iso(new Date(now.getTime() + TOPIC_TTL_DAYS * DAY_MS)),
      evidence: { kind: "proxy", metric: "relative_search_interest", value: Math.round(p.relativeIndex), unit: "relative_index_0_100", note: `Relative to the peak interest for this term in ${where}, ${p.windowStart.slice(0, 10)} to ${p.windowEnd.slice(0, 10)} — not a count of searches` },
      rights: "unknown",
      dedupKey: `trends:${where.toLowerCase()}:${term.toLowerCase()}`,
    },
    why: null,
  }
}

/** @proofSeam scripts/google-intelligence-guard.ts drives this producer with a recording transport; production caller runSearchDemandScan in this file. */
export async function trendsProducer(transport: TrendsTransport | null, a: { geo: { city?: string | null; state?: string | null }; now: Date }): Promise<ProducerReport> {
  const base = { producer: "trends" as const, rowsRead: 0, ideas: [] as TopicIdea[], caveats: [] as string[] }
  if (!transport) return { ...base, status: "not_connected", reason: "Google Trends is not connected — Google's Trends API is access-limited and no grant is on record (OWNER-HELD); nothing is scraped and nothing is invented" }
  const r = await transport.fetchRegional({ geo: a.geo, category: "real_estate" })
  if (!r.ok) return { ...base, status: "refused", reason: `${transport.provider}: ${r.error}` }
  const ideas: TopicIdea[] = []
  for (const p of r.points) {
    const { idea, why } = trendIdea(p, a.now)
    if (idea) ideas.push({ ...idea, rights: transport.rights })
    else base.caveats.push(`skipped "${clean(p.term)}": ${why}`)
  }
  return { ...base, rowsRead: r.points.length, ideas, status: ideas.length ? "ran" : "nothing_found", reason: null }
}

// ── PRODUCER 2: SEARCH CONSOLE — THE TENANT'S OWN AUTHORIZED SITE ─────────────────────────────────────────────────

export interface SearchConsoleRow {
  /** null = a query Google anonymized (it never reports who searched — and suppresses rare queries entirely). */
  query: string | null
  page?: string | null
  country?: string | null
  clicks: number
  impressions: number
  ctr?: number | null
  position?: number | null
}

export interface SearchConsoleReport {
  siteUrl: string
  startDate: string
  endDate: string
  rows: SearchConsoleRow[]
  /** Property totals for the window (include anonymized queries), when the transport read them. */
  totals?: { clicks: number; impressions: number } | null
  /** The row limit the request asked for — a full page means the list was truncated. */
  rowLimit: number
  /** The previous window's rows, for the change. */
  previousRows?: SearchConsoleRow[] | null
}

export interface SearchConsoleTransport {
  readonly provider: string
  query(a: { siteUrl: string; startDate: string; endDate: string }): Promise<{ ok: true; report: SearchConsoleReport } | { ok: false; error: string }>
}

/** The production Search Console transport: none. No adapter or OAuth grant (webmasters.readonly) exists — OWNER-HELD per tenant. */
export function productionSearchConsoleTransport(): SearchConsoleTransport | null { return null }

/** PURE — the only fields of a Search Console row this module keeps. Anything else on a row is dropped here, by name. */
function whitelistSearchConsoleRow(r: Record<string, unknown>): SearchConsoleRow {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  const o = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null)
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null)
  return { query: s(r.query), page: s(r.page), country: s(r.country), clicks: n(r.clicks), impressions: n(r.impressions), ctr: o(r.ctr), position: o(r.position) }
}

/** PURE — the caveats Google's own reporting carries, said beside every idea. */
function searchConsoleCaveats(rep: SearchConsoleReport, rows: SearchConsoleRow[]): string[] {
  const out: string[] = []
  const anonymizedRows = rows.filter((r) => !r.query).length
  const listed = rows.reduce((s, r) => s + r.impressions, 0)
  if (rep.totals && rep.totals.impressions > listed) out.push(`${rep.totals.impressions - listed} of ${rep.totals.impressions} impressions are in anonymized or suppressed queries Google does not list — they cannot be attributed to a query, let alone a person`)
  else if (!rep.totals) out.push("property totals not read — the share of anonymized / suppressed queries is unknown")
  if (anonymizedRows) out.push(`${anonymizedRows} row(s) carried no query (anonymized) and were not used as topics`)
  if (rows.length >= rep.rowLimit) out.push(`the list hit the ${rep.rowLimit}-row limit — lower-volume queries were truncated`)
  return out
}

/** @proofSeam scripts/google-intelligence-guard.ts drives this producer with a recording transport; production caller runSearchDemandScan in this file. */
export async function searchConsoleProducer(
  transport: SearchConsoleTransport | null,
  a: { site: { url: string; verifiedOwner: boolean } | null; now: Date; windowDays?: number; maxIdeas?: number },
): Promise<ProducerReport> {
  const base = { producer: "search_console" as const, rowsRead: 0, ideas: [] as TopicIdea[], caveats: [] as string[] }
  if (!a.site) return { ...base, status: "owner_held", reason: "No tenant website is recorded for Search Console — the tenant connects their own verified property (OWNER-HELD)" }
  if (!a.site.verifiedOwner) return { ...base, status: "refused", reason: "Search Console reads only a property the tenant has verified they own" }
  if (!transport) return { ...base, status: "not_connected", reason: "Search Console is not connected — the tenant's Google grant (webmasters.readonly) is OWNER-HELD; zero rows, none invented" }
  const days = a.windowDays ?? 28
  const end = new Date(a.now.getTime() - 2 * DAY_MS) // Search Console data lags ~2 days
  const start = new Date(end.getTime() - days * DAY_MS)
  const r = await transport.query({ siteUrl: a.site.url, startDate: iso(start).slice(0, 10), endDate: iso(end).slice(0, 10) })
  if (!r.ok) return { ...base, status: "refused", reason: `${transport.provider}: ${r.error}` }
  const rows = r.report.rows.map((x) => whitelistSearchConsoleRow(x as unknown as Record<string, unknown>))
  const prev = new Map<string, number>()
  for (const p of (r.report.previousRows ?? []).map((x) => whitelistSearchConsoleRow(x as unknown as Record<string, unknown>))) if (p.query) prev.set(p.query.toLowerCase(), (prev.get(p.query.toLowerCase()) ?? 0) + p.impressions)
  const caveats = searchConsoleCaveats(r.report, rows)
  const byQuery = new Map<string, { query: string; clicks: number; impressions: number; pages: Set<string>; regions: Set<string>; posSum: number; posN: number }>()
  for (const x of rows) {
    if (!x.query || x.impressions <= 0) continue
    const k = x.query.toLowerCase()
    const g = byQuery.get(k) ?? { query: x.query, clicks: 0, impressions: 0, pages: new Set<string>(), regions: new Set<string>(), posSum: 0, posN: 0 }
    g.clicks += x.clicks; g.impressions += x.impressions
    if (x.page) g.pages.add(x.page)
    if (x.country) g.regions.add(x.country)
    if (x.position != null) { g.posSum += x.position * x.impressions; g.posN += x.impressions }
    byQuery.set(k, g)
  }
  const ranked = [...byQuery.values()].sort((p, q) => q.impressions - p.impressions).slice(0, a.maxIdeas ?? 10)
  const ideas: TopicIdea[] = ranked.map((g) => {
    const before = prev.get(g.query.toLowerCase())
    const change = before != null && before > 0 ? Math.round(((g.impressions - before) / before) * 100) : null
    const ctr = g.impressions > 0 ? Math.round((g.clicks / g.impressions) * 1000) / 10 : null
    const pos = g.posN > 0 ? Math.round((g.posSum / g.posN) * 10) / 10 : null
    return {
      sourceKind: SEARCH_DEMAND_SOURCE_KINDS.search_console,
      title: `A clear answer for people searching "${g.query}"`,
      angle: ctr != null && ctr < 2 ? "Seen often, clicked rarely — the page that answers this needs a better answer" : change != null && change > 0 ? `Impressions up ${change}% on the previous window` : null,
      categories: demandCategoriesOf(g.query),
      geo: null,
      sourceUrl: [...g.pages][0] ?? null,
      publishedAt: r.report.endDate,
      observedAt: iso(a.now),
      expiresAt: iso(new Date(a.now.getTime() + TOPIC_TTL_DAYS * DAY_MS)),
      evidence: {
        kind: "measured", metric: "search_console_impressions", value: g.impressions, unit: "impressions",
        note: [`${g.clicks} clicks`, ctr != null ? `CTR ${ctr}%` : null, pos != null ? `avg position ${pos}` : null, change != null ? `${change >= 0 ? "+" : ""}${change}% vs previous window` : "no previous-window figure", `regions: ${[...g.regions].join(", ") || "not reported"}`, `on ${r.report.siteUrl} ${r.report.startDate}..${r.report.endDate}`, ...caveats].filter(Boolean).join("; "),
      },
      rights: "first_party",
      brief: { pages: [...g.pages].slice(0, 5), regions: [...g.regions].slice(0, 10) },
      dedupKey: `gsc:${r.report.siteUrl}:${g.query.toLowerCase()}`,
    }
  })
  return { ...base, rowsRead: rows.length, ideas, caveats, status: ideas.length ? "ran" : "nothing_found", reason: null }
}

// ── PRODUCER 3: CONSENTED FIRST-PARTY SEARCH STATEMENTS → BUYER DEMAND CATEGORIES ────────────────────────────────

/** A demand category becomes a topic only when this many DISTINCT contacts stated it — fewer could single someone out.
 *  A privacy floor (owner-adjustable policy), not a measurement. */
export const FIRST_PARTY_MIN_CONTACTS = 3
export const FIRST_PARTY_WINDOW_DAYS = 60

/** Lifestyle kinds as topic labels (kind-level only — a named destination or the buyer's own words never leave). */
const LIFESTYLE_TOPIC: Readonly<Record<string, string>> = {
  natural_light: "homes with great natural light", commute: "commute-friendly neighborhoods", layout: "open and flexible floor plans",
  accessibility: "single-level and accessible homes", nearby_amenity: "homes near parks and everyday amenities",
  outdoor_space: "homes with a large private yard", quiet_setting: "quiet streets and low-traffic settings",
}

interface UtteranceRow { contact_id: string | null; consent_basis: string | null; created_at: string | null; interpretation: Record<string, any> | null }

/** PURE — consented statements → demand categories × city with distinct-contact counts (no words, no ids out). */
/** @proofSeam scripts/google-intelligence-guard.ts drives the first-party aggregation on fixture rows; production caller firstPartyDemandProducer in this file. */
export function aggregateFirstPartyDemand(rows: readonly UtteranceRow[]): Array<{ label: string; city: string | null; contacts: number; lastAt: string | null }> {
  const g = new Map<string, { label: string; city: string | null; who: Set<string>; lastAt: string | null }>()
  for (const r of rows) {
    if (!r.contact_id || !r.consent_basis) continue // no stated consent → not used (never assumed)
    const i = r.interpretation ?? {}
    const crit = (i.criteria ?? {}) as Record<string, any>
    const city = Array.isArray(crit.cities) && typeof crit.cities[0] === "string" ? clean(crit.cities[0]) || null : null
    const labels = new Set<string>()
    for (const l of Array.isArray(i.lifestyle) ? i.lifestyle : []) { const t = LIFESTYLE_TOPIC[String(l?.kind ?? "")]; if (t) labels.add(t) }
    for (const f of Array.isArray(crit.features) ? crit.features : []) { const w = clean(f).toLowerCase(); if (w && /^[a-z][a-z \-]{1,30}$/.test(w)) labels.add(`homes with a ${w}`) }
    for (const label of labels) {
      const k = `${label}|${(city ?? "").toLowerCase()}`
      const e = g.get(k) ?? { label, city, who: new Set<string>(), lastAt: null }
      e.who.add(r.contact_id)
      if (r.created_at && (!e.lastAt || r.created_at > e.lastAt)) e.lastAt = r.created_at
      g.set(k, e)
    }
  }
  return [...g.values()].map((e) => ({ label: e.label, city: e.city, contacts: e.who.size, lastAt: e.lastAt })).sort((a, b) => b.contacts - a.contacts)
}

/** @proofSeam scripts/google-intelligence-guard.ts drives this producer alone; production caller runSearchDemandScan in this file. */
export async function firstPartyDemandProducer(db: Db, a: { brokerageId: string; now: Date; state?: string | null }): Promise<ProducerReport> {
  const base = { producer: "first_party" as const, rowsRead: 0, ideas: [] as TopicIdea[], caveats: [] as string[] }
  const since = iso(new Date(a.now.getTime() - FIRST_PARTY_WINDOW_DAYS * DAY_MS))
  const { data, error } = await db.from("buyer_criteria_utterances")
    .select("contact_id, consent_basis, created_at, interpretation")
    .eq("brokerage_id", a.brokerageId)
    .not("consent_basis", "is", null)
    .gte("created_at", since)
    .limit(2000)
  if (error) return { ...base, status: "refused", reason: `buyer_criteria_utterances read refused: ${error.message ?? "unknown"}` }
  const rows = (data ?? []) as UtteranceRow[]
  const groups = aggregateFirstPartyDemand(rows)
  const kept = groups.filter((x) => x.contacts >= FIRST_PARTY_MIN_CONTACTS)
  const held = groups.length - kept.length
  if (held) base.caveats.push(`${held} demand categor${held === 1 ? "y" : "ies"} held below the ${FIRST_PARTY_MIN_CONTACTS}-contact privacy floor`)
  const ideas: TopicIdea[] = kept.map((x) => ({
    sourceKind: SEARCH_DEMAND_SOURCE_KINDS.first_party,
    title: `${x.label.charAt(0).toUpperCase()}${x.label.slice(1)}${x.city ? ` in ${x.city}` : ""}: what buyers should know before they search`,
    angle: "Buyers are asking us for this — an educational guide and a better saved search",
    categories: ["buyer_advice", ...demandCategoriesOf(x.label).filter((c) => c !== "buyer_advice")],
    geo: x.city ? { city: x.city, state: a.state ?? null, label: x.city } : null,
    sourceUrl: null,
    publishedAt: x.lastAt,
    observedAt: iso(a.now),
    expiresAt: iso(new Date(a.now.getTime() + TOPIC_TTL_DAYS * DAY_MS)),
    evidence: { kind: "measured", metric: "consented_buyer_statements", value: x.contacts, unit: "distinct_contacts", note: `distinct buyers who stated this on a consented first-party channel in the last ${FIRST_PARTY_WINDOW_DAYS} days (this tenant only); their words and identities are not part of the topic` },
    rights: "first_party",
    dedupKey: `fp:${x.label}:${(x.city ?? "").toLowerCase()}`,
  }))
  return { ...base, rowsRead: rows.length, ideas, status: ideas.length ? "ran" : "nothing_found", reason: null }
}

// ── PRODUCER 4: THE EXISTING keyword_intelligence ROWS ────────────────────────────────────────────────────────────

const NICHE_LABEL: Readonly<Record<string, string>> = { buyer_advice: "Buying a home", seller_advice: "Selling a home", finance: "Mortgages and money", market_education: "Understanding the market", neighborhood: "Neighborhood life", home_improvement: "Improving a home" }

async function keywordIntelProducer(db: Db, a: { brokerageId: string; now: Date }): Promise<ProducerReport> {
  const base = { producer: "keyword_intel" as const, rowsRead: 0, ideas: [] as TopicIdea[], caveats: [] as string[] }
  const { data, error } = await db.from("keyword_intelligence")
    .select("id, source, intent_category, related_keywords, search_volume_monthly, trend_direction, trend_change_pct, city, state, zip_code, captured_at, expires_at")
    .eq("brokerage_id", a.brokerageId)
    .limit(200)
  if (error) return { ...base, status: "refused", reason: `keyword_intelligence read refused: ${error.message ?? "unknown"}` }
  const nowIso = iso(a.now)
  const rows = ((data ?? []) as Array<Record<string, any>>).filter((r) => !r.expires_at || r.expires_at > nowIso)
  const seen = new Set<string>()
  const ideas: TopicIdea[] = []
  for (const r of rows) {
    const phrase = (Array.isArray(r.related_keywords) ? r.related_keywords : []).map(clean).find((p: string) => p.length >= 4 && p.split(" ").length <= 5)
    const niche = NICHE_LABEL[String(r.intent_category ?? "")] ?? null
    if (!phrase || !niche) continue
    const where = [clean(r.city), clean(r.state)].filter(Boolean).join(", ")
    const key = `kw:${String(r.intent_category)}:${phrase.toLowerCase()}:${where.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    const vol = displaySearchVolume(r.source, r.search_volume_monthly)
    ideas.push({
      sourceKind: SEARCH_DEMAND_SOURCE_KINDS.keyword_intel,
      title: `${niche}${where ? ` in ${where}` : ""}: ${phrase}`,
      angle: r.trend_direction === "rising" ? "A rising topic in published content" : null,
      categories: [String(r.intent_category)],
      geo: where ? { city: r.city ?? null, state: r.state ?? null, zip: r.zip_code ?? null, label: where } : null,
      sourceUrl: null,
      publishedAt: r.captured_at ?? null,
      observedAt: nowIso,
      expiresAt: r.expires_at ?? iso(new Date(a.now.getTime() + TOPIC_TTL_DAYS * DAY_MS)),
      evidence: vol.searchCount != null
        ? { kind: "measured", metric: "estimated_monthly_searches", value: vol.searchCount, unit: "searches_per_month", note: vol.basis.label }
        : vol.relativeIndex != null
          ? { kind: "proxy", metric: `${String(r.source)}_relative_index`, value: vol.relativeIndex, unit: "relative_index_0_100", note: vol.basis.label }
          : { kind: "unknown", metric: null, value: null, unit: null, note: vol.basis.label },
      rights: "public_read_reworded",
      dedupKey: key,
    })
  }
  return { ...base, rowsRead: rows.length, ideas, status: ideas.length ? "ran" : "nothing_found", reason: null }
}

// ── THE SCAN ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SearchDemandDeps {
  /** THE ONE intake (lane 154C). `null` → read and report, store nothing (intake_unwired). */
  intake: TopicIntake | null
  trends?: TrendsTransport | null
  searchConsole?: SearchConsoleTransport | null
}

export interface SearchDemandScanResult {
  ok: boolean
  brokerageId: string | null
  producers: ProducerReport[]
  /** Person records this operation produced — structurally ZERO (no producer has an identity field to emit). */
  personRecords: 0
  intake: TopicIntakeResult | { ok: false; inserted: 0; merged: 0; excluded: []; refused: string } | null
  intakeStatus: "stored" | "intake_unwired" | "nothing_to_store" | "refused"
}

/**
 * One tenant's search-demand pass. The tenant is the CALLER's (session or the cron's own walk) — never a body field.
 * A refused read is a producer's status, not a thrown error; the intake receives only reworded, identity-free ideas.
 */
export async function runSearchDemandScan(
  db: Db,
  a: { brokerageId: string | null; now?: Date; geo?: { city?: string | null; state?: string | null }; site?: { url: string; verifiedOwner: boolean } | null },
  deps: SearchDemandDeps,
): Promise<SearchDemandScanResult> {
  const now = a.now ?? new Date()
  if (!a.brokerageId) return { ok: false, brokerageId: null, producers: [], personRecords: 0, intake: null, intakeStatus: "refused" }
  const producers = [
    await trendsProducer(deps.trends ?? null, { geo: a.geo ?? {}, now }),
    await searchConsoleProducer(deps.searchConsole ?? null, { site: a.site ?? null, now }),
    await firstPartyDemandProducer(db, { brokerageId: a.brokerageId, now, state: a.geo?.state ?? null }),
    await keywordIntelProducer(db, { brokerageId: a.brokerageId, now }),
  ]
  const ideas = producers.flatMap((p) => p.ideas)
  if (ideas.length === 0) return { ok: true, brokerageId: a.brokerageId, producers, personRecords: 0, intake: null, intakeStatus: "nothing_to_store" }
  if (!deps.intake) return { ok: true, brokerageId: a.brokerageId, producers, personRecords: 0, intake: null, intakeStatus: "intake_unwired" }
  const res = await deps.intake(db, { brokerageId: a.brokerageId, ideas, now })
  return { ok: res.ok, brokerageId: a.brokerageId, producers, personRecords: 0, intake: res, intakeStatus: res.ok ? "stored" : "refused" }
}

/**
 * The cron's walk: tenants with consented first-party statements in the window (the one connected producer today), each
 * scanned under its own id. Trends / Search Console stay `not_connected` / `owner_held` until their grants exist.
 */
export async function runSearchDemandCron(db: Db, deps: SearchDemandDeps, now: Date = new Date()): Promise<{ tenants: number; ideas: number; stored: number; statuses: Record<string, number>; error: string | null }> {
  const since = iso(new Date(now.getTime() - FIRST_PARTY_WINDOW_DAYS * DAY_MS))
  const { data, error } = await db.from("buyer_criteria_utterances").select("brokerage_id").not("consent_basis", "is", null).gte("created_at", since).limit(5000)
  if (error) return { tenants: 0, ideas: 0, stored: 0, statuses: {}, error: `buyer_criteria_utterances read refused: ${error.message ?? "unknown"}` }
  const tenants = [...new Set(((data ?? []) as Array<{ brokerage_id: string | null }>).map((r) => r.brokerage_id).filter((x): x is string => !!x))]
  const out = { tenants: tenants.length, ideas: 0, stored: 0, statuses: {} as Record<string, number>, error: null as string | null }
  for (const b of tenants) {
    const { data: br, error: brErr } = await db.from("brokerages").select("city, state").eq("id", b).maybeSingle()
    if (brErr) console.error(`[search-demand] brokerage geo read refused for ${b}:`, brErr.message)
    const r = await runSearchDemandScan(db, { brokerageId: b, now, geo: { city: (br as any)?.city ?? null, state: (br as any)?.state ?? null } }, deps)
    out.ideas += r.producers.reduce((s, p) => s + p.ideas.length, 0)
    out.stored += r.intake && "inserted" in r.intake ? r.intake.inserted + r.intake.merged : 0
    out.statuses[r.intakeStatus] = (out.statuses[r.intakeStatus] ?? 0) + 1
  }
  return out
}
