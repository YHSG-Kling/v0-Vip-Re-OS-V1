// lib/geo/search-visibility.ts
// ─────────────────────────────────────────────────────────────────────────────
// C31 SEARCH VISIBILITY — "where do I stand on AI search, Google, etc." for the tenant's dashboard (wave 149, lane 149E,
// owner ruling 13: "the agent can see on their dashboard where they rank on AI search, Google, etc.").
//
// THIS IS A COMPOSER OVER SURVIVORS, NOT A NEW MONITOR. Every number below is read from a stream that already has a writer:
//   · AI answer engines (reels)   ai_search_citation_observations ← lib/kernel/ai-search-citation-monitor.ts runCitationMonitor
//   · AI answer engines (landing) ai_search_landing_citation_observations ← runLandingPageCitationMonitor
//                                 both collapsed onto ANSWERS (lib/geo/citation-share.ts citationShare — five platform rows
//                                 per answer are one answer, so the sample size is answers read, never rows written).
//   · Public web mentions         brand_mentions ← lib/competitive-intel/brand-listening.ts (the Brand24 concepts on the
//                                 web_search capability; the Brand24 MCP itself is not connected — see WAITING_EXTERNAL).
//   · Recommendations + hooks     lib/content-intel/market-leadership.ts rankLeadershipOpportunities — the SAME ranking the
//                                 weekly marketing planner (lib/agents/marketing-agent.ts) reads through
//                                 renderLeadershipBriefForKickoff, so the dashboard and the planner can never disagree.
//   · Markets                     lib/geo/tenant-markets.ts (ruling 14 — settings territories, the registry's verdict each).
//   · Google organic              NOT MEASURED. No Search Console / SERP adapter exists in the repo (grep at 08712fef:
//                                 search_console, dataforseo, serpapi → 0 files). seo_keywords carries provider-estimated
//                                 volume / competition / difficulty — a keyword PLAN, not a position — so it is reported as
//                                 tracked keywords and never as a rank.
//
// THE RANK RULE (C31 — "never an invented exact rank"): nothing in this reading is a rank or a position. AI answers have no
// stable rank to read (an answer names you or it does not), and Google positions are unmeasured until a Search Console
// property is connected. What IS reported is a measured rate with its sample size, its window, and the table it came from.
// scripts/search-visibility-guard.ts walks the output and fails on any numeric key spelled rank / position / place.
//
// PURE composer (`composeSearchVisibility`) + one loader (`loadSearchVisibility`) that takes the caller's client and the
// SESSION tenant. Every refused read becomes a blind spot on the source it starves; nothing is rendered as zero by default.

import { citationShare, type CitationShare, type ShareObservationRow } from "@/lib/geo/citation-share"
import type { CitationOutcome } from "@/lib/kernel/ai-search-citation-monitor"
import { rankLeadershipOpportunities, type LeadershipOpportunity, type LeadershipSignals } from "@/lib/content-intel/market-leadership"
import type { TenantMarkets } from "@/lib/geo/tenant-markets"

type Db = { from: (table: string) => any }

const DAY_MS = 86_400_000

export type VisibilitySourceKey = "ai_answers_reels" | "ai_answers_landing" | "web_mentions" | "google_organic"
export type VisibilityStatus = "measured" | "no_observations" | "not_measured" | "refused"

/** Where a claim came from. Every claim in the reading carries one. */
export interface VisibilityEvidence {
  /** The table (or code path) the number was read from; null only for a not-measured source. */
  source: string | null
  windowFrom: string
  windowTo: string
  /** Distinct ANSWERS / MENTIONS read — the honest denominator. */
  sampleSize: number
  method: string
}

export interface VisibilitySource {
  key: VisibilitySourceKey
  label: string
  status: VisibilityStatus
  /** One plain sentence; the numbers in it are the ones in `metrics`. */
  summary: string
  metrics: { citationRatePct: number | null; shareOfVoicePct: number | null; answersRead: number; answersCited: number; notRead: number }
  evidence: VisibilityEvidence
  /** Exactly what would make an unmeasured source measurable (name only — never a value). */
  waitingExternal: string | null
}

