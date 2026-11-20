#!/usr/bin/env tsx
/**
 * scripts/search-visibility-guard.ts — wave 149, lane 149E (`test:search-visibility`).
 *
 * Holds three owner rulings to the code:
 *   · C31 / ruling 13 — the dashboard's search visibility carries EVIDENCE for every claim (source table, window, sample
 *     size counted per ANSWER, method) and NEVER an exact rank; Google positions are "not measured" with the dependency
 *     named until a Search Console adapter exists.
 *   · ruling 13 (second half) — all OS copy is findable by AI search: the public routes are listed by BOTH sitemap.xml and
 *     llms.txt (one list, PUBLIC_COPY_ROUTES), and the OS's own assistant retrieval (buildRAGContext) reads every copy
 *     source through the federated reader, tenant-pinned.
 *   · ruling 14 — markets derive from the territories the tenant entered in SETTINGS; a farm or the office address is a
 *     labelled fallback, never a market; the registry's verdict per market is classifyMarketCoverage's, not a copy.
 *
 * Positive controls: a planted `rank: 3` is caught by the rank walker; a planted literal `position: 4` is caught by the
 * source census; an llms.txt body missing `/team/` is caught by the route check; a planted settings-territory-free input
 * yields zero markets; a five-platform answer is counted once.
 *
 * Blind spots (published): the rank walker sees the composer's OUTPUT for the fixtures here, and the source census sees
 * literal `rank:`/`position:` keys in stripped source of lib/geo/** and the SEO page — a rank computed under another name
 * would pass both. The route check is lexical over stripped source (template literals are kept, because the routes live
 * in them). The fake clients have no RLS. The live model is not exercised (buildRAGContext's KB half is semantic and
 * needs the AI gateway; only the federated half is driven here).
 */
import { readFileSync } from "node:fs"
import { stripComments } from "./strip-comments"
import { loadSearchVisibility, RANK_POLICY, GOOGLE_ORGANIC_WAITING, type CitationRow, type SearchVisibilityInputs, type SearchVisibility } from "../lib/geo/search-visibility"
import { loadTenantMarkets, primaryMarketLabel, type TenantMarkets } from "../lib/geo/tenant-markets"
import { classifyMarketCoverage, MARKETS } from "../lib/external/socrata-market-registry"
import { searchOsCopy, searchTerms, OS_COPY_SOURCES, PUBLIC_COPY_ROUTES, renderOsCopyContext } from "../lib/knowledge/embedding-service"
import { resolveReportTerritory } from "../lib/market-reports/research"

let pass = 0, fail = 0
const failures: string[] = []
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const code = (p: string) => stripComments(readFileSync(p, "utf8"))
const NOW = new Date("2026-11-03T12:00:00.000Z")

// A recording fake client: every chained filter is recorded; results come from a per-table script.
type Script = Record<string, { data?: unknown[]; error?: { message: string } | null }>
function fakeDb(script: Script) {
  const calls: Array<{ table: string; ops: Array<[string, unknown[]]> }> = []
  const from = (table: string) => {
    const rec = { table, ops: [] as Array<[string, unknown[]]> }
    calls.push(rec)
    const res = () => ({ data: script[table]?.error ? null : (script[table]?.data ?? []), error: script[table]?.error ?? null })
    const b: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (r: (v: unknown) => void, j: (e: unknown) => void) => Promise.resolve(res()).then(r, j)
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve({ ...res(), data: (res().data as unknown[] | null)?.[0] ?? null })
        return (...args: unknown[]) => { rec.ops.push([prop, args]); return b }
      },
    })
    return b
  }
  return { db: { from }, calls }
}

// The rank walker: any numeric value under a key spelled rank / position / place.
function rankKeys(v: unknown, path = "$"): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => rankKeys(x, `${path}[${i}]`))
  if (v && typeof v === "object") return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) =>
    (/(^|_)(rank|position|place)$|^(rank|position|place)/i.test(k) && typeof x === "number" ? [`${path}.${k}`] : []).concat(rankKeys(x, `${path}.${k}`)))
  return []
}


