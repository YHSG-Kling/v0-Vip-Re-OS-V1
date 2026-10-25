/**
 * scripts/canaries/local-intel.ts — LOCAL INTELLIGENCE canary (wave 144, lane 144J; owner ruling 14):
 *   local news + events discovered through providers we ALREADY use (web research / search, public calendars, news feeds — no
 *   new paid scraper when an existing provider works) · publisher rights / robots / attribution respected · facts stored with
 *   date, location, freshness, source and confidence · expired vs upcoming distinguished · → topic suggestion → ORIGINAL
 *   community content → video / lead magnet → campaigns → education → permitted follow-up · never a whole-article copy ·
 *   human approval before anything is published.
 * Through the survivors at 967a4866: lib/content-intel/market-leadership.ts rankLeadershipOpportunities (the pure ranker —
 * a local_event opportunity from evidence, an ORIGINALITY brief), the existing provider modules (lib/content-intel/
 * newsapi-ai.ts, rss-scraper.ts, exa-scraper.ts, lib/ai/web-search.ts). Nothing is fetched.
 *
 * MEASURED AT 967a4866: "no dedicated local-EVENTS source exists in the repo (no events provider, no events table). Local
 * events are inferred ONLY from geo-tagged topic-bank rows whose text names an event" (market-leadership.ts header) — no
 * date, location, freshness or confidence is stored, so an expired event cannot be told from an upcoming one — 144G.
 */
import { CANARY_TAG, LIVE, canary, landedModule, uuid } from "./_harness"
import { findLanded, listFiles, strippedRepo } from "./_registry"
import { memSupabase } from "../in-memory-supabase"