export interface VisibilityTrend {
  metric: "ai_citation_rate" | "web_mentions"
  current: number | null
  previous: number | null
  direction: "up" | "down" | "flat" | "unknown"
  evidence: VisibilityEvidence
  note: string
}

export interface VisibilityTopic { text: string; kind: "question_asked" | "mention_topic"; answersRead: number; answersCited: number; evidence: VisibilityEvidence }
export interface VisibilityGap { query: string; answersRead: number; competitorsNamed: string[]; evidence: VisibilityEvidence }
export interface VisibilityCompetitor { name: string; aiAnswersNamedIn: number; webMentionsNamedIn: number; evidence: string[] }
export interface VisibilityAttribution { scope: "agent" | "team" | "unattributed"; id: string | null; answersRead: number; answersCited: number }
export interface ContentHook {
  kind: LeadershipOpportunity["kind"]
  title: string
  brief: string
  formats: LeadershipOpportunity["formats"]
  channels: LeadershipOpportunity["channels"]
  evidence: string[]
  /** The door that turns this into content — the planner that already reads the same ranking. */
  door: string
}

export interface SearchVisibility {
  brokerageId: string
  asOf: string
  windowDays: number
  markets: TenantMarkets | null
  sources: VisibilitySource[]
  trends: VisibilityTrend[]
  topics: VisibilityTopic[]
  gaps: VisibilityGap[]
  competitors: VisibilityCompetitor[]
  recommendations: Array<Pick<LeadershipOpportunity, "kind" | "title" | "evidence" | "strength">>
  contentHooks: ContentHook[]
  attribution: VisibilityAttribution[]
  /** Said on the screen: why no exact rank appears anywhere. */
  rankPolicy: string
  blindSpots: string[]
}

export const RANK_POLICY =
  "No exact rank is shown. AI answers either name you or they do not, so visibility there is a measured citation rate over the answers actually read. Google positions are not measured until a Search Console property is connected; nothing here estimates one."

/** Google organic: what would make it measurable (WAITING_EXTERNAL by name, never a value). */
export const GOOGLE_ORGANIC_WAITING =
  "Google Search Console API (Search Analytics: clicks, impressions, average position per query/page) — an OAuth connection to the tenant's verified site property. No adapter exists in this repo yet."

/** One observation row as stored on either citation rail. */
export interface CitationRow {
  page: string
  observedOn: string
  outcome: CitationOutcome
  competitorsCited: string[] | null
  query: string | null
  agentId: string | null
  teamId: string | null
}

export interface BrandReadingLike {
  mentions: number
  mentions7d: number
  mentionsPrev7d: number
  shareOfVoice: CitationShare
  topics: Array<{ topic: string; mentions: number; negative: number }>
  refused: string | null
}

export interface SearchVisibilityInputs {
  brokerageId: string
  now: Date
  windowDays: number
  reels: { rows: CitationRow[]; refused: string | null }
  landing: { rows: CitationRow[]; refused: string | null }
  brand: BrandReadingLike | null
  leadership: LeadershipSignals | null
  markets: TenantMarkets | null
  trackedKeywords: { count: number; refused: string | null }
  blindSpots?: string[]
}

const toShare = (r: CitationRow): ShareObservationRow => ({ pageId: r.page, observedOn: r.observedOn, outcome: r.outcome, competitorsCited: r.competitorsCited })
const round1 = (n: number) => Math.round(n * 10) / 10