// The pure composers are module-private; the guard drives them through their LOADERS over a scripted client, which also
// proves the loaders' row mapping. These adapters turn the fixture shapes into stored rows.
async function deriveTenantMarkets(input: { serviceAreas: any[]; scrapingMarkets: any[]; farms?: any[]; brokerage?: any | null }): Promise<TenantMarkets> {
  const { db } = fakeDb({
    subscriber_service_areas: { data: input.serviceAreas }, lead_scraping_markets: { data: input.scrapingMarkets },
    farm_territories: { data: input.farms ?? [] }, brokerages: { data: input.brokerage ? [input.brokerage] : [] },
  })
  return loadTenantMarkets(db, "b-1")
}
async function composeSearchVisibility(inp: SearchVisibilityInputs): Promise<SearchVisibility> {
  const stored = (rows: CitationRow[], reel: boolean) => rows.map((r) => ({
    ...(reel ? { project_id: r.page, observed_on: r.observedOn } : { public_slug: r.page }), observed_at: `${r.observedOn}T12:00:00.000Z`,
    outcome: r.outcome, competitors_cited: r.competitorsCited, query: r.query, agent_id: r.agentId, team_id: r.teamId,
  }))
  const { db } = fakeDb({
    ai_search_citation_observations: inp.reels.refused ? { error: { message: inp.reels.refused } } : { data: stored(inp.reels.rows, true) },
    ai_search_landing_citation_observations: inp.landing.refused ? { error: { message: inp.landing.refused } } : { data: stored(inp.landing.rows, false) },
    seo_keywords: inp.trackedKeywords.refused ? { error: { message: inp.trackedKeywords.refused } } : { data: Array.from({ length: inp.trackedKeywords.count }, (_, i) => ({ id: `k${i}` })) },
  })
  return loadSearchVisibility(db, inp.brokerageId, { now: inp.now, windowDays: inp.windowDays, deps: {
    brand: async () => inp.brand, leadership: async () => inp.leadership, markets: async () => inp.markets,
  } })
}

const row = (page: string, day: string, outcome: CitationRow["outcome"], extra: Partial<CitationRow> = {}): CitationRow =>
  ({ page, observedOn: day, outcome, competitorsCited: null, query: null, agentId: null, teamId: null, ...extra })
const fivePlatforms = (page: string, day: string, outcome: CitationRow["outcome"], extra: Partial<CitationRow> = {}) => Array.from({ length: 5 }, () => row(page, day, outcome, extra))

const AUSTIN_MARKETS = await deriveTenantMarkets({ serviceAreas: [{ city: "Austin", state: "TX", zip_code: "78702", is_primary: true }], scrapingMarkets: [] })
const baseInputs = (over: Partial<SearchVisibilityInputs> = {}): SearchVisibilityInputs => ({
  brokerageId: "b-1", now: NOW, windowDays: 30,
  reels: { rows: [
    ...fivePlatforms("p1", "2026-10-10", "cited", { query: "best neighborhoods in austin for families", agentId: "a-1" }),
    ...fivePlatforms("p2", "2026-10-25", "not_cited", { query: "austin property tax protest", competitorsCited: ["Rival Realty"], agentId: "a-1" }),
    ...fivePlatforms("p3", "2026-11-01", "not_cited", { query: "is now a good time to sell in austin", teamId: "t-1" }),
    ...fivePlatforms("p4", "2026-11-02", "not_checked", { query: "unread" }),
  ], refused: null },
  landing: { rows: [], refused: null },
  brand: { mentions: 4, mentions7d: 3, mentionsPrev7d: 1, topics: [{ topic: "closing costs", mentions: 2, negative: 0 }], refused: null,
    shareOfVoice: { queriesChecked: 4, queriesCited: 2, queriesNotChecked: 0, citationRatePct: 50, shareOfVoicePct: 50, ourCitations: 2, competitorCitations: 2, topCompetitors: [{ name: "Rival Realty", citations: 2, sharePct: 50 }], reason: null } },
  leadership: { aiVisibility: null, competitorMoves: [], mentions: null, ownPerformance: [{ assetType: "blog", topic: "first-time buyer guide", performance: 70 }], localEvents: [], blindSpots: [] },
  markets: AUSTIN_MARKETS,
  trackedKeywords: { count: 6, refused: null },
  ...over,
})