export async function run() {
  const c = canary("Local intelligence: verified local event (existing provider, dated, sourced) → topic → ORIGINAL campaign idea → human approval · expired ≠ upcoming · no article copies")
  if (LIVE) return c.report([], 0, "refused in CANARY_LIVE mode: in-memory only")
  const UNWIRED = false as boolean
  const { rankLeadershipOpportunities } = await import("../../lib/content-intel/market-leadership")
  const empty = { aiVisibility: null, competitorMoves: [], mentions: null, ownPerformance: [], localEvents: [], blindSpots: [] }

  // ── 1 · evidence → an ORIGINAL opportunity; nothing invented (green — preserve) ──
  const none = rankLeadershipOpportunities(empty as never)
  const withEvents = rankLeadershipOpportunities({ ...empty, localEvents: [{ title: "Downtown Pensacola Fall Festival returns to Palafox Street", sourceUrl: "https://example.test/news/fall-festival" }] } as never)
  const ev = withEvents.find((o) => o.kind === "local_event")
  c.rule("144G", "A LOCAL EVENT BECOMES AN ORIGINAL OPPORTUNITY, NEVER A COPY (green — preserve): with a sourced event in evidence the ranker proposes a local_event opportunity whose brief demands ORIGINAL, local, brand-voiced content that never copies or paraphrases the source and goes through the fair-housing gates and the APPROVAL step before publication; with no evidence it proposes NOTHING (no invented week of content)", none.length === 0 && !!ev && /ORIGINAL/.test(ev.brief) && /never copy/i.test(ev.brief) && /approval/i.test(ev.brief) && ev.evidence.length === 1, ev ? `${ev.title} — ${ev.brief.slice(0, 90)}` : "no local_event opportunity")

  // ── 2 · discovery through an EXISTING provider; facts stored with date / location / freshness / source / confidence ──
  // Driven through lane 144G's LANDED pass when its file exists (lib/content-intel/local-intel.ts runLocalIntelPass): one tenant,
  // one active territory (an injected pull gate), the registered search injected (zero network) answering two local events — one
  // UPCOMING on an official .gov calendar, one already PAST — and no news key, no feeds. Writes land on a private in-memory client.
  const store = findLanded(["lib/local-intel", "lib/content-intel", "lib/competitive-intel", "supabase/migrations"], /\b(local_events?|local_intel\w*|community_events?|local_news_facts?|localEventFact\w*|LOCAL_EVENT\w*)\b/)
  const li = await landedModule("../../lib/content-intel/local-intel.ts")
  const DAY = 86_400_000
  // local_event must be in the day's kind rotation (2 of 6 kinds per territory, offset by the day index): pick the most recent
  // day whose index puts it there — a deterministic fixture, never a guess at the rotation.
  let nowMs = Math.floor(Date.now() / DAY) * DAY + 12 * 3_600_000
  while (Math.floor(nowMs / DAY) % 6 !== 0) nowMs -= DAY
  const NOW = new Date(nowMs)
  const longDate = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
  const UPCOMING_URL = "https://www.cityofpensacola.gov/events/holiday-parade-144j", PAST_URL = "https://www.cityofpensacola.gov/events/fall-festival-144j"
  const fact = li ? await (async () => {
    const B = uuid()
    const db = memSupabase({ brokerages: [{ id: B, name: `${CANARY_TAG} Local Brokerage` }], content_topic_sources: [], content_topic_bank: [] }, { stampCreatedAt: true, uuidIds: true }) as any
    const hits = [
      { title: "Pensacola Holiday Parade on Palafox Street", url: UPCOMING_URL, snippet: `Pensacola's holiday parade steps off downtown on ${longDate(nowMs + 21 * DAY)}.`, publishedAt: new Date(nowMs - DAY).toISOString() },
      { title: "Pensacola Fall Festival returns downtown", url: PAST_URL, snippet: `The Pensacola fall festival took over Palafox Street on ${longDate(nowMs - 9 * DAY)}.`, publishedAt: new Date(nowMs - 12 * DAY).toISOString() },
    ]
    const r = await li.runLocalIntelPass(B, {
      db, now: NOW,
      pullGate: { check: () => ({ allowed: true, reason: "canary territory" }), resolution: { territories: [{ brokerage_id: B, city: "Pensacola", state: "FL", zip_codes: ["32501"], counties: [] }] } },
      search: async (p: { idempotencyKey?: string }) => ({ provider: "tavily", cost: 0, hits: String(p.idempotencyKey ?? "").endsWith(":local_event") ? hits : [] }),
      news: async () => null, fetchText: async () => ({ ok: false, status: 404, text: null }),
      gate: async () => ({ allowed: true, reason: "canary" }), ledger: async (_b: string, _d: string, run: () => Promise<unknown>) => run(),
    })
    const row = db.tables.content_topic_bank.find((x: any) => x.source_url === UPCOMING_URL)
    const lf = row?.raw_data?.local_fact ?? {}
    const viewNow = await li.loadLocalFacts(db, B, { now: NOW })
    const after = new Date(nowMs + 30 * DAY)
    const viewLater = await li.loadLocalFacts(db, B, { now: after })
    const viewLaterRecaps = await li.loadLocalFacts(db, B, { now: after, includeExpired: true })
    return {
      stored: {
        ran: !!r.ran && (r.inserted ?? 0) >= 1, date: typeof lf.event_start === "string" && lf.event_start.length === 10,
        location: Array.isArray(row?.geo_relevance?.cities) && row.geo_relevance.cities.includes("Pensacola"),
        freshness: typeof row?.scraped_at === "string" && typeof row?.expires_at === "string" && Date.parse(row.expires_at) > nowMs,
        source: row?.source_url === UPCOMING_URL && typeof lf.publisher === "string" && lf.publisher.length > 0,
        confidence: typeof lf.confidence === "number" && lf.confidence > 0 && lf.confidence <= 1,
        tenantPinned: row?.brokerage_id === B,
      },
      temporal: {
        pastDroppedAtCapture: (r.dropped?.expired_at_capture ?? 0) >= 1 && !db.tables.content_topic_bank.some((x: any) => x.source_url === PAST_URL),
        upcomingNow: viewNow.facts.some((f: any) => f.url === UPCOMING_URL && f.temporal === "upcoming"),
        notUpcomingOnceOver: !viewLater.facts.some((f: any) => f.url === UPCOMING_URL) && viewLaterRecaps.facts.some((f: any) => f.url === UPCOMING_URL && f.temporal === "expired"),
        undatedIsNotUpcoming: li.classifyLocalTemporal({ eventStart: null, expiresAt: new Date(nowMs + DAY).toISOString() }, NOW) === "current",
      },
    }
  })() : null
  const allTrue = (o: Record<string, boolean> | undefined) => !!o && Object.values(o).every(Boolean)
  c.rule("144G", "A VERIFIED LOCAL FACT IS STORED WITH ITS DATE, LOCATION, FRESHNESS, SOURCE AND CONFIDENCE (ruling 14): an official calendar / city notice / local news item found through a provider the platform already uses is kept as a fact row (event date, place, captured_at / freshness, source URL + publisher + attribution, confidence) under the tenant's market — not a free-text topic title", allTrue(fact?.stored), fact ? `landed pass: ${JSON.stringify(fact.stored)}` : store ? `landed at ${store}, but lib/content-intel/local-intel.ts is absent` : "HEAD: no events table or fact store under lib/local-intel, lib/content-intel, lib/competitive-intel or a migration; local events are topic-bank titles only")
  const providers = ["lib/content-intel/newsapi-ai.ts", "lib/content-intel/rss-scraper.ts", "lib/content-intel/exa-scraper.ts", "lib/ai/web-search.ts"]
  // The discovery path may land under lib/local-intel (new) or lib/content-intel (the survivor directory): every file there that
  // names a local event / news fact (the provider modules and the ranker themselves excluded) is a candidate.
  const candidates = [...listFiles("lib/local-intel", (f) => /\.tsx?$/.test(f)), ...listFiles("lib/content-intel", (f) => /\.tsx?$/.test(f))]
    .filter((f) => !providers.includes(f) && f !== "lib/content-intel/market-leadership.ts")
    .filter((f) => /\b(local_events?|localEvent\w*|community_events?|local_news\w*|LOCAL_EVENT\w*)\b/.test(strippedRepo(f) ?? ""))
  const discovery = candidates.filter((f) => /from\s+["']@\/lib\/(content-intel\/(newsapi-ai|rss-scraper|exa-scraper)|ai\/web-search)["']|import\(\s*["']@\/lib\/(content-intel\/(newsapi-ai|rss-scraper|exa-scraper)|ai\/web-search)["']\s*\)/.test(strippedRepo(f) ?? ""))
  const newScraper = candidates.filter((f) => /\bfetch\s*\(\s*["'`]https?:\/\//.test(strippedRepo(f) ?? ""))
  c.rule("144G", "NO NEW PAID SCRAPER WHEN AN EXISTING PROVIDER WORKS (ruling 14): the local discovery path calls the providers the platform already uses (News API / RSS / Exa / web search — through their own modules, so robots, terms, attribution and cost booking ride with them) and opens no raw fetch of its own", discovery.length > 0 && newScraper.length === 0, `existing provider modules: ${providers.filter((p) => strippedRepo(p) !== null).join(", ")}; local-event discovery files importing one: ${discovery.join(", ") || "none (no local-event discovery module at HEAD)"}${newScraper.length ? `; raw fetch in ${newScraper.join(", ")}` : ""}`)

  // ── 3 · expired vs upcoming ──
  c.rule("144G", "EXPIRED IS NOT UPCOMING (ruling 14): an event whose date has passed is never proposed as an upcoming community moment (a recap at most, labelled as past) and an undated item is not presented as upcoming — at HEAD the ranker's localEvents carry no date at all", allTrue(fact?.temporal), fact ? `landed pass + reader: ${JSON.stringify(fact.temporal)}` : "HEAD: LeadershipSignals.localEvents = { title, sourceUrl } — no date, so the distinction cannot be made")

  // ── 4 · topic → original campaign idea → HUMAN APPROVAL ──
  const approval = findLanded(["lib/local-intel", "lib/content-intel", "lib/kernel/content-creators.ts"], /\b(local_event|localEvent\w*|community_event)\b[\s\S]{0,600}\b(approval|approve|pending_approval|requiresApproval|human_review)\b/)
  c.rule("144G", "TOPIC → ORIGINAL CAMPAIGN IDEA → HUMAN APPROVAL (ruling 14 + the publication ruling): the verified event feeds a topic suggestion, the content-creator survivor drafts an ORIGINAL community piece / video / lead-magnet idea, and it waits for a human approval before any campaign, publication or follow-up uses it", approval !== null && UNWIRED, approval ? `landed at ${approval} — wire the proposal-awaits-approval assertion here` : "HEAD: no local-event → content proposal path")

  c.blind("No provider is called and no page is fetched (robots / terms are the provider modules' own rules). The ranker is pure; the store / discovery / approval half has no survivor at HEAD, so those steps read a landed module as evidence and stay red until their behavioural assertion is wired.")
  return c.report([], 0)
}