/** Answers (page × day) — the unit every count here is in. */
function answers(rows: ReadonlyArray<CitationRow>): Map<string, { cited: boolean; checked: boolean; query: string | null; agentId: string | null; teamId: string | null; competitors: Set<string> }> {
  const m = new Map<string, { cited: boolean; checked: boolean; query: string | null; agentId: string | null; teamId: string | null; competitors: Set<string> }>()
  for (const r of rows) {
    const key = `${r.page}\u0000${r.observedOn}`
    let a = m.get(key)
    if (!a) { a = { cited: false, checked: false, query: r.query, agentId: r.agentId, teamId: r.teamId, competitors: new Set() }; m.set(key, a) }
    if (r.outcome === "cited") { a.cited = true; a.checked = true } else if (r.outcome === "not_cited") a.checked = true
    if (!a.query && r.query) a.query = r.query
    for (const c of r.competitorsCited ?? []) if (String(c ?? "").trim()) a.competitors.add(String(c).trim())
  }
  return m
}

function aiSource(key: VisibilitySourceKey, label: string, table: string, rail: { rows: CitationRow[]; refused: string | null }, win: { from: string; to: string }): VisibilitySource {
  const method = "one web-search answer read per page per day by the citation monitor, recorded under five AI-platform labels from the same fetched text — per-platform visibility is NOT separately measured; counted per answer"
  if (rail.refused) {
    return { key, label, status: "refused", summary: `Not read: ${rail.refused}. This is a monitoring gap, not a result.`, metrics: { citationRatePct: null, shareOfVoicePct: null, answersRead: 0, answersCited: 0, notRead: 0 }, evidence: { source: table, windowFrom: win.from, windowTo: win.to, sampleSize: 0, method }, waitingExternal: null }
  }
  const s = citationShare(rail.rows.map(toShare))
  const status: VisibilityStatus = s.reason === "no_observations" ? "no_observations" : s.queriesChecked === 0 ? "refused" : "measured"
  const summary = status === "no_observations"
    ? "No AI answers have been read for these pages in the window yet."
    : status === "refused"
      ? `The search rail could not read any answer (${s.queriesNotChecked} attempts) — a monitoring gap, not a miss.`
      : `Named in ${s.queriesCited} of ${s.queriesChecked} AI answers read (${s.citationRatePct}%).${s.shareOfVoicePct === null ? " No brokerage was named in any of them." : ` Share of the brokerages named: ${s.shareOfVoicePct}%.`}`
  return {
    key, label, status, summary,
    metrics: { citationRatePct: s.citationRatePct, shareOfVoicePct: s.shareOfVoicePct, answersRead: s.queriesChecked, answersCited: s.queriesCited, notRead: s.queriesNotChecked },
    evidence: { source: table, windowFrom: win.from, windowTo: win.to, sampleSize: s.queriesChecked, method },
    waitingExternal: null,
  }
}