console.log("§A  C31 — evidence on every claim, counted per answer")
{
  const v = await composeSearchVisibility(baseInputs())
  const reels = v.sources.find((s) => s.key === "ai_answers_reels")!
  ok("four sources are always reported (reels, landing, web mentions, Google)", v.sources.map((s) => s.key).join(",") === "ai_answers_reels,ai_answers_landing,web_mentions,google_organic")
  ok("five platform rows for one answer count as ONE answer read", reels.metrics.answersRead === 3 && reels.evidence.sampleSize === 3, `answersRead=${reels.metrics.answersRead}`)
  ok("an unreadable answer is counted apart, never as a miss", reels.metrics.notRead === 1)
  ok("the measured rate is cited/read over answers (1 of 3 → 33.3%)", reels.metrics.citationRatePct === 33.3)
  ok("every source carries a window and a method", v.sources.every((s) => !!s.evidence.windowFrom && !!s.evidence.windowTo && !!s.evidence.method))
  ok("every measured / no-observation / refused source names its table", v.sources.filter((s) => s.status !== "not_measured").every((s) => !!s.evidence.source))
  ok("the per-platform limit is said on the claim (one answer under five labels)", /per-platform visibility is NOT separately measured/.test(reels.evidence.method))
  ok("topics are the questions the monitor asked, with per-answer counts", v.topics.some((t) => t.kind === "question_asked" && t.text.includes("property tax") && t.answersRead === 1))
  ok("a gap is a question read and not cited, with the rival named instead", v.gaps.some((g) => g.query.includes("property tax") && g.competitorsNamed.includes("Rival Realty")))
  ok("competitor comparison merges AI answers and web mentions, each with its own count", v.competitors.some((c) => c.name === "Rival Realty" && c.aiAnswersNamedIn === 1 && c.webMentionsNamedIn === 2))
  ok("recommendations come from the planner's own ranking (double_down from own performance)", v.recommendations.some((r) => r.kind === "double_down"))
  ok("every content hook names its door into content production", v.contentHooks.length > 0 && v.contentHooks.every((h) => /marketing-agent/.test(h.door)))
  ok("an uncontested gap (no rival named) becomes an ai_search_gap hook", v.contentHooks.some((h) => h.kind === "ai_search_gap" && h.title.includes("good time to sell")))
  ok("attribution splits by agent / team from the m335 columns", v.attribution.some((a) => a.scope === "agent" && a.id === "a-1" && a.answersRead === 2) && v.attribution.some((a) => a.scope === "team" && a.id === "t-1"))
  ok("trends carry evidence and say 'unknown' rather than guess", v.trends.every((t) => !!t.evidence.source && (t.direction !== "unknown" || /Not enough|not/i.test(t.note) || t.metric === "web_mentions")))
  const empty = await composeSearchVisibility(baseInputs({ reels: { rows: [], refused: null }, brand: null, leadership: null }))
  ok("no observations reads as 'no readings', never a zero rate", empty.sources[0].status === "no_observations" && empty.sources[0].metrics.citationRatePct === null)
  const refused = await composeSearchVisibility(baseInputs({ reels: { rows: [], refused: "ai_search_citation_observations read refused (permission denied)" } }))
  ok("a refused read is 'not read' with the reason, never 'no visibility'", refused.sources[0].status === "refused" && refused.sources[0].summary.includes("permission denied"))
  ok("a missing leadership read is a published blind spot", empty.blindSpots.some((b) => /market-leadership/.test(b)))
}

console.log("§B  C31 — never an invented rank")
{
  const v = await composeSearchVisibility(baseInputs())
  ok("the composer's output holds no numeric rank / position / place anywhere", rankKeys(v).length === 0, rankKeys(v).join(", "))
  ok("POSITIVE CONTROL: the walker catches a planted { rank: 3 }", rankKeys({ ...v, sources: [{ ...v.sources[0], rank: 3 }] }).length === 1)
  ok("POSITIVE CONTROL: the walker catches a nested google_position", rankKeys({ x: [{ google_position: 4 }] }).length === 1)
  const g = v.sources.find((s) => s.key === "google_organic")!
  ok("Google organic is NOT MEASURED, with every metric null/zero", g.status === "not_measured" && g.metrics.citationRatePct === null && g.metrics.answersRead === 0)
  ok("...and names exactly what would measure it (Search Console)", g.waitingExternal === GOOGLE_ORGANIC_WAITING && /Search Console/.test(g.waitingExternal ?? ""))
  ok("...and calls tracked keywords a plan, not a position", /a plan, not a position/.test(g.summary) && g.summary.includes("6 keyword"))
  ok("the rank policy is on the reading", v.rankPolicy === RANK_POLICY && /No exact rank/.test(RANK_POLICY))
  const RANK_LITERAL = /\b(rank|position|serpPosition|googleRank)\s*:\s*\d/
  const files = ["lib/geo/search-visibility.ts", "lib/geo/tenant-markets.ts", "lib/knowledge/embedding-service.ts", "app/dashboard/marketing/seo/search-visibility-card.tsx", "app/dashboard/marketing/seo/page.tsx"]
  const hits = files.filter((f) => RANK_LITERAL.test(code(f)))
  ok("source census: no literal numeric rank in the visibility files (stripped source)", hits.length === 0, hits.join(", "))
  ok("POSITIVE CONTROL: the census regex catches a planted `position: 4`", RANK_LITERAL.test(stripComments("const r = { position: 4 }")))
}

console.log("§C  ruling 14 — markets derive from SETTINGS territories")
{
  const t = await deriveTenantMarkets({
    serviceAreas: [
      { city: "Austin", state: "tx", zip_code: "78702", is_primary: false },
      { city: "austin ", state: "TX", zip_code: "78704", is_primary: true },
      { city: null, state: null, zip_code: "99999" },
      { city: "Gone", state: "TX", zip_code: "70000", active: false },
    ],
    scrapingMarkets: [{ city: "Nowhereville", state: "ZZ", zip_codes: ["11111"], counties: ["Somewhere"] }],
    farms: [{ city: "Farmtown", state: "TX", zip_codes: ["75000"] }],
    brokerage: { city: "Office City", state: "TX", zip: "75001" },
  })
  ok("case/whitespace-different spellings of one city are ONE market", t.markets.filter((m) => m.city.toLowerCase().trim() === "austin").length === 1)
  ok("the market carries both typed zips", t.markets.find((m) => m.state === "TX")?.zips.join(",") === "78702,78704")
  ok("a primary settings territory sorts first", t.markets[0].primary === true && t.markets[0].state === "TX")
  ok("an inactive territory is not a market", !t.markets.some((m) => m.city === "Gone"))
  ok("a scraping market (Settings → lead scraping) is a settings territory too", t.markets.some((m) => m.city === "Nowhereville" && m.bases.includes("scraping_market")))
  ok("a zip-only territory is counted as a blind spot, never dropped", t.zipOnlyTerritories.includes("99999") && t.blindSpots.some((b) => b.includes("99999")))
  ok("with settings territories present, the farm and the office are NOT markets", t.basis === "settings" && t.fallbackHint === null && !t.markets.some((m) => m.city === "Farmtown" || m.city === "Office City"))
  const aus = t.markets.find((m) => m.state === "TX")!
  ok("the registry verdict is classifyMarketCoverage's own (no second registry)", aus.registry.status === classifyMarketCoverage({ state: "TX", city: aus.city }).status)
  ok("an unregistered market says so", t.markets.find((m) => m.city === "Nowhereville")?.registry.status === "unregistered")
  ok("registry keys exist for the fixture's covered market (data control)", Object.keys(MARKETS).some((k) => k === "TX:austin"))
  const none = await deriveTenantMarkets({ serviceAreas: [], scrapingMarkets: [], farms: [{ city: "Farmtown", state: "TX", zip_codes: [] }] })
  ok("POSITIVE CONTROL: no settings territory → zero markets, the farm is a labelled fallback hint", none.markets.length === 0 && none.basis === "farm_territory" && none.fallbackHint?.basis === "farm_territory")
  ok("...and the tenant is told to add one in Settings", none.blindSpots.some((b) => /Settings → Territories/.test(b)))
  ok("primaryMarketLabel prefers a settings market, falls back to the labelled hint", primaryMarketLabel(t) === "austin, TX".replace("austin", aus.city) && primaryMarketLabel(none) === "Farmtown, TX")
}