/** PURE. The C31 reading from already-read streams. Never invents a number; never emits a rank. The guard drives it through loadSearchVisibility over a scripted client. */
function composeSearchVisibility(inp: SearchVisibilityInputs): SearchVisibility {
  const to = inp.now.toISOString()
  const from = new Date(inp.now.getTime() - inp.windowDays * DAY_MS).toISOString()
  const win = { from, to }
  const blindSpots = [...(inp.blindSpots ?? []), ...(inp.markets?.blindSpots ?? []), ...(inp.leadership?.blindSpots ?? [])]

  // ── sources ────────────────────────────────────────────────────────────────
  const sources: VisibilitySource[] = [
    aiSource("ai_answers_reels", "AI answer engines — your video pages", "ai_search_citation_observations", inp.reels, win),
    aiSource("ai_answers_landing", "AI answer engines — your landing pages", "ai_search_landing_citation_observations", inp.landing, win),
  ]
  const mentionMethod = "public web mentions captured by the brand-listening pass through the web_search capability; a mention must literally name its subject"
  if (!inp.brand) {
    sources.push({ key: "web_mentions", label: "Public web mentions", status: "refused", summary: "Brand listening was not read.", metrics: { citationRatePct: null, shareOfVoicePct: null, answersRead: 0, answersCited: 0, notRead: 0 }, evidence: { source: "brand_mentions", windowFrom: from, windowTo: to, sampleSize: 0, method: mentionMethod }, waitingExternal: null })
  } else if (inp.brand.refused) {
    sources.push({ key: "web_mentions", label: "Public web mentions", status: "refused", summary: `Not read: ${inp.brand.refused}.`, metrics: { citationRatePct: null, shareOfVoicePct: null, answersRead: 0, answersCited: 0, notRead: 0 }, evidence: { source: "brand_mentions", windowFrom: from, windowTo: to, sampleSize: 0, method: mentionMethod }, waitingExternal: null })
  } else {
    const sv = inp.brand.shareOfVoice
    sources.push({
      key: "web_mentions", label: "Public web mentions", status: inp.brand.mentions === 0 ? "no_observations" : "measured",
      summary: inp.brand.mentions === 0 ? "No public mention was captured in the window." : `${inp.brand.mentions} public mention(s) captured; ${sv.queriesCited} named you${sv.shareOfVoicePct === null ? "" : ` (share of voice ${sv.shareOfVoicePct}%)`}.`,
      metrics: { citationRatePct: sv.citationRatePct, shareOfVoicePct: sv.shareOfVoicePct, answersRead: sv.queriesChecked, answersCited: sv.queriesCited, notRead: sv.queriesNotChecked },
      evidence: { source: "brand_mentions", windowFrom: from, windowTo: to, sampleSize: inp.brand.mentions, method: mentionMethod },
      waitingExternal: null,
    })
  }
  sources.push({
    key: "google_organic", label: "Google organic search", status: "not_measured",
    summary: inp.trackedKeywords.refused
      ? `Not measured. Tracked keywords were not read (${inp.trackedKeywords.refused}).`
      : `Not measured — no Google position source is connected. ${inp.trackedKeywords.count} keyword(s) are tracked with provider-estimated volume and competition; those are a plan, not a position.`,
    metrics: { citationRatePct: null, shareOfVoicePct: null, answersRead: 0, answersCited: 0, notRead: 0 },
    evidence: { source: null, windowFrom: from, windowTo: to, sampleSize: 0, method: "no adapter" },
    waitingExternal: GOOGLE_ORGANIC_WAITING,
  })

  // ── trends (two halves of the window; unknown when either half read nothing) ──
  const allAi = [...(inp.reels.refused ? [] : inp.reels.rows), ...(inp.landing.refused ? [] : inp.landing.rows)]
  const mid = new Date(inp.now.getTime() - (inp.windowDays / 2) * DAY_MS).toISOString().slice(0, 10)
  const rate = (rows: CitationRow[]) => { const s = citationShare(rows.map(toShare)); return { pct: s.citationRatePct, n: s.queriesChecked } }
  const cur = rate(allAi.filter((r) => r.observedOn >= mid)), prev = rate(allAi.filter((r) => r.observedOn < mid))
  const dir = (c: number | null, p: number | null): VisibilityTrend["direction"] => c === null || p === null ? "unknown" : c > p ? "up" : c < p ? "down" : "flat"
  const trends: VisibilityTrend[] = [{
    metric: "ai_citation_rate", current: cur.pct, previous: prev.pct, direction: dir(cur.pct, prev.pct),
    evidence: { source: "ai_search_citation_observations + ai_search_landing_citation_observations", windowFrom: from, windowTo: to, sampleSize: cur.n + prev.n, method: `citation rate since ${mid} vs before it, per answer` },
    note: cur.pct === null || prev.pct === null ? "Not enough answers in one half of the window to call a direction." : `${cur.n} answers read since ${mid}; ${prev.n} before.`,
  }]
  if (inp.brand && !inp.brand.refused) {
    trends.push({
      metric: "web_mentions", current: inp.brand.mentions7d, previous: inp.brand.mentionsPrev7d,
      direction: inp.brand.mentions7d === 0 && inp.brand.mentionsPrev7d === 0 ? "unknown" : dir(inp.brand.mentions7d, inp.brand.mentionsPrev7d),
      evidence: { source: "brand_mentions", windowFrom: new Date(inp.now.getTime() - 14 * DAY_MS).toISOString(), windowTo: to, sampleSize: inp.brand.mentions7d + inp.brand.mentionsPrev7d, method: "mentions in the last 7 days vs the 7 before" },
      note: "A count of captured mentions, not of all mentions on the web.",
    })
  }

  // ── topics / questions and gaps (the queries the monitor actually asked) ──
  const byQuery = new Map<string, { read: number; cited: number; competitors: Set<string> }>()
  for (const a of answers(allAi).values()) {
    if (!a.checked || !a.query) continue
    const q = a.query.trim()
    const e = byQuery.get(q) ?? { read: 0, cited: 0, competitors: new Set<string>() }
    e.read++; if (a.cited) e.cited++
    for (const c of a.competitors) e.competitors.add(c)
    byQuery.set(q, e)
  }
  const aiEvidence = (n: number): VisibilityEvidence => ({ source: "ai_search_citation_observations + ai_search_landing_citation_observations (query column)", windowFrom: from, windowTo: to, sampleSize: n, method: "the question the monitor asked an answer engine, counted per answer" })
  const topics: VisibilityTopic[] = [...byQuery.entries()].sort((a, b) => b[1].read - a[1].read || a[0].localeCompare(b[0])).slice(0, 12)
    .map(([text, e]) => ({ text, kind: "question_asked" as const, answersRead: e.read, answersCited: e.cited, evidence: aiEvidence(e.read) }))
  if (inp.brand && !inp.brand.refused) {
    for (const t of inp.brand.topics.slice(0, 8)) topics.push({ text: t.topic, kind: "mention_topic", answersRead: t.mentions, answersCited: 0, evidence: { source: "brand_mentions (topics)", windowFrom: from, windowTo: to, sampleSize: t.mentions, method: "topics people discuss in captured public mentions" } })
  }
  const gaps: VisibilityGap[] = [...byQuery.entries()].filter(([, e]) => e.cited === 0)
    .sort((a, b) => b[1].competitors.size - a[1].competitors.size || b[1].read - a[1].read || a[0].localeCompare(b[0])).slice(0, 10)
    .map(([query, e]) => ({ query, answersRead: e.read, competitorsNamed: [...e.competitors].sort(), evidence: aiEvidence(e.read) }))

  // ── competitors (AI answers + web mentions, each with its own count) ──
  const comp = new Map<string, VisibilityCompetitor>()
  const aiShare = citationShare(allAi.map(toShare))
  for (const c of aiShare.topCompetitors) comp.set(c.name.toLowerCase(), { name: c.name, aiAnswersNamedIn: c.citations, webMentionsNamedIn: 0, evidence: [`named in ${c.citations} of ${aiShare.queriesChecked} AI answers read`] })
  if (inp.brand && !inp.brand.refused) {
    for (const c of inp.brand.shareOfVoice.topCompetitors) {
      const e = comp.get(c.name.toLowerCase()) ?? { name: c.name, aiAnswersNamedIn: 0, webMentionsNamedIn: 0, evidence: [] }
      e.webMentionsNamedIn = c.citations
      e.evidence.push(`named in ${c.citations} of ${inp.brand.mentions} captured public mentions`)
      comp.set(c.name.toLowerCase(), e)
    }
  }
  const competitors = [...comp.values()].sort((a, b) => (b.aiAnswersNamedIn + b.webMentionsNamedIn) - (a.aiAnswersNamedIn + a.webMentionsNamedIn) || a.name.localeCompare(b.name)).slice(0, 10)

  // ── recommendations + content-production hooks (the planner's own ranking) ──
  const opps = inp.leadership ? rankLeadershipOpportunities(inp.leadership) : []
  if (!inp.leadership) blindSpots.push("market-leadership signals were not read — no recommendations this view")
  const recommendations = opps.map(({ kind, title, evidence, strength }) => ({ kind, title, evidence, strength }))
  const contentHooks: ContentHook[] = opps.map((o) => ({
    kind: o.kind, title: o.title, brief: o.brief, formats: o.formats, channels: o.channels, evidence: o.evidence,
    door: "the weekly marketing planner (lib/agents/marketing-agent.ts) reads this same ranking through renderLeadershipBriefForKickoff; its managers draft through brand voice, the fair-housing copy scan and approval before anything is published",
  }))
  // A query nobody cites us on, with no rival named either, is still a hook: the category is open.
  for (const g of gaps.filter((x) => x.competitorsNamed.length === 0).slice(0, 3)) {
    contentHooks.push({
      kind: "ai_search_gap", title: `Answer "${g.query}" — no brokerage is being named yet`,
      brief: "Publish a direct, citable local answer to this question (question as the heading, the answer in the first two sentences, the agent's own dated figures and sources). Original, brand-voiced, through the fair-housing copy scan and approval.",
      formats: ["article", "short_video"], channels: ["blog", "social"], evidence: [`${g.answersRead} AI answer(s) read for this question named no brokerage`],
      door: "lib/agents/marketing-agent.ts (weekly planner) — or the agent's Create button on the content dashboard",
    })
  }

  // ── attribution (whose pages are being read and cited) ──
  const attr = new Map<string, VisibilityAttribution>()
  for (const a of answers(allAi).values()) {
    if (!a.checked) continue
    const scope: VisibilityAttribution["scope"] = a.agentId ? "agent" : a.teamId ? "team" : "unattributed"
    const id = a.agentId ?? a.teamId ?? null
    const key = `${scope}:${id ?? ""}`
    const e = attr.get(key) ?? { scope, id, answersRead: 0, answersCited: 0 }
    e.answersRead++; if (a.cited) e.answersCited++
    attr.set(key, e)
  }
  const attribution = [...attr.values()].sort((a, b) => b.answersCited - a.answersCited || b.answersRead - a.answersRead)

  return {
    brokerageId: inp.brokerageId, asOf: to, windowDays: inp.windowDays, markets: inp.markets,
    sources, trends, topics, gaps, competitors, recommendations, contentHooks, attribution,
    rankPolicy: RANK_POLICY, blindSpots,
  }
}