console.log("§D  ruling 14 — the loaders read settings first, tenant-pinned, failing closed")
await (async () => {
  const { db, calls } = fakeDb({
    subscriber_service_areas: { data: [{ city: "Austin", state: "TX", zip_code: "78702", is_primary: true, active: true }] },
    lead_scraping_markets: { error: { message: "permission denied for table lead_scraping_markets" } },
  })
  const t = await loadTenantMarkets(db, "b-1")
  ok("every territory read is tenant-pinned (brokerage_id or id = the session tenant)", calls.every((c) => c.ops.some(([op, a]) => op === "eq" && (a[0] === "brokerage_id" || a[0] === "id") && a[1] === "b-1")))
  ok("a refused read is a named blind spot, and the readable territory still yields its market", t.blindSpots.some((b) => b.includes("lead_scraping_markets read refused")) && t.markets.length === 1)

  const r1 = fakeDb({ subscriber_service_areas: { data: [{ city: "Austin", state: "TX", zip_code: "78702", is_primary: true, active: true }] }, farm_territories: { data: [{ name: "North farm", city: "Round Rock", state: "TX", zip_codes: ["78664"], is_active: true }] } })
  const rr = await resolveReportTerritory(r1.db as never, { brokerageId: "b-1" })
  ok("market reports: a settings territory beats a farm (basis settings_territory)", rr.basis.startsWith("settings_territory") && rr.hint?.city === "Austin")
  const r2 = fakeDb({ farm_territories: { data: [{ name: "North farm", city: "Round Rock", state: "TX", zip_codes: ["78664"], is_active: true }] } })
  const rf = await resolveReportTerritory(r2.db as never, { brokerageId: "b-1" })
  ok("market reports: no settings territory → the farm fallback still serves", rf.basis.startsWith("farm_territory") && rf.hint?.city === "Round Rock")
  const r3 = fakeDb({ subscriber_service_areas: { error: { message: "permission denied" } } })
  const rx = await resolveReportTerritory(r3.db as never, { brokerageId: "b-1" })
  ok("market reports: a refused settings read FAILS CLOSED with the reason", rx.hint === null && /subscriber_service_areas read refused/.test(rx.error ?? ""))
  const r4 = fakeDb({ subscriber_service_areas: { data: [{ city: "Austin", state: "TX", zip_code: "78702", active: true }] } })
  const rm = await resolveReportTerritory(r4.db as never, { brokerageId: "b-1", hint: { zip: "78745" } })
  ok("market reports: the magnet's own setting still wins", rm.basis === "magnet_settings")
  // Parity: the report's settings-territory pick and the dashboard's first market are the SAME rule (one written inline
  // in research.ts to keep the voice/CRM proxy graphs flat). Fixtures cover primary, most-zips, case and the tie-break.
  const parityFixtures = [
    [{ city: "Austin", state: "TX", zip_code: "78702" }, { city: "Dallas", state: "TX", zip_code: "75201", is_primary: true }],
    [{ city: "austin", state: "tx", zip_code: "78702" }, { city: "Austin ", state: "TX", zip_code: "78704" }, { city: "Dallas", state: "TX", zip_code: "75201" }],
    [{ city: "Waco", state: "TX", zip_code: "76701" }, { city: "Austin", state: "TX", zip_code: "78702" }],
    [{ city: null, state: null, zip_code: "99999" }, { city: "Gone", state: "TX", zip_code: "70000", active: false }],
  ]
  const parity: boolean[] = []
  for (const rows of parityFixtures) {
    const rep = await resolveReportTerritory(fakeDb({ subscriber_service_areas: { data: rows } }).db as never, { brokerageId: "b-1" })
    const m = (await deriveTenantMarkets({ serviceAreas: rows, scrapingMarkets: [] })).markets[0]
    const a = rep.basis.startsWith("settings_territory") ? rep.hint : null
    parity.push((a === null && !m) || (!!a && !!m && a.state === m.state && String(a.city).toLowerCase() === m.city.toLowerCase() && (a.zip ?? null) === (m.zips.length === 1 ? m.zips[0] : null)))
  }
  ok("PARITY: the market report's settings territory (resolveReportTerritory) and the dashboard's first market (loadTenantMarkets) pick the same market on every fixture", parity.every(Boolean), parity.join(","))
  const page = code("app/dashboard/marketing/seo/page.tsx")
  ok("the SEO page's default market comes from loadTenantMarkets, not brokerages.city/state", page.includes("loadTenantMarkets(supabase, brokerageId)") && !/from\("brokerages"\)\s*\.select\("city, state"\)/.test(page))
})()

console.log("§E  ruling 13 — OS copy findable: sitemap + llms.txt + the OS's own AI search")
await (async () => {
  const sitemap = code("app/sitemap.ts"), llms = code("app/llms.txt/route.ts")
  const missing = (body: string) => PUBLIC_COPY_ROUTES.filter((r) => !body.includes("${base}" + r))
  ok("sitemap.xml lists every public copy route", missing(sitemap).length === 0, missing(sitemap).join(", "))
  ok("llms.txt lists every public copy route", missing(llms).length === 0, missing(llms).join(", "))
  ok("POSITIVE CONTROL: an llms.txt without /team/ is caught", missing(llms.split("${base}/team/").join("")).includes("/team/"))
  ok("every public copy source names its publish predicate", OS_COPY_SOURCES.filter((s) => s.publicRoute).every((s) => !!s.publicWhen))
  // 149Z (ruling 12): a landing page is listed at its canonical home INSIDE the tenant website; the bare /lm/ is the fallback
  // for a tenant with no site slug, and the bare route declares the same canonical.
  const TENANT_LM = /\$\{base\}\$\{tenantLandingPagePath\(siteSlugById\.get\(m\.brokerage_id\)!, m\.slug\)\}/
  ok("sitemap.xml + llms.txt list a landing page at /site/<slug>/lm/<form> (tenantLandingPagePath) when the tenant has a site", TENANT_LM.test(sitemap) && TENANT_LM.test(llms))
  ok("the bare /lm/<form> page declares the tenant-site canonical", /alternates:\s*\{\s*canonical:\s*`\$\{origin\}\$\{tenantLandingPagePath\(siteSlug, slug\)\}`/.test(code("app/lm/[slug]/page.tsx")))
  ok("POSITIVE CONTROL: the tenant-path finder refuses the bare-only producer", !TENANT_LM.test("url: `${base}/lm/${m.slug}`,"))
  const robots = code("app/robots.ts")
  ok("robots welcomes the AI crawlers and does not disallow a public copy route", robots.includes("AI_CRAWLER_BOTS") && !PUBLIC_COPY_ROUTES.some((r) => new RegExp(`DISALLOW = \\[[^\\]]*"${r.replace(/\//g, "\\/")}`).test(robots)))

  ok("search terms drop PostgREST metacharacters and stopwords", searchTerms("What's (the) best, %school% in Austin?").join(" ") === "what's best school austin")
  const { db, calls } = fakeDb({
    blog_posts: { data: [{ id: "bp1", title: "Austin property tax protest guide", excerpt: "How to protest", content: "...", slug: "austin-tax", publish_status: "published" }] },
    lead_capture_forms: { data: [{ id: "f1", name: "Free Austin home value report", thank_you_message: "Thanks", slug: "home-value", is_active: true }] },
    social_posts: { error: { message: "permission denied for table social_posts" } },
    help_topics_kb: { data: [{ id: "h1", title: "How property tax works", content: "texas protest season" }] },
  })
  const res = await searchOsCopy(db, { brokerageId: "b-1", query: "Austin property tax protest" })
  ok("posts, magnets and help copy are all found", ["blog_posts", "lead_capture_forms", "help_topics_kb"].every((t) => res.hits.some((h) => h.table === t)))
  ok("a public post carries its public path; help is internal", res.hits.find((h) => h.table === "blog_posts")?.url === "/blog/austin-tax" && res.hits.find((h) => h.table === "help_topics_kb")?.url === null)
  ok("a title hit outranks a body-only hit (the blog title names every term; ranked first)", res.hits[0]?.table === "blog_posts")
  ok("a refused source is named, not read as 'no copy'", res.refused.some((r) => r.startsWith("social_posts")))
  const tenantReads = calls.filter((c) => !c.ops.some(([op, a]) => op === "is" && a[0] === "brokerage_id"))
  ok("every tenant read is pinned to the session tenant", tenantReads.every((c) => c.ops.some(([op, a]) => op === "eq" && a[0] === "brokerage_id" && a[1] === "b-1")))
  const platformReads = calls.filter((c) => c.ops.some(([op, a]) => op === "is" && a[0] === "brokerage_id"))
  ok("only platform-authored HELP reads brokerage_id IS NULL rows", platformReads.length > 0 && platformReads.every((c) => c.table === "help_topics_kb"))
  ok("the tenant filter is never an OR that could widen past the tenant", calls.every((c) => !c.ops.some(([op, a]) => op === "or" && String(a[0]).includes("brokerage_id"))))
  ok("the context block names where each piece lives", /public at \/blog\/austin-tax/.test(renderOsCopyContext(res.hits)))
  const none = await searchOsCopy(fakeDb({}).db, { brokerageId: "", query: "austin" })
  ok("no tenant → nothing read, said by name", none.hits.length === 0 && none.refused.includes("no tenant"))
  const rag = code("app/actions/knowledge/search.ts")
  ok("buildRAGContext reads the OS copy through the federated reader, tenant from the session", /searchOsCopy\(supabase,\s*\{\s*brokerageId,/.test(rag) && rag.includes("getAgentContext()"))
})()

console.log("§F  the dashboard door")
{
  const page = code("app/dashboard/marketing/seo/page.tsx")
  ok("the GEO tab loads the C31 reading with the session client", page.includes("loadSearchVisibility(supabase, brokerageId"))
  ok("the card renders on BOTH the empty and the populated GEO tab", (page.match(/<SearchVisibilityCard visibility=\{visibility\} \/>/g) ?? []).length === 2)
  const card = code("app/dashboard/marketing/seo/search-visibility-card.tsx")
  ok("the card shows source, sample and method on every row", card.includes("s.evidence.source") && card.includes("s.evidence.sampleSize") && card.includes("s.evidence.method"))
  ok("the card says what would measure an unmeasured source", card.includes("s.waitingExternal"))
  ok("the card shows the markets from Settings with their registry status", card.includes("Settings → Territories") && card.includes("m.registry.status"))
  ok("the card is a server component (no client bundle, no lib in a client)", !/^\s*["']use client["']/m.test(readFileSync("app/dashboard/marketing/seo/search-visibility-card.tsx", "utf8")))
  // 149Z (lane 149E Outside-lane 1): the header search box is never an inert input — it opens the ONE app search (⌘K palette).
  const gs = code("app/components/layout/global-search.tsx")
  const INERT = (s: string) => /<Input\b/.test(s) && !/on(Click|Change|KeyDown|Focus|Submit)=/.test(s)
  // RE-ASSERTED — wave 150, lane 150QTV (owner ruling R6, 2026-11-06: "Global search finds contacts, listings AND leads — scoped
  // strictly to what the signed-in user may see"): the two checks below pinned the 149Z waypoint (the box opens the palette and
  // "promises only pages and actions, never records"). The RULE now: the box is never inert, it searches RECORDS through the
  // session-scoped action (test:scoped-search proves the scope), and the ⌘K palette stays reachable from it.
  ok("R6 — the header box searches records through the session-scoped action (searchWorkspaceRecords), never inert",
    !INERT(gs) && /searchWorkspaceRecords\(/.test(gs) && /onChange=/.test(gs) && /Search contacts, listings, leads/.test(readFileSync("app/components/layout/global-search.tsx", "utf8")))
  ok("…and the ⌘K palette stays one click away (the palette's own key, dispatched)", /onClick=\{\(\) => \{[^}]*openCommandPalette\(\)/.test(gs) && /document\.dispatchEvent\(new KeyboardEvent/.test(gs))
  ok("POSITIVE CONTROL: the inert finder flags the retired shape", INERT(`<Input placeholder="Search contacts, listings, leads..." className="pl-8" />`))
}

console.log(`\n${"═".repeat(70)}`)
console.log(`RESULT: search-visibility ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