/** Raw stored rows → the composer's shape (both rails). */
function railRows(data: unknown, pageOf: (r: any) => string): CitationRow[] {
  return ((data ?? []) as any[]).map((r) => ({
    page: pageOf(r),
    observedOn: String(r.observed_on ?? String(r.observed_at ?? "").slice(0, 10)),
    outcome: r.outcome as CitationOutcome,
    competitorsCited: Array.isArray(r.competitors_cited) ? r.competitors_cited : null,
    query: typeof r.query === "string" ? r.query : null,
    agentId: r.agent_id ?? null,
    teamId: r.team_id ?? null,
  }))
}

/**
 * THE LOADER. `db` is the caller's client — the dashboard passes its SESSION client (RLS scopes it) and the tenant from
 * the session; every read is also tenant-pinned. Optional narrowing to an agent or team only ever NARROWS the citation
 * reads (the same rule scripts/geo-scope-guard.ts holds for the GEO tab).
 */
export async function loadSearchVisibility(db: Db, brokerageId: string, opts: {
  now?: Date; windowDays?: number; scope?: { column: "agent_id" | "team_id"; value: string } | null
  /** Injected stream readers (defaults: the survivors named in the header). A null return = not read. */
  deps?: {
    brand?: (db: Db, brokerageId: string, now: Date, windowDays: number) => Promise<BrandReadingLike | null>
    leadership?: (db: Db, brokerageId: string, now: Date, windowDays: number) => Promise<LeadershipSignals | null>
    markets?: (db: Db, brokerageId: string, now: Date) => Promise<TenantMarkets | null>
  }
} = {}): Promise<SearchVisibility> {
  const now = opts.now ?? new Date()
  const windowDays = opts.windowDays ?? 30
  const since = new Date(now.getTime() - windowDays * DAY_MS).toISOString()
  const blindSpots: string[] = []
  if (!brokerageId) {
    return composeSearchVisibility({ brokerageId: "", now, windowDays, reels: { rows: [], refused: "no tenant" }, landing: { rows: [], refused: "no tenant" }, brand: null, leadership: null, markets: null, trackedKeywords: { count: 0, refused: "no tenant" }, blindSpots: ["no tenant — nothing was read"] })
  }
  const narrow = (q: any) => (opts.scope?.column === "agent_id" ? q.eq("agent_id", opts.scope.value) : opts.scope?.column === "team_id" ? q.eq("team_id", opts.scope.value) : q)

  const [reelsRes, landingRes, kwRes] = await Promise.all([
    narrow(db.from("ai_search_citation_observations").select("project_id, observed_on, observed_at, outcome, competitors_cited, query, agent_id, team_id").eq("brokerage_id", brokerageId)).gte("observed_at", since).limit(3000),
    narrow(db.from("ai_search_landing_citation_observations").select("id, public_slug, observed_at, outcome, competitors_cited, query, agent_id, team_id").eq("brokerage_id", brokerageId)).gte("observed_at", since).limit(3000),
    db.from("seo_keywords").select("id").eq("brokerage_id", brokerageId).eq("is_active", true).limit(1000),
  ])
  const reels = { rows: reelsRes.error ? [] : railRows(reelsRes.data, (r) => String(r.project_id ?? "")), refused: reelsRes.error ? `ai_search_citation_observations read refused (${reelsRes.error.message ?? "unknown"})` : null }
  const landing = { rows: landingRes.error ? [] : railRows(landingRes.data, (r) => String(r.public_slug ?? r.id ?? "")), refused: landingRes.error ? `ai_search_landing_citation_observations read refused (${landingRes.error.message ?? "unknown"})` : null }
  const trackedKeywords = { count: kwRes.error ? 0 : ((kwRes.data ?? []) as unknown[]).length, refused: kwRes.error ? (kwRes.error.message ?? "unknown") : null }

  let brand: BrandReadingLike | null = null
  try {
    if (opts.deps?.brand) brand = await opts.deps.brand(db, brokerageId, now, windowDays)
    else {
      const { loadBrandListeningReading } = await import("@/lib/competitive-intel/brand-listening")
      brand = await loadBrandListeningReading(db as never, brokerageId, now, windowDays)
    }
  } catch (e) { blindSpots.push(`brand listening not read (${e instanceof Error ? e.message : "unknown"})`) }

  let leadership: LeadershipSignals | null = null
  try {
    if (opts.deps?.leadership) leadership = await opts.deps.leadership(db, brokerageId, now, windowDays)
    else {
      const { loadMarketLeadershipSignals } = await import("@/lib/content-intel/market-leadership")
      leadership = await loadMarketLeadershipSignals(db, brokerageId, now, { windowDays })
    }
  } catch (e) { blindSpots.push(`market-leadership signals not read (${e instanceof Error ? e.message : "unknown"})`) }

  let markets: TenantMarkets | null = null
  try {
    if (opts.deps?.markets) markets = await opts.deps.markets(db, brokerageId, now)
    else {
      const { loadTenantMarkets } = await import("@/lib/geo/tenant-markets")
      markets = await loadTenantMarkets(db, brokerageId, { withVerifications: true, now })
    }
  } catch (e) { blindSpots.push(`tenant markets not read (${e instanceof Error ? e.message : "unknown"})`) }

  return composeSearchVisibility({ brokerageId, now, windowDays, reels, landing, brand, leadership, markets, trackedKeywords, blindSpots })
}

/** Exported for the guard and the card: a short, honest headline that never claims a rank. */
export function visibilityHeadline(v: SearchVisibility): string {
  const ai = v.sources.filter((s) => s.key === "ai_answers_reels" || s.key === "ai_answers_landing")
  const read = ai.reduce((n, s) => n + s.metrics.answersRead, 0)
  const cited = ai.reduce((n, s) => n + s.metrics.answersCited, 0)
  if (read === 0) return "No AI answers have been read for your pages in this window yet — Google positions are not measured."
  return `Named in ${cited} of ${read} AI answers read in the last ${v.windowDays} days (${round1((cited / read) * 100)}%). Google positions are not measured.`
}
